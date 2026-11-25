import { describe, expect, it } from 'vitest';
import { makeOccSymbol } from '../src/lib/quant';
import {
  buildPhase2History, contractActionsThrough, normalizeCorporateActionReview, normalizeMarketDataCandles,
  normalizeMarketDataChain, normalizePointInTimeSnapshot, toResearchQuote, toResearchSpot,
} from '../scripts/phase-3/observations';

const rawSha256 = 'c'.repeat(64);
const retrievedAt = '2026-11-25T17:00:00Z';
const symbol = 'SPY';
const source = 'https://example.test/documented-archive';
const epoch = (at: string) => Date.parse(at) / 1000;
const expiry = '2024-11-15';
const chainId = makeOccSymbol(symbol, expiry, 'call', 575);

function candleReceipt(from = '2024-10-21', to = '2024-10-23') {
  return { requestedSymbol: symbol, requestedFrom: from, requestedTo: to, rawSha256, retrievedAt,
    sourceUrl: `https://api.marketdata.app/v1/stocks/candles/D/${symbol}/?from=${from}&to=${to}&adjustsplits=false&adjustdividends=false&dateformat=unix` };
}

function chainReceipt(date = '2024-10-21') {
  return { requestedSymbol: symbol, requestedDate: date, rawSha256, retrievedAt,
    sourceUrl: `https://api.marketdata.app/v1/options/chain/${symbol}/?date=${date}&nonstandard=false&dateformat=unix&limit=4001` };
}

function optionColumns() {
  return { s: 'ok', optionSymbol: [chainId], underlying: [symbol], expiration: [epoch('2024-11-15T21:00:00Z')], side: ['call'],
    strike: [575], updated: [epoch('2024-10-21T20:00:00Z')], bid: [2], ask: [2.2], volume: [29], openInterest: [100],
    bidSize: [3], askSize: [7] };
}

function actionReview(actions: unknown[] = []) {
  return normalizeCorporateActionReview({ reviewedFrom: '2024-10-21', reviewedTo: expiry, complete: true, coverageEvidence: source, actions },
    { requestedSymbol: symbol, rawSha256, retrievedAt, sourceUrl: source, provider: 'OCC and issuer releases' });
}

