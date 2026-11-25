import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { z } from 'zod';
import { contractQuoteSchema, optionTradingCutoff, strategySchema, validateQuote, type ContractQuote } from '../../src/lib/quant';

const underlying = 'AAPL';
const archiveFile = /^[0-9a-f]{20}\.json$/u;
const optionColumns = ['optionSymbol', 'underlying', 'expiration', 'side', 'strike', 'updated', 'bid', 'ask'] as const;
const modelFields = ['iv', 'delta', 'gamma', 'theta', 'vega'] as const;
const calendarDate = z.iso.date();
const number = z.number().finite();
const supplementalStatusSchema = z.object({
  entryDate: calendarDate,
  url: z.string(),
  status: z.number().int().min(200).max(299),
  consumed: z.literal(0),
  rows: z.number().int().positive(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/u),
});
const count = z.number().int().nonnegative();
const dateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', day: '2-digit', month: '2-digit', year: 'numeric',
});
const timeFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});

const baselineSchema = z.object({
  start: calendarDate, horizon: calendarDate, sessions: count, signals: count, signalRows: count,
  executed: count, settled: count, closedAtHorizon: count, winCount: count, lossCount: count,
  closedPnl: number, pnlAtHorizon: number, errors: z.array(z.unknown()), unmarked: z.array(z.unknown()),
  outcomes: z.array(z.object({
    signal: calendarDate, entry: calendarDate, exit: calendarDate, expiry: calendarDate,
    maxLoss: number.nonnegative(), pnl: number, score: number, strategy: strategySchema, method: z.string(),
  })),
  skipped: z.array(z.object({ date: calendarDate, reason: z.string() })),
});

export type BaselineArtifact = z.infer<typeof baselineSchema>;

type SupplementalStatus = z.infer<typeof supplementalStatusSchema>;

type SnapshotRole = 'signal' | 'original-entry' | 'supplemental-entry';
type Snapshot = {
  cacheFile: string;
  date: string;
  role: SnapshotRole;
  sha256: string;
  requestKeyVerified: boolean;
  sourceUrl: string;
  httpStatus?: number;
  creditsConsumed?: number;
  rawRows: number;
  validRows: number;
  calls: number;
  puts: number;
  expirations: number;
  quoteAt: string;
  rejectedRows: Record<string, number>;
  modelFieldsPresent: Record<(typeof modelFields)[number], number>;
};

type InputIssue = { cacheFile: string; reason: string };
type EntryConflict = { date: string; contractId: string; directSource: string; supplementalSource: string };

export type Phase1Inputs = {
  closes: Map<string, number>;
  signalChains: Map<string, ContractQuote[]>;
  entryQuotes: Map<string, Map<string, ContractQuote>>;
  originalEntryQuotes: Map<string, Map<string, ContractQuote>>;
  baseline: BaselineArtifact;
  coverage: {
    expectedSignalDates: string[];
    expectedEntryDates: string[];
    missingSignalDates: string[];
    missingOriginalEntryDates: string[];
    missingEntryDates: string[];
    snapshots: Snapshot[];
    inputIssues: InputIssue[];
    entryConflicts: EntryConflict[];
    closeFileSha256: string;
    baselineFileSha256: string;
    originalRetrievalTimestampAvailable: false;
  };
};

type InputPaths = {
  cacheDirectory: string;
  candlesPath: string;
  baselinePath?: string;
  entryDirectory?: string;
};

function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function readJson(path: string) {
  const bytes = await readFile(path);
  try {
    const payload: unknown = JSON.parse(bytes.toString('utf8'));
    return { payload, sha256: sha256(bytes) };
  } catch {
    throw new Error(`Invalid JSON in ${basename(path)}.`);
  }
}

function epoch(value: unknown): Date | null {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) return null;
  const timestamp = new Date(value * 1000);
  return Number.isFinite(timestamp.getTime()) ? timestamp : null;
}

