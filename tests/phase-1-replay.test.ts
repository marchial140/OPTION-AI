import { describe, expect, it } from 'vitest';
import {
  constructStrategies, makeOccSymbol, optionTradingCutoff,
} from '../src/lib/quant';
import type { ContractQuote } from '../src/lib/quant';
import { phase1Protocol } from '../scripts/phase-1/config';
import {
  buildSchedule, createSignalContext, drawUniform, missingEntryPlan, phase1Risk,
  replaySelections, summarizeRun, symmetricScore,
} from '../scripts/phase-1/replay';

function quote(date: string, expiration: string, type: 'call' | 'put', strike: number, bid: number, ask: number): ContractQuote {
  const quoteAt = new Date(optionTradingCutoff(date)!).toISOString();
  return {
    id: makeOccSymbol('AAPL', expiration, type, strike), symbol: 'AAPL', type, strike,
    expiration, multiplier: 100, bid, ask, currency: 'USD', quoteAt, retrievedAt: quoteAt,
    status: 'VERIFIED_DELAYED', volume: 500, openInterest: 1500,
    source: { url: 'https://example.com/analytical-test', publisher: 'Test' },
  };
}

function vertical(signalDate = '2026-09-14', entryDate = '2026-09-15', expiration = '2026-09-25') {
  const legs = [
    quote(signalDate, expiration, 'call', 155, 1.15, 1.2),
    quote(signalDate, expiration, 'call', 160, 0.30, 0.35),
  ];
  const opportunities = constructStrategies(legs, phase1Risk, createSignalContext(signalDate, 150)).opportunities;
  const opportunity = opportunities.find(({ strategy }) => strategy === 'bull_call')!;
  const entryQuotes = new Map([[entryDate, new Map(legs.map(({ id, type, strike, bid, ask }) => [
    id, quote(entryDate, expiration, type, strike, bid, ask),
  ]))]]);
  return { selection: { signalDate, entryDate, opportunity }, entryQuotes };
}

describe('Phase 1 offline replay', () => {
  it('uses anchored biweekly dates, rolls closures forward, and stops when no next session remains', () => {
    const sessions = new Map<string, number>();
    for (let timestamp = Date.parse(phase1Protocol.start); timestamp <= Date.parse(phase1Protocol.horizon); timestamp += 86_400_000) {
      const date = new Date(timestamp).toISOString().slice(0, 10);
      if (optionTradingCutoff(date) !== null) sessions.set(date, 1);
    }
    const schedule = buildSchedule(sessions);
    expect(schedule).toHaveLength(26);
    expect(schedule[0]).toEqual({ signalDate: '2025-11-24', entryDate: '2025-11-25' });
    expect(schedule).toContainEqual({ signalDate: '2026-05-26', entryDate: '2026-05-27' });
    expect(schedule.at(-1)).toEqual({ signalDate: '2026-11-09', entryDate: '2026-11-10' });
    sessions.delete('2026-02-20');
    expect(() => buildSchedule(sessions)).toThrow('Expected 251 AAPL closes');
  });

  it('treats mirrored single legs symmetrically using the hypothetical expiry payoff', () => {
    const date = '2026-09-14';
    const expiration = '2026-09-25';
    const legs = [quote(date, expiration, 'call', 105, 3.9, 4), quote(date, expiration, 'put', 95, 3.9, 4)];
    const [put, call] = constructStrategies(legs, phase1Risk, createSignalContext(date, 100)).opportunities;
    expect(put.strategy).toBe('long_put');
    expect(put.score?.breakdown.find((component) => component.key === 'payoff')?.value).toBe(100);
    expect(call.score).toBeNull();
    expect(symmetricScore(call, 100)).toEqual(symmetricScore(put, 100));
    expect(symmetricScore(call, 100)?.breakdown.find((component) => component.key === 'payoff')?.value).toBe(9.84);
    expect(call.result.maxProfit).toBeNull();
  });

  it('draws reproducibly from the predefined seeds and respects the range', () => {
    const firstPass = phase1Protocol.randomSeeds.map((seed) => drawUniform(seed, '2026-11-09', 41));
    expect(phase1Protocol.randomSeeds.map((seed) => drawUniform(seed, '2026-11-09', 41))).toEqual(firstPass);
    expect(firstPass.every((draw) => draw >= 0 && draw < 41)).toBe(true);
    expect(new Set(firstPass).size).toBeGreaterThan(10);
    expect(drawUniform(phase1Protocol.randomSeeds[0], '2026-11-09', 1)).toBe(0);
    expect(() => drawUniform(phase1Protocol.randomSeeds[0], '2026-11-09', 0)).toThrow();
  });

  it('prices long at ask and short at bid, including fees for a favorable move below break-even', () => {
    const { selection, entryQuotes } = vertical();
    const closes = new Map([[selection.entryDate, 150], [selection.opportunity.expiration, 155.5]]);
    const run = replaySelections('A', { closes }, [selection], entryQuotes);
    expect(run.trades[0]).toMatchObject({
      entryDebit: 90, maxLoss: 91.3, maxProfit: 408.7, breakEven: 155.913,
      favorable: true, maximumLoss: false, grossPnl: -40, fees: 1.30, netPnl: -41.30,
    });
  });

  it('leaves an unquoted leg unresolved, distinct from a risk rejection or full-period P&L', () => {
    const { selection, entryQuotes } = vertical();
    const missing = selection.opportunity.input.legs[1].id;
    entryQuotes.get(selection.entryDate)!.delete(missing);
    const closes = new Map([[selection.entryDate, 150], [selection.opportunity.expiration, 155.5]]);
    const run = replaySelections('B', { closes }, [selection], entryQuotes);
    expect(run.rejections).toEqual([]);
    expect(missingEntryPlan([run])).toEqual([{ date: selection.entryDate, symbol: 'AAPL', contract: missing, configs: ['B'] }]);
    expect(summarizeRun(run)).toMatchObject({
      executed_trades: null, rejected_trades: null, net_pnl_usd: null, realized_net_pnl_usd_through_horizon: null,
    });
  });

  it('retains a verified entry past the horizon without inventing a mark or forcing liquidation', () => {
    const { selection, entryQuotes } = vertical('2026-11-09', '2026-11-10', '2026-11-27');
    const run = replaySelections('D', { closes: new Map([[selection.entryDate, 150]]) }, [selection], entryQuotes);
    expect(run.openPastHorizon).toBe(1);
    expect(run.signalsWithMissingSettlement).toBe(0);
    expect(summarizeRun(run)).toMatchObject({
      executed_trades: 1, bull_call: 1, transaction_costs_usd: 1.30,
      net_pnl_usd: null, settled_trades_through_horizon: 0, realized_net_pnl_usd_through_horizon: 0,
    });
  });
});
