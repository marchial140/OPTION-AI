import { makeOccSymbol, optionTradingCutoff, type ContractQuote, type Strategy, type StrategyInput } from '../../src/lib/quant';
import { phase2Protocol as protocol } from './config';
import { evaluateResearchCandidate } from './decision';
import { lognormalDistribution } from './distributions';
import type { PriceHistory } from './history';
import { evaluateExpectedValue } from './valuation';

export const fixtureAsOf = new Date('2026-11-24T21:00:00.000Z');
const fixtureExpiry = '2026-12-11';

export function controlledInput(strategy: Strategy, longStrike: number, longAsk: number, short?: { strike: number; bid: number }, quantity = 1, fees = 1.30): StrategyInput {
  const type = strategy === 'long_call' || strategy === 'bull_call' ? 'call' : 'put';
  const quoteAt = fixtureAsOf.toISOString();
  const quote = (strike: number, bid: number, ask: number): ContractQuote => ({
    id: makeOccSymbol('TEST', fixtureExpiry, type, strike), type, strike, bid, ask, symbol: 'TEST',
    expiration: fixtureExpiry, multiplier: 100, currency: 'USD', quoteAt, retrievedAt: quoteAt,
    source: { url: 'https://example.test/analytical-fixture', publisher: 'Synthetic mathematical fixture' },
    status: 'VERIFIED_DELAYED', volume: 100, openInterest: 200,
  });
  return { strategy, quantity, fees, legs: [quote(longStrike, longAsk * 0.93, longAsk),
    ...(short ? [quote(short.strike, short.bid, short.bid * 1.08)] : [])] };
}

export function controlledHistory(lastClose = 100, logReturn: (i: number) => number = (i) => 0.0005 + 0.018 * Math.sin(i * 1.7)): PriceHistory {
  const dates: { session: string; availableAt: string }[] = [];
  for (let day = Date.parse('2026-11-24'); dates.length < protocol.minimumCloses; day -= 86_400_000) {
    const session = new Date(day).toISOString().slice(0, 10);
    const cutoff = optionTradingCutoff(session);
    if (cutoff !== null) dates.push({ session, availableAt: new Date(cutoff).toISOString() });
  }
  let close = lastClose;
  const closes = dates.map((date, i) => {
    const observation = { ...date, close };
    close /= Math.exp(logReturn(protocol.minimumCloses - 2 - i));
    return observation;
  }).reverse();
  return { symbol: 'TEST', basis: 'point-in-time-split-consistent-price', basisKnownAt: fixtureAsOf.toISOString(), closes };
}

const cases = [
  { id: 'atm-long-call', input: controlledInput('long_call', 100, 2.10) },
  { id: 'atm-long-put', input: controlledInput('long_put', 100, 2.10) },
  { id: 'wide-call-spread', input: controlledInput('bull_call', 96, 5, { strike: 121, bid: 0.2 }, 2) },
  { id: 'wide-put-spread', input: controlledInput('bear_put', 105, 6, { strike: 73, bid: 0.2 }) },
  { id: 'narrow-call-spread', input: controlledInput('bull_call', 100, 2, { strike: 100.001, bid: 1.9998 }, 3, 0) },
  { id: 'narrow-put-spread', input: controlledInput('bear_put', 100, 2, { strike: 99.999, bid: 1.9998 }, 3, 0) },
  { id: 'deep-itm-call', input: controlledInput('long_call', 63, 37, undefined, 3, 4.90) },
  { id: 'deep-otm-call', input: controlledInput('long_call', 145, 0.05) },
  { id: 'deep-itm-put', input: controlledInput('long_put', 145, 45) },
  { id: 'deep-otm-put', input: controlledInput('long_put', 63, 0.05) },
];

// Independent reference via leg-by-leg intrinsic values, without the production payoff routine.
function intrinsicFunction(input: StrategyInput) {
  const [long, short] = input.legs;
  const scale = 100 * input.quantity;
  const sign = long.type === 'call' ? 1 : -1;
  return (price: number) => scale * (Math.max(sign * (price - long.strike), 0)
    - (short ? Math.max(sign * (price - short.strike), 0) : 0));
}

function adaptiveIntegral(fn: (x: number) => number, a: number, b: number, error: number, depth = 24): number {
  const simpson = (left: number, right: number) => (right - left) / 6 * (fn(left) + 4 * fn((left + right) / 2) + fn(right));
  function refine(left: number, right: number, whole: number, tolerance: number, remaining: number): number {
    const middle = (left + right) / 2;
    const leftEstimate = simpson(left, middle);
    const rightEstimate = simpson(middle, right);
    const difference = leftEstimate + rightEstimate - whole;
    if (remaining === 0 || Math.abs(difference) <= 15 * tolerance) return leftEstimate + rightEstimate + difference / 15;
    return refine(left, middle, leftEstimate, tolerance / 2, remaining - 1) + refine(middle, right, rightEstimate, tolerance / 2, remaining - 1);
  }
  return refine(a, b, simpson(a, b), error, depth);
}

