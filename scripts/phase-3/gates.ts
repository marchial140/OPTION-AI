import { createHash } from 'node:crypto';
import Decimal from 'decimal.js';
import { z } from 'zod';
import { makeOccSymbol, optionTradingCutoff } from '../../src/lib/quant';
import { instant, prepareReturnHistory } from '../phase-2/history';
import { buildPhase2History, contractActionsThrough, type NormalizedActionReview, type NormalizedCandles,
  type NormalizedChain, type NormalizedQuote, type NormalizedSnapshot } from './observations';
import { addCalendarDays, buildStudyCalendar, nextStudySession, phase3Protocol as protocol,
  studyMorning, type SignalSchedule, type StudySymbol } from './protocol';

const roles = ['candles', 'signal', 'preclose', 'fill', 'series', 'corporate-actions'] as const;
type ProviderRole = typeof roles[number];
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const commitSchema = z.string().regex(/^[a-f0-9]{40}$/u);
const timestamp = z.iso.datetime({ offset: true }).refine((value) => Number.isFinite(instant(value)));
const label = z.string().trim().min(1).max(200);

export const phase3ApprovalSchema = z.object({
  status: z.literal('approved'),
  protocolCommit: commitSchema,
  requestManifestSha256: sha256Schema,
  timeline: z.literal(protocol.timeline.method),
  useScope: z.literal('private-internal-research'),
  approvedAt: timestamp,
  evidenceSha256: sha256Schema,
  providers: z.array(z.object({
    provider: label,
    roles: z.array(z.enum(roles)).nonempty(),
    historicalFrom: z.iso.date(),
    historicalTo: z.iso.date(),
    retainForResearchUntil: timestamp,
    evidenceSha256: sha256Schema,
  }).strict()).nonempty(),
}).strict();

export type Phase3Approval = z.infer<typeof phase3ApprovalSchema>;

export const seriesInventorySchema = z.object({
  symbol: z.enum(protocol.symbols),
  session: z.iso.date(),
  observedAt: timestamp,
  availableAt: timestamp,
  complete: z.literal(true),
  provenance: z.object({ provider: label, rawSha256: sha256Schema, actualRetrievedAt: timestamp }).strict(),
  rows: z.array(z.object({
    optionSymbol: z.string().min(1).max(32),
    strike: z.number().finite().positive(),
    expiration: z.iso.date(),
    type: z.enum(protocol.candidates.types),
    multiplier: z.literal(protocol.portfolio.multiplier),
    deliverable: z.literal('100-underlying-shares'),
  }).strict()).nonempty(),
  noBook: z.array(z.object({
    role: z.enum(['signal', 'preclose', 'fill']),
    optionSymbol: z.string().min(1).max(32),
    observedAt: timestamp,
    availableAt: timestamp,
    disposition: z.enum(['no-quote', 'halted']),
    evidence: label,
  }).strict()).optional(),
}).strict();

type SeriesInventory = z.infer<typeof seriesInventorySchema>;

export interface Phase3Dataset {
  acquisitionClass: 'observed' | 'mock';
  candles: readonly NormalizedCandles[];
  signalChains: readonly NormalizedChain[];
  preCloseSnapshots: readonly NormalizedSnapshot[];
  fillChains: readonly NormalizedChain[];
  inventories: readonly SeriesInventory[];
  corporateActions: readonly NormalizedActionReview[];
}

export interface Phase3GateInput {
  dataset: Phase3Dataset;
  approval: unknown;
  protocolCommit: string;
  requestManifestSha256: string;
  // This list comes from hashing the actual private inputs and approval files, not received file labels.
  verifiedRawSha256s: readonly string[];
  verifiedAt: string;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  const entries = Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
}

export const canonicalSha256 = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
const minute = 60_000;
const issueSampleLimit = 120;

function recordTime(observedAt: string, availableAt: string, retrievedAt: string, clock: number, latestAvailableAt: number) {
  const available = instant(availableAt);
  const retrieved = instant(retrievedAt);
  return instant(observedAt) === clock && Number.isFinite(clock) && available >= clock
    && available <= latestAvailableAt && retrieved >= available;
}

