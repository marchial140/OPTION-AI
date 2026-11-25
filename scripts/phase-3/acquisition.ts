import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { z } from 'zod';

export interface AcquisitionRequest {
  id: string;
  url: string;
  reservedCredits: number;
}

export interface AcquisitionApproval {
  planSha256: string;
  maxRequests: number;
  maxCredits: number;
}

type FailureCode = 'invalid_plan' | 'approval_required' | 'cache_busy' | 'cache_integrity' | 'budget_exhausted'
  | 'billing_uncertain' | 'credit_overrun' | 'rate_limited' | 'entitlement' | 'invalid_response';

export class AcquisitionError extends Error {
  readonly code: FailureCode;
  readonly retryAt?: string;

  constructor(code: FailureCode, message: string, retryAt?: string) {
    super(message);
    this.name = 'AcquisitionError';
    this.code = code;
    this.retryAt = retryAt;
  }
}

interface MockClient {
  fetch: typeof fetch;
  now?: () => Date;
}

interface CacheOptions {
  requests: readonly AcquisitionRequest[];
  cacheDirectory: string;
}

interface AcquireOptions extends CacheOptions {
  approval?: AcquisitionApproval;
  token?: string;
  client?: MockClient;
  validateResponse?: (request: AcquisitionRequest, json: unknown) => void | Promise<void>;
}

const provider = 'marketdata.app';
const origin = 'https://api.marketdata.app';
const maxBodyBytes = 16 * 1024 * 1024;
const maxJournalBytes = 16 * 1024 * 1024;
const dayMs = 86_400_000;
const sha = z.string().regex(/^[0-9a-f]{64}$/u);
const iso = z.iso.datetime();
const acquisitionClassSchema = z.enum(['provider', 'mock']);
const nonnegativeInteger = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

const resultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('complete'), httpStatus: z.union([z.literal(200), z.literal(203), z.literal(404)]),
    retrievedAt: iso, creditsConsumed: nonnegativeInteger, rawSha256: sha, rawBytes: nonnegativeInteger }),
  z.object({ status: z.enum(['rate_limited', 'entitlement', 'invalid_response', 'credit_overrun']),
    httpStatus: z.number().int().min(200).max(599), retrievedAt: iso, creditsConsumed: nonnegativeInteger,
    retryAt: iso.optional() }),
  z.object({ status: z.literal('billing_uncertain'), httpStatus: z.number().int().min(200).max(599).optional(), retrievedAt: iso.optional() }),
]);

const journalSchema = z.object({
  version: z.literal(1), planSha256: sha, acquisitionClass: acquisitionClassSchema,
  attempts: z.array(z.object({ requestId: z.string(), url: z.string(), reservedCredits: nonnegativeInteger,
    reservedAt: iso, result: resultSchema.nullable() })),
});
type Journal = z.infer<typeof journalSchema>;
type JournalAttempt = Journal['attempts'][number];

export interface AcquisitionReceipt {
  id: string;
  url: string;
  provider: typeof provider;
  rawSha256: string;
  rawFile: string;
  rawBytes: number;
  retrievedAt: string;
  httpStatus: 200 | 203 | 404;
  creditsConsumed: number;
  acquisitionClass: 'provider' | 'mock';
}

export interface AcquisitionResult {
  planSha256: string;
  acquisitionClass: 'provider' | 'mock' | null;
  requestsSent: number;
  creditsConsumed: number;
  unresolvedReservations: number;
  receipts: AcquisitionReceipt[];
}

export const sha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');

function instantOfDay(value: string | null) {
  if (!value || !z.iso.date().safeParse(value).success) throw new AcquisitionError('invalid_plan', 'Require explicit ISO dates.');
  return Date.parse(`${value}T00:00:00.000Z`);
}

function exactQuery(url: URL, names: string[]) {
  return [...url.searchParams.keys()].length === names.length && names.every((key) => url.searchParams.getAll(key).length === 1);
}

