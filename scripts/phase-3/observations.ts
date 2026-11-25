import Decimal from 'decimal.js';
import { z } from 'zod';
import { contractQuoteSchema, makeOccSymbol, optionTradingCutoff, validateQuote, type ContractQuote } from '../../src/lib/quant';
import { marketSession } from '../../src/lib/server/market';
import { instant, type PriceHistory, type SpotObservation } from '../phase-2/history';
import { nextStudySession, phase3Protocol, studyMorning, type SignalSchedule } from './protocol';

const minute = 60_000;
const dateSchema = z.iso.date();
const symbolSchema = z.string().regex(/^[A-Z][A-Z0-9.]{0,9}$/u);
const positivePrice = z.number().finite().positive().max(1_000_000);
const bidPrice = z.number().finite().nonnegative().max(1_000_000);
const count = z.number().nonnegative().int().max(Number.MAX_SAFE_INTEGER);
const timestamp = z.iso.datetime({ offset: true }).refine((at) => Number.isFinite(instant(at)));
const httpsUrl = z.string().max(2048).refine((value) => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.hash
      && ![...url.searchParams.keys()].some((key) => /token|credential|pass(word)?|secret|api[_. -]?key|auth/iu.test(key));
  } catch { return false; }
});
const sha256 = z.string().regex(/^[0-9a-f]{64}$/u);
const marketDataPolicyUrl = 'https://www.marketdata.app/docs/account/data-freshness/';
const closingBasis = 'as-traded-non-dividend-adjusted' as const;
const instantIso = (ms: number) => new Date(ms).toISOString();

const receiptSchema = z.object({ requestedSymbol: symbolSchema, sourceUrl: httpsUrl, retrievedAt: timestamp, rawSha256: sha256 }).strict();
const candleReceiptSchema = receiptSchema.extend({ requestedFrom: dateSchema, requestedTo: dateSchema }).strict();
const chainReceiptSchema = receiptSchema.extend({ requestedDate: dateSchema }).strict();
const licensedReceiptSchema = chainReceiptSchema.extend({ provider: z.string().trim().min(1).max(100) }).strict();
const actionReceiptSchema = receiptSchema.extend({ provider: z.string().trim().min(1).max(100) }).strict();

export type CandleReceipt = z.input<typeof candleReceiptSchema>;
export type ChainReceipt = z.input<typeof chainReceiptSchema>;
export type LicensedReceipt = z.input<typeof licensedReceiptSchema>;
export type ActionReceipt = z.input<typeof actionReceiptSchema>;

export type Availability = { at: string; kind: 'observed' | 'reconstructed'; evidence: string };
type ObservationTime = { observedAt: string; observationKind: 'provider' | 'session-close-from-daily-candle'; availability: Availability };
export type NormalizedClose = ObservationTime & { symbol: string; session: string; close: number; basis: typeof closingBasis };
export type NormalizedSpot = ObservationTime & { symbol: string; session: string; price: number; basis: typeof closingBasis };
export type NormalizedQuote = ObservationTime & { symbol: string; session: string; optionSymbol: string; type: 'call' | 'put';
  strike: number; expiration: string; bid: number; ask: number; multiplier: 100; currency: 'USD'; deliverable: '100-underlying-shares';
  deliverableEvidence: 'provider-standard-only-query' | 'licensed-explicit'; bidSize?: number; askSize?: number; volume?: number; openInterest?: number;
  volumeAvailableAt?: string; openInterestAvailableAt?: string };
export type NormalizationIssue = { index: number | null; code: 'empty' | 'cap' | 'invalid-row' | 'conflict'; message: string };

type Provenance<T> = T & { provider: string; actualRetrievedAt: string };
export type NormalizedCandles = { version: 1; kind: 'candles'; provenance: Provenance<CandleReceipt>; rows: NormalizedClose[]; issues: NormalizationIssue[] };
export type NormalizedChain = { version: 1; kind: 'chain'; provenance: Provenance<ChainReceipt>; rows: NormalizedQuote[]; issues: NormalizationIssue[]; rawRows: number };
export type NormalizedSnapshot = { version: 1; kind: 'intraday'; provenance: Provenance<LicensedReceipt>; spot: NormalizedSpot;
  rows: NormalizedQuote[]; issues: NormalizationIssue[]; rawRows: number };

