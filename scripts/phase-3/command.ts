import { lstat, mkdir, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { z } from 'zod';
import { acquireMarketData, hashAcquisitionPlan, readAcquisitionRaw, readAcquisitionReceipts, sha256, type AcquisitionResult } from './acquisition';
import { phase3ApprovalSchema, seriesInventorySchema, validatePhase3Dataset } from './gates';
import { buildCostEstimate, buildRequestManifest, frozenProtocolCommit, manifestSha256, resolveChainRequests } from './manifest';
import { normalizeCorporateActionReview, normalizeMarketDataCandles, normalizeMarketDataChain, normalizePointInTimeSnapshot } from './observations';
import { phase3Protocol } from './protocol';

const p = phase3Protocol;
const requestManifest = buildRequestManifest();
const digest = manifestSha256(requestManifest);
const sha = z.string().regex(/^[a-f0-9]{64}$/u);
const stage = z.object({ planSha256: sha, maxRequests: z.number().int().positive(), maxCredits: z.number().int().positive() }).strict();
const accessSchema = z.object({
  authorization: phase3ApprovalSchema,
  acquisitionAndCostsApproved: z.literal(true),
  budget: z.object({ maxRequests: z.number().int().positive(), maxCredits: z.number().int().positive(), maxUsd: z.number().finite().nonnegative() }).strict(),
  candles: stage,
  chains: stage.optional(),
  evidenceFiles: z.array(z.string().min(1)).nonempty(),
}).strict();

const fileReference = z.object({ file: z.string().min(1), provider: z.string().min(1), retrievedAt: z.iso.datetime({ offset: true }),
  symbol: z.enum(p.symbols), sourceUrl: z.url() }).strict();
const licensedIndexSchema = z.object({
  preClose: z.array(fileReference.extend({ date: z.iso.date() })),
  corporateActions: z.array(fileReference),
  inventories: z.array(z.object({ file: z.string().min(1), provider: z.string().min(1), retrievedAt: z.iso.datetime({ offset: true }) }).strict()),
}).strict();

function inside(parent: string, path: string) {
  const name = relative(parent, path);
  return Boolean(name && !name.startsWith('..') && !isAbsolute(name));
}

async function privateRoot(location: string) {
  const cwd = await realpath(process.cwd());
  const work = resolve(cwd, 'work');
  const root = resolve(cwd, location);
  if (!inside(work, root)) throw new Error('Private research files must be under the ignored work directory.');
  await mkdir(root, { mode: 0o700, recursive: true });
  const info = await lstat(root);
  if (!info.isDirectory() || await realpath(root) !== root || (info.mode & 0o077) !== 0) {
    throw new Error('Use an ordinary private directory with mode 0700.');
  }
  return root;
}

async function readPrivate(root: string, filename: string) {
  const path = resolve(root, filename);
  if (!inside(root, path)) throw new Error('A private input escaped the research directory.');
  const stat = await lstat(path);
  if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > 32 * 1024 * 1024 || await realpath(path) !== path) {
    throw new Error('Use ordinary private input files with mode 0600 and at most 32 MiB per evidence file.');
  }
  return readFile(path);
}

function parseJson(bytes: Uint8Array): unknown {
  try { return JSON.parse(Buffer.from(bytes).toString('utf8')); }
  catch { throw new Error('A private input is not valid JSON.'); }
}

type Access = z.output<typeof accessSchema>;

async function readAccess(root: string, name: string) {
  let bytes: Uint8Array;
  try { bytes = await readPrivate(root, name); }
  catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
    throw new Error('No approved Phase 3 acquisition plan was supplied.');
  }
  const parsed = accessSchema.safeParse(parseJson(bytes));
  if (!parsed.success) throw new Error('Explicit plan, acquisition, cost, and provider approvals are required.');
  const access = parsed.data;
  const approval = access.authorization;
  const hashes = await Promise.all(access.evidenceFiles.map(async (file) => sha256(await readPrivate(root, file))));
  const now = new Date().toISOString();
  const quotas = [access.candles, ...(access.chains ? [access.chains] : [])];
  if (approval.protocolCommit !== frozenProtocolCommit || approval.requestManifestSha256 !== digest
    || Date.parse(approval.approvedAt) > Date.parse(now) || !hashes.includes(approval.evidenceSha256)
    || approval.providers.some((grant) => !hashes.includes(grant.evidenceSha256) || Date.parse(grant.retainForResearchUntil) < Date.parse(now))
    || quotas.reduce((sum, quota) => sum + quota.maxRequests, 0) > access.budget.maxRequests
    || quotas.reduce((sum, quota) => sum + quota.maxCredits, 0) > access.budget.maxCredits) {
    throw new Error('Authorization evidence, frozen plan, retention dates, or combined limits did not match.');
  }
  return { access, hashes };
}

