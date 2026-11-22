import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { GET, POST, DELETE } from '@/app/api/[[...path]]/route';
import { constructStrategies, makeOccSymbol, optionTradingCutoff, type ResearchCandidate } from '@/lib/quant';
import { riskPreferences } from '@/lib/server/jobs';
import { emptyWorkspace, type AppState, type Scan, type WorkspaceState } from '@/lib/workspace';
import { seedWorkspace } from '@/lib/server/demo-state';

const harness = vi.hoisted(() => ({ state:undefined as unknown as WorkspaceState }));
vi.mock('@/lib/server/auth', async (load) => ({
  ...await load<typeof import('@/lib/server/auth')>(),
  getIdentity: async () => ({mode:'live',userId:'20602232-3ab2-49b8-9b20-5fdee0512a9b',token:'fixture'}),
}));
vi.mock('@/lib/server/store', () => ({
  readWorkspace: async () => structuredClone(harness.state),
  mutateWorkspace: async (_:unknown,update:(draft:WorkspaceState)=>unknown) => {
    const draft = structuredClone(harness.state);
    const result = update(draft);
    harness.state = draft;
    return result;
  },
  StorageError: class extends Error {},
  listScheduledIdentities: async () => [],
}));

const now = '2026-11-23T15:15:00.000Z';
const expiration = '2026-12-11';
const scenario: ResearchCandidate = {
  symbol:'NVDA',name:'NVIDIA',status:'UNVERIFIED',price:null,change:null,direction:'bullish',thesis:'Scenario',
  risks:[],bullishFactors:[],bearishFactors:[],sources:[],updatedAt:now,
};

beforeEach(() => {
  vi.useFakeTimers({toFake:['Date']});
  vi.setSystemTime(new Date(now));
  harness.state = emptyWorkspace('live');
});
afterEach(() => vi.useRealTimers());

function route(method: 'GET' | 'POST' | 'DELETE', endpoint: string, data?: unknown) {
  const request = new Request('https://app.example/api/' + endpoint, {
    method,...(data ? {headers:{'content-type':'application/json'},body:JSON.stringify(data)} : {}),
  });
  return {GET,POST,DELETE}[method](request, {params:Promise.resolve({path:endpoint.split('/')})});
}
function manualInput(strike = 150, quoteAt = '2026-11-23T15:10:00Z') {
  const short = strike > 150;
  return {
    id:makeOccSymbol('NVDA',expiration,'call',strike),symbol:'NVDA',type:'call' as const,strike,expiration,
    multiplier:100,bid:short?1.25:2,ask:short?1.35:2.10,currency:'USD' as const,quoteAt,
    source:{url:'https://broker.example/quotes',publisher:'Broker test'},volume:300,openInterest:1200,attested:true,
  };
}

describe('authenticated market-data boundary', () => {
  it('rejects older and conflicting records while preserving the original manual attestation', async () => {
    const input = manualInput();
    expect((await route('POST','quotes',input)).status).toBe(201);
    expect((await route('POST','quotes',manualInput(150,'2026-11-23T15:09:00Z'))).status).toBe(409);
    expect((await route('POST','quotes',{...input,quoteAt:'2026-11-23T10:10:00-05:00',bid:1.98})).status).toBe(409);
    vi.setSystemTime(new Date('2026-11-23T15:16:00.000Z'));
    const replay = await route('POST','quotes',{...input,quoteAt:'2026-11-23T10:10:00-05:00'});
    expect(replay.status).toBe(201);
    expect((await replay.json()).quote.retrievedAt).toBe(now);
    expect(harness.state.manualQuotes).toHaveLength(1);
    expect(harness.state.manualQuotes[0]).toMatchObject({
      status:'MANUAL_ATTESTED',source:{method:'manual-broker',publisher:'Broker test'},bid:2,
    });
  });

  it('matches legacy padded OCC identifiers with the same canonical contract', async () => {
    const input = manualInput();
    await route('POST','quotes',input);
    harness.state.manualQuotes[0].id = input.id.replace('NVDA','NVDA  ');
    expect((await route('POST','quotes',{...input,quoteAt:'2026-11-23T15:09:00Z'})).status).toBe(409);
    expect((await route('POST','quotes',{...input,quoteAt:'2026-11-23T15:11:00Z'})).status).toBe(201);
    expect(harness.state.manualQuotes).toHaveLength(1);
    expect(harness.state.manualQuotes[0].id).toBe(input.id);
  });

  it('removes withdrawn manual legs from current results and preserves the historical scan', async () => {
    await route('POST','quotes',manualInput());
    await route('POST','quotes',manualInput(155));
    const constructed = constructStrategies(harness.state.manualQuotes,riskPreferences(harness.state.settings),{candidate:scenario,now:new Date(now)});
    const spread = constructed.opportunities.find((item) => item.strategy === 'bull_call');
    expect(spread?.status).toBe('MANUAL_ATTESTED');
    if (!spread) throw new Error('Expected an eligible spread');
    const scan: Scan = {
      id:'recorded',type:'quick',status:'completed',tickers:['NVDA'],startedAt:now,completedAt:now,completed:['NVDA'],failed:[],
      candidates:[scenario],opportunities:[spread],rejections:[],estimatedCost:0,requestCount:0,
    };
    harness.state.scans.push(scan);
    const before = await (await route('GET','state')).json() as AppState;
    expect(before.opportunities).toHaveLength(1);
    expect(before.marketSeries.quotes).toEqual([]);
    await route('DELETE','quotes/' + manualInput(155).id);
    const after = await (await route('GET','state')).json() as AppState;
    expect(after.opportunities).toEqual([]);
    expect(after.scans[0].opportunities.map((item) => item.id)).toEqual([spread.id]);
  });

  it('does not display synthetic candidates or quotes in a live current view', async () => {
    harness.state.scans.push(seedWorkspace('demo',new Date(now)).scans[0]);
    const current = await (await route('GET','state')).json() as AppState;
    expect(current.mode).toBe('live');
    expect(current.candidates).toEqual([]);
    expect(current.opportunities).toEqual([]);
    expect(current.marketSeries.quotes).toEqual([]);
  });

  it('generates demo paper expirations on modeled trading dates', () => {
    const seeded = seedWorkspace('demo',new Date('2026-11-22T15:15:00Z'));
    expect(seeded.portfolio.length).toBeGreaterThan(0);
    for (const trade of seeded.portfolio) expect(optionTradingCutoff(trade.expiration)).not.toBeNull();
  });
});