function regularClose(session: string): number {
  const close = optionTradingCutoff(session);
  if (close === null) throw new Error(`Not a supported trading session: ${session}.`);
  return close;
}

function regularOpen(session: string): number {
  return instant(studyMorning(session, 31)) - minute;
}

export function marketDataChainAvailability(session: string): string {
  return studyMorning(nextStudySession(session), 31);
}

function checkedTime(observedAt: string, availability: Availability, actualRetrievedAt: string) {
  const observed = instant(observedAt);
  const available = instant(availability.at);
  const retrieved = instant(actualRetrievedAt);
  if (!Number.isFinite(observed) || !Number.isFinite(available) || !Number.isFinite(retrieved)
    || observed > available || available > retrieved) throw new Error('Observation, availability and retrieval are inconsistent.');
  return { observedAt: instantIso(observed), availability: { ...availability, at: instantIso(available) } };
}

function epochSecond(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 || !Number.isFinite(new Date(value * 1000).getTime())) {
    throw new Error('Invalid provider Unix timestamp.');
  }
  return value * 1000;
}

function dailySession(value: unknown) {
  const observed = new Date(epochSecond(value));
  const { date, time } = marketSession(observed);
  if (time !== '00:00' || observed.getUTCSeconds() !== 0) throw new Error('Daily data lacks a New York midnight date label.');
  return date;
}

function expirySession(value: unknown) {
  const expiresAt = epochSecond(value);
  const date = marketSession(new Date(expiresAt)).date;
  if (expiresAt !== regularClose(date)) throw new Error('Provider expiry differs from the modeled regular-close settlement clock.');
  return date;
}

function marketDataUrl(raw: string, path: string, parameters: Record<string, string>) {
  const url = new URL(raw);
  if (url.origin !== 'https://api.marketdata.app' || url.pathname !== path
    || Object.entries(parameters).some(([key, value]) => url.searchParams.getAll(key).length !== 1 || url.searchParams.get(key) !== value)) {
    throw new Error('Market Data source does not match required endpoint and frozen parameters.');
  }
}

const marketDataEnvelope = z.object({ s: z.enum(['ok', 'no_data']) }).passthrough();
const emptyIssue: NormalizationIssue = { index: null, code: 'empty', message: 'No provider observations.' };
const invalid = (index: number, error: unknown): NormalizationIssue => ({ index, code: 'invalid-row',
  message: error instanceof Error ? error.message : 'Invalid observation.' });
function columns<T extends string>(payload: Record<string, unknown>, required: readonly T[], optional: readonly string[] = []) {
  const result = Object.fromEntries(required.map((key) => [key, z.array(z.unknown()).parse(payload[key])])) as Record<T, unknown[]>;
  const size = result[required[0]].length;
  for (const key of [...required, ...optional]) {
    const column = payload[key];
    if (optional.includes(key) && column === undefined) continue;
    if (!Array.isArray(column) || column.length !== size) throw new Error(`Mismatched provider observation column: ${key}.`);
  }
  return { result, size };
}

function keepUnambiguous<T>(issues: NormalizationIssue[], key: (row: T) => string) {
  const rows = new Map<string, T>();
  const quarantined = new Set<string>();
  const add = (row: T, index: number) => {
    const identity = key(row);
    if (quarantined.has(identity)) return;
    const prior = rows.get(identity);
    if (!prior) rows.set(identity, row);
    else if (JSON.stringify(prior) !== JSON.stringify(row)) {
      issues.push({ index, code: 'conflict', message: `Conflicting rows for ${identity}.` });
      rows.delete(identity);
      quarantined.add(identity);
    }
  };
  return { add, values: () => [...rows.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, row]) => row) };
}

