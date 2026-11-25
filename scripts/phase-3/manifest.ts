import { createHash } from 'node:crypto';
import Decimal from 'decimal.js';
import { addCalendarDays, buildStudyCalendar, phase3Protocol, type StudySymbol } from './protocol';

export const frozenProtocolCommit = '2ff3fa43d72bbeb96bf7e60753ec9dcc3ce6c789';
const p = phase3Protocol;

export type PriceForRequest = { symbol: string; date: string; close: number };

function providerUrl(path: string, query: Record<string, string>) {
  const url = new URL(path, p.provider.origin);
  url.search = new URLSearchParams(query).toString();
  return url.href;
}

export const manifestSha256 = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function buildRequestManifest() {
  const { closeDates, signals } = buildStudyCalendar();
  const candles = p.symbols.map((symbol) => ({
    id: `candles-${symbol}`, symbol, from: p.warmupStartDate, to: p.cutoffDate,
    url: providerUrl(`/v1/stocks/candles/D/${symbol}/`, {
      from: p.warmupStartDate, to: p.cutoffDate, adjustsplits: 'false', adjustdividends: 'false', dateformat: 'unix',
    }), reservedCredits: p.provider.dailyCandleCredits,
  }));
  const chains = p.symbols.flatMap((symbol) => signals.flatMap(({ signalDate, entryDate }) => (
    (['signal', 'fill'] as const).map((role) => ({
      id: `${role}-${symbol}-${signalDate}`, symbol, role, signalDate, date: role === 'signal' ? signalDate : entryDate,
      from: addCalendarDays(signalDate, p.portfolio.minCalendarDte), to: addCalendarDays(signalDate, p.portfolio.maxCalendarDte),
      reservedCredits: p.provider.chainCredits,
    }))
  )));
  return {
    protocolCommit: frozenProtocolCommit, version: p.version, status: 'planning_only', symbols: p.symbols,
    closeDates, signals, candles, chains,
    chainTemplate: '/v1/options/chain/{symbol}/?date={date}&from={from}&to={to}&strike={outwardRoundedSignalSpotBand}&nonstandard=false&dateformat=unix&limit=4001',
    licensedPreclose: { symbols: p.symbols, sessionField: 'signals.entryDate', observationField: 'signals.revalidationObservedAt',
      latestAvailabilityField: 'signals.orderAt', fields: ['OCC', 'bid', 'ask', 'bid size', 'ask size', 'spot', 'observation time', 'availability evidence'] },
    independentEvidence: { symbols: p.symbols, roles: ['dated listed series or explicit no-book dispositions', 'corporate actions and deliverables', 'settlement calendar and closing basis', 'private use and retention rights'] },
  } as const;
}

export function resolveChainRequests(prices: readonly PriceForRequest[]) {
  const map = new Map<string, number>();
  for (const { symbol, date, close } of prices) {
    const key = `${symbol}/${date}`;
    if (!Number.isFinite(close) || close <= 0 || map.has(key)) throw new Error(`Invalid or duplicate underlying close for ${key}.`);
    map.set(key, close);
  }
  return buildRequestManifest().chains.map(({ id, symbol, role, signalDate, date, from, to, reservedCredits }) => {
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

function estimate(symbol: StudySymbol, chainCount: number) {
  const high = symbol === 'SPY' || symbol === 'QQQ' ? 4 : 3;
  return { symbol, marketDataRequests: 1 + chainCount, priceCloses: p.expectedCloseCount,
    indicativeCredits: [1 + chainCount, 1 + chainCount * high], hardReservation: 1 + chainCount * p.provider.chainCredits };
}

export function buildCostEstimate() {
  const { signals } = buildStudyCalendar();
  const scenario = (chainCount: number, licensedSnapshots: number) => {
    const rows = p.symbols.map((symbol) => estimate(symbol, chainCount));
    const sum = (select: (row: typeof rows[number]) => number) => rows.reduce((total, row) => total + select(row), 0);
    return { rows, marketDataRequests: sum((row) => row.marketDataRequests), licensedSnapshots,
      indicativeCredits: [sum((row) => row.indicativeCredits[0]), sum((row) => row.indicativeCredits[1])],
      hardReservation: sum((row) => row.hardReservation) };
  };
  return {
    protocolCommit: frozenProtocolCommit, planningOnly: true, actualSpendUsd: 0, actualMarketDataRequests: 0,
    assumptions: { historicalRowsPerCredit: 1000, indicativeCreditsPerResponse: { SPY: [1, 4], QQQ: [1, 4], other: [1, 3] },
      limitSentinel: p.candidates.rowLimitSentinel, privateStoragePlanningGiB: 4,
      excludes: ['extra documents or endpoint calls for OCC inventory and corporate actions', 'pagination or repair', 'alternate ETF cutoff source', 'tax and extra licensing'] },
    primary: scenario(signals.length * 2, signals.length * p.symbols.length),
    proposedEodOnlyAmendment: { ...scenario(signals.length * 3, 0), approvalRequired: true },
    pricesUsd: { marketDataStarterMonthly: 30, marketDataStarterAnnual: 144, thetaDataOptionsValueMonthlyIndicative: 40,
      cboeDataShop: 'quote required', currentAccount: 'unverified' },
  } as const;
}
