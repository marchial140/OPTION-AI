import { testOpenAIConnection } from '@/lib/server/researchOpenAI';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { demoMarket } from '@/lib/demo';
import { assessRisk, calculateStrategy, daysToExpiration, opportunityQuoteStatus, strategyInputSchema, validateQuote, type ContractQuote, type Opportunity } from '@/lib/quant';
import { emptyWorkspace, portfolioAnalytics, type AppState, type Scan, type WorkspaceState } from '@/lib/workspace';
import {
  applyIdentityCookie, authenticate, AuthError, clearAuthCookies, clearDemoCookie, demoAvailable, getIdentity, logout,
  startDemo, supabaseConfig, type Identity,
} from '@/lib/server/auth';
import { listScheduledIdentities, mutateWorkspace, readWorkspace, StorageError } from '@/lib/server/store';
import { advanceScan, activeScan, budgetHooks, JobError, notify, queueScan, reconcileExpiredReservations, riskPreferences, scanSettings, scheduledWork, usageTotals } from '@/lib/server/jobs';
import { exitPaperTrade, openPaperTrade, PaperError, portfolioExposure } from '@/lib/server/paper';
import { chatResearch, marketDataAvailableFor, marketSession, researchHealth } from '@/lib/server/research';
import { currentLegSources, sameContract, sameObservation } from '@/lib/server/observations';
import { validateManualQuote } from '@/lib/server/researchProviders';
import { authInput, chatInput, exitTradeInput, openTradeInput, scanInput, settingsInput, symbolInput, watchlistInput, watchlistItemInput, watchlistsInput } from '@/lib/server/inputs';

export const runtime = 'nodejs';
export const maxDuration = 120;
export const dynamic = 'force-dynamic';

type Routing = {params: Promise<{path?: string[]}>};

const limiter = new Map<string, {uses:number;reset:number}>();
function rateLimit(key: string, max: number, ms = 60_000) {
  const now = Date.now();
  if (limiter.size > 1500) for (const [id, value] of limiter) if (value.reset <= now) limiter.delete(id);
  if (limiter.size > 3000) limiter.clear();
  const current = limiter.get(key);
  if (!current || current.reset <= now) {
    limiter.set(key,{uses:1,reset:now + ms});
  } else {
    if (current.uses >= max) throw new JobError('Trop de requêtes. Réessayez dans un instant.',429,'rate_limited');
    current.uses++;
  }
}

function enforceOrigin(request: Request) {
  if (request.method === 'GET' || request.method === 'HEAD') return;
  if (request.headers.get('sec-fetch-site') === 'cross-site') throw new JobError('Origine de la requête refusée.',403,'origin');
  const origin = request.headers.get('origin');
  if (!origin) return;
  let parsed: string;
  try {
    parsed = new URL(origin).origin;
  } catch {
    throw new JobError('Origine de la requête refusée.',403,'origin');
  }
  const requestUrl = new URL(request.url);
  const allowed = [requestUrl.origin];
  const configuredOrigin = process.env.APP_BASE_URL;
  if (configuredOrigin && URL.canParse(configuredOrigin)) allowed.push(new URL(configuredOrigin).origin);
  if (!allowed.includes(parsed)) throw new JobError('Origine de la requête refusée.',403,'origin');
}

async function body(request: Request): Promise<unknown> {
  if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
    throw new JobError('Un corps JSON est attendu.',415,'unsupported_media');
  }
  const max = 96_000;
  if (Number(request.headers.get('content-length')) > max) throw new JobError('Le document dépasse la taille maximale.',413,'payload_too_large');
  try {
    const stream = request.body?.getReader();
    if (!stream) throw new Error('Body missing');
    const decoder = new TextDecoder();
    let text = '';
    let size = 0;
    for (;;) {
      const chunk = await stream.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > max) {
        await stream.cancel();
        throw new JobError('Le document dépasse la taille maximale.',413,'payload_too_large');
      }
      text += decoder.decode(chunk.value,{stream:true});
    }
    return JSON.parse(text + decoder.decode()) as unknown;
  } catch (error) {
    if (error instanceof JobError) throw error;
    throw new JobError('Le contenu JSON est invalide.',400,'invalid_json');
  }
}

