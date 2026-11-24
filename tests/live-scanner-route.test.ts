import { afterEach, expect, it, vi } from 'vitest';
import { GET, PATCH, POST } from '../src/app/api/[[...path]]/route';
import type { AppState, Scan, WorkspaceState } from '../src/lib/workspace';

const appOrigin = 'https://terminal.example.test';
const storageOrigin = 'https://supabase.example.test';
const providerUrl = 'https://api.openai.com/v1/responses';
const owner = { id: 'acbc070f-08da-4280-b3da-3bf41690d7b8', email: 'scanner@example.test' };
const now = '2026-07-21T15:34:00.000Z';
const source = { url: 'https://www.sec.gov/Archives/edgar/data/nvda.htm', publishedAt: null };
const issuer = { url: 'https://investor.nvidia.com/news/latest-release', publishedAt: null };
const failedSource = 'https://www.sec.gov/Archives/edgar/data/msft.htm';
const failedPublisher = 'https://www.reuters.com/markets/us/msft-research/';
const thesis = 'Le rapport de l’émetteur indique une demande soutenue.';
const quoteAt = '2026-07-21T15:30:00.000Z';

function optionsResponses(body: unknown, sources = [source.url, issuer.url]) {
  return Response.json({
    object: 'response',
    status: 'completed',
    output: [
      {
        type: 'web_search_call', status: 'completed',
        action: { type: 'search', sources: sources.map((url) => ({ type: 'url', url })) },
      },
      {
        type: 'message', role: 'assistant', status: 'completed', phase: 'final_answer',
        content: [{ type: 'output_text', text: typeof body === 'string' ? body : JSON.stringify(body), annotations: [] }],
      },
    ],
    usage: { input_tokens: 100, output_tokens: 50 },
  });
}

function call(method: 'GET' | 'PATCH' | 'POST', path: string, input?: { cookie?: string; data?: unknown; key?: string }) {
  const handler = { GET, PATCH, POST }[method];
  const request = new Request(appOrigin + '/api/' + path, {
    method,
    headers: {
      ...(method !== 'GET' && { origin: appOrigin }),
      ...(input?.cookie && { cookie: input.cookie }),
      ...(input?.data !== undefined && { 'content-type': 'application/json' }),
      ...(input?.key && { 'idempotency-key': input.key }),
    },
    body: input?.data === undefined ? undefined : JSON.stringify(input.data),
  });
  return handler(request, { params: Promise.resolve({ path: path.split('/') }) });
}