function maximumRecords(url: URL) {
  const query = url.searchParams;
  if (url.origin !== origin || url.username || url.password || url.hash || query.get('dateformat') !== 'unix') {
    throw new AcquisitionError('invalid_plan', 'Only credential-free Market Data historical HTTPS URLs are accepted.');
  }
  if (/^\/v1\/stocks\/candles\/D\/[A-Z][A-Z0-9.]{0,9}\/$/u.test(url.pathname)
    && exactQuery(url, ['from', 'to', 'adjustsplits', 'adjustdividends', 'dateformat'])
    && query.get('adjustsplits') === 'false' && query.get('adjustdividends') === 'false') {
    const span = (instantOfDay(query.get('to')) - instantOfDay(query.get('from'))) / dayMs + 1;
    if (span > 0 && span <= 1000) return span;
  }
  if (/^\/v1\/options\/chain\/[A-Z][A-Z0-9.]{0,9}\/$/u.test(url.pathname)
    && exactQuery(url, ['date', 'from', 'to', 'strike', 'nonstandard', 'dateformat', 'limit']) && query.get('nonstandard') === 'false') {
    const date = instantOfDay(query.get('date'));
    const from = instantOfDay(query.get('from'));
    const to = instantOfDay(query.get('to'));
    const limit = query.get('limit')!;
    const strikePattern = /^\d{1,8}(?:\.\d{1,2})?-\d{1,8}(?:\.\d{1,2})?$/u;
    const strike = query.get('strike')!;
    const [low, high] = strike.split('-').map(Number);
    if (date < from && from <= to && to - date <= 30 * dayMs && /^[1-9]\d{0,3}$/u.test(limit)
      && Number(limit) <= 4001 && strikePattern.test(strike) && low > 0 && high >= low) return Number(limit);
  }
  throw new AcquisitionError('invalid_plan', 'Request does not fit a supported bounded historical query.');
}

function requestPlan(requests: readonly AcquisitionRequest[]) {
  const byId = new Map<string, AcquisitionRequest>();
  const creditsByUrl = new Map<string, number>();
  for (const { id, url, reservedCredits } of requests) {
    if (!/^[a-zA-Z0-9_.:-]{1,120}$/u.test(id)) throw new AcquisitionError('invalid_plan', 'Invalid request identifier.');
    let parsed: URL;
    try { parsed = new URL(url); } catch { throw new AcquisitionError('invalid_plan', 'Invalid historical request URL.'); }
    const records = maximumRecords(parsed);
    if (!Number.isSafeInteger(reservedCredits) || reservedCredits < Math.ceil(records / 1000)) {
      throw new AcquisitionError('invalid_plan', 'The reserved credits are below the historical request bounds.');
    }
    parsed.searchParams.sort();
    const canonical = parsed.href;
    const old = byId.get(id);
    const oldCredits = creditsByUrl.get(canonical);
    if ((old && old.url !== canonical) || (oldCredits !== undefined && oldCredits !== reservedCredits)) {
      throw new AcquisitionError('invalid_plan', 'Conflicting duplicate manifest request.');
    }
    byId.set(id, { id, url: canonical, reservedCredits });
    creditsByUrl.set(canonical, reservedCredits);
  }
  return [...byId.values()].sort((a, b) => a.id < b.id ? -1 : Number(a.id > b.id));
}

export function hashAcquisitionPlan(requests: readonly AcquisitionRequest[]) {
  return sha256(JSON.stringify(requestPlan(requests)));
}

function absent(error: unknown) {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}

async function inspectPrivateDirectory(path: string) {
  let stat;
  try { stat = await lstat(path); } catch (error) { if (absent(error)) return false; throw error; }
  if (!stat.isDirectory() || (stat.mode & 0o077) !== 0) {
    throw new AcquisitionError('cache_integrity', 'Use a dedicated private acquisition directory with mode 0700.');
  }
  return true;
}

async function readPrivate(path: string, byteLimit: number) {
  let stat;
  try { stat = await lstat(path); } catch (error) { if (absent(error)) return null; throw error; }
  if (!stat.isFile() || stat.size > byteLimit || (stat.mode & 0o077) !== 0) {
    throw new AcquisitionError('cache_integrity', 'An acquisition file exceeds its bounds or is not private.');
  }
  return await readFile(path);
}

async function durablePrivateWrite(path: string, contents: string | Uint8Array) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(contents); await file.sync(); } finally { await file.close(); }
    await rename(temporary, path);
    const parent = await open(dirname(path), 'r');
    try { await parent.sync(); } finally { await parent.close(); }
  } finally {
    await rm(temporary, { force: true });
  }
}

