import Decimal from 'decimal.js';
import { calculateStrategy, payoffAt, type StrategyInput } from '../../src/lib/quant';
import { phase2Protocol as protocol } from './config';
import { positiveFinite, type LognormalDistribution, type TerminalDistribution } from './distributions';
import { normalInterval, normalQuantile } from './normal';

export interface ExpectedValue {
  expectedGrossPayoff: number;
  expectedNetPnl: number;
  expectedReturnOnRisk: number;
  probabilityOfProfit: number;
  probabilityOfMaximumLoss: number;
  probabilityOfMaximumProfit: number | null;
  medianNetPnl: number;
  percentile5NetPnl: number;
  percentile95NetPnl: number;
  expectedShortfall5: number;
  entryDebit: number;
  modeledCosts: number;
  maxLoss: number;
  maxProfit: number | null;
  breakEven: number | null;
  requiredMoveToBreakEven: number | null;
}

export function prepareStrategy(input: StrategyInput, additionalCosts = 0) {
  if (!Number.isFinite(additionalCosts) || additionalCosts < 0) throw new RangeError('Invalid explicit execution costs.');
  const adjusted = { ...input, fees: new Decimal(input.fees).plus(additionalCosts).toNumber() };
  const result = calculateStrategy(adjusted);
  const [long, short] = adjusted.legs;
  const isCall = long.type === 'call';
  const exposure = result.quantity * result.multiplier;
  const width = short ? new Decimal(short.strike).minus(long.strike).abs().toNumber() : null;
  const maximumGross = width === null ? isCall ? null : long.strike * exposure : width * exposure;
  return { input: adjusted, result, isCall, exposure, strike: long.strike, shortStrike: short?.strike, width, maximumGross };
}

type PreparedStrategy = ReturnType<typeof prepareStrategy>;

function intrinsicAt(strategy: PreparedStrategy, price: number) {
  const movement = strategy.isCall ? price - strategy.strike : strategy.strike - price;
  return Math.min(strategy.width ?? Infinity, Math.max(0, movement)) * strategy.exposure;
}

function statisticsForMasses(strategy: PreparedStrategy, ascendingPrices: readonly number[]) {
  // Collapse a constant empirical distribution to the same exact point as a zero-volatility forecast.
  const first = ascendingPrices[0];
  const prices = first === ascendingPrices.at(-1) ? [first] : strategy.isCall ? ascendingPrices : ascendingPrices.toReversed();
  const size = prices.length;
  const tailSize = protocol.downsideTailProbability * size;
  let expectedGrossPayoff = 0;
  let tailGross = 0;
  let profit = 0;
  let maximumLoss = 0;
  let maximumProfit = 0;
  let compensation = 0;
  const grossPayoffs: number[] = [];
  const precision = Number.EPSILON * 8 * Math.max(strategy.result.positionCost, strategy.exposure * strategy.strike);
  for (const [i, price] of prices.entries()) {
    const gross = intrinsicAt(strategy, price);
    const delta = gross - strategy.result.positionCost;
    // Use the money engine at break-even where subtracting floating-point strikes can change the sign.
    const net = Math.abs(delta) <= precision ? payoffAt(strategy.input, price) : delta;
    const contribution = gross / size - compensation;
    const updated = expectedGrossPayoff + contribution;
    compensation = (updated - expectedGrossPayoff) - contribution;
    expectedGrossPayoff = updated;
    tailGross += gross * Math.max(0, Math.min(1, tailSize - i)) / tailSize;
    if (net > 0) profit++;
    if (gross === 0) maximumLoss++;
    if (strategy.maximumGross !== null && (strategy.shortStrike === undefined ? price === 0
      : strategy.isCall ? price >= strategy.shortStrike : price <= strategy.shortStrike)) maximumProfit++;
    grossPayoffs.push(gross);
  }
  return {
    expectedGrossPayoff, tailGross,
    preciseNet: size === 1 || Math.abs(expectedGrossPayoff - strategy.result.positionCost) <= precision
      ? prices.reduce((total, price) => total.plus(payoffAt(strategy.input, price)), new Decimal(0)).div(size).toNumber() : null,
    profit: profit / size, maximumLoss: maximumLoss / size, maximumProfit: maximumProfit / size,
    quantileGross: (probability: number) => grossPayoffs[Math.ceil(probability * size) - 1],
  };
}