function idempotencyKey(request: Request) {
  return z.string().regex(/^[a-zA-Z0-9:_-]{1,100}$/).optional().parse(request.headers.get('idempotency-key') ?? undefined);
}

function normalizeObservation(quote: ContractQuote): ContractQuote {
  return quote.status === 'VERIFIED_DELAYED' && quote.source.method === 'manual-broker'
    ? {...quote,status:'MANUAL_ATTESTED'} : quote;
}

function normalizeOpportunity(item: Opportunity, now?: Date): Opportunity {
  const legs = item.input.legs.map(normalizeObservation).map((leg) =>
    now ? {...leg,status:validateQuote(leg,leg.symbol,now).status} : leg);
  return {...item,status:opportunityQuoteStatus(legs),input:{...item.input,legs}};
}

function safeScan(scan: Scan) {
  const { lease, idempotencyKey, requestFingerprint, webScreenSources, ...data } = scan;
  void lease;
  void idempotencyKey;
  void requestFingerprint;
  void webScreenSources;
  return {...data,opportunities:data.opportunities.map((item) => normalizeOpportunity(item))};
}

function currentOpportunities(identity: Identity, state: WorkspaceState, scan?: Scan, now = new Date()) {
  const preferences = riskPreferences(state.settings);
  const context = {
    now, allowDemo:identity.mode === 'demo',
    existingRisk:portfolioExposure(state.portfolio),
    openPositions:state.portfolio.filter((trade) => trade.status === 'open').length,
  };
  return (scan?.opportunities ?? []).flatMap((item) => {
    if (!currentLegSources(identity.mode,item.input.legs,state.manualQuotes)) return [];
    const eligibility = assessRisk(item.input,item.result,preferences,context);
    return eligibility.eligible ? [{...normalizeOpportunity(item,now),dte:daysToExpiration(item.expiration,now)}] : [];
  });
}

function stateFor(identity: Identity, state: WorkspaceState): AppState {
  const now = new Date();
  const snapshots = state.scans.filter((scan) => scan.status === 'completed' || scan.status === 'partial');
  const latest = snapshots[0];
  const candidates = (latest?.candidates ?? []).filter((candidate) => (candidate.status === 'DEMO') === (identity.mode === 'demo'));
  const opportunities = currentOpportunities(identity,state,latest,now);
  const trendByDay = new Map<string, {date:string;value:number;secondary:number}>();
  for (const scan of snapshots.toReversed()) {
    const date = (scan.completedAt ?? scan.startedAt).slice(0,10);
    const previous = trendByDay.get(date);
    trendByDay.set(date,{date,value:(previous?.value ?? 0) + scan.candidates.length,
      secondary:(previous?.secondary ?? 0) + scan.opportunities.length});
  }
  const health = researchHealth();
  return {
    mode:identity.mode,user:{email:identity.email},market:marketSession(now),
    research:{...health,model:health.model ?? undefined,demoAvailable:demoAvailable(),
      schedulerConfigured:Boolean(process.env.CRON_SECRET && process.env.CRON_SECRET.length >= 24),
      marketDataConfigured:identity.mode === 'live' && marketDataAvailableFor(identity.email)},
    settings:state.settings,watchlists:state.watchlists,scans:state.scans.map(safeScan),portfolio:state.portfolio,
    notifications:state.notifications,manualQuotes:state.manualQuotes.map(normalizeObservation),candidates,opportunities,
    savedOpportunityIds:state.savedOpportunityIds ?? [],
    analytics:portfolioAnalytics(state.portfolio),cost:usageTotals(state,now),
    marketSeries:{
      quotes:candidates.filter((item)=>item.price !== null &&
        (identity.mode === 'demo' || ((item.status === 'VERIFIED_FRESH' || item.status === 'VERIFIED_DELAYED') &&
          item.sources.some((source) => source.quoteAt && Date.parse(source.quoteAt) <= now.getTime() &&
           now.getTime() - Date.parse(source.quoteAt) <= 36 * 3600_000)))
      ).map((item) => ({
        symbol:item.symbol,name:item.name,price:item.price,change:item.change,
        quoteAt:item.sources.find((source) => source.quoteAt)?.quoteAt,
        source:item.sources.find((source) => source.quoteAt)?.publisher,status:item.status,
        history:identity.mode === 'demo' ? demoMarket.find((row) => row.symbol === item.symbol)?.history : undefined,
      })),
      trend:[...trendByDay.values()].sort((a,b) => a.date.localeCompare(b.date)).slice(-30),
    },
  };
}