function inBand(strike: number, close: number) {
  const price = new Decimal(close);
  return new Decimal(strike).gte(price.mul(protocol.candidates.minStrikeRatio))
    && new Decimal(strike).lte(price.mul(protocol.candidates.maxStrikeRatio));
}

function inScope(row: Pick<NormalizedQuote, 'strike' | 'expiration'>, close: number, schedule: SignalSchedule) {
  return row.expiration >= addCalendarDays(schedule.signalDate, protocol.portfolio.minCalendarDte)
    && row.expiration <= schedule.latestExpiryDate && inBand(row.strike, close);
}

function goodContract(row: NormalizedQuote | SeriesInventory['rows'][number], symbol: StudySymbol) {
  if (row.deliverable !== '100-underlying-shares' || row.multiplier !== protocol.portfolio.multiplier
    || !(row.type === 'call' || row.type === 'put') || optionTradingCutoff(row.expiration) === null) return false;
  try { return row.optionSymbol === makeOccSymbol(symbol, row.expiration, row.type, row.strike); }
  catch { return false; }
}

function validCount(value: number | undefined) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function validQuote(row: NormalizedQuote, symbol: StudySymbol, session: string, available: number, needsSizes: boolean) {
  const nonnegative = (value: number) => Number.isFinite(value) && value >= 0;
  const liquidityAvailable = (value: number | undefined, time: string | undefined) => (
    value === undefined && time === undefined
  ) || (validCount(value) && typeof time === 'string' && instant(time) <= available);
  return row.symbol === symbol && row.session === session && row.currency === protocol.candidates.currency
    && row.observationKind === 'provider' && goodContract(row, symbol)
    && nonnegative(row.bid) && nonnegative(row.ask) && row.ask > 0 && row.bid <= row.ask
    && (!needsSizes || (validCount(row.bidSize) && validCount(row.askSize)))
    && liquidityAvailable(row.volume, row.volumeAvailableAt) && liquidityAvailable(row.openInterest, row.openInterestAvailableAt);
}

