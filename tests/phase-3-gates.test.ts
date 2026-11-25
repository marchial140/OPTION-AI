import { describe, expect, it } from 'vitest';
import { makeOccSymbol, optionTradingCutoff } from '../src/lib/quant';
import { canonicalSha256, validatePhase3Dataset, type Phase3Approval, type Phase3Dataset } from '../scripts/phase-3/gates';
import type { NormalizedCandles, NormalizedChain, NormalizedQuote } from '../scripts/phase-3/observations';
import { buildStudyCalendar, nextStudySession, phase3Protocol, studyMorning, type SignalSchedule, type StudySymbol } from '../scripts/phase-3/protocol';

const protocolCommit = 'a'.repeat(40);
const requestManifestSha256 = 'b'.repeat(64);
const approvalDigest = 'c'.repeat(64);
const grantDigest = 'd'.repeat(64);
const receiptDigest = 'e'.repeat(64);
const actualRetrievedAt = '2026-11-25T14:00:00.000Z';
const verifiedAt = '2026-11-25T14:01:00.000Z';
const provider = 'Mock archive fixture';
const evidence = 'https://example.test/fixture-evidence';
const provenance = { provider, rawSha256: receiptDigest, actualRetrievedAt };
const approval: Phase3Approval = { status: 'approved', protocolCommit, requestManifestSha256, timeline: phase3Protocol.timeline.method,
  useScope: 'private-internal-research', approvedAt: '2026-11-25T10:00:00.000Z', evidenceSha256: approvalDigest,
  providers: [{ provider, roles: ['candles', 'signal', 'revalidation', 'fill', 'series', 'corporate-actions'],
    historicalFrom: phase3Protocol.warmupStartDate, historicalTo: phase3Protocol.cutoffDate,
    retainForResearchUntil: '2027-11-25T10:00:00.000Z', evidenceSha256: grantDigest }] };
const base = { approval, protocolCommit, requestManifestSha256, verifiedAt,
  verifiedRawSha256s: [approvalDigest, grantDigest, receiptDigest] };
const { closeDates, signals } = buildStudyCalendar();
const first = signals[0];
const symbol = 'SPY';
const expiration = '2024-11-01';
const iso = (ms: number) => new Date(ms).toISOString();
const closeTime = (day: string) => optionTradingCutoff(day)!;

const provenanceFor = (symbol: StudySymbol) => ({ ...provenance, requestedSymbol: symbol, retrievedAt: actualRetrievedAt, sourceUrl: evidence });
const syntheticCloseTimes = closeDates.map((session) => ({ session, observedAt: iso(closeTime(session)), availableAt: iso(closeTime(session) + 16 * 60_000) }));

function fixtureHistory(symbol: StudySymbol) {
  const common = provenanceFor(symbol);
  const candles: NormalizedCandles = { version: 1, kind: 'candles', provenance: { ...common,
    requestedFrom: phase3Protocol.warmupStartDate, requestedTo: phase3Protocol.cutoffDate }, issues: [],
    rows: syntheticCloseTimes.map(({ session, observedAt, availableAt }) => ({ symbol, session, close: 100, basis: 'as-traded-non-dividend-adjusted',
      observedAt, observationKind: 'session-close-from-daily-candle', availability: { kind: 'reconstructed', at: availableAt, evidence } })) };
  const actions: Phase3Dataset['corporateActions'][number] = { version: 1, kind: 'corporate-actions', provenance: common,
    reviewedFrom: phase3Protocol.warmupStartDate, reviewedTo: phase3Protocol.cutoffDate, complete: true, coverageEvidence: evidence, actions: [] };
  return { candles, actions };
}

function fixturePanel(symbol: StudySymbol, schedule: SignalSchedule, expiration: string) {
  const common = provenanceFor(symbol);
  const definitions = (['call', 'put'] as const).map((type) => ({ type, strike: 100, expiration, multiplier: 100 as const,
    optionSymbol: makeOccSymbol(symbol, expiration, type, 100), deliverable: '100-underlying-shares' as const }));
  const makeQuotes = (session: string, observedAt: string, at: string): NormalizedQuote[] => definitions.map((definition) => ({
    ...definition, symbol, session, observedAt, bid: 1, ask: 1.05, bidSize: 1, askSize: 1, currency: 'USD', observationKind: 'provider',
    deliverableEvidence: 'provider-standard-only-query', availability: { at, kind: 'reconstructed', evidence },
  }));
  const { signalDate, signalAt, revalidationDate, revalidationObservedAt, entryDate, fillAt } = schedule;
  const signal: NormalizedChain = { version: 1, kind: 'chain', rawRows: 2, issues: [], provenance: { ...common, requestedDate: signalDate },
    rows: makeQuotes(signalDate, iso(closeTime(signalDate)), studyMorning(revalidationDate, 31)) };
  const revalidation: NormalizedChain = { version: 1, kind: 'chain', rawRows: 2, issues: [], provenance: { ...common, requestedDate: revalidationDate },
    rows: makeQuotes(revalidationDate, revalidationObservedAt, studyMorning(entryDate, 31)) };
  const fill: NormalizedChain = { version: 1, kind: 'chain', rawRows: 2, issues: [], provenance: { ...common, requestedDate: entryDate },
    rows: makeQuotes(entryDate, fillAt, studyMorning(nextStudySession(entryDate), 31)) };
  const inventory: Phase3Dataset['inventories'][number] = { symbol, session: signalDate, observedAt: iso(closeTime(signalDate)), availableAt: signalAt,
    complete: true, provenance, rows: definitions };
  return { signal, revalidation, fill, inventory };
}