function decodeJson(bytes: Uint8Array): unknown {
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

function journalPath(directory: string) {
  return join(directory, 'acquisition-journal.json');
}

async function readJournal(directory: string, planSha256: string, plan: AcquisitionRequest[]) {
  const bytes = await readPrivate(journalPath(directory), maxJournalBytes);
  if (!bytes) return null;
  let journal: Journal;
  try { journal = journalSchema.parse(decodeJson(bytes)); } catch { throw new AcquisitionError('cache_integrity', 'Invalid acquisition journal.'); }
  const plannedById = new Map(plan.map((request) => [request.id, request]));
  const completed = new Set<string>();
  for (const attempt of journal.attempts) {
    const expected = plannedById.get(attempt.requestId);
    if (!expected || expected.url !== attempt.url || expected.reservedCredits !== attempt.reservedCredits || completed.has(attempt.url)) {
      throw new AcquisitionError('cache_integrity', 'Acquisition journal contains inconsistent request records.');
    }
    if (attempt.result?.status === 'complete') completed.add(attempt.url);
  }
  if (journal.planSha256 !== planSha256) throw new AcquisitionError('cache_integrity', 'Acquisition cache belongs to a different plan.');
  return journal;
}

const rawFilename = (url: string) => `${sha256(url)}.json`;

async function verifiedBytes(directory: string, receipt: AcquisitionReceipt) {
  if (receipt.rawFile !== rawFilename(receipt.url) || basename(receipt.rawFile) !== receipt.rawFile) {
    throw new AcquisitionError('cache_integrity', 'Unexpected raw response filename.');
  }
  const raw = await readPrivate(join(directory, receipt.rawFile), maxBodyBytes);
  if (!raw || receipt.rawBytes !== raw.byteLength || sha256(raw) !== receipt.rawSha256) {
    throw new AcquisitionError('cache_integrity', 'Raw response checksum or length differs from its receipt.');
  }
  return raw;
}

export async function readAcquisitionRaw({ cacheDirectory, receipt }: { cacheDirectory: string; receipt: AcquisitionReceipt }): Promise<unknown> {
  if (!await inspectPrivateDirectory(cacheDirectory)) throw new AcquisitionError('cache_integrity', 'Acquisition cache is missing.');
  const bytes = await verifiedBytes(cacheDirectory, receipt);
  try { return decodeJson(bytes); } catch { throw new AcquisitionError('cache_integrity', 'Raw response is not valid JSON.'); }
}

async function summarize(directory: string, plan: AcquisitionRequest[], planSha256: string, journal: Journal | null): Promise<AcquisitionResult> {
  const receipts: AcquisitionReceipt[] = [];
  const completeByUrl = new Map(journal?.attempts.filter((attempt) => attempt.result?.status === 'complete').map((attempt) => [attempt.url, attempt]));
  for (const { url, id } of plan) {
    const result = completeByUrl.get(url)?.result;
    if (journal && result?.status === 'complete') {
      const { retrievedAt, creditsConsumed, rawSha256, rawBytes, httpStatus } = result;
      const receipt = { id, url, provider, rawFile: rawFilename(url), rawSha256, rawBytes, retrievedAt, httpStatus,
        creditsConsumed, acquisitionClass: journal.acquisitionClass } as const;
      await verifiedBytes(directory, receipt);
      receipts.push(receipt);
    }
  }
  return { planSha256, acquisitionClass: journal?.acquisitionClass ?? null, requestsSent: journal?.attempts.length ?? 0,
    creditsConsumed: journal?.attempts.reduce((total, { result }) => total + (result && 'creditsConsumed' in result ? result.creditsConsumed : 0), 0) ?? 0,
    unresolvedReservations: journal?.attempts.reduce((total, { result, reservedCredits }) => (
      total + (!result || result.status === 'billing_uncertain' ? reservedCredits : 0)
    ), 0) ?? 0,
    receipts };
}

export async function readAcquisitionReceipts({ requests, cacheDirectory }: CacheOptions): Promise<AcquisitionResult> {
  const plan = requestPlan(requests);
  const planSha256 = hashAcquisitionPlan(plan);
  const journal = await inspectPrivateDirectory(cacheDirectory) ? await readJournal(cacheDirectory, planSha256, plan) : null;
  return summarize(cacheDirectory, plan, planSha256, journal);
}

const integerHeader = (value: string | null): number | null => (
  value !== null && /^(?:0|[1-9]\d*)$/u.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : null
);

function retryTimestamp(headers: Headers, now: Date) {
  const after = headers.get('retry-after');
  const delay = integerHeader(after);
  const reset = integerHeader(headers.get('x-api-ratelimit-reset'));
  const retryAt = Math.max(delay !== null ? now.getTime() + 1000 * delay : Date.parse(after ?? '') || 0, (reset ?? 0) * 1000);
  return Number.isFinite(new Date(retryAt).getTime()) && retryAt > now.getTime()
    ? new Date(retryAt).toISOString() : new Date(now.getTime() + 60_000).toISOString();
}

function claimedCredits(response: Response) {
  const value = response.headers.get('x-api-ratelimit-consumed');
  // Market Data documents that only 200/203 can be billed, including when 429 omits its consumption header.
  return value === null && response.status !== 200 && response.status !== 203 ? 0 : integerHeader(value);
}

async function boundedBody(response: Response) {
  const size = integerHeader(response.headers.get('content-length'));
  if ((size ?? 0) > maxBodyBytes || !response.body) throw new AcquisitionError('invalid_response', 'Response is empty or exceeds the byte cap.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return Buffer.concat(chunks, bytes);
      bytes += value.byteLength;
      if (bytes > maxBodyBytes) throw new AcquisitionError('invalid_response', 'Response exceeded the byte cap.');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function validateBoundedResponse(request: AcquisitionRequest, data: unknown, httpStatus: number) {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) throw new Error('Not a historical response.');
  const payload = data as Record<string, unknown>;
  const history = new URL(request.url).pathname.startsWith('/v1/options/') ? payload.optionSymbol : payload.t;
  if (payload.s === 'no_data' && (history === undefined || (Array.isArray(history) && history.length === 0))) return;
  if (httpStatus === 404 || payload.s !== 'ok' || !Array.isArray(history) || history.length === 0
    || history.length > maximumRecords(new URL(request.url))) {
    throw new Error('Invalid historical response status or record count.');
  }
}

function previousStateError(attempts: JournalAttempt[], now: Date) {
  for (const { result } of attempts) {
    if (!result || result.status === 'billing_uncertain') {
      throw new AcquisitionError('billing_uncertain', 'Reconcile the unresolved request reservation before resuming acquisition.');
    }
    if (result.status === 'credit_overrun' || result.status === 'invalid_response') {
      throw new AcquisitionError(result.status, 'A previous response needs manual reconciliation before acquisition can resume.');
    }
    if (result.status === 'rate_limited' && result.retryAt && Date.parse(result.retryAt) > now.getTime()) {
      throw new AcquisitionError('rate_limited', 'Provider retry window has not elapsed.', result.retryAt);
    }
  }
}

async function fetchAttempt(request: AcquisitionRequest, fetcher: typeof fetch, now: () => Date, token: string | undefined,
  validateResponse: AcquireOptions['validateResponse'], directory: string): Promise<NonNullable<JournalAttempt['result']>> {
  const headers = new Headers({ Accept: 'application/json' });
  if (token) headers.set('Authorization', `Bearer ${token}`);
  let response: Response;
  try {
    response = await fetcher(request.url, { method: 'GET', redirect: 'error', cache: 'no-store', credentials: 'omit', headers,
      signal: AbortSignal.timeout(45_000) });
  } catch {
    return { status: 'billing_uncertain' };
  }
  try {
    const observedAt = now();
    const httpStatus = response.status;
    const base = { httpStatus, retrievedAt: observedAt.toISOString() };
    const credits = claimedCredits(response);
    if (credits === null) return { ...base, status: 'billing_uncertain' };
    const accounted = { ...base, creditsConsumed: credits };
    if (credits > request.reservedCredits) return { ...accounted, status: 'credit_overrun' };
    if (httpStatus === 429) return { ...accounted, status: 'rate_limited', retryAt: retryTimestamp(response.headers, observedAt) };
    if (httpStatus === 401 || httpStatus === 402 || httpStatus === 403) return { ...accounted, status: 'entitlement' };
    if (httpStatus !== 200 && httpStatus !== 203 && httpStatus !== 404) return { ...accounted, status: 'invalid_response' };

    let raw: Buffer;
    let retrievedAt: string;
    try {
      raw = await boundedBody(response);
      retrievedAt = now().toISOString();
      const json = decodeJson(raw);
      validateBoundedResponse(request, json, httpStatus);
      await validateResponse?.(request, json);
    } catch {
      return { ...accounted, status: 'invalid_response' };
    }
    await durablePrivateWrite(join(directory, rawFilename(request.url)), raw);
    return { status: 'complete', httpStatus, retrievedAt, creditsConsumed: credits, rawSha256: sha256(raw), rawBytes: raw.byteLength };
  } finally {
    await response.body?.cancel().catch(() => undefined);
  }
}

export async function acquireMarketData({ requests, approval, cacheDirectory, token, client, validateResponse }: AcquireOptions): Promise<AcquisitionResult> {
  const plan = requestPlan(requests);
  const planSha256 = hashAcquisitionPlan(plan);
  if (!approval || approval.planSha256 !== planSha256 || !Number.isSafeInteger(approval.maxRequests) || approval.maxRequests < 0
    || !Number.isSafeInteger(approval.maxCredits) || approval.maxCredits < 0) {
    throw new AcquisitionError('approval_required', 'Explicit approval of the exact acquisition plan and both limits is required.');
  }
  if ((!client && !token) || (token !== undefined && !/^[\x21-\x7e]{1,4096}$/u.test(token))) {
    throw new AcquisitionError('approval_required', 'A valid explicit provider credential is required for network acquisition.');
  }
  if (!(await inspectPrivateDirectory(cacheDirectory))) await mkdir(cacheDirectory, { recursive: true, mode: 0o700 });
  await inspectPrivateDirectory(cacheDirectory);
  const lockPath = join(cacheDirectory, 'acquisition.lock');
  const lock = await open(lockPath, 'wx', 0o600).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'EEXIST') throw new AcquisitionError('cache_busy', 'Acquisition is running or its lock needs manual crash recovery.');
    throw error;
  });
  try {
    const acquisitionClass = client ? 'mock' : 'provider';
    const now = client?.now ?? (() => new Date());
    const journal = await readJournal(cacheDirectory, planSha256, plan) ?? { version: 1, planSha256, acquisitionClass, attempts: [] };
    if (journal.acquisitionClass !== acquisitionClass) throw new AcquisitionError('cache_integrity', 'Mock and provider responses require separate caches.');
    previousStateError(journal.attempts, now());
    const prior = await summarize(cacheDirectory, plan, planSha256, journal);
    let charged = prior.creditsConsumed;
    const complete = new Set(prior.receipts.map(({ url }) => url));
    if (journal.attempts.length > approval.maxRequests || charged > approval.maxCredits) {
      throw new AcquisitionError('budget_exhausted', 'Prior consumption already exceeds the currently approved limits.');
    }
    for (const request of plan) {
      if (complete.has(request.url)) continue;
      if (journal.attempts.length >= approval.maxRequests || request.reservedCredits > approval.maxCredits - charged) {
        throw new AcquisitionError('budget_exhausted', 'The next request exceeds an approved request or credit limit.');
      }
      const attempt: JournalAttempt = { requestId: request.id, url: request.url, reservedCredits: request.reservedCredits,
        reservedAt: now().toISOString(), result: null };
      journal.attempts.push(attempt);
      await durablePrivateWrite(journalPath(cacheDirectory), JSON.stringify(journal));
      const result = await fetchAttempt(request, client?.fetch ?? fetch, now, token, validateResponse, cacheDirectory);
      attempt.result = result;
      await durablePrivateWrite(journalPath(cacheDirectory), JSON.stringify(journal));
      if (result.status === 'complete') {
        complete.add(request.url);
        charged += result.creditsConsumed;
      } else {
        throw new AcquisitionError(result.status, result.status === 'entitlement'
          ? `Provider denied approved historical access (HTTP ${result.httpStatus}).`
          : `Historical acquisition stopped with ${result.status}.`, 'retryAt' in result ? result.retryAt : undefined);
      }
    }
    return summarize(cacheDirectory, plan, planSha256, journal);
  } finally {
    await lock.close();
    await rm(lockPath, { force: true });
  }
}