function requireMarketDataScope(access: Access, roles: ('candles' | 'signal' | 'fill')[]) {
  const from = roles.includes('candles') ? p.warmupStartDate : p.startDate;
  const to = roles.includes('candles') ? p.cutoffDate : requestManifest.signals.at(-1)!.entryDate;
  const grant = access.authorization.providers.find((item) => item.provider === 'Market Data');
  if (!grant || grant.historicalFrom > from || grant.historicalTo < to || roles.some((role) => !grant.roles.includes(role))) {
    throw new Error('Market Data scope does not cover the requested dates and roles.');
  }
}

function complete(result: AcquisitionResult, count: number, approvedAt: string) {
  if (result.acquisitionClass !== 'provider' || result.unresolvedReservations || result.receipts.length !== count
    || result.receipts.some((row) => Date.parse(row.retrievedAt) < Date.parse(approvedAt))) {
    throw new Error('The approved provider batch is missing, incomplete, uncertain, or contains mock inputs.');
  }
}

async function readCandles(root: string, approvedAt: string) {
  const requests = requestManifest.candles;
  const cacheDirectory = resolve(root, 'candles');
  const result = await readAcquisitionReceipts({ requests, cacheDirectory });
  complete(result, requests.length, approvedAt);
  const packs = await Promise.all(requests.map(async (request) => {
    const receipt = result.receipts.find(({ id }) => id === request.id)!;
    const raw = await readAcquisitionRaw({ cacheDirectory, receipt });
    return normalizeMarketDataCandles(raw, { requestedSymbol: request.symbol, requestedFrom: request.from, requestedTo: request.to,
      sourceUrl: receipt.url, retrievedAt: receipt.retrievedAt, rawSha256: receipt.rawSha256 });
  }));
  if (packs.some(({ issues, rows }) => issues.length > 0 || rows.length !== requestManifest.closeDates.length
      || rows.some((row, i) => row.session !== requestManifest.closeDates[i]))) {
    throw new Error('Consecutive warm-up and settlement candle coverage failed.');
  }
  return { packs, result, requests: resolveChainRequests(packs.flatMap(({ rows }) => rows.map(({ symbol, session, close }) => ({ symbol, date: session, close })))) };
}

function budgetSummary(result: AcquisitionResult) {
  return { planSha256: result.planSha256, requestsSent: result.requestsSent, creditsConsumed: result.creditsConsumed,
    unresolvedReservations: result.unresolvedReservations, completeReceipts: result.receipts.length };
}