function fixture(schedule = first, expires = expiration) {
  const { candles, actions } = fixtureHistory(symbol);
  const { signal, revalidation, fill, inventory } = fixturePanel(symbol, schedule, expires);
  const dataset: Phase3Dataset = { acquisitionClass: 'mock', candles: [candles], signalChains: [signal], revalidationChains: [revalidation], fillChains: [fill],
    inventories: [inventory], corporateActions: [actions] };
  return { dataset, signal, revalidation, fill, candles };
}

describe('Phase 3 historical data gates', () => {
  it('checks all 156 synthetic panels while keeping mock_data as the only blocker', { timeout: 30_000 }, () => {
    const panels = phase3Protocol.symbols.flatMap((symbol) => signals.map((schedule) => fixturePanel(symbol, schedule, schedule.latestExpiryDate)));
    const histories = phase3Protocol.symbols.map(fixtureHistory);
    const dataset: Phase3Dataset = {
      acquisitionClass: 'mock', candles: histories.map(({ candles }) => candles), corporateActions: histories.map(({ actions }) => actions),
      signalChains: panels.map(({ signal }) => signal), revalidationChains: panels.map(({ revalidation }) => revalidation),
      fillChains: panels.map(({ fill }) => fill), inventories: panels.map(({ inventory }) => inventory),
    };
    const result = validatePhase3Dataset({ ...base, dataset });
    expect(result).toMatchObject({ status: 'blocked', issueCount: 1,
      counts: { expectedCloses: 3156, validCloses: 3156, expectedPairs: 156, verifiedPairs: 156, staleRevalidationPanels: 6 } });
    expect(result.issues.map(({ code }) => code)).toEqual(['mock_data']);
  });

  it('verifies the calendar and gives synthetic fixtures no readiness authority', () => {
    const { dataset } = fixture();
    const result = validatePhase3Dataset({ ...base, dataset });
    expect(result).toMatchObject({ status: 'blocked', counts: { expectedCloses: 3156, validCloses: 526, expectedPairs: 156, verifiedPairs: 1 } });
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'mock_data' }));
    expect(result.issues).not.toContainEqual(expect.objectContaining({ code: 'quote_invalid', scope: expect.stringContaining('SPY') }));
    expect(result.datasetSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('blocks a missing quote without an independently evidenced no-book disposition', () => {
    const { dataset, revalidation } = fixture();
    const absent = revalidation.rows.pop()!;
    const evaluate = () => validatePhase3Dataset({ ...base, dataset });
    expect(evaluate().issues).toContainEqual(expect.objectContaining({ code: 'quote_missing', scope: `revalidation:SPY:${first.signalDate}` }));
    dataset.inventories[0].noBook = [{ role: 'revalidation', optionSymbol: absent.optionSymbol, observedAt: first.revalidationObservedAt,
      availableAt: first.orderAt, disposition: 'halted', evidence }];
    expect(evaluate().counts.verifiedPairs).toBe(1);
    dataset.inventories[0].noBook[0].availableAt = first.fillAt;
    expect(evaluate().issues).toContainEqual(expect.objectContaining({ code: 'no_book_unverified', scope: `revalidation:SPY:${first.signalDate}` }));
  });

  it('blocks D+2 fill quotes as revalidation inputs, delayed liquidity, and ambiguous books', () => {
    const { dataset, revalidation, fill } = fixture();
    revalidation.rows[0] = fill.rows[0];
    revalidation.rows[1].volume = 100;
    revalidation.rows[1].volumeAvailableAt = first.fillAt;
    fill.rows[0].askSize = undefined;
    fill.issues.push({ code: 'cap', index: null, message: 'Fixture row limit' });
    const result = validatePhase3Dataset({ ...base, dataset });
    expect(result.counts.verifiedPairs).toBe(0);
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'quote_invalid', scope: `revalidation:SPY:${first.signalDate}` }),
      expect.objectContaining({ code: 'quote_invalid', scope: `fill:SPY:${first.signalDate}` }),
      expect.objectContaining({ code: 'stage_incomplete' }),
    ]));
  });

  it('requires the available D+1 close even when a future D+2 close is present', () => {
    const { dataset, candles } = fixture();
    const d1 = candles.rows.find((row) => row.session === first.revalidationDate)!;
    expect(candles.rows.some((row) => row.session === first.entryDate)).toBe(true);
    d1.availability.at = first.fillAt;
    const result = validatePhase3Dataset({ ...base, dataset });
    expect(result.counts.verifiedPairs).toBe(0);
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'candle_invalid', scope: `SPY:${first.revalidationDate}` }),
      expect.objectContaining({ code: 'pair_incomplete', scope: `SPY:${first.signalDate}` }),
    ]));
  });

  it('rejects the correct D+1 snapshot if its availability is later than the order lock', () => {
    const { dataset, revalidation } = fixture();
    revalidation.rows[0].availability.at = first.fillAt;
    const result = validatePhase3Dataset({ ...base, dataset });
    expect(result.counts.verifiedPairs).toBe(0);
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'quote_invalid', scope: `revalidation:SPY:${first.signalDate}` }));
  });

  it('rejects a certified series expiring by the simulated fill as outside the frozen expiry band', () => {
    const { dataset } = fixture(first, first.entryDate);
    const result = validatePhase3Dataset({ ...base, dataset });
    expect(result.counts.verifiedPairs).toBe(0);
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'series_invalid', scope: `SPY:${first.signalDate}` }));
  });

  it('counts a complete New Year panel as stale at the lock, and still requires its proof', () => {
    const schedule = signals.find(({ signalDate }) => signalDate === '2024-12-30')!;
    expect(schedule).toMatchObject({ revalidationDate: '2024-12-31', entryDate: '2025-01-02' });
    const { dataset, revalidation } = fixture(schedule, schedule.latestExpiryDate);
    const evaluate = () => validatePhase3Dataset({ ...base, dataset });
    expect(evaluate().counts).toMatchObject({ verifiedPairs: 1, staleRevalidationPanels: 1 });
    revalidation.rows.pop();
    const incomplete = evaluate();
    expect(incomplete.counts).toMatchObject({ verifiedPairs: 0, staleRevalidationPanels: 0 });
    expect(incomplete.issues).toContainEqual(expect.objectContaining({ code: 'quote_missing', scope: `revalidation:SPY:${schedule.signalDate}` }));
  });

  it('does not accept an absent raw artifact, invalid approval, or expired storage license', () => {
    const { dataset } = fixture();
    const stale = { ...approval, providers: approval.providers.map((grant) => ({ ...grant, retainForResearchUntil: grant.historicalTo + 'T09:00:00Z' })) };
    const result = validatePhase3Dataset({ ...base, dataset, approval: stale, verifiedRawSha256s: [grantDigest] });
    expect(result.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'approval_invalid' }),
      expect.objectContaining({ code: 'entitlement_unverified' }), expect.objectContaining({ code: 'artifact_unverified' })]));
  });

  it('blocks a missing close and corporate actions without settlement coverage', () => {
    const { dataset, candles } = fixture();
    candles.rows.splice(candles.rows.findIndex((row) => row.session === expiration), 1);
    dataset.corporateActions[0].reviewedTo = '2025-10-07';
    const result = validatePhase3Dataset({ ...base, dataset });
    expect(result.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'candle_coverage' }),
      expect.objectContaining({ code: 'settlement_missing' }), expect.objectContaining({ code: 'missing_actions' })]));
    expect(result.counts.validCloses).toBe(525);
  });

  it('never includes newly listed entry rows in the frozen universe, and binds changed bytes to the digest', () => {
    const { dataset } = fixture();
    const before = validatePhase3Dataset({ ...base, dataset });
    const late = { ...dataset.fillChains[0].rows[0], strike: 101, optionSymbol: makeOccSymbol(symbol, expiration, 'call', 101) };
    dataset.fillChains[0].rows.push(late);
    const after = validatePhase3Dataset({ ...base, dataset });
    expect(after.counts.verifiedPairs).toBe(1);
    expect(after.datasetSha256).not.toBe(before.datasetSha256);
    expect(canonicalSha256({ y: 2, x: { b: 1, a: null } })).toBe(canonicalSha256({ x: { a: null, b: 1 }, y: 2 }));
  });

  it('audits known contract adjustments without attributing then-unannounced actions to the signal', () => {
    const { dataset, signal } = fixture();
    dataset.corporateActions[0].actions.push({ kind: 'contract-adjustment', effectiveSession: '2024-10-30',
      availableAt: '2024-10-22T11:00:00.000Z', evidence, optionSymbol: signal.rows[0].optionSymbol, reason: 'Fixture deliverable adjustment' },
    { kind: 'contract-adjustment', effectiveSession: '2024-10-31',
      availableAt: '2024-10-24T15:00:00.000Z', evidence, optionSymbol: signal.rows[1].optionSymbol, reason: 'Later fixture announcement' });
    expect(validatePhase3Dataset({ ...base, dataset }).counts.knownAdjustmentLegs).toBe(1);
  });
});
