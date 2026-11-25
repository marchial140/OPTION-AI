import { phase2Protocol as protocol } from './config';
import { sampleStats } from './history';

export interface LognormalDistribution {
  kind: 'lognormal';
  spot: number;
  horizonSessions: number;
  years: number;
  annualizedVolatility: number;
  annualizedDrift: number;
  expectedTerminalPrice: number;
  logMean: number;
  logVolatility: number;
}

export interface EmpiricalDistribution {
  kind: 'empirical';
  spot: number;
  horizonSessions: number;
  years: number;
  expectedTerminalPrice: number;
  // Equal-weight observations in ascending price order.
  prices: readonly number[];
}

export type TerminalDistribution = LognormalDistribution | EmpiricalDistribution;

export interface EmpiricalWindows {
  horizonSessions: number;
  logRatios: readonly number[];
  horizonMeanReturn: number;
  horizonSampleVolatility: number | null;
}

export function positiveFinite(value: number) {
  return Number.isFinite(value) && value > 0;
}

function duration(horizonSessions: number) {
  if (!Number.isSafeInteger(horizonSessions) || horizonSessions < 0) throw new RangeError('Invalid trading-session horizon.');
  return horizonSessions / protocol.sessionsPerYear;
}

export function lognormalDistribution(
  spot: number, horizonSessions: number, annualizedVolatility: number, annualizedDrift: number = protocol.baselineArithmeticDrift,
): LognormalDistribution {
  const years = duration(horizonSessions);
  if (!positiveFinite(spot) || !Number.isFinite(annualizedVolatility) || annualizedVolatility < 0 || !Number.isFinite(annualizedDrift)) {
    throw new RangeError('Invalid lognormal parameters.');
  }
  const logVolatility = annualizedVolatility * Math.sqrt(years);
  const logMean = annualizedDrift * years - logVolatility ** 2 / 2;
  const expectedTerminalPrice = spot * Math.exp(annualizedDrift * years);
  const logSpot = Math.log(spot);
  if (!positiveFinite(expectedTerminalPrice) || !positiveFinite(Math.exp(logSpot + logMean + 8 * logVolatility))
    || !positiveFinite(Math.exp(logSpot + logMean - 8 * logVolatility))) {
    throw new RangeError('Lognormal moments or central support exceed numerical range.');
  }
  return { kind: 'lognormal', spot, horizonSessions, years, annualizedVolatility, annualizedDrift, expectedTerminalPrice, logMean, logVolatility };
}

export function empiricalWindows(logReturns: readonly number[], horizonSessions: number): EmpiricalWindows {
  duration(horizonSessions);
  const count = protocol.empiricalLookbackReturns;
  if (logReturns.length < count) throw new RangeError('Insufficient history for the empirical distribution.');
  if (horizonSessions > count) throw new RangeError('Horizon exceeds the fixed empirical lookback.');
  const returns = logReturns.slice(-count);
  if (!returns.every(Number.isFinite)) throw new RangeError('Invalid historical log return.');
  const prefix = [0];
  for (const value of returns) prefix.push(prefix.at(-1)! + value);
  const logRatios = horizonSessions === 0 ? [0] : Array.from(
    { length: count - horizonSessions + 1 }, (_, i) => prefix[i + horizonSessions] - prefix[i],
  );
  const simple = logRatios.map((ratio) => Math.expm1(ratio));
  const stats = sampleStats(simple);
  if (!Number.isFinite(stats.mean) || (stats.sampleVolatility !== null && !Number.isFinite(stats.sampleVolatility))) {
    throw new RangeError('Empirical return statistics exceed numerical range.');
  }
  return { horizonSessions, logRatios, horizonMeanReturn: stats.mean, horizonSampleVolatility: stats.sampleVolatility };
}

function logMeanExp(values: readonly number[]) {
  const max = Math.max(...values);
  return max + Math.log(values.reduce((sum, value) => sum + Math.exp(value - max), 0) / values.length);
}

export function empiricalDistribution(
  spot: number, windows: EmpiricalWindows, volatilityMultiplier = 1, annualizedDriftShock = 0,
): EmpiricalDistribution {
  const { horizonSessions, logRatios } = windows;
  const years = duration(horizonSessions);
  const expectedCount = horizonSessions === 0 ? 1 : protocol.empiricalLookbackReturns - horizonSessions + 1;
  if (!positiveFinite(spot) || !positiveFinite(volatilityMultiplier) || !Number.isFinite(annualizedDriftShock)
    || logRatios.length !== expectedCount || expectedCount <= 0 || !logRatios.every(Number.isFinite)
    || (horizonSessions === 0 && logRatios[0] !== 0)) {
    throw new RangeError('Invalid empirical distribution parameters.');
  }
  const mean = sampleStats(logRatios).mean;
  const scaled = volatilityMultiplier === 1 ? logRatios : logRatios.map((value) => mean + volatilityMultiplier * (value - mean));
  const baselineLogMean = logMeanExp(logRatios);
  // The common normalization preserves the arithmetic mean of the price ratios.
  const shift = baselineLogMean - logMeanExp(scaled) + annualizedDriftShock * years;
  const prices = scaled.map((value) => spot * Math.exp(value + shift)).sort((a, b) => a - b);
  const expectedTerminalPrice = spot * Math.exp(baselineLogMean + annualizedDriftShock * years);
  if (!prices.every(positiveFinite) || !positiveFinite(expectedTerminalPrice)) {
    throw new RangeError('Empirical prices exceed numerical range.');
  }
  return { kind: 'empirical', spot, horizonSessions, years, prices, expectedTerminalPrice };
}
