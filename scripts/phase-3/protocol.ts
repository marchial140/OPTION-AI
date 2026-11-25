import { optionTradingCutoff } from '../../src/lib/quant';
import { phase1Protocol } from '../phase-1/config';

export const phase3Protocol = {
  version: 'phase-3-v1',
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
    timezone: 'America/New_York', signalLocalTime: '09:45', stockAvailabilityLagMinutes: 16,
    optionAvailabilityLocalTime: '09:31', preCloseSnapshotMinutes: 45, orderLockMinutes: 20,
    method: 'next-session-locked-limit',
  },
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
    const entryDate = nextStudySession(signalDate);
    const close = optionTradingCutoff(entryDate)!;
    let latestExpiryDate = addCalendarDays(signalDate, p.portfolio.maxCalendarDte);
    while (optionTradingCutoff(latestExpiryDate) === null) latestExpiryDate = addCalendarDays(latestExpiryDate, -1);
    signals.push({ signalDate, signalAt: studyMorning(entryDate, 45), entryDate,
      revalidationObservedAt: new Date(close - p.timeline.preCloseSnapshotMinutes * minuteMs).toISOString(),
      orderAt: new Date(close - p.timeline.orderLockMinutes * minuteMs).toISOString(),
      fillAt: new Date(close).toISOString(), latestExpiryDate });
  }
  if (closeDates.length !== p.expectedCloseCount || closeDates.indexOf(p.startDate) !== p.precedingSessions
    || signals.length !== p.expectedSignalCount || signals.some(({ latestExpiryDate }) => latestExpiryDate > p.cutoffDate)) {
    throw new Error('Study calendar differs from the frozen design.');
  }
  return { closeDates, signals };
}