export function normalizeMarketDataCandles(payload: unknown, receipt: CandleReceipt): NormalizedCandles {
  const details = candleReceiptSchema.parse(receipt);
  const { requestedFrom, requestedTo, requestedSymbol, sourceUrl, retrievedAt } = details;
  if (requestedFrom > requestedTo) throw new Error('Reversed candle request range.');
  marketDataUrl(sourceUrl, `/v1/stocks/candles/D/${requestedSymbol}/`, {
    from: requestedFrom, to: requestedTo, adjustsplits: 'false', adjustdividends: 'false', dateformat: 'unix',
  });
  const provenance = { ...details, provider: 'Market Data', actualRetrievedAt: retrievedAt };
  const raw = marketDataEnvelope.parse(payload);
  if (raw.s === 'no_data') return { version: 1, kind: 'candles', provenance, rows: [], issues: [emptyIssue] };
  const { result, size } = columns(raw, ['t', 'c']);
  const issues: NormalizationIssue[] = size ? [] : [emptyIssue];
  const book = keepUnambiguous<NormalizedClose>(issues, ({ session }) => session);
  for (let i = 0; i < size; i++) {
    try {
      const session = dailySession(result.t[i]);
      if (session < requestedFrom || session > requestedTo) throw new Error('Candle is outside the requested sessions.');
      const close = regularClose(session);
      const times = checkedTime(instantIso(close), { at: instantIso(close + phase3Protocol.timeline.stockAvailabilityLagMinutes * minute),
        kind: 'reconstructed', evidence: marketDataPolicyUrl }, retrievedAt);
      book.add({ ...times, observationKind: 'session-close-from-daily-candle', symbol: requestedSymbol, session,
        close: positivePrice.parse(result.c[i]), basis: closingBasis }, i);
    } catch (error) { issues.push(invalid(i, error)); }
  }
  return { version: 1, kind: 'candles', provenance, rows: book.values(), issues };
}

const quoteFields = z.object({ optionSymbol: z.string().min(1).max(32), symbol: symbolSchema, type: z.enum(['call', 'put']),
  strike: positivePrice, expiration: dateSchema, bid: bidPrice, ask: positivePrice, bidSize: count.optional(), askSize: count.optional(),
  volume: count.optional(), openInterest: count.optional() });

function canonicalQuote(data: z.input<typeof quoteFields>, session: string, times: ObservationTime,
  deliverableEvidence: NormalizedQuote['deliverableEvidence']) {
  const row = quoteFields.parse(data);
  const optionSymbol = row.optionSymbol.trim().toUpperCase().replace(/^([A-Z0-9]{1,6}) +(?=\d{6}[CP]\d{8}$)/u, '$1');
  if (optionSymbol !== makeOccSymbol(row.symbol, row.expiration, row.type, row.strike)) throw new Error('OCC contract identity mismatch.');
  if (row.bid > row.ask) throw new Error('Crossed quote.');
  if (instant(times.observedAt) >= regularClose(row.expiration)) throw new Error('Quotation is at or after contractual expiration.');
  return { ...row, ...times, session, optionSymbol, multiplier: 100 as const, currency: 'USD' as const,
    deliverable: '100-underlying-shares' as const, deliverableEvidence };
}

const requiredOptionColumns = ['optionSymbol', 'underlying', 'expiration', 'side', 'strike', 'updated', 'bid', 'ask'] as const;
const optionalOptionColumns = ['volume', 'openInterest', 'bidSize', 'askSize', 'nonstandard', 'multiplier'] as const;
function optionalCount(payload: Record<string, unknown>, key: string, index: number) {
  const column = payload[key];
  const value: unknown = Array.isArray(column) ? column[index] : undefined;
  return value === null || value === undefined ? undefined : count.parse(value);
}

