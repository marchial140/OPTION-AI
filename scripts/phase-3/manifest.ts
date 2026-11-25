import { createHash } from 'node:crypto';
import Decimal from 'decimal.js';
import { addCalendarDays, buildSignalSchedule, buildStudyCalendar, phase3Protocol, type StudySymbol } from './protocol';

export const frozenProtocolCommit = '1d946b027b97b325cf636eac7e446e6d52c5c294';
const p = phase3Protocol;

export type PriceForRequest = { symbol: string; date: string; close: number };
export type ManifestScope = 'study' | 'coverage';

function manifestCalendar(scope: ManifestScope) {
  if (scope === 'study') return buildStudyCalendar();
  const { signalDate, revalidationDate, entryDate } = p.technicalCoverage;
  const schedule = buildSignalSchedule(signalDate);
  if (schedule.revalidationDate !== revalidationDate || schedule.entryDate !== entryDate) throw new Error('Technical coverage dates changed.');
  return { closeDates: [signalDate, revalidationDate, entryDate], signals: [schedule] };
}

function providerUrl(path: string, query: Record<string, string>) {
  const url = new URL(path, p.provider.origin);
  url.search = new URLSearchParams(query).toString();
  return url.href;
}

export const manifestSha256 = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function buildRequestManifest(scope: ManifestScope = 'study') {
  const { closeDates, signals } = manifestCalendar(scope);
  const from = closeDates[0];
  const to = closeDates.at(-1)!;
  const candles = p.symbols.map((symbol) => ({
    id: `candles-${symbol}`, symbol, from, to,
    url: providerUrl(`/v1/stocks/candles/D/${symbol}/`, {
      from, to, adjustsplits: 'false', adjustdividends: 'false', dateformat: 'unix',
    }), reservedCredits: p.provider.dailyCandleCredits,
  }));
  const chains = p.symbols.flatMap((symbol) => signals.flatMap(({ signalDate, revalidationDate, entryDate }) => (
    ([['signal', signalDate], ['revalidation', revalidationDate], ['fill', entryDate]] as const).map(([role, date]) => ({
      id: `${role}-${symbol}-${signalDate}`, symbol, role, signalDate, date,
      from: addCalendarDays(signalDate, p.portfolio.minCalendarDte), to: addCalendarDays(signalDate, p.portfolio.maxCalendarDte),
      reservedCredits: p.provider.chainCredits,
    }))
  )));
  return {
    originalProtocolCommit: p.originalProtocolCommit, protocolCommit: frozenProtocolCommit, version: p.version,
    timeline: p.timeline.method, scope, status: 'planning_only', symbols: p.symbols,
    closeDates, signals, candles, chains,
    chainTemplate: '/v1/options/chain/{symbol}/?date={date}&from={from}&to={to}&strike={outwardRoundedSignalSpotBand}&nonstandard=false&dateformat=unix&limit=4001',
    revalidation: { chainRole: 'revalidation', sessionField: 'signals.revalidationDate', observationField: 'signals.revalidationObservedAt',
      latestAvailabilityField: 'signals.orderAt', spot: 'regular closing candle from revalidationDate' },
    independentEvidence: { symbols: p.symbols, roles: ['dated listed series or explicit no-book dispositions', 'corporate actions and deliverables', 'settlement calendar and closing basis', 'private use and retention rights'] },
  } as const;
}

export function resolveChainRequests(prices: readonly PriceForRequest[], scope: ManifestScope = 'study') {
  const map = new Map<string, number>();
  for (const { symbol, date, close } of prices) {
    const key = `${symbol}/${date}`;
    if (!Number.isFinite(close) || close <= 0 || map.has(key)) throw new Error(`Invalid or duplicate underlying close for ${key}.`);
    map.set(key, close);
  }
  return buildRequestManifest(scope).chains.map(({ id, symbol, role, signalDate, date, from, to, reservedCredits }) => {
    const close = map.get(`${symbol}/${signalDate}`);
    if (close === undefined) throw new Error(`Missing observed signal close for ${symbol}/${signalDate}.`);
    const spot = new Decimal(close);
    const low = spot.times(p.candidates.minStrikeRatio).toDecimalPlaces(2, Decimal.ROUND_FLOOR);
    const high = spot.times(p.candidates.maxStrikeRatio).toDecimalPlaces(2, Decimal.ROUND_CEIL);
    if (low.lte(0)) throw new Error(`Invalid observed strike band for ${symbol}/${signalDate}.`);
    const url = providerUrl(`/v1/options/chain/${symbol}/`, {
      date, from, to, strike: `${low.toFixed(2)}-${high.toFixed(2)}`, nonstandard: 'false',
      dateformat: 'unix', limit: String(p.candidates.rowLimitSentinel),
    });
    return { id, url, reservedCredits, symbol, role, signalDate, date };
  });
}

function estimate(symbol: StudySymbol, chainCount: number, priceCloses: number) {
  const high = symbol === 'SPY' || symbol === 'QQQ' ? 4 : 3;
  return { symbol, marketDataRequests: 1 + chainCount, priceCloses,
    indicativeCredits: [1 + chainCount, 1 + chainCount * high], hardReservation: 1 + chainCount * p.provider.chainCredits };
}

export function buildCostEstimate() {
  const scenario = (scope: ManifestScope) => {
    const { signals, closeDates } = manifestCalendar(scope);
    const rows = p.symbols.map((symbol) => estimate(symbol, signals.length * 3, closeDates.length));
    const sum = (select: (row: typeof rows[number]) => number) => rows.reduce((total, row) => total + select(row), 0);
    return { rows, marketDataRequests: sum((row) => row.marketDataRequests),
      indicativeCredits: [sum((row) => row.indicativeCredits[0]), sum((row) => row.indicativeCredits[1])],
      hardReservation: sum((row) => row.hardReservation) };
  };
  return {
    originalProtocolCommit: p.originalProtocolCommit, protocolCommit: frozenProtocolCommit, planningOnly: true, actualSpendUsd: 0, actualMarketDataRequests: 0,
    assumptions: { historicalRowsPerCredit: 1000, indicativeCreditsPerResponse: { SPY: [1, 4], QQQ: [1, 4], other: [1, 3] },
      limitSentinel: p.candidates.rowLimitSentinel, privateStoragePlanningGiB: 4,
      excludes: ['extra documents or endpoint calls for OCC inventory and corporate actions', 'pagination or repair', 'alternate ETF cutoff source', 'tax and extra licensing'] },
    primary: scenario('study'),
    separateTechnicalCoverage: { ...scenario('coverage'), ...p.technicalCoverage, approvalRequired: true },
    pricesUsd: { marketDataStarterMonthly: 30, marketDataStarterAnnual: 144, currentAccount: 'unverified', additionalRightsOrData: 'unverified' },
  } as const;
}
