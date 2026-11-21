import Decimal from 'decimal.js';
import type { ContractQuote, EvidenceSource, Opportunity, ResearchCandidate, ScoreWeights, Strategy, StrategyInput } from './quant';

export type Mode = 'demo' | 'live';
export type ScanType = 'quick' | 'deep' | 'custom';
export type ScanStatus = 'queued' | 'running' | 'completed' | 'partial' | 'failed' | 'cancelled';

export type Schedule = {
  enabled: boolean;
  time: string;
  weekdays: number[];
  watchlistId: string | null;
};

export type Settings = {
  accountCapital: number;
  riskPerTrade: number;
  maxPortfolioRisk: number;
  maxPositions: number;
  maxContracts: number;
  minDte: number;
  maxDte: number;
  strategies: Strategy[];
  minVolume: number;
  minOpenInterest: number;
  maxSpreadPercent: number;
  avoidEarnings: boolean;
  avoidNearExpiration: boolean;
  maxRequestsPerScan: number;
  dailyBudget: number;
  monthlyBudget: number;
  dailySearchLimit: number;
  language: 'fr';
  currency: 'USD';
  theme: 'dark' | 'contrast';
  schedule: Schedule;
  scoreWeights?: ScoreWeights;
};

export type Watchlist = { id: string; name: string; items: string[] };
export type Scan = {
  id: string;
  type: ScanType;
  status: ScanStatus;
  tickers: string[];
  startedAt: string;
  completedAt?: string;
  completed: string[];
  failed: string[];
  current?: string;
  stage?: string;
  candidates: ResearchCandidate[];
  opportunities: Opportunity[];
  rejections: {symbol: string; reason: string}[];
  estimatedCost: number;
  requestCount: number;
  error?: string;
  parameters?: Settings;
  idempotencyKey?: string;
  lease?: { id: string; expiresAt: string };
  cached?: string[];
  examinedSources?: EvidenceSource[];
};

export type PaperExit = {
  id: string;
  quantity: number;
  exitCredit: number;
  exitDate: string;
  fees: number;
  realizedPnl: number;
  notes?: string;
  requestKey?: string;
};

export type PaperTrade = {
  id: string;
  symbol: string;
  strategy: Strategy;
  input: StrategyInput;
  entryDebit: number;
  entryDate: string;
  expiration: string;
  quantity: number;
  remainingQuantity: number;
  fees: number;
  maxLoss: number;
  notes?: string;
  thesis?: string;
  opportunityId?: string;
  researchScore?: number | null;
  status: 'open' | 'closed';
  exits: PaperExit[];
  realizedPnl: number;
  mode: Mode;
  requestKey?: string;
};

export type Notification = {
  id: string;
  type: 'scan_completed' | 'scan_failed' | 'candidate' | 'quote' | 'expiration' | 'budget';
  message: string;
  createdAt: string;
  readAt?: string;
};

export type Usage = {
  model: string;
  requestType: 'screen' | 'contract' | 'chat';
  inputTokens: number;
  outputTokens: number;
  searchUsage: number;
  estimatedCost: number;
  createdAt: string;
  scanId?: string;
};

export type BudgetReservation = {
  id: string;
  scanId?: string;
  estimatedCost: number;
  expiresAt: string;
  estimatedSearches?: number;
};

export type WorkspaceState = {
  settings: Settings;
  watchlists: Watchlist[];
  scans: Scan[];
  portfolio: PaperTrade[];
  notifications: Notification[];
  manualQuotes: ContractQuote[];
  usage: Usage[];
  reservations: BudgetReservation[];
  lastScheduledKey?: string;
  savedOpportunityIds?: string[];
};

export type MarketState = {
  status: 'pre-market' | 'regular' | 'after-hours' | 'closed' | 'holiday';
  label: string;
  time: string;
  optionsOpen: boolean;
  date?: string;
  nextOpen?: string | null;
  source?: string;
};

export type SeriesPoint = { date: string; value: number; secondary?: number };
export type Analytics = {
  realizedPnl: number;
  completedTrades: number;
  winRate: number | null;
  equity: SeriesPoint[];
  stats: {
    wins: number; losses: number; averageWin: number | null; averageLoss: number | null;
    profitFactor: number | null; totalFees: number; averageHoldDays: number | null; maxDrawdown: number | null;
  };
  byTicker: {label:string;value:number;count:number}[];
  byStrategy: {label:string;value:number;count:number}[];
  byHolding: {label:string;value:number;count:number}[];
  byMonth: {label:string;value:number;count:number}[];
  scoreOutcomes: {symbol:string;score:number;pnl:number}[];
};

export type AppState = Omit<WorkspaceState, 'usage' | 'reservations' | 'manualQuotes' | 'lastScheduledKey' | 'savedOpportunityIds'> & {
  mode: Mode;
  user: { email?: string };
  market: MarketState;
  research: { configured: boolean; model?: string; pricingConfigured?: boolean; webSearch?: boolean; demoAvailable?: boolean };
  candidates: ResearchCandidate[];
  opportunities: Opportunity[];
  analytics: Analytics;
  marketSeries: {
    quotes: {symbol:string;name:string;price:number|null;change:number|null;quoteAt?:string;source?:string;status?:string;history?:number[]}[];
    trend: SeriesPoint[];
  };
  cost: {daily:number;monthly:number;requests:number;searches:number};
  manualQuotes: ContractQuote[];
  savedOpportunityIds: string[];
};