export function normalizeMarketDataChain(payload: unknown, receipt: ChainReceipt): NormalizedChain {
  const details = chainReceiptSchema.parse(receipt);
  const { requestedDate, requestedSymbol, sourceUrl, retrievedAt } = details;
  const sentinel = phase3Protocol.candidates.rowLimitSentinel;
  marketDataUrl(sourceUrl, `/v1/options/chain/${requestedSymbol}/`, { date: requestedDate, nonstandard: 'false', dateformat: 'unix', limit: String(sentinel) });
  const provenance = { ...details, provider: 'Market Data', actualRetrievedAt: retrievedAt };
  const requestedClose = regularClose(requestedDate);
  const times = checkedTime(instantIso(requestedClose), { at: marketDataChainAvailability(requestedDate),
    kind: 'reconstructed', evidence: marketDataPolicyUrl }, retrievedAt);
  const raw = marketDataEnvelope.parse(payload);
  if (raw.s === 'no_data') return { version: 1, kind: 'chain', provenance, rows: [], issues: [emptyIssue], rawRows: 0 };
  const { result, size } = columns(raw, requiredOptionColumns, optionalOptionColumns);
  if (size >= sentinel) return { version: 1, kind: 'chain', provenance, rows: [], rawRows: size,
    issues: [{ index: null, code: 'cap', message: 'Provider sentinel reached. Chain completeness is unverified.' }] };
  const issues: NormalizationIssue[] = size ? [] : [emptyIssue];
  const book = keepUnambiguous<NormalizedQuote>(issues, ({ optionSymbol }) => optionSymbol);
  for (let i = 0; i < size; i++) {
    try {
      if (result.underlying[i] !== requestedSymbol || epochSecond(result.updated[i]) !== requestedClose) {
        throw new Error('Quote differs from the requested symbol or documented regular close.');
      }
      if ((Array.isArray(raw.nonstandard) && raw.nonstandard[i] !== false)
        || (Array.isArray(raw.multiplier) && raw.multiplier[i] !== 100)) throw new Error('Nonstandard provider contract.');
      const volume = optionalCount(raw, 'volume', i);
      const openInterest = optionalCount(raw, 'openInterest', i);
      const input = quoteFields.parse({ optionSymbol: result.optionSymbol[i], symbol: result.underlying[i], type: result.side[i],
        strike: result.strike[i], expiration: expirySession(result.expiration[i]), bid: result.bid[i], ask: result.ask[i], volume, openInterest,
        bidSize: optionalCount(raw, 'bidSize', i), askSize: optionalCount(raw, 'askSize', i) });
      const quote = canonicalQuote(input, requestedDate, { ...times, observationKind: 'provider' }, 'provider-standard-only-query');
      book.add({ ...quote, volumeAvailableAt: volume === undefined ? undefined : times.availability.at,
        openInterestAvailableAt: openInterest === undefined ? undefined : times.availability.at }, i);
    } catch (error) { issues.push(invalid(i, error)); }
  }
  return { version: 1, kind: 'chain', provenance, rows: book.values(), issues, rawRows: size };
}

const observedFields = { observedAt: timestamp, availableAt: timestamp, availabilityEvidence: httpsUrl };
const licensedOptionSchema = quoteFields.extend({ ...observedFields, multiplier: z.literal(100), currency: z.literal('USD'),
  deliverable: z.literal('100-underlying-shares'), nonstandard: z.literal(false), volumeAvailableAt: timestamp.optional(),
  openInterestAvailableAt: timestamp.optional() }).strict();
const licensedSpotSchema = z.object({ ...observedFields, symbol: symbolSchema, price: positivePrice, basis: z.literal(closingBasis) }).strict();
const licensedSnapshotSchema = z.object({ s: z.literal('ok'), spot: licensedSpotSchema, options: z.array(z.unknown()) }).strict();