export function newYorkDate(timestamp: Date): string {
  const parts = Object.fromEntries(dateFormatter.formatToParts(timestamp).map(({ type, value }) => [type, value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function columns(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Malformed provider response.');
  const data = payload as Record<string, unknown>;
  if (data.s !== 'ok') throw new Error('Provider response has no successful quotation payload.');
  return data;
}

export function historicalChainRequest(date: string): string {
  return `https://api.marketdata.app/v1/options/chain/AAPL/?date=${date}&nonstandard=false&dateformat=unix&dte=7-30&strikeLimit=12&limit=256`;
}

function historicalEntryRequests(date: string, optionData: Record<(typeof optionColumns)[number], unknown[]>): string[] {
  const expiry = epoch(optionData.expiration[0]);
  const side = optionData.side[0];
  const strikes = optionData.strike;
  if (!expiry || (side !== 'call' && side !== 'put') || !strikes.every((strike) => typeof strike === 'number')
    || !optionData.side.every((value) => value === side) || !optionData.expiration.every((value) => value === optionData.expiration[0])) {
    return [];
  }
  return [strikes, strikes.toReversed()].map((order) => {
    const parameters = new URLSearchParams({
      date, nonstandard: 'false', dateformat: 'unix', expiration: newYorkDate(expiry), side, strike: order.join(','),
    });
    return `https://api.marketdata.app/v1/options/chain/AAPL/?${parameters}`;
  });
}

function readCloses(payload: unknown, baseline: BaselineArtifact): Map<string, number> {
  const { t, c } = columns(payload);
  if (!Array.isArray(t) || !Array.isArray(c) || t.length !== c.length) throw new Error('Mismatched AAPL candle columns.');
  const closes = new Map<string, number>();
  for (const [index, value] of t.entries()) {
    const time = epoch(value);
    const price: unknown = c[index];
    if (!time || timeFormatter.format(time) !== '00:00:00' || typeof price !== 'number' || !Number.isFinite(price) || price <= 0) {
      throw new Error('Invalid AAPL closing candle.');
    }
    const date = newYorkDate(time);
    if (optionTradingCutoff(date) === null) throw new Error(`Unexpected non-trading candle on ${date}.`);
    if (closes.has(date)) throw new Error(`Duplicate close for ${date}.`);
    closes.set(date, price);
  }
  const sorted = [...closes.entries()].sort(([a], [b]) => a.localeCompare(b));
  const dates = sorted.map(([date]) => date);
  if (dates.length !== baseline.sessions || dates[0] !== baseline.start || dates.at(-1) !== baseline.horizon) {
    throw new Error('The candle archive does not cover the exact baseline session period.');
  }
  return new Map(sorted);
}

function numericalCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

async function readSupplementalUsage(directory: string): Promise<Map<string, SupplementalStatus> | undefined> {
  let data: Awaited<ReturnType<typeof readJson>>;
  try {
    data = await readJson(join(directory, 'usage.json'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const parsed = z.array(supplementalStatusSchema).safeParse(data.payload);
  if (!parsed.success) throw new Error('Invalid supplemental usage manifest.');
  const rows = new Map<string, SupplementalStatus>();
  const queryKeys = new Set(['date', 'from', 'to', 'strike', 'nonstandard', 'dateformat']);
  for (const record of parsed.data) {
    let url: URL;
    try {
      url = new URL(record.url);
    } catch {
      throw new Error('Invalid supplemental source URL.');
    }
    if (url.origin !== 'https://api.marketdata.app' || url.username || url.password || url.hash ||
      url.pathname !== '/v1/options/chain/AAPL/' || [...url.searchParams.keys()].some((key) => !queryKeys.has(key)) ||
      url.searchParams.get('date') !== record.entryDate || url.searchParams.get('nonstandard') !== 'false' ||
      url.searchParams.get('dateformat') !== 'unix' || rows.has(record.entryDate)) {
      throw new Error('The supplemental usage manifest has an unsupported or duplicate request.');
    }
    rows.set(record.entryDate, record);
  }
  return rows;
}

function parseSnapshot(payload: unknown, cacheFile: string, dataHash: string, supplemental: boolean,
  signalDates: Set<string>, entryDates: Set<string>, supplementalUsage?: Map<string, SupplementalStatus>) {
  const data = columns(payload);
  const rawRows = Array.isArray(data.optionSymbol) ? data.optionSymbol.length : 0;
  if (!rawRows || optionColumns.some((name) => !Array.isArray(data[name]) || data[name].length !== rawRows)) {
    throw new Error('Missing or misaligned historical option columns.');
  }
  // Market Data returns a columnar snapshot. A mixed timestamp payload has no single close.
  const optionData = data as Record<(typeof optionColumns)[number], unknown[]> & Record<string, unknown>;
  const singleTime = new Set(optionData.updated);
  const updated = singleTime.size === 1 ? epoch(optionData.updated[0]) : null;
  if (!updated) throw new Error('Expected one close-of-session timestamp for this snapshot.');
  const date = newYorkDate(updated);
  if (updated.getTime() !== optionTradingCutoff(date)) {
    throw new Error(`Snapshot does not match the session close on ${date}.`);
  }
  const quoteAt = updated.toISOString();
  const role: SnapshotRole | undefined = supplemental
    ? entryDates.has(date) ? 'supplemental-entry' : undefined
    : signalDates.has(date) ? 'signal' : entryDates.has(date) ? 'original-entry' : undefined;
  if (!role) throw new Error(`Snapshot date ${date} is outside the relevant baseline sessions.`);
  const possibleUrls = role === 'signal' ? [historicalChainRequest(date)]
    : role === 'original-entry' ? historicalEntryRequests(date, optionData) : [];
  const reconstructed = possibleUrls.find((url) => sha256(url).slice(0, 20) === cacheFile.slice(0, -5));
  const requestKeyVerified = reconstructed !== undefined;
  const recorded = supplementalUsage?.get(date);
  if (supplementalUsage && (!recorded || recorded.sha256 !== dataHash || recorded.rows !== rawRows)) {
    throw new Error(`The supplemental snapshot does not match its usage manifest for ${date}.`);
  }
  const sourceUrl = reconstructed ?? recorded?.url ?? 'https://www.marketdata.app/docs/api/options/';
  const rejectedRows = new Map<string, number>();
  const quotes = new Map<string, ContractQuote>();
  let calls = 0;
  let puts = 0;
  const expirations = new Set<string>();
  for (let index = 0; index < rawRows; index++) {
    const rejection = (reason: string) => rejectedRows.set(reason, (rejectedRows.get(reason) ?? 0) + 1);
    const rawSymbol = optionData.underlying[index];
    const optionId = optionData.optionSymbol[index];
    const side = optionData.side[index];
    const expiry = epoch(optionData.expiration[index]);
    if (side === 'call') calls++;
    if (side === 'put') puts++;
    if (expiry) expirations.add(newYorkDate(expiry));
    if (rawSymbol !== underlying || typeof optionId !== 'string' || !expiry) {
      rejection('Invalid underlying, identifier or expiry');
      continue;
    }
    const parsed = contractQuoteSchema.safeParse({
      id: optionId.trim().toUpperCase(),
      symbol: rawSymbol,
      type: side,
      strike: optionData.strike[index],
      expiration: newYorkDate(expiry),
      multiplier: 100,
      bid: optionData.bid[index],
      ask: optionData.ask[index],
      currency: 'USD',
      quoteAt,
      retrievedAt: quoteAt,
      source: {
        url: sourceUrl,
        publisher: 'Market Data',
        method: 'marketdata-historical-eod-replay',
        citation: `Historical replay archive ${cacheFile}. Quote time is the simulation clock; the original retrieval time was not saved.`,
      },
      volume: numericalCount(Array.isArray(data.volume) ? data.volume[index] : undefined),
      openInterest: numericalCount(Array.isArray(data.openInterest) ? data.openInterest[index] : undefined),
      status: 'VERIFIED_DELAYED',
    });
    if (!parsed.success) {
      rejection('Malformed bid, ask or contract');
      continue;
    }
    const quote = parsed.data;
    const validation = validateQuote(quote, underlying, updated);
    if (!validation.valid) {
      rejection(validation.reason ?? 'Invalid options quotation');
      continue;
    }
    const prior = quotes.get(quote.id);
    if (prior && !samePrint(prior, quote)) throw new Error(`Conflicting contract rows on ${date}.`);
    quotes.set(quote.id, quote);
  }
  const modelFieldsPresent = Object.fromEntries(modelFields.map((key) => {
    const values = data[key];
    return [key, Array.isArray(values) ? values.filter((value) => typeof value === 'number' && Number.isFinite(value)).length : 0];
  })) as Snapshot['modelFieldsPresent'];
  const snapshot: Snapshot = {
    cacheFile, date, role, sha256: dataHash, requestKeyVerified, sourceUrl,
    httpStatus: recorded?.status, creditsConsumed: recorded?.consumed,
    rawRows, validRows: quotes.size,
    calls, puts, expirations: expirations.size, quoteAt, rejectedRows: Object.fromEntries(rejectedRows), modelFieldsPresent,
  };
  return { snapshot, quotes };
}

function samePrint(a: ContractQuote, b: ContractQuote): boolean {
  return a.quoteAt === b.quoteAt && a.bid === b.bid && a.ask === b.ask;
}

export async function loadPhase1Inputs(paths: InputPaths): Promise<Phase1Inputs> {
  const [artifact, candles] = await Promise.all([
    readJson(paths.baselinePath ?? join(paths.cacheDirectory, 'result.json')),
    readJson(paths.candlesPath),
  ]);
  const baseline = baselineSchema.parse(artifact.payload);
  const closes = readCloses(candles.payload, baseline);
  const sessions = [...closes.keys()];
  const signalDates = new Set([...baseline.outcomes.map(({ signal }) => signal), ...baseline.skipped.map(({ date }) => date)]);
  if (signalDates.size !== baseline.signals) throw new Error('The saved baseline signal dates do not reconcile.');
  const nextSessionBySignal = new Map<string, string>();
  for (const signal of signalDates) {
    const index = sessions.indexOf(signal);
    const next = index >= 0 ? sessions[index + 1] : undefined;
    if (!next) throw new Error(`Missing next trading session for ${signal}.`);
    nextSessionBySignal.set(signal, next);
  }
  for (const item of baseline.outcomes) {
    if (nextSessionBySignal.get(item.signal) !== item.entry || !closes.has(item.exit)) {
      throw new Error(`Inconsistent archived baseline trade dates for ${item.signal}.`);
    }
  }
  const entryDates = new Set(nextSessionBySignal.values());
  const signalChains = new Map<string, ContractQuote[]>();
  const originalEntryQuotes = new Map<string, Map<string, ContractQuote>>();
  const entryQuotes = new Map<string, Map<string, ContractQuote>>();
  const snapshots: Snapshot[] = [];
  const inputIssues: InputIssue[] = [];
  const entryConflicts: EntryConflict[] = [];
  const blocked = new Set<string>();

  async function scanDirectory(directory: string, supplemental: boolean) {
    const usage = supplemental ? await readSupplementalUsage(directory) : undefined;
    const entries = await readdir(directory, { withFileTypes: true });
    const files = entries.filter((file) => file.isFile() &&
      (supplemental ? file.name !== 'usage.json' && file.name.endsWith('.json') : archiveFile.test(file.name)));
    for (const file of files.sort((a, b) => a.name.localeCompare(b.name))) {
      let parsed: ReturnType<typeof parseSnapshot>;
      try {
        const data = await readJson(join(directory, file.name));
        parsed = parseSnapshot(data.payload, file.name, data.sha256, supplemental, signalDates, entryDates, usage);
      } catch (failure) {
        inputIssues.push({ cacheFile: file.name, reason: failure instanceof Error ? failure.message : 'Invalid input file.' });
        continue;
      }
      const { snapshot, quotes } = parsed;
      const { date, role } = snapshot;
      snapshots.push(snapshot);
      if (role === 'signal') {
        if (signalChains.has(date)) throw new Error(`Multiple signal chain snapshots on ${date}.`);
        signalChains.set(date, [...quotes.values()]);
        continue;
      }
      if (!supplemental) {
        if (originalEntryQuotes.has(date)) throw new Error(`Multiple direct baseline entry snapshots on ${date}.`);
        originalEntryQuotes.set(date, quotes);
        entryQuotes.set(date, new Map(quotes));
        continue;
      }
      const entriesForDate = entryQuotes.get(date) ?? new Map<string, ContractQuote>();
      for (const [contractId, quote] of quotes) {
        const key = `${date}:${contractId}`;
        if (blocked.has(key)) continue;
        const existing = entriesForDate.get(contractId);
        if (existing && !samePrint(existing, quote)) {
          entryConflicts.push({
            date, contractId, directSource: existing.source.citation ?? '', supplementalSource: file.name,
          });
          entriesForDate.delete(contractId);
          blocked.add(key);
        } else if (!existing) {
          entriesForDate.set(contractId, quote);
        }
      }
      entryQuotes.set(date, entriesForDate);
    }
  }

  await scanDirectory(paths.cacheDirectory, false);
  if (paths.entryDirectory) await scanDirectory(paths.entryDirectory, true);

  const expectedSignalDates = [...signalDates].sort();
  const expectedEntryDates = [...entryDates].sort();
  return {
    baseline, closes, signalChains, entryQuotes, originalEntryQuotes,
    coverage: {
      expectedSignalDates, expectedEntryDates,
      missingSignalDates: expectedSignalDates.filter((date) => !signalChains.get(date)?.length),
      missingOriginalEntryDates: expectedEntryDates.filter((date) => !originalEntryQuotes.get(date)?.size),
      missingEntryDates: expectedEntryDates.filter((date) => !entryQuotes.get(date)?.size),
      snapshots: snapshots.sort((a, b) => a.date.localeCompare(b.date) || a.role.localeCompare(b.role)),
      inputIssues, entryConflicts, closeFileSha256: candles.sha256, baselineFileSha256: artifact.sha256,
      originalRetrievalTimestampAvailable: false,
    },
  };
}