export const initialSymbols = ['NVDA', 'AMD', 'SOFI', 'TSLA', 'SPY', 'QQQ'];
export const defaultSettings: Settings = {
  accountCapital: 10000,
  currency: 'USD',
  riskPerTrade: 5,
  maxPortfolioRisk: 20,
  maxPositions: 10,
  maxContracts: 3,
  minDte: 7,
  maxDte: 30,
  strategies: ['long_call', 'long_put', 'bull_call', 'bear_put'],
  minVolume: 1,
  minOpenInterest: 1,
  maxSpreadPercent: 25,
  avoidEarnings: false,
  avoidNearExpiration: true,
  maxRequestsPerScan: 12,
  dailyBudget: 1,
  monthlyBudget: 15,
  dailySearchLimit: 30,
  language: 'fr',
  theme: 'dark',
  schedule: { enabled: false, time: '10:00', weekdays: [1, 2, 3, 4, 5], watchlistId: null },
};

export function emptyWorkspace(mode: Mode): WorkspaceState {
  return {
    settings: structuredClone(defaultSettings),
    watchlists: [
      { id: 'principal', name: 'Liste principale', items: [...initialSymbols] },
      ...(mode === 'demo' ? [{ id: 'etf', name: 'ETF', items: ['SPY', 'QQQ'] }] : []),
    ],
    scans: [],
    portfolio: [],
    notifications: [],
    manualQuotes: [],
    usage: [],
    reservations: [],
    savedOpportunityIds: [],
  };
}

function decimalSum(values: number[]) {
  return values.reduce((total, value) => total.plus(value), new Decimal(0)).toNumber();
}

export function portfolioAnalytics(portfolio: PaperTrade[]): Analytics {
  const closed = portfolio.filter((trade) => trade.status === 'closed');
  const exits = portfolio.flatMap((trade) => trade.exits.map((exit) => ({...exit, trade})))
    .sort((a, b) => a.exitDate.localeCompare(b.exitDate));
  const days = (entry: string, exit: string) => Math.floor((Date.parse(exit) - Date.parse(entry)) / 86400000);
  const duration = (trade: PaperTrade) => days(trade.entryDate, trade.exits.at(-1)?.exitDate ?? trade.entryDate);
  const wins = closed.filter((trade) => trade.realizedPnl > 0);
  const losses = closed.filter((trade) => trade.realizedPnl < 0);
  const grossWins = decimalSum(wins.map((trade) => trade.realizedPnl));
  const grossLosses = decimalSum(losses.map((trade) => trade.realizedPnl));
  const daily = new Map<string, Decimal>();
  for (const exit of exits) {
    const date = exit.exitDate.slice(0, 10);
    daily.set(date, (daily.get(date) ?? new Decimal(0)).plus(exit.realizedPnl));
  }
  let cumulative = new Decimal(0);
  let peak = new Decimal(0);
  let drawdown = new Decimal(0);
  const equity = [...daily].map(([date, value]) => {
    cumulative = cumulative.plus(value);
    peak = Decimal.max(peak, cumulative);
    drawdown = Decimal.max(drawdown, peak.minus(cumulative));
    return {date, value: cumulative.toNumber()};
  });
  function group<T>(items: T[], label: (item:T)=>string, value:(item:T)=>number) {
    const groups = new Map<string, {label:string;total:Decimal;count:number}>();
    for (const item of items) {
      const key = label(item);
      const row = groups.get(key) ?? {label:key,total:new Decimal(0),count:0};
      groups.set(key, {...row,total:row.total.plus(value(item)),count:row.count + 1});
    }
    return [...groups.values()].map(({label,total,count}) => ({label,value:total.toNumber(),count}));
  }
  const holdingBucket = (trade: PaperTrade) => {
    const held = duration(trade);
    return held <= 7 ? '0–7 j' : held <= 14 ? '8–14 j' : held <= 30 ? '15–30 j' : '31 j et plus';
  };
  return {
    realizedPnl: cumulative.toNumber(),
    completedTrades: closed.length,
    winRate: closed.length ? 100 * wins.length / closed.length : null,
    equity,
    stats: {
      wins: wins.length,
      losses: losses.length,
      averageWin: wins.length ? new Decimal(grossWins).div(wins.length).toNumber() : null,
      averageLoss: losses.length ? new Decimal(grossLosses).div(losses.length).toNumber() : null,
      profitFactor: grossLosses < 0 ? new Decimal(grossWins).div(-grossLosses).toNumber() : null,
      totalFees: decimalSum([...portfolio.map((trade) => trade.fees), ...exits.map((exit) => exit.fees)]),
      averageHoldDays: closed.length ? closed.reduce((sum, trade) => sum + duration(trade), 0) / closed.length : null,
      maxDrawdown: equity.length > 1 ? drawdown.toNumber() : null,
    },
    byTicker: group(closed, (trade) => trade.symbol, (trade) => trade.realizedPnl),
    byStrategy: group(closed, (trade) => trade.strategy, (trade) => trade.realizedPnl),
    byHolding: group(closed, holdingBucket, (trade) => trade.realizedPnl),
    byMonth: group(exits, (exit) => exit.exitDate.slice(0, 7), (exit) => exit.realizedPnl),
    scoreOutcomes: closed.flatMap((trade) => trade.researchScore == null ? [] :
      [{symbol:trade.symbol,score:trade.researchScore,pnl:trade.realizedPnl}]),
  };
}
