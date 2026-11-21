import { randomUUID } from 'node:crypto';
import Decimal from 'decimal.js';
import { initialSymbols, type BudgetReservation, type Notification, type Scan, type ScanType, type Settings, type Usage, type WorkspaceState } from '@/lib/workspace';
import type { RiskPreferences } from '@/lib/quant';
import type { Identity } from './auth';
import { portfolioExposure } from './paper';
import { marketSession, researchAsset, researchHealth } from './research';
import { mutateWorkspace, readWorkspace } from './store';

export class JobError extends Error {
  constructor(message: string, readonly status=400, readonly code='scan_error') { super(message); }
}

export const activeScan = (scan: Scan) => scan.status === 'queued' || scan.status === 'running';
function safeRequestCap() {
  const input = Number(process.env.MAX_AI_REQUESTS_PER_SCAN ?? 20);
  return Number.isSafeInteger(input) && input > 0 ? Math.min(input, 60) : 20;
}
export function scanSettings(settings: Settings, overrides: Partial<Settings> = {}): Settings {
  const parameters = { ...settings, ...overrides };
  if (parameters.minDte > parameters.maxDte) throw new JobError('La plage d’échéances est inversée.');
  if (parameters.riskPerTrade > parameters.maxPortfolioRisk) throw new JobError('Le risque individuel dépasse le risque total autorisé.');
  return parameters;
}

function boundedParameters(base: Settings, overrides?: Partial<Settings>) {
  const selected = scanSettings(base, overrides);
  return {
    ...selected,
    accountCapital: Math.min(selected.accountCapital, base.accountCapital),
    riskPerTrade: Math.min(selected.riskPerTrade, base.riskPerTrade),
    maxPortfolioRisk: Math.min(selected.maxPortfolioRisk, base.maxPortfolioRisk),
    maxPositions: Math.min(selected.maxPositions, base.maxPositions),
    maxContracts: Math.min(selected.maxContracts, base.maxContracts),
    minDte: Math.max(selected.minDte, base.minDte),
    maxDte: Math.min(selected.maxDte, base.maxDte),
    strategies: selected.strategies.filter((strategy) => base.strategies.includes(strategy)),
    minVolume: Math.max(selected.minVolume, base.minVolume),
    minOpenInterest: Math.max(selected.minOpenInterest, base.minOpenInterest),
    maxSpreadPercent: Math.min(selected.maxSpreadPercent, base.maxSpreadPercent),
    avoidEarnings: selected.avoidEarnings || base.avoidEarnings,
    avoidNearExpiration: selected.avoidNearExpiration || base.avoidNearExpiration,
    maxRequestsPerScan: Math.min(selected.maxRequestsPerScan, base.maxRequestsPerScan, safeRequestCap()),
  };
}

export function queueScan(state: WorkspaceState, identity: Identity, data: {
  type: ScanType; tickers?: string[]; watchlistId?: string; overrides?: Partial<Settings>;
}, idempotencyKey?: string, now = new Date()) {
  const existing = idempotencyKey && state.scans.find((scan) => scan.idempotencyKey === idempotencyKey);
  if (existing) return existing;
  if (state.scans.some(activeScan)) throw new JobError('Une analyse est déjà en cours.', 409, 'scan_active');
  if (identity.mode === 'live' && !researchHealth().configured && !state.manualQuotes.length) {
    throw new JobError('Configurez OpenAI et les hypothèses tarifaires, ou saisissez des cotations courtier.', 503, 'research_unconfigured');
  }
  const list = data.watchlistId ? state.watchlists.find((watchlist) => watchlist.id === data.watchlistId) : state.watchlists[0];
  if (data.watchlistId && !list) throw new JobError('Liste de suivi introuvable.', 404, 'not_found');
  const tickers = data.tickers ?? list?.items ?? initialSymbols;
  if (!tickers.length || tickers.length > 20) throw new JobError('Sélectionnez entre 1 et 20 symboles par analyse.');
  const parameters = boundedParameters(state.settings, data.type === 'custom' ? data.overrides : undefined);
  if (!parameters.strategies.length || parameters.minDte > parameters.maxDte) {
    throw new JobError('Les critères personnalisés et les limites du compte ne se recoupent pas.');
  }
  const scan: Scan = {
    id:randomUUID(), type:data.type, status:'queued', tickers, startedAt:now.toISOString(),
    completed:[], failed:[], candidates:[], opportunities:[], rejections:[], estimatedCost:0, requestCount:0,
    stage:'En attente', parameters, idempotencyKey, cached:[],
  };
  state.scans.unshift(scan);
  return scan;
}

