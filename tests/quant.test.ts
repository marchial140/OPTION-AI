import { describe, expect, it } from 'vitest';
import { makeDemoFixtures } from '@/lib/demo';
import {
  assessRisk, calculateStrategy, constructStrategies, createPayoffSeries, daysToExpiration,
  makeOccSymbol, payoffAt, scoreOpportunity, validateQuote, type ContractQuote, type StrategyInput,
} from '@/lib/quant';

const now = new Date('2026-06-01T15:00:00.000Z');
const expiration = '2026-06-19';

function quote(type: ContractQuote['type'], strike: number, bid: number, ask: number, overrides: Partial<ContractQuote> = {}): ContractQuote {
  return {
    id: makeOccSymbol('SPY', expiration, type, strike), symbol: 'SPY', type, strike, expiration,
    multiplier: 100, bid, ask, currency: 'USD', quoteAt: '2026-06-01T14:55:00.000Z', retrievedAt: now.toISOString(),
    source: { url: 'https://example.test/options-fixture', publisher: 'Test fixture' }, volume: 1100, openInterest: 3000,
    status: 'VERIFIED_FRESH', ...overrides,
  };
}

function bullCall(): StrategyInput {
  return { strategy: 'bull_call', legs: [quote('call', 100, 3.05, 3.2), quote('call', 105, 1.4, 1.48)], quantity: 1, fees: 0 };
}

function bearPut(): StrategyInput {
  return { strategy: 'bear_put', legs: [quote('put', 100, 3.88, 4), quote('put', 95, 2, 2.12)], quantity: 1, fees: 0 };
}

describe('payoff engine', () => {
  it('reproduces the bull call debit spread example', () => {
    const input = bullCall();
    expect(calculateStrategy(input)).toMatchObject({ entryDebit: 180, maxLoss: 180, maxProfit: 320, breakEven: 101.8 });
    expect(payoffAt(input, 99)).toBe(-180);
    expect(payoffAt(input, 101.8)).toBe(0);
    expect(payoffAt(input, 125)).toBe(320);
  });

  it('reproduces the bear put debit spread example', () => {
    const input = bearPut();
    expect(calculateStrategy(input)).toMatchObject({ entryDebit: 200, maxLoss: 200, maxProfit: 300, breakEven: 98, rewardRisk: 1.5 });
    expect(payoffAt(input, 120)).toBe(-200);
    expect(payoffAt(input, 98)).toBe(0);
    expect(payoffAt(input, 75)).toBe(300);
  });

  it('models a long call with no finite maximum profit', () => {
    const input: StrategyInput = { ...bullCall(), strategy: 'long_call', legs: [quote('call', 100, 2.4, 2.5)] };
    expect(calculateStrategy(input)).toMatchObject({ entryDebit: 250, maxLoss: 250, maxProfit: null, breakEven: 102.5, rewardRisk: null });
    expect(payoffAt(input, 99)).toBe(-250);
    expect(payoffAt(input, 120)).toBe(1750);
  });

  it('models a long put with profit capped at an underlying price of zero', () => {
    const input: StrategyInput = { ...bearPut(), strategy: 'long_put', legs: [quote('put', 100, 3.8, 4)] };
    expect(calculateStrategy(input)).toMatchObject({ entryDebit: 400, maxLoss: 400, maxProfit: 9600, breakEven: 96 });
    expect(payoffAt(input, 120)).toBe(-400);
    expect(payoffAt(input, 0)).toBe(9600);
  });

  it('scales contract quantity and applies fees once to the full position', () => {
    const input = { ...bullCall(), quantity: 3, fees: 3.15 };
    const result = calculateStrategy(input);
    expect(result).toMatchObject({ entryDebit: 540, positionCost: 543.15, maxLoss: 543.15, maxProfit: 956.85, breakEven: 101.8105 });
    expect(payoffAt(input, 101.8105)).toBe(0);
  });

  it('preserves decimal quote precision and includes exact chart landmarks', () => {
    const input = { ...bullCall(), legs: [quote('call', 100, 0.1, 0.3), quote('call', 105, 0.1, 0.11)] };
    expect(calculateStrategy(input).netDebitPerShare).toBe(0.2);
    const curve = createPayoffSeries(input, 95, 110, 3);
    expect(curve).toContainEqual({ underlying: 100.2, pnl: 0 });
    expect(curve).toContainEqual({ underlying: 105, pnl: 480 });
  });

  it('reports unreachable net break-even when oversized fees exceed spread payout', () => {
    const input = { ...bullCall(), fees: 400 };
    expect(calculateStrategy(input)).toMatchObject({ maxProfit: -80, breakEven: null });
    expect(payoffAt(input, 110)).toBe(-80);
  });

  it('rejects legs with incompatible strike order, expiration, type and multiplier', () => {
    const input = bullCall();
    expect(() => calculateStrategy({ ...input, legs: [...input.legs].reverse() })).toThrow(/strikes/);
    expect(() => calculateStrategy({ ...input, legs: [input.legs[0], quote('call', 105, 1.4, 1.48, { expiration: '2026-06-26', id: makeOccSymbol('SPY', '2026-06-26', 'call', 105) })] })).toThrow(/échéance/);
    expect(() => calculateStrategy({ ...input, legs: [input.legs[0], quote('put', 105, 1.4, 1.48)] })).toThrow(/Type/);
    expect(() => calculateStrategy({ ...input, legs: [input.legs[0], { ...input.legs[1], multiplier: 10 }] })).toThrow(/non standards/);
  });

  it('rejects zero-credit and uneconomic debit spreads, and nonfinite values', () => {
    const input = bullCall();
    expect(() => calculateStrategy({ ...input, legs: [quote('call', 100, 1, 1.2), input.legs[1]] })).toThrow(/positif/);
    expect(() => calculateStrategy({ ...input, legs: [quote('call', 100, 7, 7.2), input.legs[1]] })).toThrow(/valeur maximale/);
    expect(() => calculateStrategy({ ...input, quantity: 0 })).toThrow();
    expect(() => calculateStrategy({ ...input, fees: Number.NaN })).toThrow();
    expect(() => payoffAt(input, Number.POSITIVE_INFINITY)).toThrow();
  });
});

