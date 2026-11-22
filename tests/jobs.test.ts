import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Identity } from '@/lib/server/auth';
import { advanceScan, budgetHooks, queueScan, scheduledWork } from '@/lib/server/jobs';
import { mutateWorkspace, readWorkspace } from '@/lib/server/store';

let directory: string;
let identity: Identity;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'options-ai-jobs-'));
  vi.stubEnv('OPTIONS_DATA_DIR', directory);
  vi.stubEnv('DEMO_STORAGE', '');
  vi.stubEnv('VERCEL', '');
  vi.stubEnv('AI_DAILY_BUDGET_USD', '');
  vi.stubEnv('AI_MONTHLY_BUDGET_USD', '');
  identity = {mode:'demo',userId:randomUUID()};
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(directory,{recursive:true,force:true});
});

describe('durable scanner jobs', () => {
  it('advances one asset per lease and conserves per-ticker outcomes', async () => {
    const scan = await mutateWorkspace(identity,(state)=>queueScan(state, identity, {type:'quick',tickers:['NVDA','ZZZZ']},'lease-test'));
    const [first, concurrently] = await Promise.all([advanceScan(identity,scan.id),advanceScan(identity,scan.id)]);
    const state = await readWorkspace(identity);
    const persisted = state.scans.find((row)=>row.id===scan.id);
    expect([first.id,concurrently.id]).toEqual([scan.id,scan.id]);
    expect(persisted?.candidates.filter((row)=>row.symbol==='NVDA')).toHaveLength(1);
    await advanceScan(identity,scan.id);
    const done = (await readWorkspace(identity)).scans.find((row)=>row.id===scan.id);
    expect(done).toMatchObject({status:'completed',completed:['NVDA','ZZZZ'],failed:[]});
    expect(done?.rejections.some((row)=>row.symbol==='ZZZZ')).toBe(true);
    expect(done?.requestCount).toBe(0);
  });

  it('uses New York schedule time, skips holidays, and deduplicates a due invocation', async () => {
    await mutateWorkspace(identity,(state)=>{
      state.watchlists[0].items = ['NVDA'];
      state.settings.schedule = {enabled:true,time:'10:00',weekdays:[1,2,3,4,5],watchlistId:'principal'};
    });
    await expect(scheduledWork(identity,new Date('2026-11-26T15:30:00Z'))).resolves.toBeNull();
    await expect(scheduledWork(identity,new Date('2026-11-25T14:59:00Z'))).resolves.toBeNull();
    const runTime = new Date('2026-11-25T15:00:00Z');
    await expect(scheduledWork(identity,runTime)).resolves.toMatchObject({status:'completed',tickers:['NVDA']});
    await expect(scheduledWork(identity,runTime)).resolves.toBeNull();
    const state = await readWorkspace(identity);
    expect(state.scans.filter((row)=>row.idempotencyKey==='scheduled-2026-11-25')).toHaveLength(1);
  });

  it('enforces reservations and daily search limits across concurrent calls', async () => {
    await mutateWorkspace(identity,(state)=>{
      state.settings.dailyBudget = 0.1;
      state.settings.dailySearchLimit = 2;
    });
    const first = budgetHooks(identity,'chat');
    const second = budgetHooks(identity,'chat');
    await expect(first.allowRequest({estimatedCost:0.07,requestType:'chat',estimatedSearches:0})).resolves.toBe(true);
    await expect(second.allowRequest({estimatedCost:0.04,requestType:'chat',estimatedSearches:0})).resolves.toBe(false);
    await first.recordUsage({model:'test',requestType:'chat',estimatedCost:0.01,inputTokens:10,outputTokens:4,searchUsage:0,createdAt:new Date().toISOString()});
    await expect(second.allowRequest({estimatedCost:0.04,requestType:'screen',estimatedSearches:3})).resolves.toBe(false);
    await expect(second.allowRequest({estimatedCost:0.04,requestType:'screen',estimatedSearches:2})).resolves.toBe(true);
    await second.release();
    expect((await readWorkspace(identity)).reservations).toEqual([]);
  });
});

describe('research authorization across interrupted requests', () => {
  it('keeps expired reservations in the budget and reconciles a late provider response once', async () => {
    await mutateWorkspace(identity,(state)=>{ state.settings.dailyBudget = 0.1; });
    const interrupted = budgetHooks(identity,'chat');
    const next = budgetHooks(identity,'chat');
    await expect(interrupted.allowRequest({estimatedCost:0.08,requestType:'chat'})).resolves.toBe(true);
    await mutateWorkspace(identity,(state)=>{
      state.reservations[0].expiresAt = new Date(Date.now() - 2000).toISOString();
    });
    await expect(next.allowRequest({estimatedCost:0.03,requestType:'chat'})).resolves.toBe(false);
    const unsettled = await readWorkspace(identity);
    expect(unsettled.usage).toHaveLength(1);
    expect(unsettled.usage[0]).toMatchObject({estimatedCost:0,unreconciledCost:0.08,usageAvailable:false});
    await interrupted.recordUsage({model:'test',requestType:'chat',estimatedCost:0.01,inputTokens:12,outputTokens:3,searchUsage:0,createdAt:new Date().toISOString()});
    const settled = await readWorkspace(identity);
    expect(settled.usage).toHaveLength(1);
    expect(settled.usage[0]).toMatchObject({estimatedCost:0.01});
    expect(settled.usage[0].unreconciledCost).toBeUndefined();
    await expect(next.allowRequest({estimatedCost:0.03,requestType:'chat'})).resolves.toBe(true);
    await next.release();
    expect((await readWorkspace(identity)).usage.at(-1)?.unreconciledCost).toBe(0.03);
  });

  it('fails closed for a malformed deployment spend limit', async () => {
    vi.stubEnv('AI_DAILY_BUDGET_USD', 'zero USD');
    await expect(budgetHooks(identity,'chat').allowRequest({estimatedCost:0.02,requestType:'chat'})).resolves.toBe(false);
    expect((await readWorkspace(identity)).reservations).toHaveLength(0);
  });

  it('rejects authorization when a scan worker is using an expired lease', async () => {
    const scan = await mutateWorkspace(identity, (state) => {
      const scan = queueScan(state,identity,{type:'quick',tickers:['NVDA']});
      scan.lease = {id:'old-worker',expiresAt:new Date(Date.now()-1000).toISOString()};
      scan.status = 'running';
      return scan;
    });
    await expect(budgetHooks(identity,'scan',scan.id,'old-worker').allowRequest({estimatedCost:0.01,requestType:'screen'})).resolves.toBe(false);
    expect((await readWorkspace(identity)).scans[0].requestCount).toBe(0);
  });

  it('rejects a reused scan key with a different payload', async () => {
    await mutateWorkspace(identity,(state)=>queueScan(state,identity,{type:'quick',tickers:['NVDA']},'same-key'));
    await expect(mutateWorkspace(identity,(state)=>queueScan(state,identity,{type:'quick',tickers:['AMD']},'same-key')))
      .rejects.toMatchObject({status:409,code:'idempotency_conflict'});
  });
});

it('releases a disconnected browser lease without discarding pending work', async () => {
  const scan = await mutateWorkspace(identity,(state)=>queueScan(state,identity,{type:'quick',tickers:['NVDA']}));
  await expect(advanceScan(identity,scan.id,AbortSignal.abort())).resolves.toMatchObject({
    status:'running',completed:[],failed:[],
  });
  await expect(advanceScan(identity,scan.id)).resolves.toMatchObject({status:'completed',completed:['NVDA']});
});
