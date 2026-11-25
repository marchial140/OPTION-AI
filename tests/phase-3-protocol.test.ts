import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { hashAcquisitionPlan, sha256 } from '../scripts/phase-3/acquisition';
import { runPhase3 } from '../scripts/phase-3/command';
import { phase3RiskPreferences, signalRiskPreferences } from '../scripts/phase-3/eligibility';
import { buildCostEstimate, buildRequestManifest, frozenProtocolCommit, manifestSha256, resolveChainRequests } from '../scripts/phase-3/manifest';
import { buildStudyCalendar, nextStudySession, phase3Protocol } from '../scripts/phase-3/protocol';

const manifest = buildRequestManifest();
const opts = { privateDirectory: 'outside-private-work', approvalFile: 'missing.json', licensedIndex: 'missing.json' };

describe('Phase 3 calendar and frozen request contract', () => {
  it('fixes the warm-up, cadence, settlement buffer and DST-aware clocks', () => {
    const { closeDates, signals } = buildStudyCalendar();
    expect(closeDates).toHaveLength(526);
    expect(closeDates[0]).toBe('2023-10-19');
    expect(closeDates[252]).toBe('2024-10-21');
    expect(closeDates.at(-1)).toBe('2025-11-21');
    expect(closeDates).not.toContain('2025-01-09');
    expect(nextStudySession('2024-12-31')).toBe('2025-01-02');
    expect(signals).toHaveLength(26);
    expect(signals[0]).toEqual({ signalDate: '2024-10-21', signalAt: '2024-10-22T13:45:00.000Z', revalidationDate: '2024-10-22',
      entryDate: '2024-10-23', revalidationObservedAt: '2024-10-22T20:00:00.000Z', orderAt: '2024-10-23T13:45:00.000Z',
      fillAt: '2024-10-23T20:00:00.000Z', latestExpiryDate: '2024-11-20' });
    expect(signals[1].fillAt).toBe('2024-11-06T21:00:00.000Z');
    expect(signals.at(-1)).toMatchObject({ signalDate: '2025-10-06', revalidationDate: '2025-10-07',
      entryDate: '2025-10-08', latestExpiryDate: '2025-11-05' });
    expect(signals.every((row) => row.latestExpiryDate < phase3Protocol.cutoffDate)).toBe(true);
  });

  it('keeps the New Year anchor and the exact original 36-hour freshness cutoff', () => {
    const stale = manifest.signals.filter(({ revalidationObservedAt, orderAt }) => (
      Date.parse(orderAt) - Date.parse(revalidationObservedAt) > phase3Protocol.timeline.maxHistoricalQuoteAgeHours * 3_600_000
    ));
    expect(stale).toHaveLength(1);
    expect(stale[0]).toMatchObject({ signalDate: '2024-12-30', revalidationDate: '2024-12-31', entryDate: '2025-01-02',
      revalidationObservedAt: '2024-12-31T21:00:00.000Z', orderAt: '2025-01-02T14:45:00.000Z' });
    expect(Date.parse(stale[0].orderAt) - Date.parse(stale[0].revalidationObservedAt)).toBe(41.75 * 3_600_000);
  });

  it('keeps one reference capital and the 7–30 day signal window with the later forecast clock', () => {
    expect(phase3RiskPreferences).toMatchObject({ minDte: 7, maxDte: 30, capital: 10000, maxRiskPercent: 5, maxPositions: 8 });
    expect(signalRiskPreferences(manifest.signals[0])).toMatchObject({ minDte: 6, maxDte: 29, capital: 10000 });
    expect(phase3Protocol.primary).toBe('D');
    expect(phase3Protocol.randomSeeds).toHaveLength(20);
  });

  it('builds exact reproducible public artifacts without a data request', async () => {
    expect(await runPhase3('manifest', opts)).toEqual(manifest);
    expect(JSON.parse(await readFile('phase_3_data_manifest.json', 'utf8'))).toEqual(manifest);
    expect(JSON.parse(await readFile('phase_3_cost_estimate.json', 'utf8'))).toEqual(buildCostEstimate());
    expect(buildCostEstimate().primary).toMatchObject({ marketDataRequests: 474,
      indicativeCredits: [474, 1566], hardReservation: 2346 });
    expect(buildCostEstimate().separateTechnicalCoverage).toMatchObject({ marketDataRequests: 24, hardReservation: 96, approvalRequired: true });
    expect(await runPhase3('fingerprints', opts)).toEqual({ protocolCommit: frozenProtocolCommit,
      requestManifestSha256: manifestSha256(manifest), candlesPlanSha256: hashAcquisitionPlan(manifest.candles) });
  });

  it('uses the original signal band and dates for the later conditional fill snapshots', () => {
    const synthetic = manifest.symbols.flatMap((symbol) => manifest.signals.map(({ signalDate }) => ({ symbol, date: signalDate, close: 100.001 })));
    const requests = resolveChainRequests(synthetic);
    expect(requests).toHaveLength(468);
    const [signal, revalidation, fill] = requests.map(({ url }) => new URL(url).searchParams);
    expect(signal.get('date')).toBe('2024-10-21');
    expect(revalidation.get('date')).toBe('2024-10-22');
    expect(fill.get('date')).toBe('2024-10-23');
    for (const params of [signal, revalidation, fill]) {
      expect(params.get('strike')).toBe('80.00-120.01');
      expect(params.get('from')).toBe('2024-10-28');
      expect(params.get('to')).toBe('2024-11-20');
      expect(params.get('limit')).toBe('4001');
      expect(params.has('side')).toBe(false);
    }
    expect(hashAcquisitionPlan(requests)).toBe(hashAcquisitionPlan(requests.toReversed()));
    expect(() => resolveChainRequests(synthetic.slice(1))).toThrow(/Missing observed signal close/);
  });

  it('uses a separate hash and three outside-holdout dates for the coverage check', async () => {
    const coverage = buildRequestManifest('coverage');
    expect(coverage.closeDates).toEqual(['2026-10-05', '2026-10-06', '2026-10-07']);
    expect(coverage.candles).toHaveLength(6);
    expect(coverage.chains).toHaveLength(18);
    expect(manifestSha256(coverage)).not.toBe(manifestSha256(manifest));
    expect(await runPhase3('manifest', { ...opts, scope: 'coverage' })).toEqual(coverage);
  });

  it('checks documentary coverage approvals offline and rejects cross-scope use and over-reservation', async () => {
    await mkdir('work', { recursive: true });
    const privateDirectory = await mkdtemp('work/phase-3-1-approval-test-');
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected external request'));
    try {
      const coverage = buildRequestManifest('coverage');
      const evidence = 'Synthetic test evidence only.';
      const hash = sha256(evidence);
      const approval = {
        authorization: { status: 'approved', protocolCommit: frozenProtocolCommit, requestManifestSha256: manifestSha256(coverage),
          timeline: phase3Protocol.timeline.method, useScope: 'private-internal-research', approvedAt: '2026-10-08T00:00:00Z',
          evidenceSha256: hash, providers: [{ provider: 'Market Data', roles: ['candles', 'signal', 'revalidation', 'fill'],
            historicalFrom: '2026-10-05', historicalTo: '2026-10-07', retainForResearchUntil: '2099-01-01T00:00:00Z', evidenceSha256: hash }] },
        acquisitionAndCostsApproved: true, budget: { maxRequests: 24, maxCredits: 96, maxUsd: 0 },
        candles: { planSha256: hashAcquisitionPlan(coverage.candles), maxRequests: 6, maxCredits: 6 }, evidenceFiles: ['evidence.txt'],
      };
      await writeFile(join(privateDirectory, 'evidence.txt'), evidence, { mode: 0o600 });
      const approvalFile = join(privateDirectory, 'approval.json');
      await writeFile(approvalFile, JSON.stringify(approval), { mode: 0o600 });
      const options = { ...opts, privateDirectory, approvalFile: 'approval.json' };
      expect(await runPhase3('verify-entitlements', { ...options, scope: 'coverage' })).toMatchObject({
        status: 'documentary-approval-verified', scope: 'coverage', accountCheck: 'manual-account-dashboard-and-provider-confirmation',
      });
      await expect(runPhase3('verify-entitlements', options)).rejects.toThrow(/did not match/);
      approval.budget.maxCredits++;
      await writeFile(approvalFile, JSON.stringify(approval), { mode: 0o600 });
      await expect(runPhase3('acquire-candles', { ...options, scope: 'coverage' })).rejects.toThrow(/did not match/);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
      await rm(privateDirectory, { recursive: true, force: true });
    }
  });

  it('blocks private storage outside ignored work before any acquisition', async () => {
    await expect(runPhase3('acquire-candles', opts)).rejects.toThrow(/ignored work directory/);
    await expect(runPhase3('validate', opts)).rejects.toThrow(/ignored work directory/);
  });
});
