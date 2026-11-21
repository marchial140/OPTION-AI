import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeDemoFixtures } from '@/lib/demo';
import { exitPaperTrade, openPaperTrade, PaperError, portfolioExposure } from '@/lib/server/paper';
import { emptyWorkspace, portfolioAnalytics } from '@/lib/workspace';

const now = new Date('2026-06-04T18:00:00.000Z');
const entryDate = '2026-06-01T15:00:00.000Z';
const exitDates = [1, 2, 3].map((day) => `2026-06-0${day + 1}T15:00:00.000Z`);

function paperInput() {
  const fixture = makeDemoFixtures(now).opportunities.find((item) => item.symbol === 'NVDA')!;
  return { input: { ...fixture.input, quantity: 3, fees: 0.01 }, entryDebit: 181, entryDate };
}

describe('paper portfolio', () => {
  beforeEach(() => vi.useFakeTimers().setSystemTime(now));
  afterEach(() => vi.useRealTimers());

  it('allocates the whole entry cost across partial exits without a rounding remainder', () => {
    const state = emptyWorkspace('demo');
    const trade = openPaperTrade(state, 'demo', paperInput());
    expect(trade).toMatchObject({ maxLoss: 181.01, quantity: 3, remainingQuantity: 3 });
    expect(portfolioExposure(state.portfolio)).toBe(181.01);
    exitPaperTrade(trade, { quantity: 1, exitCredit: 70, exitDate: exitDates[0], fees: .25 });
    expect(trade).toMatchObject({ remainingQuantity: 2, realizedPnl: 9.41, status: 'open' });
    expect(portfolioExposure(state.portfolio)).toBe(120.67);
    expect(portfolioAnalytics(state.portfolio)).toMatchObject({ realizedPnl: 9.41, completedTrades: 0, winRate: null });
    exitPaperTrade(trade, { quantity: 1, exitCredit: 70, exitDate: exitDates[1], fees: .25 });
    exitPaperTrade(trade, { quantity: 1, exitCredit: 70, exitDate: exitDates[2], fees: .25 });
    expect(trade).toMatchObject({ remainingQuantity: 0, realizedPnl: 28.24, status: 'closed' });
    expect(trade.exits.map(({ realizedPnl }) => realizedPnl)).toEqual([9.41, 9.42, 9.41]);
    expect(portfolioExposure(state.portfolio)).toBe(0);
    const analytics = portfolioAnalytics(state.portfolio);
    expect(analytics).toMatchObject({ realizedPnl: 28.24, completedTrades: 1, winRate: 100, stats: { averageWin: 28.24, totalFees: .76 } });
    expect(analytics.equity.at(-1)?.value).toBe(28.24);
  });

  it('checks aggregate exposure before accepting another hypothetical fill', () => {
    const state = emptyWorkspace('demo');
    state.settings = { ...state.settings, accountCapital: 2000, riskPerTrade: 10, maxPortfolioRisk: 12 };
    const trade = openPaperTrade(state, 'demo', paperInput());
    expect(() => openPaperTrade(state, 'demo', paperInput())).toThrow(/enveloppe de risque totale/);
    exitPaperTrade(trade, { quantity: 3, exitCredit: 200, exitDate: exitDates[0], fees: 0 });
    expect(openPaperTrade(state, 'demo', paperInput()).status).toBe('open');
  });

  it('uses the complementary cent when a partial exit rounds entry cost upward', () => {
    const state = emptyWorkspace('demo');
    const data = paperInput();
    const trade = openPaperTrade(state, 'demo', { ...data, input: { ...data.input, quantity: 2 } });
    exitPaperTrade(trade, { quantity: 1, exitCredit: 100, exitDate: exitDates[0], fees: 0 });
    expect(trade.realizedPnl).toBe(9.49);
    expect(portfolioExposure(state.portfolio)).toBe(90.5);
  });

  it('rejects demo contracts in live portfolios', () => {
    const state = emptyWorkspace('live');
    expect(() => openPaperTrade(state, 'live', paperInput())).toThrow(/démonstration/);
    expect(state.portfolio).toHaveLength(0);
  });

  it('rejects excess exits and dates before the recorded trade without mutating the position', () => {
    const state = emptyWorkspace('demo');
    const trade = openPaperTrade(state, 'demo', paperInput());
    expect(() => exitPaperTrade(trade, { quantity: 4, exitCredit: 200, exitDate: exitDates[0], fees: 0 })).toThrow(PaperError);
    expect(() => exitPaperTrade(trade, { quantity: 1, exitCredit: 70, exitDate: '2026-05-30T00:00:00.000Z', fees: 0 })).toThrow(PaperError);
    expect(trade).toMatchObject({ remainingQuantity: 3, realizedPnl: 0, exits: [] });
  });
});
