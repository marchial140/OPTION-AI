import { describe, expect, it } from 'vitest';
import { seedWorkspace } from '@/lib/server/demo-state';
import { portfolioAnalytics } from '@/lib/workspace';

describe('portfolio calendar attribution', () => {
  it('orders exit instants and groups them on a consistent UTC timeline', () => {
    const trade = seedWorkspace('demo',new Date('2026-11-23T16:00:00Z')).portfolio[0];
    const exit = trade.exits[0];
    trade.exits = [
      {...exit,id:'later',exitDate:'2026-11-30T23:55:00-04:00',realizedPnl:-20},
      {...exit,id:'earlier',exitDate:'2026-12-01T02:50:00+00:00',realizedPnl:100},
      {...exit,id:'november',exitDate:'2026-11-30T21:10:00+00:00',realizedPnl:30},
    ];
    trade.realizedPnl = 110;
    const result = portfolioAnalytics([trade]);
    expect(result.equity).toEqual([{date:'2026-11-30',value:30},{date:'2026-12-01',value:110}]);
    expect(result.byMonth).toEqual([{label:'2026-11',value:30,count:1},{label:'2026-12',value:80,count:2}]);
  });
});
