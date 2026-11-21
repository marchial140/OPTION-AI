import Decimal from 'decimal.js';
import { makeDemoFixtures } from '@/lib/demo';
import { makeOccSymbol } from '@/lib/quant';
import { emptyWorkspace, type Mode, type PaperTrade } from '@/lib/workspace';

const days = 86_400_000;

export function seedWorkspace(mode: Mode, now = new Date()) {
  const state = emptyWorkspace(mode);
  if (mode !== 'demo') return state;
  const demo = makeDemoFixtures(now);
  state.scans = demo.scanHistory.slice(0, -1).map((point, index) => {
    const completedAt = point.date + 'T14:34:00Z';
    const snapshot = makeDemoFixtures(new Date(completedAt));
    const candidates = snapshot.candidates.slice(0, point.candidates);
    const symbols = candidates.map((item) => item.symbol);
    const opportunities = snapshot.opportunities.filter((item) => symbols.includes(item.symbol)).slice(0, point.opportunities)
      .map((item) => ({...item,id:'demo-history-' + index + '-' + item.id}));
    return {
      id:'demo-history-' + index, type:'quick' as const, status:'completed' as const, tickers:symbols,
      startedAt:point.date + 'T14:30:00Z',completedAt,completed:symbols,failed:[],candidates,
      opportunities,rejections:[],estimatedCost:0,requestCount:0,
    };
  }).reverse();
  state.scans.unshift({
    id:'demo-initial', type:'quick', status:'completed', tickers:demo.candidates.map((item) => item.symbol),
    startedAt:new Date(now.getTime() - 5 * 60_000).toISOString(), completedAt:now.toISOString(),
    completed:demo.candidates.map((item) => item.symbol), failed:[], candidates:demo.candidates,
    opportunities:demo.opportunities, rejections:[], estimatedCost:0, requestCount:0,
  });
  const outcomes = [128.7, 92.6, -57.4, 151.2, -26.8, 133.5, 72.2];
  state.portfolio = outcomes.flatMap((pnl, index): PaperTrade[] => {
    const item = demo.opportunities[index % demo.opportunities.length];
    if (!item) return [];
    const entryDate = new Date(now.getTime() - (35 - index * 4) * days).toISOString();
    const exitDate = new Date(now.getTime() - (30 - index * 4) * days).toISOString();
    const expiration = new Date(Date.parse(entryDate) + 21 * days).toISOString().slice(0, 10);
    const input = {
      ...item.input,
      fees: 1.3,
      legs: item.input.legs.map((leg) => ({
        ...leg, expiration, quoteAt: entryDate, retrievedAt: entryDate,
        id: makeOccSymbol(leg.symbol, expiration, leg.type, leg.strike),
      })),
    };
    const fees = 1.3;
    const exitCredit = new Decimal(item.result.entryDebit).plus(pnl).plus(fees).plus(fees).toNumber();
    return [{
      id:'demo-trade-' + index, symbol:item.symbol, strategy:item.strategy, input, entryDebit:item.result.entryDebit,
      entryDate, expiration, quantity:input.quantity, remainingQuantity:0, fees,
      maxLoss:new Decimal(item.result.entryDebit).plus(fees).toNumber(),
      notes:'Position papier synthétique, enregistrée pour illustrer le journal.',
      thesis:item.thesis, researchScore:item.score?.total, status:'closed', mode, realizedPnl:pnl,
      exits:[{id:'demo-exit-' + index, quantity:input.quantity, exitCredit, exitDate, fees, realizedPnl:pnl}],
    }];
  }).reverse();
  return state;
}