export function normalizePointInTimeSnapshot(payload: unknown, receipt: LicensedReceipt): NormalizedSnapshot {
  const details = licensedReceiptSchema.parse(receipt);
  const { requestedSymbol, requestedDate, retrievedAt } = details;
  const raw = licensedSnapshotSchema.parse(payload);
  const close = regularClose(requestedDate);
  // The licensed snapshot importer preserves the original Phase 3 intraday archive contract.
  const when = close - 45 * minute;
  const order = close - 20 * minute;
  const prepare = (row: z.output<typeof licensedSpotSchema> | z.output<typeof licensedOptionSchema>) => {
    if (row.symbol !== requestedSymbol || instant(row.observedAt) !== when || instant(row.availableAt) > order) {
      throw new Error('Snapshot symbol, observation window or availability misses the pre-close order clock.');
    }
    return checkedTime(row.observedAt, { at: row.availableAt, kind: 'observed', evidence: row.availabilityEvidence }, retrievedAt);
  };
  const spotTime = prepare(raw.spot);
  const spot: NormalizedSpot = { ...spotTime, observationKind: 'provider', symbol: raw.spot.symbol,
    session: requestedDate, price: raw.spot.price, basis: raw.spot.basis };
  const provenance = { ...details, actualRetrievedAt: retrievedAt };
  const issues: NormalizationIssue[] = raw.options.length ? [] : [emptyIssue];
  const book = keepUnambiguous<NormalizedQuote>(issues, ({ optionSymbol }) => optionSymbol);
  for (const [index, candidate] of raw.options.entries()) {
    try {
      const option = licensedOptionSchema.parse(candidate);
      const times = prepare(option);
      const requireFieldTimestamp = (value: number | undefined, availableAt: string | undefined, earliest = -Infinity) => {
        if (value === undefined && availableAt === undefined) return undefined;
        if (value === undefined || availableAt === undefined || instant(availableAt) < earliest
          || instant(availableAt) > order || instant(availableAt) > instant(retrievedAt)) {
          throw new Error('Intraday liquidity value has no timely availability evidence.');
        }
        return instantIso(instant(availableAt));
      };
      const quote = canonicalQuote(option, requestedDate, { ...times, observationKind: 'provider' }, 'licensed-explicit');
      book.add({ ...quote, volumeAvailableAt: requireFieldTimestamp(option.volume, option.volumeAvailableAt, when),
        openInterestAvailableAt: requireFieldTimestamp(option.openInterest, option.openInterestAvailableAt) }, index);
    } catch (error) { issues.push(invalid(index, error)); }
  }
  return { version: 1, kind: 'intraday', provenance, spot, rows: book.values(), issues, rawRows: raw.options.length };
}

const actionFields = { effectiveSession: dateSchema, availableAt: timestamp, evidence: httpsUrl };
const corporateActionSchema = z.discriminatedUnion('kind', [
  z.object({ ...actionFields, kind: z.literal('split'), oldShares: count.positive(), newShares: count.positive() }).strict(),
  z.object({ ...actionFields, kind: z.literal('cash-dividend'), cashPerShare: positivePrice }).strict(),
  z.object({ ...actionFields, kind: z.literal('contract-adjustment'), optionSymbol: z.string().regex(/^[A-Z0-9]{1,6}\d{6}[CP]\d{8}$/u).optional(),
    reason: z.string().trim().min(1).max(300) }).strict(),
]);
const actionCoverageSchema = z.object({ reviewedFrom: dateSchema, reviewedTo: dateSchema, complete: z.literal(true),
  coverageEvidence: httpsUrl, actions: z.array(corporateActionSchema) }).strict();

export type CorporateAction = z.output<typeof corporateActionSchema>;
export type NormalizedActionReview = z.output<typeof actionCoverageSchema> & {
  version: 1; kind: 'corporate-actions'; provenance: Provenance<ActionReceipt>;
};

export function normalizeCorporateActionReview(payload: unknown, receipt: ActionReceipt): NormalizedActionReview {
  const details = actionReceiptSchema.parse(receipt);
  const review = actionCoverageSchema.parse(payload);
  if (review.reviewedFrom > review.reviewedTo || review.reviewedTo > marketSession(new Date(details.retrievedAt)).date) {
    throw new Error('Corporate action coverage is reversed or in the future relative to this receipt.');
  }
  const actions = new Map<string, CorporateAction>();
  for (const action of review.actions) {
    regularClose(action.effectiveSession);
    const availableAt = instant(action.availableAt);
    if (action.effectiveSession < review.reviewedFrom || action.effectiveSession > review.reviewedTo || availableAt > instant(details.retrievedAt)) {
      throw new Error('Corporate action falls outside the documented evidence coverage.');
    }
    if (action.kind === 'split' && action.oldShares === action.newShares) throw new Error('A split must change share count.');
    const key = `${action.effectiveSession}:${action.kind}:${action.kind === 'contract-adjustment' ? action.optionSymbol ?? '*' : '*'}`;
    const prior = actions.get(key);
    const normalized = { ...action, availableAt: instantIso(availableAt) };
    if (prior && JSON.stringify(prior) !== JSON.stringify(normalized)) throw new Error(`Conflicting corporate action evidence on ${action.effectiveSession}.`);
    actions.set(key, normalized);
  }
  return { ...review, version: 1, kind: 'corporate-actions', provenance: { ...details, actualRetrievedAt: details.retrievedAt },
    actions: [...actions.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, action]) => action) };
}