async function result<T>(response: Response, status = 200) {
  const body = await response.json() as T;
  expect(response.status, JSON.stringify(body)).toBe(status);
  expect(response.headers.get('x-request-id')).toBeTruthy();
  return body;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it('persists authenticated scanner results, sources and usage through success, reformat limits, and budget limits', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(now));
  for (const [name, value] of Object.entries({
    DEMO_MODE: 'false',
    APP_BASE_URL: appOrigin,
    NEXT_PUBLIC_SUPABASE_URL: storageOrigin,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: '',
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'test-publishable-key',
    SUPABASE_SERVICE_ROLE_KEY: 'test-service-key',
    OPENAI_API_KEY: 'test-openai-key',
    OPENAI_MODEL: 'wire-fixture-model',
    OPENAI_DEEP_MODEL: '',
    OPENAI_BASE_URL: '',
    OPENAI_ADMIN_KEY: '',
    OPENAI_ORG_ID: '',
    OPENAI_PROJECT_ID: '',
    OPENAI_WEBHOOK_SECRET: '',
    OPENAI_CUSTOM_HEADERS: '',
    OPENAI_LOG: 'off',
    MARKETDATA_API_TOKEN: '',
    MARKETDATA_OWNER_EMAIL: '',
    AI_INPUT_USD_PER_MILLION: '0.5',
    AI_OUTPUT_USD_PER_MILLION: '2',
    AI_SEARCH_USD_PER_CALL: '0.01',
    AI_MAX_CALLS_PER_TICKER: '2',
    AI_MAX_RETRIES: '0',
    AI_RESEARCH_TIMEOUT_MS: '22000',
    MAX_AI_REQUESTS_PER_SCAN: '2',
    AI_DAILY_BUDGET_USD: '1',
    AI_MONTHLY_BUDGET_USD: '15',
  })) vi.stubEnv(name, value);

  let stored: { revision: number; value: WorkspaceState } | undefined;
  const unexpected: string[] = [];
  const providerCalls: unknown[] = [];
  const marketDataCalls: string[] = [];

  // Intercept all network traffic. Keep the production SDK, routing,
  // authentication, storage CAS, scan orchestration and pricing code in use.
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const auth = request.headers.get('authorization');
    const key = request.headers.get('apikey');
    if (url.origin === storageOrigin) {
      if (url.pathname === '/auth/v1/token' && url.searchParams.get('grant_type') === 'password' &&
          request.method === 'POST' && key === 'test-publishable-key') {
        const credentials = await request.json() as { email?: string; password?: string };
        if (credentials.email !== owner.email || credentials.password !== 'fixture-password') {
          return Response.json({}, { status: 401 });
        }
        return Response.json({
          access_token: 'fixture-access', refresh_token: 'fixture-refresh', expires_in: 1800, user: owner,
        });
      }
      if (url.pathname === '/auth/v1/user' && key === 'test-publishable-key' && auth === 'Bearer fixture-access') {
        return Response.json(owner);
      }
      if (url.pathname === '/rest/v1/workspace_states' && url.searchParams.get('owner_id') === 'eq.' + owner.id &&
          key === 'test-publishable-key' && auth === 'Bearer fixture-access') {
        return Response.json(stored ? [stored] : []);
      }
      if (url.pathname === '/rest/v1/rpc/save_workspace_state' && request.method === 'POST' &&
          key === 'test-service-key' && auth === 'Bearer test-service-key') {
        const change = await request.json() as { p_owner: string; p_demo: boolean; p_revision: number; p_value: WorkspaceState };
        if (change.p_owner !== owner.id || change.p_demo) return Response.json({}, { status: 403 });
        if ((stored?.revision ?? 0) !== change.p_revision) return Response.json(false);
        stored = { revision: change.p_revision + 1, value: change.p_value };
        return Response.json(true);
      }
    }
    if (url.href === providerUrl && request.method === 'POST' && auth === 'Bearer test-openai-key') {
      providerCalls.push(await request.json());
      if (providerCalls.length === 1) {
        const partialExample = { ticker: 'NVDA', direction: 'insufficient' };
        const report = {
          ticker: 'NVDA', companyName: 'NVIDIA', direction: 'bullish',
          thesis: { text: thesis, source },
          bullishFactors: [{ text: 'Le communiqué annonce une adoption accrue du produit.', source: issuer }],
          volatilityContext: 'Volatilité sans source, à écarter.',
          underlyingQuote: { price: 171.31, currency: 'USD', quoteAt, source },
        };
        const fencedExample = ['```json', JSON.stringify(partialExample), '```'].join('\n');
        return optionsResponses(fencedExample + '\n' + JSON.stringify(report));
      }
      if (providerCalls.length === 2) return optionsResponses({
        ticker: 'NVDA',
        contracts: [{
          identifier: 'NVDA260807C00175000', type: 'call', expiration: '2026-08-07',
          strike: 175, multiplier: 100, bid: 4.9, ask: 5.1, quoteAt, currency: 'USD',
          volume: 900, openInterest: 3000, source,
        }],
      });
      if (providerCalls.length === 3) {
        const malformed = JSON.stringify({
          ticker: 'MSFT',
          companyName: 'Microsoft',
          direction: 'bullish',
          thesis: { text: 'La thèse illisible demeure non publiée.', source: { url: failedSource } },
        }).replace('"MSFT"', 'MSFT');
        return optionsResponses(malformed, [failedSource, failedPublisher, 'https://unverified.example.test/msft']);
      }
      if (providerCalls.length === 4) return Response.json({
        error: { message: 'Private mock provider detail', type: 'rate_limit_error', code: 'rate_limit_exceeded' },
      }, { status: 429, headers: { 'Retry-After': '60' } });
    }
    if (url.origin === 'https://www.nasdaqtrader.com') {
      if (url.pathname === '/dynamic/SymDir/nasdaqlisted.txt') return new Response([
        'Symbol|Security Name|Market Category|Test Issue|Financial Status|Round Lot Size|ETF|NextShares',
        'AMD|Advanced Micro Devices|Q|N|N|100|N|N',
        'TSLA|Tesla|Q|N|N|100|N|N',
        'File Creation Time: 0721202615:30|||||||',
      ].join('\n'));
      if (url.pathname === '/dynamic/SymDir/otherlisted.txt') return new Response([
        'ACT Symbol|Security Name|Exchange|CQS Symbol|ETF|Round Lot Size|Test Issue|NASDAQ Symbol',
        'SPY|SPDR S&P 500 ETF Trust|P|SPY|Y|100|N|SPY',
        'File Creation Time: 0721202615:30|||||||',
      ].join('\n'));
    }
    if (url.origin === 'https://api.marketdata.app' && request.method === 'GET' && auth === 'Bearer fixture-market-data') {
      const symbol = url.pathname.match(/^\/v1\/options\/chain\/(AMD|TSLA)\/$/)?.[1];
      if (symbol && url.searchParams.get('mode') === 'cached' && url.searchParams.get('nonstandard') === 'false') {
        marketDataCalls.push(symbol);
        return Response.json({
          s: 'ok', optionSymbol: [symbol + '260807C00175000'], underlying: [symbol], side: ['call'],
          expiration: [Date.parse('2026-08-07T20:00:00Z') / 1000],
          strike: [175], bid: [1.7], ask: [1.9], updated: [Date.parse(quoteAt) / 1000],
          volume: [150], openInterest: [300],
        }, { status: 203 });
      }
    }
    unexpected.push(request.method + ' ' + url.origin + url.pathname);
    throw new Error('Unexpected outbound request in the offline scanner test.');
  });

  await result(await call('GET', 'state'), 401);
  expect(providerCalls).toEqual([]);
  const login = await call('POST', 'auth', { data: { action: 'login', email: owner.email, password: 'fixture-password' } });
  await result(login);
  const cookies = login.headers.getSetCookie();
  expect(cookies).toEqual(expect.arrayContaining([
    expect.stringMatching(/^__Host-options_ai_access=fixture-access; .*HttpOnly.*Secure/u),
  ]));
  const cookie = cookies.filter((entry) => !entry.includes('Max-Age=0'))
    .map((entry) => entry.split(';', 1)[0]).join('; ');
  const before = await result<AppState>(await call('GET', 'state', { cookie }));
  expect(before).toMatchObject({
    mode: 'live', user: { email: owner.email }, candidates: [], opportunities: [], scans: [],
  });

  const scanInput = { cookie, data: { type: 'deep', tickers: ['NVDA'] }, key: 'offline-live-nvda' };
  const queued = await result<{ scan: Scan }>(await call('POST', 'scans', scanInput), 202);
  expect(queued.scan.status).toBe('queued');
  const path = `scans/${queued.scan.id}`;
  const { scan } = await result<{ scan: Scan }>(await call('POST', path + '/advance', { cookie }));
  expect(scan).toMatchObject({
    id: queued.scan.id, status: 'completed', completed: ['NVDA'], failed: [],
    opportunities: [], requestCount: 2, estimatedCost: 0.0203, completedAt: now,
  });
  expect(scan.candidates).toEqual([expect.objectContaining({
    symbol: 'NVDA', thesis, price: null, change: null, status: 'UNVERIFIED',
    sources: expect.arrayContaining([expect.objectContaining({ url: source.url, publisher: 'SEC', retrievedAt: now })]),
    evidence: expect.arrayContaining([
      expect.objectContaining({ kind: 'underlying', status: 'UNVERIFIED' }),
      expect.objectContaining({ kind: 'option', status: 'UNVERIFIED' }),
    ]),
  })]);
  expect(JSON.stringify(scan)).not.toMatch(/171\.31|NVDA260807C00175000|Volatilité sans source/u);
  expect(providerCalls).toHaveLength(2);
  for (const payload of providerCalls) expect(payload).toMatchObject({
    model: 'wire-fixture-model', tools: [{ type: 'web_search' }], tool_choice: 'required', store: false,
  });

  const finished = await result<AppState>(await call('GET', 'state', { cookie }));
  expect(finished.scans[0]).toEqual(scan);
  expect(finished.cost).toMatchObject({ daily: 0.0203, monthly: 0.0203, requests: 2, searches: 2, pending: 0 });
  expect(finished.notifications).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'scan_completed' })]));
  expect(stored?.value.reservations).toEqual([]);
  expect(stored?.value.usage.map((entry) => entry.requestType)).toEqual(['screen', 'contract']);

  const replay = await result<{ scan: Scan }>(await call('POST', 'scans', scanInput), 202);
  expect(replay.scan.id).toBe(scan.id);
  const unreadable = await result<{ scan: Scan }>(await call('POST', 'scans', { cookie, data: { type: 'quick', tickers: ['MSFT'] } }), 202);
  const { scan: limited } = await result<{ scan: Scan }>(await call('POST', `scans/${unreadable.scan.id}/advance`, { cookie }));
  expect(limited).toMatchObject({
    status: 'failed', completed: [], failed: ['MSFT'], candidates: [], opportunities: [],
    requestCount: 2, estimatedCost: 0.01015,
  });
  expect(limited.rejections).toEqual(expect.arrayContaining([
    expect.objectContaining({ symbol: 'MSFT', reason: expect.stringMatching(/reformatage.*limite/iu) }),
  ]));
  expect(JSON.stringify(limited)).not.toMatch(/thèse illisible|Private mock provider detail/iu);
  expect(providerCalls).toHaveLength(4);
  expect(providerCalls[2]).toMatchObject({ tools: [{ type: 'web_search' }], tool_choice: 'required' });
  expect(providerCalls[3]).toMatchObject({ store: false, text: { format: { type: 'json_schema' } } });
  expect(providerCalls[3]).not.toHaveProperty('tools');

  const afterLimit = await result<AppState>(await call('GET', 'state', { cookie }));
  expect(afterLimit.scans[0]).toEqual(limited);
  expect(afterLimit.scans[0].examinedSources).toEqual([
    expect.objectContaining({ url: failedSource, publisher: 'SEC', retrievedAt: now }),
    expect.objectContaining({ url: failedPublisher, publisher: 'Reuters', retrievedAt: now }),
  ]);
  expect(afterLimit.candidates.map(({ symbol }) => symbol)).toEqual(['NVDA']);
  expect(afterLimit.cost).toMatchObject({ daily: 0.03045, monthly: 0.03045, requests: 4, searches: 3, pending: 0 });
  expect(stored?.value.usage.filter(({ scanId }) => scanId === limited.id)).toEqual([
    expect.objectContaining({ inputTokens: 100, outputTokens: 50, searchUsage: 1, estimatedCost: 0.01015 }),
    expect.objectContaining({ inputTokens: 0, outputTokens: 0, searchUsage: 0, estimatedCost: 0 }),
  ]);
  expect(stored?.value.reservations).toEqual([]);

  await result(await call('PATCH', 'settings', { cookie, data: { dailyBudget: 0 } }));
  const blocked = await result<{ scan: Scan }>(await call('POST', 'scans', { cookie, data: { type: 'quick', tickers: ['AMD'] } }), 202);
  const { scan: failed } = await result<{ scan: Scan }>(await call('POST', `scans/${blocked.scan.id}/advance`, { cookie }));
  expect(failed).toMatchObject({ status: 'failed', failed: ['AMD'], candidates: [], opportunities: [], requestCount: 0 });
  expect(failed.rejections).toEqual(expect.arrayContaining([expect.objectContaining({ reason: expect.stringMatching(/budget/iu) })]));

  vi.stubEnv('MARKETDATA_API_TOKEN', 'fixture-market-data');
  vi.stubEnv('MARKETDATA_OWNER_EMAIL', 'another-owner@example.test');
  vi.stubEnv('OPENAI_API_KEY', '');
  const otherWorkspace = await result<AppState>(await call('GET', 'state', { cookie }));
  expect(otherWorkspace.research.marketDataConfigured).toBe(false);
  await result(await call('POST', 'scans', { cookie, data: { type: 'quick', tickers: ['AMD'] } }), 503);
  expect(marketDataCalls).toEqual([]);

  vi.stubEnv('MARKETDATA_OWNER_EMAIL', owner.email);
  const automated = await result<AppState>(await call('GET', 'state', { cookie }));
  expect(automated.research).toMatchObject({ configured: false, marketDataConfigured: true });
  const autoInput = { cookie, data: { type: 'quick', tickers: ['AMD', 'TSLA'] }, key: 'automatic-options-scan' };
  const { scan: autoQueued } = await result<{ scan: Scan }>(await call('POST', 'scans', autoInput), 202);
  const duplicate = await result<{ scan: Scan }>(await call('POST', 'scans', autoInput), 202);
  expect(duplicate.scan.id).toBe(autoQueued.id);
  const autoPath = `scans/${autoQueued.id}/advance`;
  await result(await call('POST', autoPath, { cookie }));
  const { scan: autoFinished } = await result<{ scan: Scan }>(await call('POST', autoPath, { cookie }));
  expect(autoFinished).toMatchObject({
    status: 'completed', completed: ['AMD', 'TSLA'], failed: [], requestCount: 0, estimatedCost: 0,
    opportunities: expect.arrayContaining(['AMD', 'TSLA'].map((symbol) => expect.objectContaining({
      symbol, price: null, status: 'VERIFIED_DELAYED', score: null,
      input: expect.objectContaining({
        legs: [expect.objectContaining({ bid: 1.7, ask: 1.9, quoteAt, source: expect.objectContaining({ publisher: 'Market Data' }) })],
      }),
      result: expect.objectContaining({ maxLoss: 191.3 }),
    }))),
  });
  expect(marketDataCalls).toEqual(['AMD', 'TSLA']);
  const saved = await result<AppState>(await call('GET', 'state', { cookie }));
  expect(saved.scans[0]).toEqual(autoFinished);
  expect(saved.opportunities.map(({ symbol }) => symbol)).toEqual(expect.arrayContaining(['AMD', 'TSLA']));
  expect(JSON.stringify(saved)).not.toContain('fixture-market-data');
  const repeated = await result<{ scan: Scan }>(await call('POST', 'scans', { ...autoInput, key: 'repeat-options-scan' }), 202);
  const repeatPath = `scans/${repeated.scan.id}/advance`;
  await result(await call('POST', repeatPath, { cookie }));
  const finalRepeat = await result<{ scan: Scan }>(await call('POST', repeatPath, { cookie }));
  expect(finalRepeat.scan).toMatchObject({ status: 'completed', completed: ['AMD', 'TSLA'], requestCount: 0 });
  expect(marketDataCalls).toEqual(['AMD', 'TSLA']);
  expect(providerCalls).toHaveLength(4);
  expect(unexpected).toEqual([]);
});