function lognormalStatistics(strategy: PreparedStrategy, dist: LognormalDistribution) {
  const { logMean, logVolatility, spot, expectedTerminalPrice } = dist;
  if (logVolatility === 0) return statisticsForMasses(strategy, [expectedTerminalPrice]);
  const zAt = (price: number) => price === 0 ? -Infinity : ((Math.log(price) - Math.log(spot)) - logMean) / logVolatility;
  const longZ = zAt(strategy.strike);
  const shortZ = strategy.shortStrike === undefined ? undefined : zAt(strategy.shortStrike);
  const strikeLow = strategy.isCall ? longZ : shortZ ?? -Infinity;
  const strikeHigh = strategy.isCall ? shortZ ?? Infinity : longZ;

  const grossWithin = (low: number, high: number) => {
    const a = Math.max(low, strikeLow);
    const b = Math.min(high, strikeHigh);
    const mass = normalInterval(a, b);
    const moment = expectedTerminalPrice * normalInterval(a - logVolatility, b - logVolatility);
    const intrinsic = strategy.isCall ? moment - strategy.strike * mass : strategy.strike * mass - moment;
    const cappedMass = shortZ === undefined ? 0 : strategy.isCall
      ? normalInterval(Math.max(low, shortZ), high) : normalInterval(low, Math.min(high, shortZ));
    return (Math.max(0, intrinsic) + cappedMass * (strategy.width ?? 0)) * strategy.exposure;
  };

  const p = protocol.downsideTailProbability;
  const breakEven = strategy.result.breakEven;
  const profit = breakEven === null || (strategy.result.maxProfit !== null && strategy.result.maxProfit <= 0) ? 0
    : strategy.isCall ? normalInterval(zAt(breakEven), Infinity) : normalInterval(-Infinity, zAt(breakEven));
  return {
    expectedGrossPayoff: grossWithin(-Infinity, Infinity),
    preciseNet: null,
    tailGross: (strategy.isCall ? grossWithin(-Infinity, normalQuantile(p)) : grossWithin(normalQuantile(1 - p), Infinity)) / p,
    profit,
    maximumLoss: strategy.isCall ? normalInterval(-Infinity, longZ) : normalInterval(longZ, Infinity),
    maximumProfit: shortZ === undefined ? 0 : strategy.isCall ? normalInterval(shortZ, Infinity) : normalInterval(-Infinity, shortZ),
    quantileGross: (probability: number) => intrinsicAt(strategy,
      spot * Math.exp(logMean + logVolatility * normalQuantile(strategy.isCall ? probability : 1 - probability))),
  };
}

export function evaluatePrepared(strategy: PreparedStrategy, distribution: TerminalDistribution): ExpectedValue {
  if (!positiveFinite(distribution.spot) || !positiveFinite(distribution.expectedTerminalPrice)) {
    throw new RangeError('Invalid terminal distribution.');
  }
  if (distribution.kind === 'empirical' && (!distribution.prices.length || distribution.prices.some(
    (price, i) => !positiveFinite(price) || (i > 0 && price < distribution.prices[i - 1]),
  ))) throw new RangeError('Invalid empirical price support.');
  if (distribution.kind === 'lognormal' && (!Number.isFinite(distribution.logMean)
    || !Number.isFinite(distribution.logVolatility) || distribution.logVolatility < 0)) throw new RangeError('Invalid lognormal support.');

  const statistics = distribution.kind === 'lognormal' ? lognormalStatistics(strategy, distribution)
    : statisticsForMasses(strategy, distribution.prices);
  const { result } = strategy;
  const boundGross = (value: number) => {
    if (!Number.isFinite(value)) throw new RangeError('Expected payoff exceeds numerical range.');
    return Math.min(strategy.maximumGross ?? Infinity, Math.max(0, value));
  };
  const net = (gross: number) => {
    const bounded = boundGross(gross);
    if (bounded === 0) return -result.maxLoss;
    if (bounded === strategy.maximumGross && result.maxProfit !== null) return result.maxProfit;
    return bounded - result.positionCost;
  };
  const probability = (value: number) => {
    const tolerance = protocol.validation.probabilityTolerance;
    if (!Number.isFinite(value) || value < -tolerance || value > 1 + tolerance) throw new RangeError('Invalid probability.');
    return Math.max(0, Math.min(1, value));
  };
  const expectedNetPnl = statistics.preciseNet ?? net(statistics.expectedGrossPayoff);
  const expectedReturnOnRisk = expectedNetPnl / result.maxLoss;
  const requiredMove = result.breakEven === null ? null : result.breakEven / distribution.spot - 1;
  if (!Number.isFinite(expectedReturnOnRisk) || (requiredMove !== null && !Number.isFinite(requiredMove))) {
    throw new RangeError('Return or required break-even movement exceeds numerical range.');
  }
  const [lower, median, upper] = protocol.quantileProbabilities;
  return {
    expectedGrossPayoff: boundGross(statistics.expectedGrossPayoff), expectedNetPnl, expectedReturnOnRisk,
    probabilityOfProfit: probability(statistics.profit), probabilityOfMaximumLoss: probability(statistics.maximumLoss),
    probabilityOfMaximumProfit: result.maxProfit === null ? null : probability(statistics.maximumProfit),
    medianNetPnl: net(statistics.quantileGross(median)), percentile5NetPnl: net(statistics.quantileGross(lower)),
    percentile95NetPnl: net(statistics.quantileGross(upper)), expectedShortfall5: net(statistics.tailGross),
    entryDebit: result.entryDebit, modeledCosts: result.fees, maxLoss: result.maxLoss, maxProfit: result.maxProfit,
    breakEven: result.breakEven, requiredMoveToBreakEven: requiredMove,
  };
}

export function evaluateExpectedValue(input: StrategyInput, distribution: TerminalDistribution, additionalCosts = 0): ExpectedValue {
  return evaluatePrepared(prepareStrategy(input, additionalCosts), distribution);
}