export function validatePhase3Dataset(input: Phase3GateInput) {
  const { dataset, requestManifestSha256, protocolCommit, verifiedAt } = input;
  const { closeDates, signals } = buildStudyCalendar();
  const issues: { code: string; scope: string; detail: string }[] = [];
  let issueCount = 0;
  const fail = (code: string, scope: string, detail: string) => {
    issueCount++;
    if (issues.length < issueSampleLimit) issues.push({ code, scope, detail });
  };
  const verificationTime = instant(verifiedAt);
  const raw = new Set(input.verifiedRawSha256s.filter((hash) => sha256Schema.safeParse(hash).success));
  const parsed = phase3ApprovalSchema.safeParse(input.approval);
  const approval = parsed.success ? parsed.data : undefined;
  const permissions = new Map(approval?.providers.map((grant) => [grant.provider, grant]) ?? []);
  if (!approval || !Number.isFinite(verificationTime) || !commitSchema.safeParse(protocolCommit).success
    || !sha256Schema.safeParse(requestManifestSha256).success || approval.requestManifestSha256 !== requestManifestSha256
    || approval.protocolCommit !== protocolCommit || !raw.has(approval.evidenceSha256) || instant(approval.approvedAt) > verificationTime
    || permissions.size !== approval.providers.length) fail('approval_invalid', 'study', 'Missing verified protocol, plan or authorization binding.');
  if (dataset.acquisitionClass !== 'observed') fail('mock_data', 'study', 'Synthetic input cannot authorize the historical evaluation.');

  type Provenance = { provider: string; rawSha256: string; actualRetrievedAt: string };
  const artifact = (role: ProviderRole, scope: string, p: Provenance, from: string, to: string) => {
    const retrieved = instant(p.actualRetrievedAt);
    const grant = permissions.get(p.provider);
    if (!raw.has(p.rawSha256) || !Number.isFinite(retrieved) || retrieved > verificationTime) {
      fail('artifact_unverified', scope, 'Missing raw checksum verification or valid actual retrieval time.');
    }
    if (!grant || !grant.roles.includes(role) || !raw.has(grant.evidenceSha256)
      || grant.historicalFrom > from || grant.historicalTo < to || instant(grant.retainForResearchUntil) < verificationTime
      || (approval !== undefined && retrieved < instant(approval.approvedAt))) {
      fail('entitlement_unverified', scope, 'Missing valid approval for the provider, dates, acquisition, or current private retention.');
    }
  };

  const index = <T,>(rows: readonly T[], label: string, scope: (row: T) => string) => {
    const result = new Map<string, T>();
    for (const row of rows) {
      const key = scope(row);
      if (result.has(key)) fail('duplicate_artifact', `${label}:${key}`, 'More than one input pack.');
      else result.set(key, row);
    }
    return result;
  };

  const candlesBySymbol = index(dataset.candles, 'candles', (pack) => pack.provenance.requestedSymbol);
  const reviewsBySymbol = index(dataset.corporateActions, 'corporate-actions', (pack) => pack.provenance.requestedSymbol);
  const pair = (symbol: string, date: string) => `${symbol}:${date}`;
  const byRequestedDate = (pack: NormalizedChain | NormalizedSnapshot) => pair(pack.provenance.requestedSymbol, pack.provenance.requestedDate);
  const signalByPair = index(dataset.signalChains, 'signal', byRequestedDate);
  const precloseByPair = index(dataset.preCloseSnapshots, 'preclose', byRequestedDate);
  const fillByPair = index(dataset.fillChains, 'fill', byRequestedDate);
  const inventories = index(dataset.inventories, 'series', (pack) => pair(pack.symbol, pack.session));
  const counts = { expectedCloses: closeDates.length * protocol.symbols.length, validCloses: 0,
    expectedPairs: signals.length * protocol.symbols.length, verifiedPairs: 0, knownAdjustmentLegs: 0 };
  const panelDigests = [
    ...dataset.candles.map((item) => ({ scope: `candles:${item.provenance.requestedSymbol}`, digest: canonicalSha256(item) })),
    ...dataset.corporateActions.map((item) => ({ scope: `actions:${item.provenance.requestedSymbol}`, digest: canonicalSha256(item) })),
    ...dataset.signalChains.map((item) => ({ scope: `signal:${byRequestedDate(item)}`, digest: canonicalSha256(item) })),
    ...dataset.preCloseSnapshots.map((item) => ({ scope: `preclose:${byRequestedDate(item)}`, digest: canonicalSha256(item) })),
    ...dataset.fillChains.map((item) => ({ scope: `fill:${byRequestedDate(item)}`, digest: canonicalSha256(item) })),
    ...dataset.inventories.map((item) => ({ scope: `inventory:${pair(item.symbol, item.session)}`, digest: canonicalSha256(item) })),
  ].sort((a, b) => `${a.scope}:${a.digest}`.localeCompare(`${b.scope}:${b.digest}`, 'en-US'));

  for (const symbol of protocol.symbols) {
    const candles = candlesBySymbol.get(symbol);
    const review = reviewsBySymbol.get(symbol);
    const closes = new Map<number, number>();
    if (!candles || candles.kind !== 'candles') fail('missing_candles', symbol, 'Underlying candle pack is required.');
    else {
      const { provenance, rows } = candles;
      artifact('candles', symbol, provenance, protocol.warmupStartDate, protocol.cutoffDate);
      if (provenance.requestedFrom !== protocol.warmupStartDate || provenance.requestedTo !== protocol.cutoffDate
        || candles.issues.length || rows.length !== closeDates.length) {
        fail('candle_coverage', symbol, 'Underlying observations must match the exact consecutive session set.');
      }
      const bySession = index(rows, `candle:${symbol}`, ({ session }) => session);
      for (const session of closeDates) {
        const row = bySession.get(session);
        const clock = optionTradingCutoff(session)!;
        const available = clock + protocol.timeline.stockAvailabilityLagMinutes * minute;
        if (!row || row.symbol !== symbol || row.basis !== 'as-traded-non-dividend-adjusted'
          || !Number.isFinite(row.close) || row.close <= 0 || instant(row.availability.at) !== available
          || row.availability.kind !== 'reconstructed' || (session === protocol.cutoffDate && available > instant(protocol.cutoffAt))
          || !recordTime(row.observedAt, row.availability.at, provenance.actualRetrievedAt, clock, available)) {
          fail('candle_invalid', `${symbol}:${session}`, 'Missing or inconsistent regular close and availability evidence.');
          continue;
        }
        closes.set(Date.parse(session), row.close);
        counts.validCloses++;
      }
    }
    if (!review || review.kind !== 'corporate-actions' || !review.complete || review.reviewedFrom > protocol.warmupStartDate
      || review.reviewedTo < protocol.cutoffDate) fail('missing_actions', symbol, 'Complete corporate-action review is required through settlement.');
    else {
      artifact('corporate-actions', symbol, review.provenance, protocol.warmupStartDate, protocol.cutoffDate);
    }

    for (const schedule of signals) {
      const { signalDate, signalAt, entryDate, revalidationObservedAt, orderAt, fillAt } = schedule;
      const signalKey = pair(symbol, signalDate);
      const entryKey = pair(symbol, entryDate);
      const signal = signalByPair.get(signalKey);
      const preclose = precloseByPair.get(entryKey);
      const fill = fillByPair.get(entryKey);
      const foundInventory = seriesInventorySchema.safeParse(inventories.get(signalKey));
      const before = issueCount;
      const spot = closes.get(Date.parse(signalDate));
      if (candles && review && closes.size === closeDates.length) {
        for (const asOf of [signalAt, orderAt]) {
          try {
            const now = new Date(asOf);
            const history = buildPhase2History(candles, review, now);
            const check = prepareReturnHistory(history, symbol, now);
            if (check.status !== 'ok') fail('history_unavailable', signalKey, check.reason);
          } catch (error) {
            fail('history_unavailable', signalKey, error instanceof Error ? error.message : 'Price basis could not be validated.');
          }
        }
      } else fail('history_unavailable', signalKey, 'Required close or corporate-action coverage is incomplete.');
      if (!signal || !preclose || !fill || signal.kind !== 'chain' || preclose.kind !== 'intraday' || fill.kind !== 'chain'
        || spot === undefined || !foundInventory.success) {
        fail('pair_incomplete', signalKey, 'Signal, pre-close, fill, spot, and certified series inventory must all be present.');
        continue;
      }
      const inventory = foundInventory.data;
      artifact('series', signalKey, inventory.provenance, signalDate, signalDate);
      const signalClose = optionTradingCutoff(signalDate)!;
      if (!recordTime(inventory.observedAt, inventory.availableAt, inventory.provenance.actualRetrievedAt, signalClose, instant(signalAt))) {
        fail('series_clock', signalKey, 'Certified inventory must describe listings at the signal date and be available before selection.');
      }
      const expectedIds = new Set<string>();
      for (const row of inventory.rows) {
        if (!inScope(row, spot, schedule) || !goodContract(row, symbol) || expectedIds.has(row.optionSymbol)) {
          fail('series_invalid', signalKey, 'Certified series must be unique, standard, and in the frozen price and expiration band.');
        } else expectedIds.add(row.optionSymbol);
      }
      const observedSpot = instant(revalidationObservedAt);
      if (preclose.spot.symbol !== symbol || preclose.spot.session !== entryDate || preclose.spot.availability.kind !== 'observed'
        || preclose.spot.observationKind !== 'provider' || preclose.spot.basis !== 'as-traded-non-dividend-adjusted'
        || !Number.isFinite(preclose.spot.price) || preclose.spot.price <= 0
        || !recordTime(preclose.spot.observedAt, preclose.spot.availability.at, preclose.provenance.actualRetrievedAt, observedSpot, instant(orderAt))) {
        fail('preclose_spot_invalid', entryKey, 'The actual pre-close spot and its point-in-time availability are required.');
      }

      for (const stage of [
        { role: 'signal', pack: signal, session: signalDate, clock: signalClose, available: instant(signalAt), reconstructed: studyMorning(entryDate, 31) },
        { role: 'preclose', pack: preclose, session: entryDate, clock: observedSpot, available: instant(orderAt), reconstructed: null },
        { role: 'fill', pack: fill, session: entryDate, clock: instant(fillAt),
          available: instant(protocol.cutoffAt), reconstructed: studyMorning(nextStudySession(entryDate), 31) },
      ] as const) {
        const { role, pack, session, clock, available, reconstructed } = stage;
        const scope = `${role}:${signalKey}`;
        artifact(role, scope, pack.provenance, session, session);
        if (pack.issues.some(({ code }) => code !== 'empty') || pack.rawRows >= protocol.candidates.rowLimitSentinel) {
          fail('stage_incomplete', scope, 'The options payload is quarantined or truncated.');
        }
        // Entry data can include newly listed series. They cannot amend the signal-side universe.
        const relevant = pack.rows.filter((row) => role === 'signal' ? inScope(row, spot, schedule) : expectedIds.has(row.optionSymbol));
        const rows = index(relevant, scope, ({ optionSymbol }) => optionSymbol);
        for (const [id, row] of rows) {
          if (!expectedIds.has(id)) fail('series_mismatch', scope, `Option missing from certified signal inventory: ${id}.`);
          const kind = reconstructed === null ? 'observed' : 'reconstructed';
          const validAvailability = row.availability.kind === kind && row.availability.evidence.length > 0
            && (reconstructed === null || instant(row.availability.at) === instant(reconstructed));
          if (!validAvailability || !recordTime(row.observedAt, row.availability.at, pack.provenance.actualRetrievedAt, clock, available)
            || !validQuote(row, symbol, session, available, role !== 'signal')) {
            fail('quote_invalid', scope, `Inconsistent quote, size, or timestamp for ${id}.`);
          }
          if (role === 'fill' && clock <= instant(orderAt)) fail('fill_leakage', scope, 'No order may use its later fill quote.');
          if (row.expiration > protocol.cutoffDate || !closes.has(Date.parse(row.expiration))) {
            fail('settlement_missing', scope, `No complete expiration settlement reference for ${id}.`);
          }
          if (role === 'signal' && review) {
            try {
              if (contractActionsThrough(review, row, new Date(signalAt)).length) counts.knownAdjustmentLegs++;
            } catch {
              fail('contract_action_unverified', scope, `No applicable corporate-action review through expiry for ${id}.`);
            }
          }
        }
        const resolvedNoBook = new Set<string>();
        for (const item of (inventory.noBook ?? []).filter((item) => item.role === role)) {
          const id = item.optionSymbol;
          artifact('series', scope, inventory.provenance, session, session);
          if (!expectedIds.has(id) || rows.has(id) || resolvedNoBook.has(id)
            || !recordTime(item.observedAt, item.availableAt, inventory.provenance.actualRetrievedAt, clock, available)) {
            fail('no_book_unverified', scope, `Contradictory or unproven no-book disposition for ${id}.`);
          } else resolvedNoBook.add(id);
        }
        for (const id of expectedIds) {
          if (!rows.has(id) && !resolvedNoBook.has(id)) fail('quote_missing', scope, `No quote or evidenced no-book disposition for ${id}.`);
        }
      }
      if (issueCount === before) counts.verifiedPairs++;
    }
  }
  if (candlesBySymbol.size !== protocol.symbols.length || reviewsBySymbol.size !== protocol.symbols.length
    || [signalByPair, precloseByPair, fillByPair, inventories].some((map) => map.size !== counts.expectedPairs)) {
    fail('panel_count', 'study', 'Panel scopes differ from the complete frozen universe and schedule.');
  }
  const datasetSha256 = canonicalSha256({ acquisitionClass: dataset.acquisitionClass, protocolCommit, requestManifestSha256,
    panelDigests });
  return { status: issueCount > 0 ? 'blocked' as const : 'ready' as const, issueCount, issues, counts, datasetSha256 };
}
