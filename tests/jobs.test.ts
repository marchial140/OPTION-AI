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