function required<T>(value: T | undefined | null, label: string): T {
  if (value == null) throw new JobError(label,404,'not_found');
  return value;
}

function download(content: unknown, name: string) {
  return new NextResponse(JSON.stringify(content,null,2),{headers:{
    'Content-Type':'application/json; charset=utf-8','Content-Disposition':'attachment; filename="' + name + '"',
  }});
}

function authorizedCron(request: Request) {
  const secret = process.env.CRON_SECRET;
  const actual = Buffer.from(request.headers.get('authorization') ?? '');
  const expected = Buffer.from('Bearer ' + (secret ?? ''));
  return Boolean(secret && secret.length >= 24 && actual.length === expected.length && timingSafeEqual(actual,expected));
}

async function cron(request: Request) {
  if (!authorizedCron(request)) throw new JobError('Authentification requise.',401,'cron_auth');
  const identities = await listScheduledIdentities();
  let processed = 0;
  let errors = 0;
  // Retain enough headroom for a subsequent tick to reclaim slow or interrupted work.
  const batchCap = 3;
  const slot = Math.floor(Date.now() / 60_000);
  const offset = (slot * batchCap) % Math.max(1,identities.length);
  const batch = [...identities.slice(offset),...identities.slice(0,offset)].slice(0,batchCap);
  await Promise.all(batch.map(async (identity) => {
    try {
      if (await scheduledWork(identity)) processed++;
    } catch {
      errors++;
    }
  }));
  return NextResponse.json({processed,errors,eligible:identities.length});
}

async function handle(request: Request, routing: Routing) {
  const requestId = randomUUID();
  const {path = []} = await routing.params;
  const endpoint = path.join('/');
  const method = request.method;
  let identity: Identity | undefined;
  let response: Response;
  try {
    if (endpoint === 'health' && method === 'GET') {
      response = NextResponse.json({status:'ok',researchConfigured:researchHealth().configured,authConfigured:Boolean(supabaseConfig()),demoAvailable:demoAvailable()});
    } else if (endpoint === 'cron' && (method === 'GET' || method === 'POST')) {
      response = await cron(request);
    } else {
      enforceOrigin(request);
      const ip = request.headers.get('x-real-ip') ?? request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'local';
      if (method === 'POST' && endpoint === 'auth') {
        rateLimit('auth:' + ip, 15);
        const result = await authenticate(request,authInput.parse(await body(request)));
        identity = result.identity;
        response = NextResponse.json({pendingConfirmation:result.pendingConfirmation});
        if (identity) response = clearDemoCookie(response,request);
      } else if (method === 'POST' && endpoint === 'auth/demo') {
        rateLimit('demo:' + ip, 20);
        identity = await startDemo(request);
        response = clearAuthCookies(NextResponse.json({mode:'demo'}),request);
      } else if (method === 'POST' && endpoint === 'auth/signout') {
        await logout(request);
        response = clearDemoCookie(clearAuthCookies(NextResponse.json({signedOut:true}),request),request);
      } else {
        identity = await getIdentity(request);
        rateLimit(identity.mode + ':' + identity.userId, 180);
        response = await workspaceResponse(request,identity,path);
      }
    }
  } catch (error) {
    if (error instanceof AuthError || error instanceof StorageError || error instanceof JobError) {
      response = NextResponse.json({error:{code:error.code,message:error.message,requestId}},{status:error.status});
    } else if (error instanceof z.ZodError) {
      response = NextResponse.json({error:{code:'validation',message:'Certains champs ne correspondent pas au format attendu.',
        fields:error.issues.map((issue)=>issue.path.join('.')),requestId}},{status:422});
    } else if (error instanceof PaperError) {
      response = NextResponse.json({error:{code:error.code,message:error.message,requestId}},{status:error.status});
    } else {
      console.error('api request failed', {requestId,endpoint,errorType:error instanceof Error ? error.name : 'unknown'});
      response = NextResponse.json({error:{code:'internal_error',message:'Le service est temporairement indisponible.',requestId}},{status:500});
    }
  }
  if (response.status === 429) response.headers.set('Retry-After','60');
  response.headers.set('Cache-Control','no-store');
  response.headers.set('X-Request-Id',requestId);
  return identity ? applyIdentityCookie(response,identity) : response;
}