export function notify(state: WorkspaceState, type: Notification['type'], message: string, id=randomUUID() as string) {
  if (state.notifications.some((item) => item.id === id)) return;
  state.notifications.unshift({id,type,message,createdAt:new Date().toISOString()});
  state.notifications.splice(150);
}

export function usageTotals(state: WorkspaceState, now = new Date()) {
  const today = now.toISOString().slice(0, 10);
  const month = today.slice(0, 7);
  let daily = new Decimal(0);
  let monthly = new Decimal(0);
  let requests = 0;
  let searches = 0;
  for (const item of state.usage) {
    if (item.createdAt.startsWith(month)) monthly = monthly.plus(item.estimatedCost);
    if (item.createdAt.startsWith(today)) {
      daily = daily.plus(item.estimatedCost);
      searches += item.searchUsage;
      requests++;
    }
  }
  return {daily:daily.toNumber(),monthly:monthly.toNumber(),requests,searches};
}

function envBudget(configured: string | undefined, limit: number) {
  if (configured === undefined || configured.trim() === '') return limit;
  const number = Number(configured);
  return Number.isFinite(number) && number >= 0 ? Math.min(limit, number) : limit;
}

export function budgetHooks(identity: Identity, type: 'scan' | 'chat', scanId?: string, leaseId?: string) {
  const reserved: string[] = [];
  return {
    async allowRequest(request: {estimatedCost:number;requestType:Usage['requestType'];estimatedSearches?:number}) {
      if (!Number.isFinite(request.estimatedCost) || request.estimatedCost < 0) return false;
      const id = randomUUID();
      const accepted = await mutateWorkspace(identity, (state) => {
        const scan = state.scans.find((item) => item.id === scanId);
        if (type === 'scan' && (!scan || !activeScan(scan) || scan.lease?.id !== leaseId ||
          scan.requestCount >= Math.min(scan.parameters?.maxRequestsPerScan ?? safeRequestCap(), safeRequestCap()))) return false;
        const now = new Date();
        const totals = usageTotals(state, now);
        state.reservations = state.reservations.filter((item) => item.expiresAt > now.toISOString());
        const held = state.reservations.reduce((sum, item) => sum.plus(item.estimatedCost), new Decimal(0));
        const total = held.plus(request.estimatedCost);
        const searched = request.estimatedSearches ?? (request.requestType === 'chat' ? 0 : 1);
        const searchCapReached = searched > 0 && totals.searches + searched +
          state.reservations.reduce((sum, item) => sum + (item.estimatedSearches ?? 0), 0) > state.settings.dailySearchLimit;
        const daily = envBudget(process.env.AI_DAILY_BUDGET_USD, state.settings.dailyBudget);
        const monthly = envBudget(process.env.AI_MONTHLY_BUDGET_USD, state.settings.monthlyBudget);
        if (daily === 0 || monthly === 0 || total.plus(totals.daily).gt(daily) || total.plus(totals.monthly).gt(monthly) ||
          searchCapReached) {
          notify(state, 'budget', 'La limite de recherche est atteinte.', 'budget-' + now.toISOString().slice(0, 10));
          return false;
        }
        const reservation: BudgetReservation = {id,scanId,estimatedCost:request.estimatedCost,estimatedSearches:searched,expiresAt:new Date(Date.now() + 300_000).toISOString()};
        state.reservations.push(reservation);
        if (scan) scan.requestCount++;
        return true;
      });
      if (accepted) reserved.push(id);
      return accepted;
    },
    async recordUsage(usage: Usage) {
      const id = reserved.shift();
      await mutateWorkspace(identity, (state) => {
        state.reservations = state.reservations.filter((item) => item.id !== id);
        state.usage.push({...usage,scanId});
        const scan = state.scans.find((item) => item.id === scanId);
        if (scan) scan.estimatedCost = new Decimal(scan.estimatedCost).plus(usage.estimatedCost).toNumber();
      });
    },
    async release() {
      if (!reserved.length) return;
      await mutateWorkspace(identity, (state) => {
        state.reservations = state.reservations.filter((item) => !reserved.includes(item.id));
      });
      reserved.length = 0;
    },
  };
}

