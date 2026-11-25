import { describe, expect, it } from 'vitest';
import { auditCandidates, enumerateEligible } from '../scripts/phase-1/candidate-audit';
import { phase1Protocol } from '../scripts/phase-1/config';
import { constructStrategies, makeOccSymbol, type ConstructionContext, type ContractQuote } from '../src/lib/quant';

const now = new Date('2026-06-02T20:00:00Z');
const quoteAt = now.toISOString();
const context: ConstructionContext = {
  now, fees: phase1Protocol.entryFees, weights: phase1Protocol.weightsA,
  candidate: {
    symbol: 'AAPL', name: 'AAPL', price: 100, change: null, direction: 'insufficient', thesis: '',
    risks: [], bullishFactors: [], bearishFactors: [], sources: [], updatedAt: quoteAt, status: 'VERIFIED_DELAYED',
  },
};

function quote(type: ContractQuote['type'], strike: number, ask: number, expiration = '2026-06-18'): ContractQuote {
  return {
    id: makeOccSymbol('AAPL', expiration, type, strike), symbol: 'AAPL', expiration, type, strike,
    multiplier: 100, bid: ask - 0.05, ask, currency: 'USD', quoteAt, retrievedAt: quoteAt,
    source: { url: 'https://example.com/fixture', publisher: 'Unit-test fixture' },
    volume: 500, openInterest: 1500, status: 'VERIFIED_DELAYED',
  };
}

describe('Phase 1 candidate diagnostics with controlled mathematical inputs', () => {
  it('isolates the long call/put asymmetry for identical liquidity and cost', () => {
    const chain = [quote('call', 102, 0.50), quote('put', 98, 0.50)];
    const original = enumerateEligible(chain, phase1Protocol.risk, context);
    expect(original.map(({ strategy, score }) => [strategy, score?.breakdown.find(({ key }) => key === 'payoff')?.value])).toEqual([
      ['long_put', 100], ['long_call', undefined],
    ]);
    const withoutPayoff = enumerateEligible(chain, phase1Protocol.risk, { ...context, weights: phase1Protocol.weightsB });
    expect(withoutPayoff[0].score?.total).toBe(withoutPayoff[1].score?.total);
  });

  it('compares eligible pairs before both caps and preserves the top candidate on reordered input', () => {
    const chain = ['2026-06-18', '2026-06-26'].flatMap((expiry) => (
      Array.from({ length: 12 }, (_, index) => [
        quote('call', 95 + index, 4 - index * 0.20, expiry),
        quote('put', 95 + index, 1 + index * 0.20, expiry),
      ]).flat()
    ));
    const audited = auditCandidates(chain, phase1Protocol.risk, context);
    expect(audited.removedByLegCap).toBeGreaterThan(0);
    expect(audited.removedBySymbolCap).toBeGreaterThan(0);
    expect(audited.retainedOutsideExhaustive).toBe(0);
    expect(audited.bestUnchanged).toBe(true);
    expect(audited.orderInvariant).toBe(true);
  });

  it('rejects conflicting duplicates regardless of order and never fills missing quotes with fixtures', () => {
    const valid = quote('call', 102, 0.50);
    const conflict = { ...valid, bid: 0.35 };
    expect(() => enumerateEligible([valid, conflict], phase1Protocol.risk, context)).toThrow(/unambiguous quote/);
    for (const chain of [[valid, conflict], [conflict, valid]]) {
      const scan = constructStrategies(chain, phase1Protocol.risk, context);
      expect(scan.opportunities).toEqual([]);
      expect(scan.rejections).toContain(`${valid.id} · cotations contradictoires au même horodatage.`);
    }
    expect(enumerateEligible([], phase1Protocol.risk, context)).toEqual([]);
  });
});
