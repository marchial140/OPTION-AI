import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { acquireMarketData, hashAcquisitionPlan, readAcquisitionRaw, readAcquisitionReceipts, sha256,
  type AcquisitionRequest } from '../scripts/phase-3/acquisition';

const directoryPaths: string[] = [];
const destination = async () => {
  const path = await mkdtemp(join(tmpdir(), 'phase-3-acquisition-'));
  directoryPaths.push(path);
  return path;
};
afterEach(async () => {
  for (const path of directoryPaths.splice(0)) await rm(path, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const chainUrl = (symbol: string) => `https://api.marketdata.app/v1/options/chain/${symbol}/?date=2024-10-21&from=2024-10-28&to=2024-11-20&strike=80.00-120.00&nonstandard=false&dateformat=unix&limit=4001`;
const requests: AcquisitionRequest[] = [{ id: 'a', url: chainUrl('SPY'), reservedCredits: 5 }, { id: 'b', url: chainUrl('QQQ'), reservedCredits: 5 }];
const approved = (plan: AcquisitionRequest[], maxRequests = 10, maxCredits = 20) => ({ planSha256: hashAcquisitionPlan(plan), maxRequests, maxCredits });
const exampleBody = JSON.stringify({ s: 'ok', optionSymbol: ['SYNTHETIC'] });
const good = () => new Response(exampleBody, { status: 203, headers: { 'x-api-ratelimit-consumed': '1' } });

describe('approved historical acquisition', () => {
  it('requires explicit approval of the hashed manifest and credentials before using the network', async () => {
    const cacheDirectory = await destination();
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('must remain offline'));
    await expect(acquireMarketData({ requests, cacheDirectory })).rejects.toMatchObject({ code: 'approval_required' });
    await expect(acquireMarketData({ requests, cacheDirectory, approval: approved(requests) })).rejects.toMatchObject({ code: 'approval_required' });
    await expect(acquireMarketData({ requests, cacheDirectory, approval: approved(requests.slice(1)), token: 'example' }))
      .rejects.toMatchObject({ code: 'approval_required' });
    expect(fetch).not.toHaveBeenCalled();
    const result = await readAcquisitionReceipts({ requests, cacheDirectory });
    expect(result).toMatchObject({ requestsSent: 0, creditsConsumed: 0, receipts: [] });
  });

  it('rejects other hosts, unbounded or nonhistorical paths and embedded credentials before approval', () => {
    const request = requests[0];
    const unsafe = [request.url.replace('api.marketdata.app', 'example.test'), `${request.url}&token=example`,
      request.url.replace('limit=4001', 'limit=5000'), request.url.replace('date=2024-10-21&', ''),
      request.url.replace('nonstandard=false', 'nonstandard=true'), `${request.url}&date=2024-10-22`,
      request.url.replace('strike=80.00-120.00', 'strike=all')];
    for (const url of unsafe) expect(() => hashAcquisitionPlan([{ ...request, url }])).toThrow();
    expect(() => hashAcquisitionPlan([{ ...request, reservedCredits: 4 }])).toThrow(/credits/);
  });

  it('caches by URL, marks synthetic receipts, and reconciles identical requests across aliases and reruns', async () => {
    const cacheDirectory = await destination();
    const url = new URL(requests[0].url);
    url.searchParams.sort();
    const plan = [requests[0], { ...requests[0], id: 'alias', url: url.href }, requests[0]];
    expect(hashAcquisitionPlan(plan)).toEqual(hashAcquisitionPlan(plan.toReversed()));
    const fixed = new Date('2026-11-25T16:00:00Z');
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, options) => {
      expect(options?.redirect).toBe('error');
      expect(new Headers(options?.headers).get('Authorization')).toBeNull();
      const journal = JSON.parse(await readFile(join(cacheDirectory, 'acquisition-journal.json'), 'utf8'));
      expect(journal.attempts[0]).toMatchObject({ reservedCredits: 5, result: null });
      return good();
    });
    const run = { requests: plan, cacheDirectory, approval: approved(plan), client: { fetch, now: () => fixed } };
    const result = await acquireMarketData(run);
    expect(result).toMatchObject({ requestsSent: 1, creditsConsumed: 1, unresolvedReservations: 0, acquisitionClass: 'mock' });
    expect(result.receipts.map((receipt) => receipt.id)).toEqual(['a', 'alias']);
    expect(result.receipts[0]).toMatchObject({ retrievedAt: fixed.toISOString(), rawSha256: sha256(exampleBody), acquisitionClass: 'mock' });
    const { rawFile } = result.receipts[0];
    expect((await stat(join(cacheDirectory, rawFile))).mode & 0o777).toBe(0o600);
    expect(await readAcquisitionRaw({ cacheDirectory, receipt: result.receipts[0] })).toEqual(JSON.parse(exampleBody));
    expect(await acquireMarketData(run)).toEqual(result);
    expect(fetch).toHaveBeenCalledTimes(1);
    await writeFile(join(cacheDirectory, rawFile), '{}');
    await expect(readAcquisitionReceipts({ requests: plan, cacheDirectory })).rejects.toMatchObject({ code: 'cache_integrity' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([[1, 100], [100, 5]])('enforces persistent request and credit ceilings independently (%s, %s)', async (maxRequests, maxCredits) => {
    const cacheDirectory = await destination();
    const fetch = vi.fn<typeof globalThis.fetch>(async () => good());
    const run = { requests, cacheDirectory, approval: approved(requests, maxRequests, maxCredits), client: { fetch } };
    await expect(acquireMarketData(run)).rejects.toMatchObject({ code: 'budget_exhausted' });
    await expect(acquireMarketData(run)).rejects.toMatchObject({ code: 'budget_exhausted' });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await readAcquisitionReceipts({ requests, cacheDirectory })).toMatchObject({ requestsSent: 1, creditsConsumed: 1 });
  });

  it('pauses on rate limit, honors the later retry or reset time, and counts both attempts across runs', async () => {
    const cacheDirectory = await destination();
    const plan = requests.slice(0, 1);
    let clock = new Date('2026-11-25T16:00:00Z');
    const resume = new Date('2026-11-25T16:02:00Z');
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response('rate restricted', { status: 429, headers: { 'retry-after': '60', 'x-api-ratelimit-reset': String(resume.getTime() / 1000) } }))
      .mockImplementation(async () => good());
    const run = { requests: plan, cacheDirectory, approval: approved(plan, 2, 5), client: { fetch, now: () => clock } };
    await expect(acquireMarketData(run)).rejects.toMatchObject({ code: 'rate_limited', retryAt: resume.toISOString() });
    clock = new Date('2026-11-25T16:01:59Z');
    await expect(acquireMarketData(run)).rejects.toMatchObject({ code: 'rate_limited' });
    expect(fetch).toHaveBeenCalledTimes(1);
    clock = resume;
    await expect(acquireMarketData(run)).resolves.toMatchObject({ requestsSent: 2, creditsConsumed: 1 });
  });

  it.each([401, 402, 403])('records %s as an entitlement failure without leaking a provider response or credential', async (status) => {
    const cacheDirectory = await destination();
    const plan = requests.slice(0, 1);
    const token = 'sensitive-placeholder';
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, options) => {
      expect(new Headers(options?.headers).get('Authorization')).toBe(`Bearer ${token}`);
      return new Response(token, { status });
    });
    await expect(acquireMarketData({ requests: plan, cacheDirectory, approval: approved(plan), token, client: { fetch } }))
      .rejects.toMatchObject({ code: 'entitlement', message: `Provider denied approved historical access (HTTP ${status}).` });
    expect(await readFile(join(cacheDirectory, 'acquisition-journal.json'), 'utf8')).not.toContain(token);
    expect(await readAcquisitionReceipts({ requests: plan, cacheDirectory })).toMatchObject({ requestsSent: 1, creditsConsumed: 0, receipts: [] });
  });

  it('keeps an unresolved reservation after missing successful-response billing and cannot repeat a possibly billed request', async () => {
    const cacheDirectory = await destination();
    const plan = requests.slice(0, 1);
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(exampleBody, { status: 203 }));
    const run = { requests: plan, cacheDirectory, approval: approved(plan), client: { fetch } };
    await expect(acquireMarketData(run)).rejects.toMatchObject({ code: 'billing_uncertain' });
    await expect(acquireMarketData(run)).rejects.toMatchObject({ code: 'billing_uncertain' });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await readAcquisitionReceipts({ requests: plan, cacheDirectory })).toMatchObject({ requestsSent: 1, unresolvedReservations: 5, receipts: [] });
  });

  it('records an unexpectedly larger charge or response and aborts without permitting more requests', async () => {
    const cacheDirectory = await destination();
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(exampleBody, { status: 203,
      headers: { 'x-api-ratelimit-consumed': '6' } }));
    const run = { requests, cacheDirectory, approval: approved(requests), client: { fetch } };
    await expect(acquireMarketData(run)).rejects.toMatchObject({ code: 'credit_overrun' });
    await expect(acquireMarketData(run)).rejects.toMatchObject({ code: 'credit_overrun' });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await readAcquisitionReceipts({ requests, cacheDirectory })).toMatchObject({ requestsSent: 1, creditsConsumed: 6, unresolvedReservations: 0, receipts: [] });
  });

  it('records but does not cache a successful charge with invalid or unusually large data', async () => {
    const cacheDirectory = await destination();
    const plan = requests.slice(0, 1);
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(exampleBody, { status: 203,
      headers: { 'x-api-ratelimit-consumed': '1', 'content-length': String(17 * 1024 * 1024) } }));
    const run = { requests: plan, cacheDirectory, approval: approved(plan), client: { fetch } };
    await expect(acquireMarketData(run)).rejects.toMatchObject({ code: 'invalid_response' });
    expect(await readAcquisitionReceipts({ requests: plan, cacheDirectory })).toMatchObject({ requestsSent: 1, creditsConsumed: 1, receipts: [] });
  });

  it('preserves an explicit no-data result and checks the remaining snapshots', async () => {
    const cacheDirectory = await destination();
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ s: 'no_data' }), { status: 404 }))
      .mockImplementation(async () => good());
    const result = await acquireMarketData({ requests, cacheDirectory, approval: approved(requests), client: { fetch } });
    expect(result).toMatchObject({ requestsSent: 2, creditsConsumed: 1, receipts: [{ httpStatus: 404 }, { httpStatus: 203 }] });
    expect(await readAcquisitionRaw({ cacheDirectory, receipt: result.receipts[0] })).toEqual({ s: 'no_data' });
  });

  it('prevents a second concurrent request using the same private cache', async () => {
    const cacheDirectory = await destination();
    const plan = requests.slice(0, 1);
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<Response>();
    const fetch = vi.fn<typeof globalThis.fetch>(async () => { started.resolve(); return finish.promise; });
    const run = { requests: plan, cacheDirectory, approval: approved(plan), client: { fetch } };
    const first = acquireMarketData(run);
    await started.promise;
    try {
      await expect(acquireMarketData(run)).rejects.toMatchObject({ code: 'cache_busy' });
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally {
      finish.resolve(good());
      await first;
    }
  });
});