export function riskPreferences(settings: Settings): RiskPreferences {
  return {
    capital:settings.accountCapital, maxRiskPercent:settings.riskPerTrade, maxPortfolioRiskPercent:settings.maxPortfolioRisk,
    minDte:settings.minDte,maxDte:settings.maxDte,maxContracts:settings.maxContracts,maxPositions:settings.maxPositions,
    strategies:settings.strategies,minVolume:settings.minVolume,minOpenInterest:settings.minOpenInterest,
    maxSpreadPercent:settings.maxSpreadPercent,avoidEarnings:settings.avoidEarnings,avoidNearExpiration:settings.avoidNearExpiration,
  };
}

function finishScan(state: WorkspaceState, current: Scan) {
  current.status = current.failed.length === current.tickers.length ? 'failed' : current.failed.length ? 'partial' : 'completed';
  current.completedAt = new Date().toISOString();
  current.stage = current.status === 'failed' ? 'Échec de l’analyse' : 'Analyse terminée';
  current.opportunities.sort((a, b) => (b.score?.total ?? -1) - (a.score?.total ?? -1));
  const amount = current.opportunities.length;
  notify(state,current.status === 'failed' ? 'scan_failed' : 'scan_completed',
    current.status === 'failed' ? 'La recherche n’a pas abouti. Consultez les diagnostics.' :
    amount ? 'Analyse terminée. ' + amount + ' stratégie' + (amount === 1 ? ' retenue.' : 's retenues.') :
    'Analyse terminée. Aucune stratégie ne répond aux critères.', 'scan-' + current.id);
  if (current.candidates.length) notify(state,'candidate',
    current.candidates.length + ' dossiers de recherche enregistrés.', 'candidate-' + current.id);
  if (current.rejections.length && !amount) notify(state, 'quote', 'Consultez les limites de validation dans le rapport du scan.', 'quote-' + current.id);
}