function quadrature(input: StrategyInput, price: (z: number) => number, stdev: number) {
  const intrinsic = intrinsicFunction(input);
  const borders = [-12, 0, 12, ...input.legs.map(({ strike }) => Math.log(strike / price(0)) / stdev)]
    .filter((z) => z >= -12 && z <= 12).sort((a, b) => a - b);
  const density = (z: number) => Math.exp(-(z ** 2) / 2) / Math.sqrt(2 * Math.PI);
  return borders.slice(1).reduce((sum, end, i) => sum + adaptiveIntegral((z) => intrinsic(price(z)) * density(z), borders[i], end, 1e-10), 0);
}

function randomNormals(seed: number) {
  let state = seed;
  const uniform = () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ state >>> 15, 1 | state);
    value ^= value + Math.imul(value ^ value >>> 7, 61 | value);
    return (((value ^ value >>> 14) >>> 0) + 0.5) / 2 ** 32;
  };
  let spare: number | undefined;
  return () => {
    if (spare !== undefined) {
      const result = spare;
      spare = undefined;
      return result;
    }
    const radius = Math.sqrt(-2 * Math.log(uniform()));
    const theta = 2 * Math.PI * uniform();
    spare = radius * Math.sin(theta);
    return radius * Math.cos(theta);
  };
}

export function runNumericalValidation() {
  const spot = 100;
  const horizonSessions = 21;
  const annualizedVolatility = 0.30;
  const years = horizonSessions / protocol.sessionsPerYear;
  const mean = -(annualizedVolatility ** 2) * years / 2;
  const stdev = annualizedVolatility * Math.sqrt(years);
  const price = (z: number) => spot * Math.exp(mean + stdev * z);
  const distribution = lognormalDistribution(spot, horizonSessions, annualizedVolatility);
  const analytical = cases.map(({ id, input }) => {
    const expected = evaluateExpectedValue(input, distribution).expectedGrossPayoff;
    const reference = quadrature(input, price, stdev);
    const absoluteError = Math.abs(expected - reference);
    const { quadratureAbsoluteToleranceUsd, quadratureRelativeTolerance } = protocol.validation;
    const tolerance = Math.max(quadratureAbsoluteToleranceUsd, Math.abs(reference) * quadratureRelativeTolerance);
    return { id, expected, reference, absoluteError, tolerance };
  });
  const draws = randomNormals(protocol.randomSeed);
  const states = cases.slice(0, 4).map(({ id, input }) => ({ id, intrinsic: intrinsicFunction(input), mean: 0, squaredDeviations: 0 }));
  const convergence = [];
  let count = 0;
  for (const target of protocol.simulationSizes) {
    while (count < target) {
      const terminal = price(draws());
      count++;
      for (const state of states) {
        const sample = state.intrinsic(terminal);
        const delta = sample - state.mean;
        state.mean += delta / count;
        state.squaredDeviations += delta * (sample - state.mean);
      }
    }
    convergence.push(...states.map(({ id, mean, squaredDeviations }, i) => {
      const standardError = Math.sqrt(squaredDeviations / (count - 1) / count);
      const error = mean - analytical[i].expected;
      return { id, simulations: count, estimate: mean, error, standardError, errorInStandardErrors: error / standardError };
    }));
  }
  return { fixture: 'synthetic mathematical validation', spot, horizonSessions, annualizedVolatility, seed: protocol.randomSeed, analytical, convergence };
}

export function runStressValidation() {
  const history = controlledHistory();
  const asOf = fixtureAsOf;
  const request = { history, asOf, spot: { symbol: 'TEST', price: 100, observedAt: asOf.toISOString(), availableAt: asOf.toISOString() },
    preferences: { capital: 10_000, maxRiskPercent: 5 } };
  return [controlledInput('long_call', 100, 2.10), controlledInput('long_put', 100, 2.10),
    controlledInput('bull_call', 96, 5, { strike: 105, bid: 1.7 }),
    controlledInput('bear_put', 104, 5, { strike: 95, bid: 1.7 }),
  ].map((input) => {
    const result = evaluateResearchCandidate(request, input);
    if (result.status !== 'ok') throw new Error(result.reasons.join(' '));
    const { horizonSessions, empiricalObservations, historicalAnnualizedVolatility, historicalHorizonMeanReturn,
      historicalHorizonVolatility } = result.forecast;
    const summarize = ({ baseline, scenarios, ...summary }: typeof result.lognormal) => ({
      ...summary, baselineExpectedNetPnl: baseline.expectedNetPnl, baselineProbabilityOfProfit: baseline.probabilityOfProfit,
      scenarios: scenarios.map(({ volatilityMultiplier, driftAdjustment, expectedNetPnl, probabilityOfProfit }) => ({
        volatilityMultiplier, driftAdjustment, expectedNetPnl, probabilityOfProfit,
      })),
    });
    return { strategy: input.strategy, horizonSessions, empiricalObservations, historicalAnnualizedVolatility,
      historicalHorizonMeanReturn, historicalHorizonVolatility, lognormal: summarize(result.lognormal),
      empirical: summarize(result.empirical), disagreement: result.disagreement };
  });
}