export async function runPhase3(command: string, options: { privateDirectory: string; approvalFile: string; licensedIndex: string; token?: string }) {
  if (command === 'manifest') return requestManifest;
  if (command === 'cost') return buildCostEstimate();
  if (command === 'fingerprints') return { protocolCommit: frozenProtocolCommit, requestManifestSha256: digest,
    candlesPlanSha256: hashAcquisitionPlan(requestManifest.candles) };
  if (!['acquire-candles', 'prepare-chains', 'acquire-chains', 'validate'].includes(command)) throw new Error('Unknown Phase 3 command.');
  const root = await privateRoot(options.privateDirectory);
  const { access, hashes } = await readAccess(root, options.approvalFile);
  const { approvedAt } = access.authorization;
  requireMarketDataScope(access, ['candles']);
  if (command === 'acquire-candles') {
    const result = await acquireMarketData({ requests: requestManifest.candles, approval: access.candles,
      cacheDirectory: resolve(root, 'candles'), token: options.token });
    return budgetSummary(result);
  }

  const candles = await readCandles(root, approvedAt);
  const requests = candles.requests;
  if (command === 'prepare-chains') {
    return { protocolCommit: frozenProtocolCommit, requestManifestSha256: digest, planSha256: hashAcquisitionPlan(requests),
      requests: requests.length, reservedCredits: requests.reduce((sum, item) => sum + item.reservedCredits, 0) };
  }

  requireMarketDataScope(access, ['signal', 'fill']);
  if (!access.chains || access.chains.planSha256 !== hashAcquisitionPlan(requests)) throw new Error('The exact derived chain plan requires explicit approval.');
  const cacheDirectory = resolve(root, 'chains');
  if (command === 'acquire-chains') {
    const plannedById = new Map(requests.map((request) => [request.id, request]));
    const result = await acquireMarketData({ requests, approval: access.chains, cacheDirectory, token: options.token,
      validateResponse: (receipt, raw) => {
        const request = plannedById.get(receipt.id)!;
        const pack = normalizeMarketDataChain(raw, { requestedSymbol: request.symbol, requestedDate: request.date,
          sourceUrl: receipt.url, retrievedAt: new Date().toISOString(), rawSha256: sha256(JSON.stringify(raw)) });
        if (pack.issues.some(({ code }) => code !== 'empty')) throw new Error('An option response failed normalized coverage checks.');
      } });
    return budgetSummary(result);
  }

  const chains = await readAcquisitionReceipts({ requests, cacheDirectory });
  complete(chains, requests.length, approvedAt);
  const plannedById = new Map(requests.map((request) => [request.id, request]));
  const chainPacks = [];
  for (const receipt of chains.receipts) {
    const request = plannedById.get(receipt.id)!;
    chainPacks.push({ role: request.role, pack: normalizeMarketDataChain(await readAcquisitionRaw({ cacheDirectory, receipt }), {
      requestedSymbol: request.symbol, requestedDate: request.date, sourceUrl: receipt.url,
      retrievedAt: receipt.retrievedAt, rawSha256: receipt.rawSha256,
    }) });
  }
  const index = licensedIndexSchema.parse(parseJson(await readPrivate(root, options.licensedIndex)));
  const verifiedRawSha256s = [...hashes, ...[...candles.result.receipts, ...chains.receipts].map(({ rawSha256 }) => rawSha256)];
  const readArtifact = async (file: string) => {
    const bytes = await readPrivate(root, file);
    const rawSha256 = sha256(bytes);
    verifiedRawSha256s.push(rawSha256);
    return { raw: parseJson(bytes), rawSha256 };
  };
  const preCloseSnapshots = [];
  for (const row of index.preClose) {
    const { raw, rawSha256 } = await readArtifact(row.file);
    preCloseSnapshots.push(normalizePointInTimeSnapshot(raw, {
      provider: row.provider, requestedDate: row.date, requestedSymbol: row.symbol, sourceUrl: row.sourceUrl, retrievedAt: row.retrievedAt, rawSha256,
    }));
  }
  const corporateActions = [];
  for (const row of index.corporateActions) {
    const { raw, rawSha256 } = await readArtifact(row.file);
    corporateActions.push(normalizeCorporateActionReview(raw, {
      provider: row.provider, requestedSymbol: row.symbol, sourceUrl: row.sourceUrl, retrievedAt: row.retrievedAt, rawSha256,
    }));
  }
  const inventories = [];
  for (const row of index.inventories) {
    const { raw, rawSha256 } = await readArtifact(row.file);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid listed-series input.');
    inventories.push(seriesInventorySchema.parse({ ...raw, provenance: { provider: row.provider, actualRetrievedAt: row.retrievedAt, rawSha256 } }));
  }
  return validatePhase3Dataset({ approval: access.authorization, protocolCommit: frozenProtocolCommit,
    requestManifestSha256: digest, verifiedRawSha256s, verifiedAt: new Date().toISOString(), dataset: {
      acquisitionClass: 'observed', candles: candles.packs, corporateActions, inventories, preCloseSnapshots,
      signalChains: chainPacks.filter(({ role }) => role === 'signal').map(({ pack }) => pack),
      fillChains: chainPacks.filter(({ role }) => role === 'fill').map(({ pack }) => pack),
    } });
}