export function buildPhase2History(batch: NormalizedCandles, review: NormalizedActionReview, asOf: Date): PriceHistory {
  const symbol = batch.provenance.requestedSymbol;
  if (!Number.isFinite(asOf.getTime()) || review.provenance.requestedSymbol !== symbol || !review.complete) {
    throw new Error('A verified matching corporate action history and forecast are required.');
  }
  const closeRows = batch.rows.filter((row) => instant(row.observedAt) <= asOf.getTime() && instant(row.availability.at) <= asOf.getTime());
  const latest = closeRows.at(-1)?.session;
  if (!latest || review.reviewedFrom > closeRows[0].session || review.reviewedTo < marketSession(asOf).date) {
    throw new Error('Corporate action evidence does not cover the closing-price basis at the forecast.');
  }
  const splits: Extract<CorporateAction, { kind: 'split' }>[] = [];
  for (const action of review.actions) {
    if (action.kind !== 'split' || regularOpen(action.effectiveSession) > asOf.getTime() || action.effectiveSession < closeRows[0].session) continue;
    if (instant(action.availableAt) > asOf.getTime()) throw new Error('An already-effective split has no as-of evidence.');
    splits.push(action);
  }
  const closes = closeRows.map((row) => ({
    close: splits.reduce((price, action) => row.session < action.effectiveSession
      ? price.times(action.oldShares).div(action.newShares) : price, new Decimal(row.close)).toNumber(),
    session: row.session,
    availableAt: row.availability.at,
  }));
  if (closes.some(({ close }) => !Number.isFinite(close) || close <= 0)) throw new Error('Normalized close leaves valid numerical range.');
  return { symbol, basis: 'point-in-time-split-consistent-price', basisKnownAt: asOf.toISOString(), closes };
}

export function toResearchSpot(row: NormalizedClose | NormalizedSpot, asOf: Date): SpotObservation {
  const observed = instant(row.observedAt);
  const available = instant(row.availability.at);
  const price = 'close' in row ? row.close : row.price;
  if (!Number.isFinite(asOf.getTime()) || !Number.isFinite(observed) || !Number.isFinite(available)
    || observed > available || available > asOf.getTime() || !positivePrice.safeParse(price).success) {
    throw new Error('Underlying observation is unavailable at the forecast.');
  }
  return { symbol: row.symbol, price, observedAt: row.observedAt, availableAt: row.availability.at };
}

function projectResearchQuote(row: NormalizedQuote, batch: NormalizedChain | NormalizedSnapshot, asOf: Date): ContractQuote {
  const { observedAt, availability } = checkedTime(row.observedAt, row.availability, batch.provenance.actualRetrievedAt);
  if (!Number.isFinite(asOf.getTime()) || row.symbol !== batch.provenance.requestedSymbol || row.session !== batch.provenance.requestedDate
    || instant(availability.at) > asOf.getTime()) {
    throw new Error('Historical quote was unavailable as of the research decision.');
  }
  const keep = (value: number | undefined, at: string | undefined) => value !== undefined && at !== undefined && instant(at) <= asOf.getTime()
    ? value : undefined;
  return contractQuoteSchema.parse({
    id: row.optionSymbol, symbol: row.symbol, type: row.type, strike: row.strike, expiration: row.expiration,
    multiplier: row.multiplier, currency: row.currency, bid: row.bid, ask: row.ask,
    quoteAt: observedAt,
    // Phase 2 uses this slot for modeled availability. Archive retrieval remains in the private provenance.
    retrievedAt: availability.at,
    source: { url: batch.provenance.sourceUrl, publisher: batch.provenance.provider, method: `phase-3-${row.availability.kind}-availability`,
      citation: `Observed at ${row.observedAt}; ${row.availability.kind} availability ${row.availability.at}; archive retrieved at ${batch.provenance.actualRetrievedAt}.` },
    volume: keep(row.volume, row.volumeAvailableAt), openInterest: keep(row.openInterest, row.openInterestAvailableAt), status: 'VERIFIED_DELAYED',
  });
}