describe('Phase 3 normalized market observations', () => {
  it('separates reconstructed candle availability from the exchange date label and actual transport', () => {
    const raw = { s: 'ok', t: [epoch('2024-10-21T04:00:00Z')], c: [576.54] };
    const result = normalizeMarketDataCandles(raw, candleReceipt());
    expect(result.issues).toEqual([]);
    expect(result.provenance).toMatchObject({ provider: 'Market Data', actualRetrievedAt: retrievedAt, rawSha256 });
    expect(result.rows).toMatchObject([{ session: '2024-10-21', close: 576.54, observedAt: '2024-10-21T20:00:00.000Z',
      observationKind: 'session-close-from-daily-candle', availability: { kind: 'reconstructed', at: '2024-10-21T20:16:00.000Z' } }]);
    expect(() => toResearchSpot(result.rows[0], new Date('2024-10-21T20:15:59Z'))).toThrow(/unavailable/u);
    expect(() => toResearchSpot({ ...result.rows[0], observedAt: 'unknown' }, new Date('2024-10-22T13:45:00Z'))).toThrow(/unavailable/u);
    expect(toResearchSpot(result.rows[0], new Date('2024-10-22T13:45:00Z'))).toMatchObject({ price: 576.54, symbol });
  });

  it('uses an early close and rejects provider adjustment flags, bad columns and unscheduled dates', () => {
    const receipt = candleReceipt('2024-11-28', '2024-11-29');
    const raw = { s: 'ok', t: [epoch('2024-11-28T05:00:00Z'), epoch('2024-11-29T05:00:00Z')], c: [575, 576] };
    const batch = normalizeMarketDataCandles(raw, receipt);
    expect(batch.issues).toMatchObject([{ index: 0, code: 'invalid-row' }]);
    expect(batch.rows[0]).toMatchObject({ observedAt: '2024-11-29T18:00:00.000Z', availability: { at: '2024-11-29T18:16:00.000Z' } });
    expect(() => normalizeMarketDataCandles(raw, { ...receipt, sourceUrl: receipt.sourceUrl.replace('adjustsplits=false', 'adjustsplits=true') }))
      .toThrow(/frozen parameters/u);
    expect(() => normalizeMarketDataCandles({ ...raw, c: [1] }, receipt)).toThrow(/Mismatched/u);
    expect(() => normalizeMarketDataCandles(raw, { ...receipt, sourceUrl: receipt.sourceUrl + '&token=sensitive' })).toThrow();
  });

  it('keeps the observed close, vendor-supported next-session availability and actual retrieval distinct', () => {
    const chain = normalizeMarketDataChain(optionColumns(), chainReceipt());
    expect(chain.rows[0]).toMatchObject({ optionSymbol: chainId, observedAt: '2024-10-21T20:00:00.000Z', bidSize: 3, askSize: 7,
      availability: { at: '2024-10-22T13:31:00.000Z', kind: 'reconstructed' }, multiplier: 100,
      deliverableEvidence: 'provider-standard-only-query' });
    expect(() => toResearchQuote(chain.rows[0], chain, new Date('2024-10-22T13:30:59Z'))).toThrow(/unavailable/u);
    const quote = toResearchQuote(chain.rows[0], chain, new Date('2024-10-22T13:45:00Z'));
    expect(quote.retrievedAt).toBe('2024-10-22T13:31:00.000Z');
    expect(chain.provenance.actualRetrievedAt).toBe(retrievedAt);
    expect(quote.source.citation).toContain(retrievedAt);
    expect(() => toResearchQuote(chain.rows[0], chain, new Date('2024-10-23T13:45:00Z'))).toThrow(/Historical risk eligibility/u);
    expect(() => toResearchQuote({ ...chain.rows[0], observedAt: '2024-10-22T13:32:00Z' }, chain,
      new Date('2024-10-22T13:45:00Z'))).toThrow(/inconsistent/u);
  });

  it('rolls a prior-session EOD chain across Thanksgiving using the next open', () => {
    const id = makeOccSymbol(symbol, '2024-12-20', 'call', 575);
    const batch = normalizeMarketDataChain({ ...optionColumns(), optionSymbol: [id], updated: [epoch('2024-11-27T21:00:00Z')],
      expiration: [epoch('2024-12-20T21:00:00Z')] }, chainReceipt('2024-11-27'));
    expect(batch.rows[0].availability.at).toBe('2024-11-29T14:31:00.000Z');
    // The publication rule does not relax the existing risk engine's freshness check after a holiday.
    expect(() => toResearchQuote(batch.rows[0], batch, new Date('2024-11-29T14:45:00Z'))).toThrow(/Historical risk eligibility/u);
  });

  it('quarantines crossed, adjusted, and mismatched contracts and rejects a hit sentinel', () => {
    const raw = optionColumns();
    for (const row of [{ ...raw, bid: [3] }, { ...raw, optionSymbol: [chainId.replace('C', 'P')] }, { ...raw, multiplier: [10] },
      { ...raw, nonstandard: [true] }, { ...raw, updated: [epoch('2024-10-21T20:15:00Z')] },
      { ...raw, expiration: [epoch('2024-11-15T21:15:00Z')] }]) {
      const result = normalizeMarketDataChain(row, chainReceipt());
      expect(result.rows).toEqual([]);
      expect(result.issues[0]).toMatchObject({ code: 'invalid-row' });
    }
    const full = Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, Array.isArray(value) ? Array(4001).fill(value[0]) : value]));
    expect(normalizeMarketDataChain(full, chainReceipt())).toMatchObject({ rawRows: 4001, rows: [], issues: [{ code: 'cap' }] });
  });

  it('deduplicates identical OCC rows and drops each conflicted identity on either input ordering', () => {
    const raw = optionColumns();
    const repeated = Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, Array.isArray(value) ? [value[0], value[0]] : value]));
    expect(normalizeMarketDataChain(repeated, chainReceipt()).rows).toHaveLength(1);
    for (const bids of [[2, 2.1], [2.1, 2]]) {
      const result = normalizeMarketDataChain({ ...repeated, bid: bids }, chainReceipt());
      expect(result.rows).toEqual([]);
      expect(result.issues[0]).toMatchObject({ code: 'conflict' });
    }
  });

  it('validates as-traded underlying and option dissemination by the pre-close order', () => {
    const observedAt = '2024-10-22T19:15:00Z';
    const availableAt = '2024-10-22T19:30:00Z';
    const times = { observedAt, availableAt, availabilityEvidence: source };
    const spot = { ...times, symbol, basis: 'as-traded-non-dividend-adjusted', price: 580 };
    const option = { ...times, optionSymbol: chainId, symbol, type: 'call', strike: 575, expiration: expiry, bid: 2, ask: 2.20,
      bidSize: 1, askSize: 3, multiplier: 100, nonstandard: false, currency: 'USD', deliverable: '100-underlying-shares',
      volume: 101, volumeAvailableAt: availableAt, openInterest: 101, openInterestAvailableAt: '2024-10-22T13:31:00Z' };
    const receipt = { requestedSymbol: symbol, requestedDate: '2024-10-22', sourceUrl: source, provider: 'Licensed OPRA archive', rawSha256, retrievedAt };
    const snap = normalizePointInTimeSnapshot({ s: 'ok', spot, options: [option] }, receipt);
    const asOf = new Date('2024-10-22T19:40:00Z');
    expect(toResearchSpot(snap.spot, asOf).price).toBe(580);
    expect(toResearchQuote(snap.rows[0], snap, asOf)).toMatchObject({ volume: 101, openInterest: 101, retrievedAt: '2024-10-22T19:30:00.000Z' });
    for (const invalid of [{ ...option, availableAt: '2024-10-22T19:40:01Z' }, { ...option, volumeAvailableAt: undefined },
      { ...option, volumeAvailableAt: '2024-10-22T19:10:00Z' }, { ...option, availableAt: '2024-10-22T19:00:00Z' }]) {
      expect(normalizePointInTimeSnapshot({ s: 'ok', spot, options: [invalid] }, receipt)).toMatchObject({ rows: [], issues: [{ code: 'invalid-row' }] });
    }
  });
});

