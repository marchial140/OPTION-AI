import { optionTradingCutoff } from '../../src/lib/quant';
import { phase1Protocol } from '../phase-1/config';

export const phase3Protocol = {
  version: 'phase-3.1-eod-d-plus-2',
  originalProtocolCommit: '2ff3fa43d72bbeb96bf7e60753ec9dcc3ce6c789',
  phase2ReportCommit: 'c7bda67c1b694a33f2fded16bf7451512206985e',
  phase2ProtocolCommit: '4cec1d6addda59e0dec56c271cb162fe09044cce',
  symbols: ['SPY', 'QQQ', 'MSFT', 'NVDA', 'AMD', 'SOFI'],
  startDate: '2024-10-21',
  lastPermittedSignalDate: '2025-10-17',
  cutoffDate: '2025-11-21',
  cutoffAt: '2025-11-22T02:00:00.000Z',
  warmupStartDate: '2023-10-19',
  expectedCloseCount: 526,
  precedingSessions: 252,
  cadenceCalendarDays: 14,
  expectedSignalCount: 26,
  portfolio: {
    initialCapital: 10_000, referenceCapital: 10_000, maxRiskPercent: 5, maxPortfolioRiskPercent: 20,
    maxPositions: 8, quantityPerLeg: 1, multiplier: 100, entryFees: 1.30,
    minCalendarDte: 7, maxCalendarDte: 30, maxSpreadPercent: 35, maxSelectionsPerSignal: 1,
  },
  candidates: {
    minStrikeRatio: 0.8, maxStrikeRatio: 1.2, minVolume: 0, minOpenInterest: 0, minDisplayedEntrySize: 1,
    currency: 'USD', minBid: 0, minimumAskExclusive: 0, rowLimitSentinel: 4001,
    types: ['call', 'put'], deliverable: '100 unadjusted underlying shares',
    provider: 'Market Data historical date chains', settlement: 'underlying regular close and theoretical intrinsic',
  },
  timeline: {
    timezone: 'America/New_York', signalLocalTime: '09:45', orderLocalTime: '09:45', stockAvailabilityLagMinutes: 16,
    optionAvailabilityLocalTime: '09:31', maxHistoricalQuoteAgeHours: 36,
    method: 'two-session-eod-locked-limit',
  },
  technicalCoverage: { signalDate: '2026-10-05', revalidationDate: '2026-10-06', entryDate: '2026-10-07', purpose: 'schema-and-timestamp-only' },
  configurations: {
    A: 'Original score, direction disabled, original per-leg and per-symbol caps',
    B: 'Phase 1 B, payoff and direction disabled, uncapped eligible candidates',
    C: 'Lognormal standard', D: 'Lognormal conservative',
    E: 'Empirical standard', F: 'Empirical conservative',
    G: 'Uniform eligible draw, including unscored calls, without replacement trade',
    H: 'Cash without interest',
  },
  primary: 'D',
  primaryMetric: 'net terminal portfolio P&L in USD after modeled costs',
  primaryComparators: ['H', 'A', 'G'],
  randomSeeds: phase1Protocol.randomSeeds,
  uncertainty: { blockLengthSignalDates: 3, replications: 10_000, seed: 42, interval: 0.95, method: 'paired circular moving-block percentile' },
  provider: { origin: 'https://api.marketdata.app', dailyCandleCredits: 1, chainCredits: 5 },
} as const;

export type StudySymbol = typeof phase3Protocol.symbols[number];
export interface SignalSchedule {
  signalDate: string;
  signalAt: string;
  revalidationDate: string;
  entryDate: string;
  revalidationObservedAt: string;
  orderAt: string;
  fillAt: string;
  latestExpiryDate: string;
}

const dayMs = 86_400_000;
const minuteMs = 60_000;
const isoDay = (time: number) => new Date(time).toISOString().slice(0, 10);
export const addCalendarDays = (date: string, count: number) => isoDay(Date.parse(date) + count * dayMs);

export function nextStudySession(date: string) {
  for (let day = addCalendarDays(date, 1); ; day = addCalendarDays(day, 1)) {
    if (optionTradingCutoff(day) !== null) return day;
  }
}

export function studyMorning(date: string, minute: 31 | 45) {
  const cutoff = optionTradingCutoff(date);
  if (cutoff === null) throw new Error(`No study session for ${date}.`);
  const closeHour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'America/New_York', hour: 'numeric', hourCycle: 'h23' }).format(cutoff));
  return new Date(cutoff - ((closeHour - 9) * 60 - minute) * minuteMs).toISOString();
}

export function buildSignalSchedule(signalDate: string): SignalSchedule {
  const p = phase3Protocol;
  if (optionTradingCutoff(signalDate) === null) throw new Error(`No signal session for ${signalDate}.`);
  const revalidationDate = nextStudySession(signalDate);
  const entryDate = nextStudySession(revalidationDate);
  const revalidationClose = optionTradingCutoff(revalidationDate)!;
  const fillClose = optionTradingCutoff(entryDate)!;
  let latestExpiryDate = addCalendarDays(signalDate, p.portfolio.maxCalendarDte);
  while (optionTradingCutoff(latestExpiryDate) === null) latestExpiryDate = addCalendarDays(latestExpiryDate, -1);
  return { signalDate, signalAt: studyMorning(revalidationDate, 45), revalidationDate, entryDate,
    revalidationObservedAt: new Date(revalidationClose).toISOString(), orderAt: studyMorning(entryDate, 45),
    fillAt: new Date(fillClose).toISOString(), latestExpiryDate };
}

export function buildStudyCalendar() {
  const p = phase3Protocol;
  const closeDates: string[] = [];
  for (let date: string = p.warmupStartDate; date <= p.cutoffDate; date = addCalendarDays(date, 1)) {
    if (optionTradingCutoff(date) !== null) closeDates.push(date);
  }
  const signals: SignalSchedule[] = [];
  for (let anchor: string = p.startDate; anchor <= p.lastPermittedSignalDate; anchor = addCalendarDays(anchor, p.cadenceCalendarDays)) {
    const signalDate = optionTradingCutoff(anchor) === null ? nextStudySession(anchor) : anchor;
    if (signalDate > p.lastPermittedSignalDate) break;
    signals.push(buildSignalSchedule(signalDate));
  }
  if (closeDates.length !== p.expectedCloseCount || closeDates.indexOf(p.startDate) !== p.precedingSessions
    || signals.length !== p.expectedSignalCount || signals.some(({ entryDate, latestExpiryDate }) => entryDate >= latestExpiryDate || latestExpiryDate > p.cutoffDate)) {
    throw new Error('Study calendar differs from the frozen design.');
  }
  return { closeDates, signals };
}
