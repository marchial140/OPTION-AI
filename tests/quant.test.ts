import { describe, expect, it } from 'vitest';
import { makeDemoFixtures } from '@/lib/demo';
import {
  assessRisk, calculateStrategy, compareOpportunities, constructStrategies, createPayoffSeries, daysToExpiration,
  makeOccSymbol, optionTradingCutoff, payoffAt, quotesAreSynchronized, scoreOpportunity, validateQuote, type ContractQuote, type StrategyInput,
} from '@/lib/quant';

const now = new Date('2026-06-01T15:00:00.000Z');
const expiration = '2026-06-18';

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
  it('keeps automatic cached quotes indicative and expires them after thirty minutes', () => {
    const snapshot = quote('call', 100, 1.7, 1.9, {
      source: { url: 'https://api.marketdata.app/v1/options/chain/SPY/', publisher: 'Market Data', method: 'marketdata-cached' },
      status: 'VERIFIED_DELAYED',
    });
    expect(validateQuote(snapshot, 'SPY', now)).toEqual({ valid: true, status: 'VERIFIED_DELAYED' });
    expect(validateQuote(snapshot, 'SPY', new Date('2026-06-01T15:25:01.000Z'))).toMatchObject({ valid: false, status: 'STALE' });
  });

  it('reproduces the bull call debit spread example', () => {
    const input = bullCall();
    expect(calculateStrategy(input)).toMatchObject({ entryDebit: 180, maxLoss: 180, maxProfit: 320, breakEven: 101.8 });
    expect(payoffAt(input, 99)).toBe(-180);
    expect(payoffAt(input, 101.8)).toBe(0);
    expect(payoffAt(input, 125)).toBe(320);
    expect(payoffAt(input, Number.MAX_VALUE)).toBe(320);
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
    expect(() => payoffAt(input, Number.MAX_VALUE)).toThrow(/plage de calcul/);
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
    expect(daysToExpiration(expiration, new Date('2026-06-19T00:55:00.000Z'))).toBe(0);
  });

  it('uses the New York regular cutoff on daylight saving, shortened and closed days', () => {
    expect(optionTradingCutoff('2026-06-18')).toBe(Date.parse('2026-06-18T20:00:00Z'));
    expect(optionTradingCutoff('2026-12-04')).toBe(Date.parse('2026-12-04T21:00:00Z'));
    expect(optionTradingCutoff('2026-11-27')).toBe(Date.parse('2026-11-27T18:00:00Z'));
    expect(optionTradingCutoff('2026-06-19')).toBeNull();
    expect(optionTradingCutoff('2026-06-20')).toBeNull();
    const valid = quote('call', 100, 2.1, 2.2, { quoteAt: '2026-06-18T19:59:00Z', retrievedAt: '2026-06-18T19:59:30Z' });
    expect(validateQuote(valid, 'SPY', new Date('2026-06-18T19:59:30Z')).valid).toBe(true);
    expect(validateQuote(valid, 'SPY', new Date('2026-06-18T20:00:00Z'))).toMatchObject({ valid: false, status: 'VERIFIED_HISTORICAL' });
    expect(validateQuote({ ...valid, status: 'UNVERIFIED' }, 'SPY', new Date('2026-06-18T20:00:00Z'))).toMatchObject({ valid: false, status: 'UNVERIFIED' });
    expect(validateQuote({ ...valid, source: { url: 'http://example.test', publisher: 'Test' } }, 'SPY', new Date('2026-06-18T20:00:00Z'))).toMatchObject({ valid: false, status: 'UNVERIFIED' });
  });

  it('keeps manual attestations distinct from exchange quote freshness', () => {
    const input = bullCall();
    input.legs[0].status = 'MANUAL_ATTESTED';
    input.legs[1].status = 'VERIFIED_DELAYED';
    input.legs[1].source.method = 'manual-broker';
    for (const contract of input.legs) expect(validateQuote(contract, 'SPY', now)).toEqual({ valid: true, status: 'MANUAL_ATTESTED' });
    expect(validateQuote(input.legs[0], 'SPY', new Date('2026-06-03T15:00:00.000Z'))).toMatchObject({ valid: false, status: 'STALE' });
    expect(validateQuote(input.legs[0], 'SPY', new Date('2026-06-19T15:00:00.000Z'))).toMatchObject({ valid: false, status: 'STALE' });
    const candidate = { ...makeDemoFixtures(now).candidates.find(({ symbol }) => symbol === 'SPY')!, status: 'UNVERIFIED' as const };
    const result = constructStrategies(input.legs, { capital: 10_000, maxRiskPercent: 5, strategies: ['bull_call'] }, { candidate, now });
    expect(result.opportunities[0]).toMatchObject({ status: 'MANUAL_ATTESTED', score: { breakdown: expect.arrayContaining([expect.objectContaining({ key: 'quality', value: 65 })]) } });
  });

  it('rejects spreads that combine individually valid quotes observed too far apart', () => {
    const input = bullCall();
    input.legs[1].quoteAt = '2026-06-01T14:49:59Z';
    expect(input.legs.every((contract) => validateQuote(contract, 'SPY', now).valid)).toBe(true);
    expect(quotesAreSynchronized(input.legs)).toBe(false);
    expect(assessRisk(input, calculateStrategy(input), { capital: 10000, maxRiskPercent: 5 }, { now })).toMatchObject({ eligible: false, reasons: [expect.stringContaining('plus de cinq minutes')] });
    input.legs[1].quoteAt = '2026-06-01T14:50:00Z';
    expect(quotesAreSynchronized(input.legs)).toBe(true);
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

  it('reports an unknown earnings calendar without treating it as confirmed or disqualifying', () => {
    const input = bullCall();
    const preferences = { capital: 10_000, maxRiskPercent: 5, avoidEarnings: true };
    const risk = assessRisk(input, calculateStrategy(input), preferences, { now });
    expect(risk.eligible).toBe(true);
    expect(risk.warnings).toContainEqual(expect.stringContaining('calendrier des résultats est inconnu'));
    expect(assessRisk(input, calculateStrategy(input), { ...preferences, avoidEarnings: false }, { now }).warnings)
      .not.toContainEqual(expect.stringContaining('calendrier des résultats est inconnu'));
  });

  it('computes deterministic scores and leaves unavailable components unranked', () => {
    const input = bullCall();
    const result = calculateStrategy(input);
    expect(scoreOpportunity(input, result, 'bullish')?.total).toBeGreaterThan(scoreOpportunity(input, result, 'bearish')?.total ?? 100);
    expect(scoreOpportunity(input, result, 'bullish', { liquidity: 100, payoff: 0, direction: 0, execution: 0, quality: 0 })?.total).toBe(100);
    input.legs[0].openInterest = undefined;
    expect(scoreOpportunity(input, result, 'bullish')).toBeNull();
  });

  it('permits a quality-only score and keeps absent enabled criteria unscored', () => {
    const input: StrategyInput = {
      strategy: 'long_call', quantity: 1, fees: 0,
      legs: [quote('call', 100, 3.05, 3.2, { volume: undefined, openInterest: undefined })],
    };
    const result = calculateStrategy(input);
    const qualityOnly = { liquidity: 0, payoff: 0, direction: 0, execution: 0, quality: 100 };
    expect(scoreOpportunity(input, result, 'insufficient')).toBeNull();
    expect(scoreOpportunity(input, result, 'insufficient', { ...qualityOnly, direction: 1 })).toBeNull();
    expect(scoreOpportunity(input, result, 'insufficient', qualityOnly)).toMatchObject({
      total: 100, breakdown: [{ key: 'quality', weight: 100, value: 100 }],
    });
    input.legs[0].status = 'UNVERIFIED';
    expect(scoreOpportunity(input, result, 'insufficient', qualityOnly)).toBeNull();
  });

  it('raises the intended criterion when all other inputs are held constant', () => {
    const input = bullCall();
    const base = scoreOpportunity(input, calculateStrategy(input), 'bullish')!;
    const higherCost = { ...input, fees: 64 };
    const higherCostScore = scoreOpportunity(higherCost, calculateStrategy(higherCost), 'bullish')!;
    expect(higherCostScore.total).toBeLessThan(base.total);
    expect(higherCostScore.breakdown.filter(({ key }) => key !== 'payoff')).toEqual(base.breakdown.filter(({ key }) => key !== 'payoff'));

    const narrower = { ...input, legs: [{ ...input.legs[0], bid: 3.19 }, { ...input.legs[1], ask: 1.41 }] };
    const narrowerScore = scoreOpportunity(narrower, calculateStrategy(narrower), 'bullish')!;
    expect(narrowerScore.total).toBeGreaterThan(base.total);
    expect(narrowerScore.breakdown.filter(({ key }) => key !== 'execution')).toEqual(base.breakdown.filter(({ key }) => key !== 'execution'));

    const thinner = { ...input, legs: [{ ...input.legs[0], volume: 20, openInterest: 40 }, input.legs[1]] };
    const thinnerScore = scoreOpportunity(thinner, calculateStrategy(thinner), 'bullish')!;
    expect(thinnerScore.total).toBeLessThan(base.total);
    expect(thinnerScore.breakdown.filter(({ key }) => key !== 'liquidity')).toEqual(base.breakdown.filter(({ key }) => key !== 'liquidity'));
  });

  it('selects the best admissible short legs from a captured chain regardless of feed order', () => {
    const candidate = { ...makeDemoFixtures(now).candidates.find(({ symbol }) => symbol === 'SPY')!, status: 'UNVERIFIED' as const };
    const [long] = bullCall().legs;
    const earlierInvalidRows = Array.from({ length: 48 }, (_, index) => quote('call', 120 + index, .21, .24, { multiplier: 10 }));
    const shorts = [[103, 2.15, 2.24], [104, 1.6, 1.68], [105, 1.25, 1.3], [106, .99, 1.02], [107, .73, .77], [108, .60, .62], [109, .55, .56]]
      .map(([strike, bid, ask]) => quote('call', strike, bid, ask, { volume: strike === 109 ? 1000 : 50 }));
    const chain = [...earlierInvalidRows, long, ...shorts];
    const preferences = { capital: 10_000, maxRiskPercent: 5, strategies: ['bull_call' as const] };
    const context = { candidate, now, weights: { liquidity: 100, payoff: 0, direction: 0, execution: 0, quality: 0 } };
    const fromLong = (items: ReturnType<typeof constructStrategies>['opportunities']) => items.filter((item) => item.input.legs[0].id === long.id);
    const records = fromLong(constructStrategies(chain, preferences, context).opportunities);
    expect(records).toHaveLength(5);
    expect(records[0]?.input.legs[1].strike).toBe(109);
    expect(fromLong(constructStrategies([...chain].reverse(), preferences, context).opportunities)).toEqual(records);

    const [best, next] = records;
    expect(compareOpportunities(best, next)).toBeLessThan(0);
    expect(compareOpportunities({ ...best, score: null }, next)).toBeGreaterThan(0);
    expect(compareOpportunities({ ...next, symbol: 'AMD' }, next)).toBeLessThan(0);
  });

  it('replays a dated snapshot without using unavailable or expired quote evidence', () => {
    const candidate = { ...makeDemoFixtures(now).candidates.find(({ symbol }) => symbol === 'SPY')!, status: 'UNVERIFIED' as const };
    const [long, short] = bullCall().legs;
    const unavailableAtCapture = { ...short, bid: 1.45, quoteAt: '2026-06-01T14:56:00Z', retrievedAt: '2026-06-01T15:05:00Z' };
    const preferences = { capital: 10_000, maxRiskPercent: 5, strategies: ['bull_call' as const] };
    const captured = constructStrategies([long, short, unavailableAtCapture], preferences, { candidate, now });
    expect(captured.opportunities[0]).toMatchObject({ result: { entryDebit: 180 }, updatedAt: now.toISOString() });
    const newer = constructStrategies([long, short, unavailableAtCapture], preferences, { candidate, now: new Date('2026-06-01T15:10:00Z') });
    expect(newer.opportunities[0]?.result.entryDebit).toBe(175);
    const expired = constructStrategies([long, short], preferences, { candidate, now: new Date('2026-06-19T15:00:00Z') });
    expect(expired.opportunities).toHaveLength(0);
    expect(captured.opportunities[0]?.result.entryDebit).toBe(180);
  });

  it('preserves representatives across ranked strategies and expiries when limiting saved results', () => {
    const candidate = { ...makeDemoFixtures(now).candidates.find(({ symbol }) => symbol === 'SPY')!, status: 'UNVERIFIED' as const };
    const expiries = [expiration, '2026-06-26', '2026-06-29'];
    const types = ['call', 'put'] as const;
    const chain = expiries.flatMap((expiry) => types.flatMap((type) => Array.from({ length: 12 }, (_, index) => {
      const strike = 95 + index;
      const bid = (100 + (type === 'call' ? 11 - index : index) * 13) / 100;
      return quote(type, strike, bid, bid + 0.05, { expiration: expiry, id: makeOccSymbol('SPY', expiry, type, strike) });
    })));
    const context = { candidate, now };
    const preferences = { capital: 10_000, maxRiskPercent: 5 };
    const results = constructStrategies(chain, preferences, context).opportunities;
    expect(results).toHaveLength(60);
    expect(results).toEqual([...results].sort(compareOpportunities));
    for (const expiry of expiries) {
      expect(new Set(results.filter((item) => item.expiration === expiry).map((item) => item.strategy)))
        .toEqual(new Set(['bull_call', 'bear_put', 'long_call', 'long_put']));
    }
    expect(constructStrategies([...chain].reverse(), preferences, context).opportunities).toEqual(results);
  });

  it('handles identical duplicates, conflicting quotes and no-trade results', () => {
    const demoCandidate = makeDemoFixtures(now).candidates.find(({ symbol }) => symbol === 'SPY')!;
    const candidate = { ...demoCandidate, status: 'UNVERIFIED' as const };
    const [long, short] = bullCall().legs;
    const prefs = { capital: 10_000, maxRiskPercent: 5, strategies: ['bull_call'] as const };
    const withDuplicates = constructStrategies([long, short, long], { ...prefs, strategies: [...prefs.strategies] }, { candidate, now });
    expect(withDuplicates.opportunities).toHaveLength(1);
    const conflict = constructStrategies([long, short, { ...long, ask: 3.3, quoteAt: '2026-06-01T10:55:00-04:00' }], { ...prefs, strategies: [...prefs.strategies] }, { candidate, now });
    expect(conflict.opportunities).toHaveLength(0);
    expect(conflict.rejections.join(' ')).toContain('contradictoires');
    const newQuote = { ...long, ask: 3.15, quoteAt: '2026-06-01T14:56:00Z' };
    const recovered = constructStrategies([long, short, { ...long, ask: 3.3 }, newQuote], { ...prefs, strategies: [...prefs.strategies] }, { candidate, now });
    expect(recovered.opportunities[0]?.input.legs[0].ask).toBe(3.15);
    const missingMetadata = { ...long, volume: undefined };
    const metadataConflict = { ...long, volume: 350 };
    const conflicted = [missingMetadata, metadataConflict, long, short];
    const context = { candidate, now };
    expect(constructStrategies(conflicted, { ...prefs, strategies: [...prefs.strategies] }, context).opportunities).toHaveLength(0);
    expect(constructStrategies([...conflicted].reverse(), { ...prefs, strategies: [...prefs.strategies] }, context).opportunities).toHaveLength(0);
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
    expect(constructStrategies(bullCall().legs, prefs, { candidate, now, allowDemo: true }).opportunities).toHaveLength(0);
  });
});