async function workspaceResponse(request: Request, identity: Identity, path: string[]) {
  const [group,id,action] = path;
  const method = request.method;
  const endpoint = path.join('/');
  if (method === 'GET') {
    const state = await readWorkspace(identity);
    if (endpoint === 'state') {
      const expiring = state.portfolio.filter((trade) => {
        const days = daysToExpiration(trade.expiration);
        return trade.status === 'open' && days >= 0 && days <= 3 &&
          !state.notifications.some((item) => item.id === 'expiration-' + trade.id);
      });
      if (expiring.length) {
        state.notifications = await mutateWorkspace(identity,(draft) => {
          for (const trade of expiring) notify(draft,'expiration',trade.symbol + ' approche de son échéance.', 'expiration-' + trade.id);
          return draft.notifications;
        });
      }
      return NextResponse.json(stateFor(identity,state));
    }
    if (endpoint === 'data') return download({
      mode:identity.mode,settings:state.settings,watchlists:state.watchlists,scans:state.scans.map(safeScan),
      portfolio:state.portfolio,notifications:state.notifications,manualQuotes:state.manualQuotes,usage:state.usage,
      savedOpportunityIds:state.savedOpportunityIds ?? [],
    },'options-ai-pro-donnees.json');
    if (endpoint === 'scans') return NextResponse.json({scans:state.scans.map(safeScan)});
    if (group === 'scans' && id && (!action || action === 'status' || action === 'export') && path.length <= 3) {
      const scan = safeScan(required(state.scans.find((item) => item.id === id),'Analyse introuvable.'));
      return action === 'export' ? download({mode:identity.mode,scan},'options-ai-pro-analyse.json') : NextResponse.json({scan});
    }
    if (endpoint === 'opportunities') return NextResponse.json({opportunities:stateFor(identity,state).opportunities});
    if (group === 'opportunities' && id && path.length === 2) {
      const opportunity = required(state.scans.flatMap((scan)=>scan.opportunities).find((item)=>item.id===id),'Stratégie introuvable.');
      return NextResponse.json({opportunity:normalizeOpportunity(opportunity)});
    }
    if (endpoint === 'analytics') return NextResponse.json({analytics:portfolioAnalytics(state.portfolio)});
    if (endpoint === 'portfolio') return NextResponse.json({portfolio:state.portfolio});
    if (endpoint === 'watchlists') return NextResponse.json({watchlists:state.watchlists});
    if (endpoint === 'settings') return NextResponse.json({settings:state.settings});
    if (endpoint === 'quotes') return NextResponse.json({quotes:state.manualQuotes.map(normalizeObservation)});
  }
  if (endpoint === 'scans' && method === 'POST') {
    const input = scanInput.parse(await body(request));
    const key = idempotencyKey(request);
    const scan = await mutateWorkspace(identity,(state)=>queueScan(state,identity,input,key));
    return NextResponse.json({scan:safeScan(scan)},{status:202});
  }
  if (group === 'scans' && id && path.length === 3 && method === 'POST') {
    if (action === 'advance') return NextResponse.json({scan:safeScan(await advanceScan(identity,id,request.signal))});
    if (action === 'cancel') {
      const scan = await mutateWorkspace(identity,(state)=>{
        const found = required(state.scans.find((item)=>item.id===id),'Analyse introuvable.');
        if (activeScan(found)) {
          found.status = 'cancelled'; found.completedAt = new Date().toISOString(); found.stage = 'Analyse annulée';
          delete found.lease;
          delete found.current;
        }
        return found;
      });
      return NextResponse.json({scan:safeScan(scan)});
    }
  }
  if (group === 'scans' && id && path.length === 2 && method === 'DELETE') {
    await mutateWorkspace(identity,(state)=>{
      const found = required(state.scans.find((item)=>item.id===id),'Analyse introuvable.');
      if (activeScan(found)) throw new JobError('Annulez cette analyse avant de la supprimer.',409,'scan_active');
      state.scans = state.scans.filter((item)=>item.id!==id);
      const removed = new Set(found.opportunities.map((item) => item.id));
      state.savedOpportunityIds = state.savedOpportunityIds?.filter((saved) => !removed.has(saved)) ?? [];
    });
    return NextResponse.json({deleted:true});
  }
  if (group === 'opportunities' && id && action === 'bookmark' && path.length === 3 &&
    (method === 'POST' || method === 'DELETE')) {
    const savedOpportunityIds = await mutateWorkspace(identity, (state) => {
      required(state.scans.flatMap((scan) => scan.opportunities).find((item) => item.id === id),'Stratégie introuvable.');
      const saved = new Set(state.savedOpportunityIds ?? []);
      if (method === 'DELETE') saved.delete(id);
      else saved.add(id);
      state.savedOpportunityIds = [...saved];
      return state.savedOpportunityIds;
    });
    return NextResponse.json({savedOpportunityIds});
  }
  if (endpoint === 'settings' && method === 'PATCH') {
    const input = settingsInput.parse(await body(request));
    const settings = await mutateWorkspace(identity,(state)=>{
      const next = scanSettings(state.settings,input);
      if (next.schedule.watchlistId && !state.watchlists.some((list)=>list.id===next.schedule.watchlistId)) {
        throw new JobError('La liste du scan planifié est introuvable.');
      }
      state.settings = next;
      return next;
    });
    return NextResponse.json({settings});
  }
  if (endpoint === 'watchlists' && (method === 'PUT' || method === 'POST')) {
    const {watchlists} = watchlistsInput.parse(await body(request));
    await mutateWorkspace(identity,(state)=>{
      state.watchlists = watchlists;
      if (!watchlists.some((item)=>item.id===state.settings.schedule.watchlistId)) state.settings.schedule.watchlistId = null;
    });
    return NextResponse.json({watchlists});
  }
  if (endpoint === 'watchlists/list' && method === 'POST') {
    const list = watchlistInput.parse(await body(request));
    const watchlists = await mutateWorkspace(identity,(state)=>{
      if (state.watchlists.some((item) => item.id === list.id)) throw new JobError('Cette liste existe déjà.',409,'watchlist_exists');
      if (state.watchlists.length >= 20) throw new JobError('Vous avez atteint la limite des listes.');
      state.watchlists.push(list);
      return state.watchlists;
    });
    return NextResponse.json({watchlists},{status:201});
  }
  if (group === 'watchlists' && id && action === 'items' && path.length === 4 && method === 'DELETE') {
    const symbol = symbolInput.parse(path[3]);
    const watchlists = await mutateWorkspace(identity,(state)=>{
      const list = state.watchlists.find((item)=>item.id===id);
      if (!list && id !== 'favoris') throw new JobError('Liste de suivi introuvable.',404,'not_found');
      if (list) list.items = list.items.filter((item) => item !== symbol);
      return state.watchlists;
    });
    return NextResponse.json({watchlists});
  }
  if (endpoint === 'watchlists/items' && method === 'POST') {
    const {symbol,watchlistId} = watchlistItemInput.parse(await body(request));
    const watchlists = await mutateWorkspace(identity,(state)=>{
      if (watchlistId === 'favoris' && !state.watchlists.some((item) => item.id === watchlistId)) {
        if (state.watchlists.length >= 20) throw new JobError('Vous avez atteint la limite des listes.');
        state.watchlists.push({id:watchlistId,name:'Favoris',items:[]});
      }
      const list = required(watchlistId ? state.watchlists.find((item)=>item.id===watchlistId) : state.watchlists[0],'Liste de suivi introuvable.');
      if (!list.items.includes(symbol)) {
        if (list.items.length >= 60) throw new JobError('Cette liste a atteint sa capacité.');
        list.items.push(symbol);
      }
      return state.watchlists;
    });
    return NextResponse.json({watchlists});
  }
  if (group === 'watchlists' && id && path.length === 2 && method === 'DELETE') {
    const watchlists = await mutateWorkspace(identity,(state)=>{
      if (state.watchlists.length <= 1) throw new JobError('Conservez au moins une liste de suivi.');
      required(state.watchlists.find((item)=>item.id===id),'Liste de suivi introuvable.');
      state.watchlists = state.watchlists.filter((item)=>item.id!==id);
      if (state.settings.schedule.watchlistId === id) state.settings.schedule.watchlistId = null;
      return state.watchlists;
    });
    return NextResponse.json({watchlists});
  }
  if (endpoint === 'strategies/calculate' && method === 'POST') {
    const input = strategyInputSchema.parse(await body(request));
    try {
      return NextResponse.json({result:calculateStrategy(input)});
    } catch (error) {
      throw new JobError(error instanceof Error ? error.message : 'La stratégie est invalide.',422,'calculation');
    }
  }
  if (endpoint === 'portfolio/trades' && method === 'POST') {
    const data = {...openTradeInput.parse(await body(request)),requestKey:idempotencyKey(request)};
    const trade = await mutateWorkspace(identity,(state)=>openPaperTrade(state,identity.mode,data));
    return NextResponse.json({trade},{status:201});
  }
  if (group === 'portfolio' && id === 'trades' && action && path.length === 3 && method === 'PATCH') {
    const data = {...exitTradeInput.parse(await body(request)),requestKey:idempotencyKey(request)};
    const trade = await mutateWorkspace(identity,(state)=>exitPaperTrade(
      required(state.portfolio.find((item)=>item.id===action),'Position introuvable.'),data));
    return NextResponse.json({trade});
  }
  if (endpoint === 'quotes' && method === 'POST') {
    if (identity.mode !== 'live') throw new JobError('La saisie de cotations courtier est réservée à l’espace réel.',403,'demo');
    const result = validateManualQuote(await body(request));
    const {quote} = result;
    if (!quote) throw new JobError(result.reason,422,'quote_invalid');
    const saved = await mutateWorkspace(identity,(state)=>{
      const previous = state.manualQuotes.find((item) => sameContract(item,quote));
      if (previous && Date.parse(previous.quoteAt) >= Date.parse(quote.quoteAt)) {
        if (sameObservation(previous,quote)) return previous;
        throw new JobError('Une cotation plus récente ou contradictoire existe pour ce contrat.',409,'quote_conflict');
      }
      state.manualQuotes = [quote,...state.manualQuotes.filter((item)=>!sameContract(item,quote))].slice(0,200);
      return quote;
    });
    return NextResponse.json({quote:normalizeObservation(saved)},{status:201});
  }
  if (group === 'quotes' && id && path.length === 2 && method === 'DELETE') {
    await mutateWorkspace(identity,(state)=>{state.manualQuotes=state.manualQuotes.filter((item)=>item.id!==id);});
    return NextResponse.json({deleted:true});
  }
  if (endpoint === 'ai/connection-test' && method === 'POST') {
    if (identity.mode === 'demo' && (
      process.env.NODE_ENV !== 'development' || process.env.OPENAI_LOCAL_CONNECTION_TEST !== 'true' ||
      !['localhost','127.0.0.1','[::1]'].includes(new URL(request.url).hostname)
    )) throw new JobError('Connectez-vous ou activez le test local dans la configuration du serveur.',403,'connection_test_disabled');
    rateLimit(identity.mode === 'demo' ? 'connection-test:local' : 'connection-test:' + identity.userId,1,60_000);
    const hooks = budgetHooks(identity,'chat');
    try {
      return NextResponse.json(await testOpenAIConnection(hooks,request.signal));
    } finally {
      await hooks.release();
    }
  }
  if ((endpoint === 'ai/chat' || endpoint === 'ai/research') && method === 'POST') {
    rateLimit('chat:' + identity.userId,12);
    const {message,opportunityId,history} = chatInput.parse(await body(request));
    const state = await readWorkspace(identity);
    const latest = state.scans.find((scan)=>scan.status==='completed'||scan.status==='partial');
    const sourceScan = opportunityId ? required(
      state.scans.find((scan) => scan.opportunities.some((item)=>item.id===opportunityId)),'Stratégie introuvable.',
    ) : latest;
    const current = currentOpportunities(identity,state,latest);
    const currentSelected = current.find((item) => item.id === opportunityId);
    const selected = currentSelected ?? sourceScan?.opportunities.find((item) => item.id === opportunityId);
    const hooks = budgetHooks(identity,'chat');
    try {
      const context = {
        candidates:selected ? sourceScan?.candidates.filter((item) => item.symbol === selected.symbol) : latest?.candidates,
        opportunities:selected?[normalizeOpportunity(selected)]:current, archived:Boolean(selected && !currentSelected),
        rejections:sourceScan?.rejections.map((item)=>item.symbol+' · '+item.reason),
      };
      const result = await chatResearch({message,history,context,dataMode:identity.mode,signal:request.signal,
        allowRequest:hooks.allowRequest,recordUsage:hooks.recordUsage});
      return NextResponse.json({answer:result.answer,sources:result.sources,error:result.error});
    } finally {
      await hooks.release();
    }
  }
  if (endpoint === 'notifications/read' && method === 'POST') {
    await mutateWorkspace(identity,(state)=>{
      const now = new Date().toISOString();
      for (const item of state.notifications) item.readAt ??= now;
    });
    return NextResponse.json({read:true});
  }
  if (endpoint === 'data' && method === 'DELETE') {
    await mutateWorkspace(identity,(state)=>{
      if (state.scans.some(activeScan) || state.reservations.some((reservation)=>reservation.expiresAt>new Date().toISOString())) {
        throw new JobError('Attendez la fin des recherches avant de réinitialiser les données.',409,'research_active');
      }
      reconcileExpiredReservations(state);
      const month = new Date().toISOString().slice(0, 7);
      const budgetLedger = state.usage.filter((item) => item.createdAt.startsWith(month)).map((item) => {
        const {scanId, ...record} = item;
        void scanId;
        return record;
      });
      delete state.lastScheduledKey;
      Object.assign(state,emptyWorkspace(identity.mode),{usage:budgetLedger});
    });
    return NextResponse.json({deleted:true});
  }
  throw new JobError('Ressource introuvable.',404,'not_found');
}

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
