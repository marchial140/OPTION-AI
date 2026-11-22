import { createHash, randomUUID } from 'node:crypto';
import Decimal from 'decimal.js';
import { initialSymbols, type BudgetReservation, type Notification, type Scan, type ScanType, type Settings, type Usage, type WorkspaceState } from '@/lib/workspace';
import { assessRisk, type RiskPreferences } from '@/lib/quant';
import type { Identity } from './auth';
import { currentLegSources } from './observations';
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
  const fingerprint = createHash('sha256').update(JSON.stringify(data, (_, value) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
      : value,
  )).digest('hex');
  const existing = idempotencyKey && state.scans.find((scan) => scan.idempotencyKey === idempotencyKey);
  if (existing) {
    if (existing.requestFingerprint && fingerprint !== existing.requestFingerprint) {
      throw new JobError('Cette clé de requête est déjà associée à une autre analyse.',409,'idempotency_conflict');
    }
    return existing;
  }
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
    stage:'En attente', parameters, idempotencyKey, requestFingerprint:idempotencyKey ? fingerprint : undefined, cached:[],
  };
  state.scans.unshift(scan);
  return scan;
}

export function notify(state: WorkspaceState, type: Notification['type'], message: string, id=randomUUID() as string) {
  if (state.notifications.some((item) => item.id === id)) return;
  state.notifications.unshift({id,type,message,createdAt:new Date().toISOString()});
  state.notifications.splice(150);
}

function unknownUsage(reservation: BudgetReservation): Usage {
  return {
    reservationId:reservation.id, scanId:reservation.scanId,
    model:reservation.model ?? 'inconnu', requestType:reservation.requestType ?? (reservation.scanId ? 'screen' : 'chat'),
    estimatedCost:0, inputTokens:0, outputTokens:0, searchUsage:0, usageAvailable:false,
    createdAt:reservation.createdAt ?? new Date(Date.parse(reservation.expiresAt) - 300_000).toISOString(),
    unreconciledCost:reservation.estimatedCost, unreconciledSearches:reservation.estimatedSearches,
  };
}

export function reconcileExpiredReservations(state: WorkspaceState, now = new Date()) {
  const active: BudgetReservation[] = [];
  for (const reservation of state.reservations) {
    if (Date.parse(reservation.expiresAt) > now.getTime()) active.push(reservation);
    else state.usage.push(unknownUsage(reservation));
  }
  state.reservations = active;
}

export function usageTotals(state: WorkspaceState, now = new Date()) {
  const today = now.toISOString().slice(0, 10);
  const month = today.slice(0, 7);
  let daily = new Decimal(0);
  let monthly = new Decimal(0);
  let dailyUnreconciled = new Decimal(0);
  let monthlyUnreconciled = new Decimal(0);
  let pending = new Decimal(0);
  let requests = 0;
  let searches = 0;
  let uncertainSearches = 0;
  for (const reservation of state.reservations) {
    if (Date.parse(reservation.expiresAt) > now.getTime()) pending = pending.plus(reservation.estimatedCost);
  }
  const expired = state.reservations.filter((item) => Date.parse(item.expiresAt) <= now.getTime()).map(unknownUsage);
  for (const item of [...state.usage, ...expired]) {
    const date = new Date(item.createdAt).toISOString();
    const unknown = item.unreconciledCost ?? 0;
    if (date.startsWith(month)) {
      monthly = monthly.plus(item.estimatedCost);
      monthlyUnreconciled = monthlyUnreconciled.plus(unknown);
    }
    if (date.startsWith(today)) {
      daily = daily.plus(item.estimatedCost);
      dailyUnreconciled = dailyUnreconciled.plus(unknown);
      searches += item.searchUsage;
      uncertainSearches += item.unreconciledSearches ?? 0;
      requests++;
    }
  }
  return {
    daily:daily.toNumber(),monthly:monthly.toNumber(),requests,searches,
    dailyUnreconciled:dailyUnreconciled.toNumber(),monthlyUnreconciled:monthlyUnreconciled.toNumber(),
    pending:pending.toNumber(),uncertainSearches,
  };
}

function envBudget(configured: string | undefined, limit: number) {
  if (configured === undefined || configured.trim() === '') return limit;
  const number = Number(configured);
  return Number.isFinite(number) && number >= 0 ? Math.min(limit, number) : 0;
}

