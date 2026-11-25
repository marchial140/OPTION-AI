import { describe, expect, it } from 'vitest';
import {
  assessRisk, calculateStrategy, makeOccSymbol, payoffAt,
  type ContractQuote, type StrategyInput, type StrategyResult,
} from '@/lib/quant';

const now = new Date('2026-11-23T16:00:00Z');
const expiration = '2026-12-11';

function quote(type: ContractQuote['type'], strike: number, bid: number, ask: number): ContractQuote {
  return {
    id: makeOccSymbol('SPY', expiration, type, strike), symbol: 'SPY', type, strike, expiration,
    multiplier: 100, bid, ask, currency: 'USD', volume: 1200, openInterest: 2400,
    quoteAt: '2026-11-23T15:59:00Z', retrievedAt: now.toISOString(),
    source: { url: 'https://example.test/analytical-fixture', publisher: 'Analytical test fixture' }, status: 'VERIFIED_FRESH',
  };
}

const call100 = quote('call', 100, 3.05, 3.20);
const put100 = quote('put', 100, 3.85, 4.00);
const cases = [
  {
    strategy: 'long_call', legs: [call100],
    expected: { entryDebit: 640, maxLoss: 641.30, maxProfit: null, breakEven: 103.2065 },
    settlements: [[0, -641.30], [100, -641.30], [103.2065, 0], [105, 358.70], [120, 3358.70]],
  },
  {
    strategy: 'long_put', legs: [put100],
    expected: { entryDebit: 800, maxLoss: 801.30, maxProfit: 19198.70, breakEven: 95.9935 },
    settlements: [[0, 19198.70], [95, 198.70], [95.9935, 0], [100, -801.30], [120, -801.30]],
  },
  {
    strategy: 'bull_call', legs: [call100, quote('call', 105, 1.40, 1.48)],
    expected: { entryDebit: 360, maxLoss: 361.30, maxProfit: 638.70, breakEven: 101.8065 },
    settlements: [[0, -361.30], [100, -361.30], [101.8065, 0], [105, 638.70], [120, 638.70]],
  },
  {
    strategy: 'bear_put', legs: [put100, quote('put', 95, 2.00, 2.10)],
    expected: { entryDebit: 400, maxLoss: 401.30, maxProfit: 598.70, breakEven: 97.9935 },
    settlements: [[0, 598.70], [95, 598.70], [97.9935, 0], [100, -401.30], [120, -401.30]],
  },
] satisfies {
  strategy: StrategyInput['strategy']; legs: ContractQuote[];
  expected: Pick<StrategyResult, 'entryDebit' | 'maxLoss' | 'maxProfit' | 'breakEven'>;
  settlements: [price: number, pnl: number][];
}[];

describe('Phase 1 analytical finance checks', () => {
  it.each(cases)('computes $strategy across expiration boundaries with two 100-share contracts and total fees', ({ strategy, legs, expected, settlements }) => {
    const input = { strategy, legs, quantity: 2, fees: 1.30 };
    expect(calculateStrategy(input)).toMatchObject({ ...expected, multiplier: 100, quantity: 2, fees: 1.30 });
    expect(settlements.map(([price]) => payoffAt(input, price))).toEqual(settlements.map(([, pnl]) => pnl));
  });

  it('enforces the exact dollar risk thresholds with fees and existing exposure', () => {
    const input: StrategyInput = { strategy: 'long_call', legs: [quote('call', 100, 0.19, 0.20)], quantity: 1, fees: 2.50 };
    const preferences = { capital: 450, maxRiskPercent: 5, maxPortfolioRiskPercent: 20 };
    const riskAt = (fees: number, existingRisk: number) => {
      const position = { ...input, fees };
      return assessRisk(position, calculateStrategy(position), preferences, { now, existingRisk });
    };

    expect(riskAt(2.50, 67.50)).toMatchObject({ eligible: true, maxTradeLoss: 22.50, remainingPortfolioRisk: 22.50 });
    expect(riskAt(2.51, 67.50)).toMatchObject({ eligible: false, reasons: expect.arrayContaining([expect.stringContaining('par opération')]) });
    expect(riskAt(2.50, 67.51)).toMatchObject({ eligible: false, reasons: [expect.stringContaining('exposition cumulée')] });
  });

  it('rejects a fractional contract quantity in the calculation engine', () => {
    expect(() => calculateStrategy({ strategy: 'long_call', legs: [call100], quantity: 1.5, fees: 0 })).toThrow();
  });
});