export async function advanceScan(identity: Identity, scanId: string, signal?: AbortSignal) {
  const leaseId = randomUUID();
  const claim = await mutateWorkspace(identity, (state) => {
    const scan = state.scans.find((item) => item.id === scanId);
    if (!scan) throw new JobError('Analyse introuvable.', 404, 'not_found');
    const symbol = scan.tickers.find((ticker) => !scan.completed.includes(ticker) && !scan.failed.includes(ticker));
    const now = new Date();
    if (!activeScan(scan) || !symbol || (scan.lease && scan.lease.expiresAt > now.toISOString())) {
      return {scan, claim:false as const};
    }
    scan.lease = {id:leaseId,expiresAt:new Date(now.getTime() + 150_000).toISOString()};
    scan.status = 'running';
    scan.current = symbol;
    scan.stage = 'screening';
    const previous = state.scans.find((item) => item.id !== scanId && !activeScan(item) && item.completed.includes(symbol));
    const cached = previous?.candidates.find((item) => item.symbol === symbol);
    const cachedResult = cached ? {
      symbol,status:'completed' as const,candidate:cached,
      opportunities:previous?.opportunities.filter((item) => item.symbol === symbol) ?? [],
      rejections:previous?.rejections.filter((item) => item.symbol === symbol).map((item) => item.reason) ?? [],
      examinedSources:cached.sources,
      requestCount:0,estimatedCost:0,
    } : undefined;
    return {
      scan, symbol, cachedResult, claim:true as const, manualQuotes:state.manualQuotes,
      settings:boundedParameters(state.settings,scan.parameters),
      exposure:portfolioExposure(state.portfolio),openPositions:state.portfolio.filter((trade) => trade.status === 'open').length,
    };
  });
  if (!claim.claim) return claim.scan;
  const hooks = budgetHooks(identity, 'scan', scanId, leaseId);
  let result: Awaited<ReturnType<typeof researchAsset>>;
  try {
    result = await researchAsset({
      symbol:claim.symbol,mode:claim.scan.type,dataMode:identity.mode,
      preferences:riskPreferences(claim.settings),manualQuotes:claim.manualQuotes,
      cachedResult:claim.cachedResult,signal,
      construction:{existingRisk:claim.exposure,openPositions:claim.openPositions, quantity:1,fees:1.30,weights:claim.settings.scoreWeights},
      allowRequest:hooks.allowRequest,recordUsage:hooks.recordUsage,
      onStage:identity.mode === 'live' ? async (stage) => {
        await mutateWorkspace(identity,(state) => {
          const scan = state.scans.find((item) => item.id === scanId);
          if (scan && scan.lease?.id === leaseId && activeScan(scan)) scan.stage = stage;
        });
      } : undefined,
    });
  } catch {
    result = {
      symbol:claim.symbol,status:'failed',candidate:null,opportunities:[],
      rejections:['Le fournisseur n’a pas terminé la recherche.'],requestCount:0,estimatedCost:0,error:'Recherche indisponible.',
    };
  } finally {
    await hooks.release();
  }

  return mutateWorkspace(identity, (state) => {
    const scan = state.scans.find((item) => item.id === scanId);
    if (!scan) throw new JobError('Analyse introuvable.',404,'not_found');
    if (scan.lease?.id !== leaseId || !activeScan(scan)) return scan;
    delete scan.lease;
    delete scan.current;
    if (result.status === 'failed') scan.failed.push(claim.symbol);
    else scan.completed.push(claim.symbol);
    if (result.candidate) scan.candidates.push(result.candidate);
    if (result.cached) (scan.cached ??= []).push(claim.symbol);
    if (result.examinedSources?.length) {
      scan.examinedSources = [...new Map([...(scan.examinedSources ?? []),...result.examinedSources]
        .map((source) => [source.url,source])).values()];
    }
    scan.opportunities.push(...result.opportunities.map((item) => ({...item,id:scan.id + '-' + item.id})));
    for (const reason of new Set([...result.rejections, ...(result.error ? [result.error] : [])])) {
      scan.rejections.push({symbol:claim.symbol,reason});
    }
    if (scan.completed.length + scan.failed.length === scan.tickers.length) finishScan(state, scan);
    else scan.stage = 'En attente du prochain symbole';
    return scan;
  });
}

export async function scheduledWork(identity: Identity, now = new Date()) {
  const state = await readWorkspace(identity);
  const active = state.scans.find(activeScan);
  if (active) return advanceScan(identity, active.id);
  const market = marketSession(now);
  const dateParts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone:'America/New_York',weekday:'short',year:'numeric',month:'2-digit',day:'2-digit',
    hour:'2-digit',minute:'2-digit',hourCycle:'h23',
  }).formatToParts(now).map((part) => [part.type,part.value]));
  const key = [dateParts.year,dateParts.month,dateParts.day].join('-');
  const marketTime = dateParts.hour + ':' + dateParts.minute;
  const weekday = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(dateParts.weekday);
  const { schedule } = state.settings;
  if (!schedule.enabled || market.status === 'holiday' || weekday === 0 || weekday === 6 ||
    !schedule.weekdays.includes(weekday) || marketTime < schedule.time || state.lastScheduledKey === key) return null;
  const queued = await mutateWorkspace(identity, (draft) => {
    if (draft.lastScheduledKey === key || draft.scans.some(activeScan)) return null;
    const scan = queueScan(draft,identity,{type:'quick',watchlistId:draft.settings.schedule.watchlistId ?? undefined}, 'scheduled-' + key, now);
    draft.lastScheduledKey = key;
    return scan.id;
  });
  return queued ? advanceScan(identity, queued) : null;
}