export function budgetHooks(identity: Identity, type: 'scan' | 'chat', scanId?: string, leaseId?: string) {
  const reserved: string[] = [];
  return {
    async allowRequest(request: {model?:string;estimatedCost:number;requestType:Usage['requestType'];estimatedSearches?:number}) {
      const searched = request.estimatedSearches ?? (request.requestType === 'chat' ? 0 : 1);
      if (!Number.isFinite(request.estimatedCost) || request.estimatedCost < 0 || !Number.isSafeInteger(searched) || searched < 0) return false;
      const id = randomUUID();
      const accepted = await mutateWorkspace(identity, (state) => {
        const scan = state.scans.find((item) => item.id === scanId);
        const now = new Date();
        if (type === 'scan' && (!scan || !activeScan(scan) || !scan.lease || scan.lease.id !== leaseId ||
          Date.parse(scan.lease.expiresAt) <= now.getTime() || scan.requestCount >= Math.min(
            scan.parameters?.maxRequestsPerScan ?? safeRequestCap(),state.settings.maxRequestsPerScan,safeRequestCap(),
          ))) return false;
        reconcileExpiredReservations(state,now);
        const totals = usageTotals(state, now);
        const total = new Decimal(totals.pending).plus(request.estimatedCost);
        const searchCap = Math.min(state.settings.dailySearchLimit, scan?.parameters?.dailySearchLimit ?? Infinity);
        const searchCapReached = searched > 0 && totals.searches + totals.uncertainSearches + searched +
          state.reservations.reduce((sum, item) => sum + (item.estimatedSearches ?? 0), 0) > searchCap;
        const daily = envBudget(process.env.AI_DAILY_BUDGET_USD, Math.min(state.settings.dailyBudget,scan?.parameters?.dailyBudget ?? Infinity));
        const monthly = envBudget(process.env.AI_MONTHLY_BUDGET_USD, Math.min(state.settings.monthlyBudget,scan?.parameters?.monthlyBudget ?? Infinity));
        if (daily === 0 || monthly === 0 || total.plus(totals.daily).plus(totals.dailyUnreconciled).gt(daily) ||
          total.plus(totals.monthly).plus(totals.monthlyUnreconciled).gt(monthly) || searchCapReached) {
          notify(state, 'budget', 'La limite de recherche est atteinte.', 'budget-' + now.toISOString().slice(0, 10));
          return false;
        }
        state.reservations.push({
          id,scanId,model:request.model,requestType:request.requestType,estimatedCost:request.estimatedCost,
          estimatedSearches:searched,createdAt:now.toISOString(),expiresAt:new Date(now.getTime() + 300_000).toISOString(),
        });
        if (scan) scan.requestCount++;
        return true;
      });
      if (accepted) reserved.push(id);
      return accepted;
    },
    async recordUsage(usage: Usage) {
      const id = reserved[0];
      if (!id) throw new JobError('Réservation de recherche introuvable.',500,'usage_reservation');
      await mutateWorkspace(identity, (state) => {
        const reservation = state.reservations.find((item) => item.id === id);
        const settled = state.usage.find((item) => item.reservationId === id);
        state.reservations = state.reservations.filter((item) => item.id !== id);
        state.usage = state.usage.filter((item) => item.reservationId !== id);
        state.usage.push({...usage,scanId,reservationId:id,createdAt:reservation?.createdAt ?? settled?.createdAt ?? usage.createdAt});
        const scan = state.scans.find((item) => item.id === scanId);
        if (scan) scan.estimatedCost = new Decimal(scan.estimatedCost).minus(settled?.estimatedCost ?? 0).plus(usage.estimatedCost).toNumber();
      });
      reserved.shift();
    },
    async release() {
      if (!reserved.length) return;
      await mutateWorkspace(identity, (state) => {
        for (const reservation of state.reservations) {
          if (reserved.includes(reservation.id)) state.usage.push(unknownUsage(reservation));
        }
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
    if (signal?.aborted) {
      scan.stage = 'Analyse interrompue, en attente de reprise';
      return scan;
    }
    if (result.status === 'failed') scan.failed.push(claim.symbol);
    else scan.completed.push(claim.symbol);
    if (result.candidate) scan.candidates.push(result.candidate);
    if (result.cached) (scan.cached ??= []).push(claim.symbol);
    if (result.examinedSources?.length) {
      scan.examinedSources = [...new Map([...(scan.examinedSources ?? []),...result.examinedSources]
        .map((source) => [source.url,source])).values()];
    }
    const preferences = riskPreferences(boundedParameters(state.settings,scan.parameters));
    const riskContext = {
      now:new Date(), allowDemo:identity.mode === 'demo', existingRisk:portfolioExposure(state.portfolio),
      openPositions:state.portfolio.filter((trade) => trade.status === 'open').length,
    };
    const rejections = [...result.rejections, ...(result.error ? [result.error] : [])];
    for (const item of result.opportunities) {
      if (!currentLegSources(identity.mode,item.input.legs,state.manualQuotes)) {
        rejections.push('Une cotation a été remplacée ou retirée pendant l’analyse.');
        continue;
      }
      const assessment = assessRisk(item.input,item.result,preferences,riskContext);
      if (!assessment.eligible) {
        rejections.push(...assessment.reasons);
        continue;
      }
      scan.opportunities.push({...item,id:scan.id + '-' + item.id});
    }
    for (const reason of new Set(rejections)) {
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
  if (market.status === 'holiday' || weekday === 0 || weekday === 6) return null;
  const due = (workspace: WorkspaceState) => {
    const {schedule} = workspace.settings;
    return schedule.enabled && schedule.weekdays.includes(weekday) && marketTime >= schedule.time && workspace.lastScheduledKey !== key;
  };
  if (!due(state)) return null;
  const queued = await mutateWorkspace(identity, (draft) => {
    if (!due(draft) || draft.scans.some(activeScan)) return null;
    const scan = queueScan(draft,identity,{type:'quick',watchlistId:draft.settings.schedule.watchlistId ?? undefined}, 'scheduled-' + key, now);
    draft.lastScheduledKey = key;
    return scan.id;
  });
  return queued ? advanceScan(identity, queued) : null;
}
