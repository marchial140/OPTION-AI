import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { hashAcquisitionPlan } from '../scripts/phase-3/acquisition';
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
    expect(signals[0]).toEqual({ signalDate: '2024-10-21', signalAt: '2024-10-22T13:45:00.000Z', entryDate: '2024-10-22',
      revalidationObservedAt: '2024-10-22T19:15:00.000Z', orderAt: '2024-10-22T19:40:00.000Z',
      fillAt: '2024-10-22T20:00:00.000Z', latestExpiryDate: '2024-11-20' });
    expect(signals[1].fillAt).toBe('2024-11-05T21:00:00.000Z');
    expect(signals.at(-1)).toMatchObject({ signalDate: '2025-10-06', entryDate: '2025-10-07', latestExpiryDate: '2025-11-05' });
    expect(signals.every((row) => row.latestExpiryDate < phase3Protocol.cutoffDate)).toBe(true);
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
    expect(buildCostEstimate().primary).toMatchObject({ marketDataRequests: 318, licensedSnapshots: 156,
      indicativeCredits: [318, 1046], hardReservation: 1566 });
    expect(buildCostEstimate().proposedEodOnlyAmendment).toMatchObject({ marketDataRequests: 474, approvalRequired: true });
    expect(await runPhase3('fingerprints', opts)).toEqual({ protocolCommit: frozenProtocolCommit,
      requestManifestSha256: manifestSha256(manifest), candlesPlanSha256: hashAcquisitionPlan(manifest.candles) });
  });

  it('uses the original signal band and dates for the later conditional fill snapshots', () => {
    const synthetic = manifest.symbols.flatMap((symbol) => manifest.signals.map(({ signalDate }) => ({ symbol, date: signalDate, close: 100.001 })));
    const requests = resolveChainRequests(synthetic);
    expect(requests).toHaveLength(312);
    const [signal, fill] = requests.map(({ url }) => new URL(url).searchParams);
    expect(signal.get('date')).toBe('2024-10-21');
    expect(fill.get('date')).toBe('2024-10-22');
    for (const params of [signal, fill]) {
      expect(params.get('strike')).toBe('80.00-120.01');
      expect(params.get('from')).toBe('2024-10-28');
      expect(params.get('to')).toBe('2024-11-20');
      expect(params.get('limit')).toBe('4001');
      expect(params.has('side')).toBe(false);
    }
    expect(hashAcquisitionPlan(requests)).toBe(hashAcquisitionPlan(requests.toReversed()));
    expect(() => resolveChainRequests(synthetic.slice(1))).toThrow(/Missing observed signal close/);
  });

  it('blocks private storage outside ignored work before any acquisition', async () => {
    await expect(runPhase3('acquire-candles', opts)).rejects.toThrow(/ignored work directory/);
    await expect(runPhase3('validate', opts)).rejects.toThrow(/ignored work directory/);
  });
});