export function toResearchQuote(row: NormalizedQuote, batch: NormalizedChain | NormalizedSnapshot, asOf: Date): ContractQuote {
  const candidate = projectResearchQuote(row, batch, asOf);
  const validation = validateQuote(candidate, row.symbol, asOf);
  if (!validation.valid) throw new Error(`Historical risk eligibility: ${validation.reason ?? validation.status}`);
  return candidate;
}

type StudyQuoteStage = 'signal' | 'revalidation' | 'fill';

function studyDecisionStage(schedule: SignalSchedule, stage: Exclude<StudyQuoteStage, 'fill'>) {
  return stage === 'signal' ? { session: schedule.signalDate, cutoff: schedule.signalAt }
    : { session: schedule.revalidationDate, cutoff: schedule.orderAt };
}

export function toStudySpot(row: NormalizedClose, batch: NormalizedCandles, schedule: SignalSchedule,
  stage: Exclude<StudyQuoteStage, 'fill'>): SpotObservation {
  const { session, cutoff } = studyDecisionStage(schedule, stage);
  const close = regularClose(session);
  if (row.session !== session || row.symbol !== batch.provenance.requestedSymbol || row.basis !== closingBasis
    || row.observationKind !== 'session-close-from-daily-candle' || instant(row.observedAt) !== close
    || row.availability.kind !== 'reconstructed' || instant(row.availability.at) !== close + phase3Protocol.timeline.stockAvailabilityLagMinutes * minute) {
    throw new Error('Underlying observation does not match the scheduled decision session.');
  }
  checkedTime(row.observedAt, row.availability, batch.provenance.actualRetrievedAt);
  return toResearchSpot(row, new Date(cutoff));
}

export function toStudyQuote(row: NormalizedQuote, batch: NormalizedChain, schedule: SignalSchedule,
  stage: StudyQuoteStage): ContractQuote & Pick<NormalizedQuote, 'bidSize' | 'askSize'> {
  const { session, cutoff } = stage === 'fill'
    ? { session: schedule.entryDate, cutoff: marketDataChainAvailability(schedule.entryDate) }
    : studyDecisionStage(schedule, stage);
  if (row.session !== session || row.observationKind !== 'provider' || instant(row.observedAt) !== regularClose(session)
    || row.availability.kind !== 'reconstructed' || instant(row.availability.at) !== instant(marketDataChainAvailability(session))) {
    throw new Error('Option observation does not match the scheduled study session.');
  }
  // Archive evidence remains intact even when the original freshness or expiry gate rejects the trade.
  const quote = projectResearchQuote(row, batch, new Date(cutoff));
  return { ...quote, bidSize: count.optional().parse(row.bidSize), askSize: count.optional().parse(row.askSize) };
}

export function contractActionsThrough(review: NormalizedActionReview, row: NormalizedQuote, decision?: Date): CorporateAction[] {
  if (review.provenance.requestedSymbol !== row.symbol || review.reviewedFrom > row.session || review.reviewedTo < row.expiration
    || (decision && !Number.isFinite(decision.getTime()))) throw new Error('Corporate action evidence does not cover this contract horizon.');
  return review.actions.filter((action) => action.kind !== 'cash-dividend' && action.effectiveSession > row.session
    && action.effectiveSession <= row.expiration && (!decision || instant(action.availableAt) <= decision.getTime())
    && (action.kind !== 'contract-adjustment' || action.optionSymbol === undefined || action.optionSymbol === row.optionSymbol));
}