describe('quote verification and ranking', () => {
  it('rejects missing required prices and timestamps and crossed spreads', () => {
    const valid = quote('call', 100, 2.1, 2.2);
    const withoutAsk = { ...valid, ask: undefined } as unknown as ContractQuote;
    const withoutTimestamp = { ...valid, quoteAt: '' };
    expect(validateQuote(withoutAsk, 'SPY', now)).toMatchObject({ valid: false, status: 'INSUFFICIENT' });
    expect(validateQuote(withoutTimestamp, 'SPY', now)).toMatchObject({ valid: false, status: 'INSUFFICIENT' });
    expect(validateQuote({ ...valid, bid: 2.3 }, 'SPY', now)).toMatchObject({ valid: false, status: 'CONTRADICTORY' });
  });

  it('preserves quote provenance and classifies according to quote time', () => {
    const valid = quote('call', 100, 2.1, 2.2);
    expect(validateQuote(valid, 'SPY', now)).toEqual({ valid: true, status: 'VERIFIED_FRESH' });
    expect(validateQuote({ ...valid, quoteAt: '2026-06-01T13:30:00.000Z' }, 'SPY', now)).toEqual({ valid: true, status: 'VERIFIED_DELAYED' });
    expect(validateQuote({ ...valid, quoteAt: '2026-05-27T14:55:00.000Z' }, 'SPY', now)).toMatchObject({ valid: false, status: 'STALE' });
    expect(validateQuote({ ...valid, source: { ...valid.source, url: 'javascript:alert(1)' } }, 'SPY', now)).toMatchObject({ valid: false, status: 'UNVERIFIED' });
    expect(validateQuote({ ...valid, quoteAt: '2026-06-01T15:03:00.000Z' }, 'SPY', now)).toMatchObject({ valid: false, status: 'CONTRADICTORY' });
  });

  it('rejects mismatches and expiration based on New York calendar dates', () => {
    const valid = quote('call', 100, 2.1, 2.2);
    expect(validateQuote(valid, 'QQQ', now)).toMatchObject({ valid: false, status: 'CONTRADICTORY' });
    expect(validateQuote({ ...valid, id: makeOccSymbol('SPY', expiration, 'put', 100) }, 'SPY', now)).toMatchObject({ valid: false, status: 'CONTRADICTORY' });
    expect(validateQuote(valid, 'SPY', new Date('2026-06-20T15:00:00.000Z'))).toMatchObject({ valid: false, status: 'VERIFIED_HISTORICAL' });
    expect(daysToExpiration('2026-06-19', new Date('2026-06-20T00:55:00.000Z'))).toBe(0);
  });

  it('enforces the $22.50 trade limit for $450 capital and 5% risk', () => {
    const input: StrategyInput = { strategy: 'long_call', legs: [quote('call', 100, 0.39, 0.4)], quantity: 1, fees: 0 };
    const risk = assessRisk(input, calculateStrategy(input), { capital: 450, maxRiskPercent: 5 }, { now });
    expect(risk).toMatchObject({ eligible: false, maxTradeLoss: 22.5 });
    expect(risk.reasons.join(' ')).toMatch(/22,50/);
  });

  it('enforces remaining exposure, position counts, earnings and missing liquidity', () => {
    const input = bullCall();
    input.legs[0].volume = undefined;
    const risk = assessRisk(input, calculateStrategy(input), { capital: 10_000, maxRiskPercent: 5, minVolume: 5, maxPositions: 2 }, {
      now, existingRisk: 1900, openPositions: 2, earningsAt: '2026-06-12',
    });
    expect(risk).toMatchObject({ eligible: false, remainingPortfolioRisk: 100 });
    expect(risk.reasons.join(' ')).toMatch(/exposition.*positions.*résultats.*volume/);
  });

  it('computes deterministic scores and leaves unavailable components unranked', () => {
    const input = bullCall();
    const result = calculateStrategy(input);
    expect(scoreOpportunity(input, result, 'bullish')?.total).toBeGreaterThan(scoreOpportunity(input, result, 'bearish')?.total ?? 100);
    expect(scoreOpportunity(input, result, 'bullish', { liquidity: 100, payoff: 0, direction: 0, execution: 0, quality: 0 })?.total).toBe(100);
    input.legs[0].openInterest = undefined;
    expect(scoreOpportunity(input, result, 'bullish')).toBeNull();
  });

  it('handles identical duplicates, conflicting quotes and no-trade results', () => {
    const demoCandidate = makeDemoFixtures(now).candidates.find(({ symbol }) => symbol === 'SPY')!;
    const candidate = { ...demoCandidate, status: 'UNVERIFIED' as const };
    const [long, short] = bullCall().legs;
    const prefs = { capital: 10_000, maxRiskPercent: 5, strategies: ['bull_call'] as const };
    const withDuplicates = constructStrategies([long, short, long], { ...prefs, strategies: [...prefs.strategies] }, { candidate, now });
    expect(withDuplicates.opportunities).toHaveLength(1);
    const conflict = constructStrategies([long, short, { ...long, ask: 3.3 }], { ...prefs, strategies: [...prefs.strategies] }, { candidate, now });
    expect(conflict.opportunities).toHaveLength(0);
    expect(conflict.rejections.join(' ')).toContain('contradictoires');
    expect(constructStrategies([], { ...prefs, strategies: [...prefs.strategies] }, { candidate, now }).rejections[0]).toContain('Aucune cotation');
  });

  it('updates demo evidence for the requested clock and isolates it from production construction', () => {
    const fixtures = makeDemoFixtures(now);
    expect(fixtures.candidates).toHaveLength(6);
    expect(fixtures.opportunities).toHaveLength(6);
    expect(fixtures.quotes.every((contract) => contract.status === 'DEMO' && contract.retrievedAt === now.toISOString())).toBe(true);
    const candidate = fixtures.candidates.find(({ symbol }) => symbol === 'SPY')!;
    const quotes = fixtures.quotes.filter(({ symbol }) => symbol === candidate.symbol);
    const prefs = { capital: 10_000, maxRiskPercent: 5 };
    const live = constructStrategies(quotes, prefs, { candidate: { ...candidate, status: 'UNVERIFIED' }, now });
    expect(live.opportunities).toHaveLength(0);
    expect(live.rejections.join(' ')).toContain('fictive');
    expect(constructStrategies(bullCall().legs, prefs, { candidate, now }).opportunities).toHaveLength(0);
  });
});
