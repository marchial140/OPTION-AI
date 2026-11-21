import { expect, test, type APIRequestContext, type APIResponse } from '@playwright/test';
import { makeOccSymbol, type StrategyInput } from '../../src/lib/quant';
import type { AppState, PaperTrade, Scan } from '../../src/lib/workspace';

async function json<T>(response: APIResponse): Promise<T> {
  expect(response.ok(), `${response.status()} ${response.url()} ${await response.text()}`).toBeTruthy();
  return response.json() as Promise<T>;
}

async function workspace(request: APIRequestContext) {
  return json<AppState>(await request.get('/api/state'));
}

function longCall(quantity: number, fees: number, price: number): StrategyInput {
  const expiration = new Date(Date.now() + 21 * 86_400_000).toISOString().slice(0, 10);
  const quoteAt = new Date().toISOString();
  return {
    strategy: 'long_call', quantity, fees,
    legs: [{
      id: makeOccSymbol('NVDA', expiration, 'call', 150),
      symbol: 'NVDA', type: 'call', strike: 150, expiration, multiplier: 100,
      bid: price, ask: price, currency: 'USD', quoteAt, retrievedAt: quoteAt,
      source: { url: '/settings', publisher: 'Données fictives du test' }, status: 'DEMO',
    }],
  };
}

test('demo workspaces persist settings and lists for each session independently', async ({ request, playwright, baseURL }) => {
  expect((await workspace(request)).mode).toBe('demo');
  await json(await request.patch('/api/settings', { data: { accountCapital: 750 } }));
  await json(await request.post('/api/watchlists/items', { data: { symbol: 'AAPL' } }));

  const updated = await workspace(request);
  expect(updated.settings.accountCapital).toBe(750);
  expect(updated.watchlists[0].items).toContain('AAPL');

  const separate = await playwright.request.newContext({ baseURL });
  try {
    const otherWorkspace = await workspace(separate);
    expect(otherWorkspace.mode).toBe('demo');
    expect(otherWorkspace.settings.accountCapital).toBe(10_000);
    expect(otherWorkspace.watchlists[0].items).not.toContain('AAPL');
  } finally {
    await separate.dispose();
  }
});

test('cross-origin writes and unauthorized scheduler requests are rejected', async ({ request }) => {
  const before = await workspace(request);
  const crossOrigin = await request.patch('/api/settings', {
    data: { accountCapital: 100 }, headers: { origin: 'https://unrelated.example' },
  });
  expect(crossOrigin.status()).toBe(403);
  expect(await crossOrigin.json()).toMatchObject({ error: { code: 'origin', requestId: crossOrigin.headers()['x-request-id'] } });
  expect((await workspace(request)).settings.accountCapital).toBe(before.settings.accountCapital);

  const cron = await request.get('/api/cron');
  expect(cron.status()).toBe(401);
  expect(await cron.json()).toMatchObject({ error: { code: 'cron_auth' } });
});

test('concurrent duplicate scan requests share one durable result', async ({ request, playwright, baseURL }) => {
  await workspace(request);
  const data = { type: 'quick', tickers: ['NVDA'] };
  const headers = { 'Idempotency-Key': 'quick-nvda-duplicate' };
  const [first, duplicate] = await Promise.all([
    request.post('/api/scans', { data, headers }),
    request.post('/api/scans', { data, headers }),
  ]).then((responses) => Promise.all(responses.map((response) => json<{ scan: Scan }>(response))));
  expect(first.scan.status).toBe('queued');
  expect(duplicate.scan.id).toBe(first.scan.id);

  const scanPath = `/api/scans/${first.scan.id}`;
  const { scan } = await json<{ scan: Scan }>(await request.post(`${scanPath}/advance`));
  expect(scan.status).toBe('completed');
  expect(scan.completed).toEqual(['NVDA']);
  expect(scan.candidates).toEqual([expect.objectContaining({ symbol: 'NVDA', status: 'DEMO' })]);
  const { scan: repeated } = await json<{ scan: Scan }>(await request.post(`${scanPath}/advance`));
  expect(repeated.completed).toEqual(['NVDA']);
  expect((await workspace(request)).scans.filter((item) => item.id === scan.id)).toHaveLength(1);

  const separate = await playwright.request.newContext({ baseURL });
  try {
    await workspace(separate);
    expect((await separate.get(scanPath)).status()).toBe(404);
  } finally {
    await separate.dispose();
  }
});

test('paper positions enforce the loss cap and reconcile partial exits to the cent', async ({ request }) => {
  const initial = await workspace(request);
  await json(await request.patch('/api/settings', { data: { accountCapital: 450, riskPerTrade: 5 } }));
  const entryDate = new Date(Date.now() - 60_000).toISOString();
  const data = { input: longCall(1, 0, 0.4), entryDebit: 40, entryDate };
  const rejected = await request.post('/api/portfolio/trades', { data });
  expect(rejected.status()).toBe(422);
  expect(await rejected.json()).toMatchObject({ error: { code: 'paper_risk', message: expect.stringContaining('limite par position') } });
  expect((await workspace(request)).portfolio).toHaveLength(initial.portfolio.length);

  await json(await request.patch('/api/settings', { data: { accountCapital: 5_000, maxContracts: 3 } }));
  const { trade } = await json<{ trade: PaperTrade }>(await request.post('/api/portfolio/trades', {
    data: { input: longCall(3, 1, 0.4), entryDebit: 100, entryDate },
  }));
  expect(trade).toMatchObject({ remainingQuantity: 3, status: 'open', maxLoss: 101 });

  for (const [index, expectedPnl] of [6.18, 6.19, 6.18].entries()) {
    const exitDate = new Date(Date.parse(entryDate) + (index + 1) * 1_000).toISOString();
    const { trade: updated } = await json<{ trade: PaperTrade }>(await request.patch(`/api/portfolio/trades/${trade.id}`, {
      data: { quantity: 1, exitCredit: 40, fees: 0.15, exitDate },
    }));
    expect(updated.exits.at(-1)?.realizedPnl).toBe(expectedPnl);
    expect(updated.remainingQuantity).toBe(2 - index);
  }

  const persisted = await workspace(request);
  expect(persisted.portfolio.find((item) => item.id === trade.id)).toMatchObject({ status: 'closed', realizedPnl: 18.55 });
  expect(persisted.analytics.realizedPnl - initial.analytics.realizedPnl).toBeCloseTo(18.55, 2);
});

test('rechecks stored opportunities against current risk while preserving scan snapshots', async ({ request }) => {
  const before = await workspace(request);
  expect(before.opportunities.length).toBeGreaterThan(0);
  await json(await request.patch('/api/settings', { data:{accountCapital:450,riskPerTrade:5} }));
  const now = await workspace(request);
  expect(now.opportunities).toEqual([]);
  expect(now.scans[0].opportunities).toEqual(before.scans[0].opportunities);
});
