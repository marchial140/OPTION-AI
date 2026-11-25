import { optionTradingCutoff } from '../../src/lib/quant';
import { marketSession } from '../../src/lib/server/market';
import { phase2Protocol as protocol } from './config';

const dayMs = 86_400_000;
const isoDay = (day: number) => new Date(day).toISOString().slice(0, 10);

export interface ClosingPrice {
  session: string;
  close: number;
  availableAt: string;
}

export interface PriceHistory {
  symbol: string;
  basis: 'point-in-time-split-consistent-price';
  // Includes the latest corporate action available when this version was prepared.
  basisKnownAt: string;
  closes: readonly ClosingPrice[];
}

export interface SpotObservation {
  symbol: string;
  price: number;
  observedAt: string;
  availableAt: string;
}

export interface ReturnHistory {
  firstSession: string;
  lastSession: string;
  lastCloseTime: number;
  logReturns: readonly number[];
  dailyMeanLogReturn: number;
  dailyLogVolatility: number;
  annualizedVolatility: number;
}

export type DataFailure = { status: 'insufficient_data' | 'invalid_data'; reason: string };

export function instant(value: string) {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)
    && isoSession(value.slice(0, 10)) ? Date.parse(value) : Number.NaN;
}

function isoSession(session: string) {
  const time = Date.parse(session);
  return /^\d{4}-\d{2}-\d{2}$/u.test(session) && Number.isFinite(time) && isoDay(time) === session;
}

export function tradingSessionsRemaining(asOf: Date, expiration: string): number | null {
  if (!Number.isFinite(asOf.getTime()) || !isoSession(expiration)) return null;
  const cutoff = optionTradingCutoff(expiration);
  if (cutoff === null || asOf.getTime() > cutoff) return null;
  const start = Date.parse(marketSession(asOf).date);
  const end = Date.parse(expiration);
  let sessions = 0;
  for (let day = start; day <= end; day += dayMs) {
    const close = optionTradingCutoff(isoDay(day));
    if (close !== null && close > asOf.getTime()) sessions++;
  }
  return sessions;
}

export function sampleStats(values: readonly number[]) {
  let mean = 0;
  let squaredDeviations = 0;
  for (const [i, value] of values.entries()) {
    const delta = value - mean;
    mean += delta / (i + 1);
    squaredDeviations += delta * (value - mean);
  }
  const divisor = values.length - protocol.logReturnSampleDegreesOfFreedom;
  return { mean, sampleVolatility: divisor > 0 ? Math.sqrt(Math.max(0, squaredDeviations / divisor)) : null };
}

function completedCloses(asOf: Date) {
  const sessions: { date: string; cutoff: number }[] = [];
  for (let day = Date.parse(marketSession(asOf).date); sessions.length < protocol.minimumCloses; day -= dayMs) {
    const date = isoDay(day);
    const cutoff = optionTradingCutoff(date);
    if (cutoff !== null && cutoff <= asOf.getTime()) sessions.push({ date, cutoff });
  }
  return sessions.reverse();
}

export function prepareReturnHistory(history: PriceHistory | undefined, symbol: string, asOf: Date):
  { status: 'ok'; history: ReturnHistory } | DataFailure {
  if (!Number.isFinite(asOf.getTime())) return { status: 'invalid_data', reason: 'Invalid forecast timestamp.' };
  if (!history) return { status: 'insufficient_data', reason: 'No underlying closing-price history.' };
  const basisKnownAt = instant(history.basisKnownAt);
  if (history.symbol !== symbol || history.basis !== 'point-in-time-split-consistent-price' || !Number.isFinite(basisKnownAt)) {
    return { status: 'invalid_data', reason: 'Missing or inconsistent symbol or price basis.' };
  }
  if (basisKnownAt > asOf.getTime()) return { status: 'invalid_data', reason: 'Price basis includes information after the forecast.' };

  const required = completedCloses(asOf);
  const cutoffs = new Map(required.map(({ date, cutoff }) => [date, cutoff]));
  const closes = new Map<string, number>();
  for (const row of history.closes) {
    const cutoff = cutoffs.get(row.session);
    if (cutoff === undefined) continue;
    const availableAt = instant(row.availableAt);
    if (availableAt > asOf.getTime()) continue;
    if (!Number.isFinite(availableAt) || availableAt < cutoff || !Number.isFinite(row.close) || row.close <= 0) {
      return { status: 'invalid_data', reason: `Invalid completed close for ${row.session}.` };
    }
    const previous = closes.get(row.session);
    if (previous !== undefined && previous !== row.close) {
      return { status: 'invalid_data', reason: `Conflicting closes for ${row.session}.` };
    }
    closes.set(row.session, row.close);
  }
  if (closes.size !== required.length) {
    return { status: 'insufficient_data', reason: `${closes.size}/${required.length} consecutive required closes were available.` };
  }

  const prices = required.map(({ date }) => closes.get(date)!);
  const logReturns = prices.slice(1).map((close, i) => Math.log(close) - Math.log(prices[i]));
  const { mean, sampleVolatility } = sampleStats(logReturns.slice(-protocol.volatilityLookbackReturns));
  const volatility = sampleVolatility!;
  const last = required.at(-1)!;
  return { status: 'ok', history: {
    firstSession: required[0].date, lastSession: last.date, lastCloseTime: last.cutoff, logReturns,
    dailyMeanLogReturn: mean, dailyLogVolatility: volatility, annualizedVolatility: volatility * Math.sqrt(protocol.sessionsPerYear),
  } };
}