describe('Phase 3 corporate action basis', () => {
  const published = '2024-10-22T12:00:00Z';
  const split = { kind: 'split', effectiveSession: '2024-10-22', availableAt: published, evidence: source, oldShares: 1, newShares: 2 };
  const cash = { kind: 'cash-dividend', effectiveSession: '2024-10-23', availableAt: published, evidence: source, cashPerShare: 1 };
  const closes = () => normalizeMarketDataCandles({ s: 'ok', t: [21, 22, 23].map((day) => epoch(`2024-10-${day}T04:00:00Z`)),
    c: [200, 100, 99] }, candleReceipt());

  it('back-adjusts only the effective split with as-of evidence and preserves ex-date cash price movements', () => {
    const batch = closes();
    const review = actionReview([cash, split]);
    const before = buildPhase2History(batch, review, new Date('2024-10-21T21:00:00Z'));
    const after = buildPhase2History(batch, review, new Date('2024-10-23T21:00:00Z'));
    expect(before.closes.map(({ close }) => close)).toEqual([200]);
    expect(after.closes.map(({ close }) => close)).toEqual([100, 100, 99]);
    expect(after.basisKnownAt).toBe('2024-10-23T21:00:00.000Z');
    expect(() => buildPhase2History(batch, actionReview([{ ...split, availableAt: '2024-10-23T21:00:01Z' }]),
      new Date('2024-10-23T21:00:00Z'))).toThrow(/no as-of evidence/u);
  });

  it('uses only then-known option adjustments for selection and exposes later conflicts for settlement review', () => {
    const row = normalizeMarketDataChain(optionColumns(), chainReceipt()).rows[0];
    const review = actionReview([cash, split]);
    expect(contractActionsThrough(review, row, new Date('2024-10-21T21:00:00Z'))).toEqual([]);
    expect(contractActionsThrough(review, row).map(({ kind }) => kind)).toEqual(['split']);
    expect(contractActionsThrough(actionReview([cash]), row)).toEqual([]);
  });
});
