import Decimal from 'decimal.js';
import { z } from 'zod';

export const strategyLabels = {
  long_call: 'Achat de call',
  long_put: 'Achat de put',
  bull_call: 'Spread haussier de calls',
  bear_put: 'Spread baissier de puts',
} as const;

export const strategySchema = z.enum(['long_call', 'long_put', 'bull_call', 'bear_put']);
export type Strategy = z.infer<typeof strategySchema>;

export const dataStatusSchema = z.enum([
  'VERIFIED_FRESH', 'VERIFIED_DELAYED', 'VERIFIED_HISTORICAL', 'UNVERIFIED',
  'STALE', 'INSUFFICIENT', 'CONTRADICTORY', 'DEMO',
]);
export type DataStatus = z.infer<typeof dataStatusSchema>;
export type Direction = 'bullish' | 'bearish' | 'neutral' | 'mixed' | 'insufficient';

export interface EvidenceSource {
  url: string;
  publisher: string;
  retrievedAt: string;
  quoteAt?: string;
  publishedAt?: string;
  citation?: string;
  method?: string;
  confidence?: string;
}

export interface ResearchCandidate {
  symbol: string;
  name: string;
  price: number | null;
  change: number | null;
  direction: Direction;
  thesis: string;
  risks: string[];
  bullishFactors: string[];
  bearishFactors: string[];
  sources: EvidenceSource[];
  updatedAt: string;
  status: DataStatus;
}

const symbolSchema = z.string().regex(/^[A-Z][A-Z0-9.]{0,9}$/);
const financialNumber = z.number().finite().nonnegative().max(1_000_000);
const timestampSchema = z.iso.datetime({ offset: true });

export const contractQuoteSchema = z.object({
  id: z.string().min(1).max(32),
  symbol: symbolSchema,
  type: z.enum(['call', 'put']),
  strike: financialNumber.positive(),
  expiration: z.iso.date(),
  multiplier: z.number().int().positive(),
  bid: financialNumber,
  ask: financialNumber,
  currency: z.literal('USD'),
  quoteAt: timestampSchema,
  retrievedAt: timestampSchema,
  source: z.object({
    url: z.string().min(1).max(2048),
    publisher: z.string().trim().min(1).max(160),
    method: z.string().max(120).optional(),
    publishedAt: timestampSchema.optional(),
    citation: z.string().max(800).optional(),
    confidence: z.string().max(60).optional(),
  }),
  volume: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  openInterest: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  status: dataStatusSchema,
});
export type ContractQuote = z.infer<typeof contractQuoteSchema>;

export const strategyInputSchema = z.object({
  strategy: strategySchema,
  legs: z.array(contractQuoteSchema).min(1).max(2),
  quantity: z.number().int().positive().max(10_000),
  fees: financialNumber,
});
export type StrategyInput = z.infer<typeof strategyInputSchema>;

export interface StrategyResult {
  entryDebit: number;
  positionCost: number;
  maxLoss: number;
  maxProfit: number | null;
  breakEven: number | null;
  rewardRisk: number | null;
  returnOnRisk: number | null;
  netDebitPerShare: number;
  fees: number;
  multiplier: number;
  quantity: number;
}

export interface RiskPreferences {
  capital: number;
  maxRiskPercent: number;
  maxPortfolioRiskPercent?: number;
  minDte?: number;
  maxDte?: number;
  maxContracts?: number;
  maxPositions?: number;
  strategies?: Strategy[];
  minVolume?: number;
  minOpenInterest?: number;
  maxSpreadPercent?: number;
  avoidEarnings?: boolean;
  avoidNearExpiration?: boolean;
}

export interface RiskContext {
  now?: Date;
  existingRisk?: number;
  openPositions?: number;
  earningsAt?: string | null;
  dividendAt?: string | null;
  allowDemo?: boolean;
}

export interface RiskResult {
  eligible: boolean;
  reasons: string[];
  warnings: string[];
  maxTradeLoss: number;
  remainingPortfolioRisk: number;
}

export type ScoreKey = 'liquidity' | 'payoff' | 'direction' | 'execution' | 'quality';
export type ScoreWeights = Partial<Record<ScoreKey, number>>;
export interface ScoreResult {
  total: number;
  breakdown: { key: ScoreKey; label: string; value: number; weight: number; reason: string }[];
}

export interface Opportunity {
  id: string;
  symbol: string;
  name: string;
  price: number | null;
  direction: Direction;
  strategy: Strategy;
  expiration: string;
  dte: number;
  input: StrategyInput;
  result: StrategyResult;
  score: ScoreResult | null;
  status: DataStatus;
  updatedAt: string;
  thesis: string;
  warnings: string[];
}

export interface ConstructionContext extends RiskContext {
  candidate: ResearchCandidate;
  fees?: number;
  quantity?: number;
  weights?: ScoreWeights;
}

export const defaultRiskPreferences: Required<RiskPreferences> = {
  capital: 10_000,
  maxRiskPercent: 5,
  maxPortfolioRiskPercent: 20,
  minDte: 7,
  maxDte: 30,
  maxContracts: 1,
  maxPositions: 8,
  strategies: [...strategySchema.options],
  minVolume: 0,
  minOpenInterest: 0,
  maxSpreadPercent: 35,
  avoidEarnings: true,
  avoidNearExpiration: true,
};

const dateInNewYork = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
});
const dayMs = 86_400_000;
const minuteMs = 60_000;

export function daysToExpiration(expiration: string, now = new Date()): number {
  const dateParts = Object.fromEntries(dateInNewYork.formatToParts(now).map(({ type, value }) => [type, value]));
  return Math.round((Date.parse(expiration) - Date.parse(`${dateParts.year}-${dateParts.month}-${dateParts.day}`)) / dayMs);
}

export function makeOccSymbol(symbol: string, expiration: string, type: 'call' | 'put', strike: number): string {
  const units = new Decimal(strike).times(1_000);
  if (!/^[A-Z0-9]{1,6}$/.test(symbol) || !z.iso.date().safeParse(expiration).success || !units.isInteger() || units.lte(0) || units.gt(99_999_999)) {
    throw new Error('L’identité OCC ne correspond pas à un contrat standard.');
  }
  return `${symbol}${expiration.slice(2).replaceAll('-', '')}${type === 'call' ? 'C' : 'P'}${units.toFixed(0).padStart(8, '0')}`;
}

function validateContractTerms(quote: ContractQuote) {
  if (quote.multiplier !== 100) throw new Error('Les contrats ajustés ou non standards sont exclus.');
  const normalizedId = quote.id.trim().toUpperCase().replace(/^([A-Z0-9]{1,6}) +(?=\d{6}[CP]\d{8}$)/, '$1');
  if (normalizedId !== makeOccSymbol(quote.symbol, quote.expiration, quote.type, quote.strike)) {
    throw new Error('L’identité OCC ne correspond pas au symbole, à l’échéance, au type et au strike.');
  }
  if (quote.bid > quote.ask) throw new Error('Le bid dépasse le ask.');
}

export function validateQuote(quote: ContractQuote, expectedSymbol = quote.symbol, now = new Date()): { valid: boolean; status: DataStatus; reason?: string } {
  const parsed = contractQuoteSchema.safeParse(quote);
  if (!parsed.success) return { valid: false, status: 'INSUFFICIENT', reason: 'Cotation incomplète ou mal formée.' };
  try {
    validateContractTerms(quote);
  } catch (error) {
    return { valid: false, status: 'CONTRADICTORY', reason: (error as Error).message };
  }
  if (quote.symbol !== expectedSymbol) return { valid: false, status: 'CONTRADICTORY', reason: 'Le sous-jacent de la cotation est incorrect.' };
  if (daysToExpiration(quote.expiration, now) < 0) return { valid: false, status: 'VERIFIED_HISTORICAL', reason: 'Le contrat a expiré.' };

  try {
    const validDemoUrl = quote.status === 'DEMO' && quote.source.url.startsWith('/') && !quote.source.url.startsWith('//');
    if (!validDemoUrl) {
      const source = new URL(quote.source.url);
      if (source.protocol !== 'https:' || source.username || source.password) throw new Error();
    }
  } catch {
    return { valid: false, status: 'UNVERIFIED', reason: 'URL de provenance non valide.' };
  }

  const quoteTime = Date.parse(quote.quoteAt);
  const retrieved = Date.parse(quote.retrievedAt);
  const age = now.getTime() - quoteTime;
  if (quoteTime > retrieved + minuteMs || retrieved > now.getTime() + minuteMs || age < -minuteMs) {
    return { valid: false, status: 'CONTRADICTORY', reason: 'Horodatage de la cotation incohérent.' };
  }
  if (quote.status === 'DEMO') return { valid: true, status: 'DEMO' };
  if (quote.status !== 'VERIFIED_FRESH' && quote.status !== 'VERIFIED_DELAYED') {
    return { valid: false, status: quote.status, reason: 'La provenance ou la fraîcheur de la cotation ne permet pas son classement.' };
  }
  if (age > 36 * 60 * minuteMs) return { valid: false, status: 'STALE', reason: 'La cotation a plus de 36 heures.' };
  return { valid: true, status: age > 15 * minuteMs ? 'VERIFIED_DELAYED' : quote.status };
}

function strategyTerms(input: StrategyInput) {
  if (!strategyInputSchema.safeParse(input).success) throw new Error('Renseignez les champs contractuels et les prix requis.');
  const { legs, strategy } = input;
  const [long, short] = legs;
  const isCall = strategy === 'long_call' || strategy === 'bull_call';
  const isVertical = strategy === 'bull_call' || strategy === 'bear_put';
  if (legs.length !== (isVertical ? 2 : 1)) throw new Error('Nombre de jambes incompatible avec la stratégie.');
  for (const leg of legs) {
    validateContractTerms(leg);
    if (leg.type !== (isCall ? 'call' : 'put')) throw new Error('Type de contrat incompatible avec la stratégie.');
  }
  if (short && (long.symbol !== short.symbol || long.expiration !== short.expiration || long.multiplier !== short.multiplier || long.currency !== short.currency)) {
    throw new Error('Les deux jambes doivent partager le sous-jacent, l’échéance, le multiplicateur et la devise.');
  }
  const width = short ? new Decimal(short.strike).minus(long.strike).times(isCall ? 1 : -1) : null;
  if (width?.lte(0)) throw new Error('Ordre des strikes incompatible avec la stratégie.');
  const netDebit = new Decimal(long.ask).minus(short?.bid ?? 0);
  if (netDebit.lte(0)) throw new Error('Le débit net doit être strictement positif.');
  if (width?.lte(netDebit) || (!isCall && !isVertical && netDebit.gte(long.strike))) {
    throw new Error('Le débit atteint ou dépasse la valeur maximale à l’échéance.');
  }
  return { long, short, isCall, width, netDebit, exposure: new Decimal(long.multiplier).times(input.quantity) };
}

export function calculateStrategy(input: StrategyInput): StrategyResult {
  const { long, isCall, width, netDebit, exposure } = strategyTerms(input);
  const entryDebit = netDebit.times(exposure);
  const totalCost = entryDebit.plus(input.fees);
  const perShareCost = totalCost.div(exposure);
  const maxIntrinsic = width ?? (isCall ? null : new Decimal(long.strike));
  const maxProfit = maxIntrinsic?.times(exposure).minus(totalCost) ?? null;
  const breakEven = maxProfit?.lt(0) ? null : new Decimal(long.strike).plus(perShareCost.times(isCall ? 1 : -1));
  const rewardRisk = maxProfit?.div(totalCost) ?? null;
  return {
    entryDebit: entryDebit.toNumber(),
    positionCost: totalCost.toNumber(),
    maxLoss: totalCost.toNumber(),
    maxProfit: maxProfit?.toNumber() ?? null,
    breakEven: breakEven?.toNumber() ?? null,
    rewardRisk: rewardRisk?.toNumber() ?? null,
    returnOnRisk: rewardRisk?.times(100).toNumber() ?? null,
    netDebitPerShare: netDebit.toNumber(),
    fees: input.fees,
    multiplier: long.multiplier,
    quantity: input.quantity,
  };
}

function calculatePayoff(input: StrategyInput, terms: ReturnType<typeof strategyTerms>, underlying: Decimal) {
  const { long, short, isCall, netDebit, exposure } = terms;
  const intrinsic = (strike: number) => Decimal.max(underlying.minus(strike).times(isCall ? 1 : -1), 0);
  return intrinsic(long.strike).minus(short ? intrinsic(short.strike) : 0).minus(netDebit).times(exposure).minus(input.fees).toNumber();
}

export function payoffAt(input: StrategyInput, underlying: number): number {
  if (!Number.isFinite(underlying) || underlying < 0) throw new Error('Le prix du sous-jacent doit être positif ou nul.');
  return calculatePayoff(input, strategyTerms(input), new Decimal(underlying));
}

export function createPayoffSeries(input: StrategyInput, min: number, max: number, steps = 60) {
  if (!Number.isFinite(min) || !Number.isFinite(max) || min < 0 || max <= min || !Number.isInteger(steps) || steps < 1 || steps > 500) {
    throw new Error('Intervalle de simulation non valide.');
  }
  const terms = strategyTerms(input);
  const step = new Decimal(max).minus(min).div(steps);
  const points = Array.from({ length: steps + 1 }, (_, index) => new Decimal(min).plus(step.times(index)).toNumber());
  const breakEven = calculateStrategy(input).breakEven;
  const landmarks = [...input.legs.map(({ strike }) => strike), ...(breakEven === null ? [] : [breakEven])];
  return [...new Set([...points, ...landmarks.filter((point) => point >= min && point <= max)])]
    .sort((a, b) => a - b)
    .map((underlying) => ({ underlying, pnl: calculatePayoff(input, terms, new Decimal(underlying)) }));
}

function spreadPercent(quote: ContractQuote): number {
  if (quote.ask === 0) return quote.bid === 0 ? 0 : 100;
  return new Decimal(quote.ask).minus(quote.bid).div(new Decimal(quote.ask).plus(quote.bid).div(2)).times(100).toNumber();
}

function money(value: number) {
  return new Intl.NumberFormat('fr-CA', { style: 'currency', currency: 'USD' }).format(value);
}

export function assessRisk(input: StrategyInput, result: StrategyResult, preferences: RiskPreferences, context: RiskContext = {}): RiskResult {
  const prefs = { ...defaultRiskPreferences, ...preferences };
  const now = context.now ?? new Date();
  const reasons: string[] = [];
  const warnings: string[] = [];
  const currentRisk = context.existingRisk ?? 0;
  const invalidLimits = !Number.isFinite(prefs.capital) || prefs.capital < 0 || !Number.isFinite(prefs.maxRiskPercent) || prefs.maxRiskPercent < 0 || prefs.maxRiskPercent > 100 || !Number.isFinite(prefs.maxPortfolioRiskPercent) || prefs.maxPortfolioRiskPercent < 0 || prefs.maxPortfolioRiskPercent > 100 || !Number.isFinite(currentRisk) || currentRisk < 0;
  if (invalidLimits) {
    return { eligible: false, reasons: ['Les paramètres de capital ou de risque sont non valides.'], warnings, maxTradeLoss: 0, remainingPortfolioRisk: 0 };
  }
  const maxTradeLoss = new Decimal(prefs.capital).times(prefs.maxRiskPercent).div(100).toNumber();
  const remainingPortfolioRisk = Decimal.max(0, new Decimal(prefs.capital).times(prefs.maxPortfolioRiskPercent).div(100).minus(currentRisk)).toNumber();
  if (!Number.isFinite(result.maxLoss) || result.maxLoss <= 0) reasons.push('Perte maximale indisponible.');
  else {
    if (result.maxLoss > maxTradeLoss) reasons.push(`La perte maximale dépasse le plafond de ${money(maxTradeLoss)} par opération.`);
    if (result.maxLoss > remainingPortfolioRisk) reasons.push(`L’exposition cumulée dépasserait le plafond du portefeuille.`);
    if (result.positionCost > Math.max(0, prefs.capital - currentRisk)) reasons.push('Le capital disponible est insuffisant.');
  }
  if (!prefs.strategies.includes(input.strategy)) reasons.push('Cette stratégie est exclue des préférences.');
  if (input.quantity > prefs.maxContracts) reasons.push('Le nombre de contrats dépasse le maximum autorisé.');
  if ((context.openPositions ?? 0) >= prefs.maxPositions) reasons.push('Le nombre maximal de positions est atteint.');
  if (result.maxProfit !== null && result.maxProfit <= 0) reasons.push('Aucun profit net possible à l’échéance avec les frais indiqués.');

  const expiration = input.legs[0]?.expiration;
  const dte = expiration ? daysToExpiration(expiration, now) : Number.NaN;
  if (!Number.isFinite(dte) || dte < prefs.minDte || dte > prefs.maxDte) reasons.push('L’échéance est en dehors de l’intervalle configuré.');
  if (dte < 3) {
    const message = 'Expiration imminente et risque de règlement.';
    if (prefs.avoidNearExpiration) reasons.push(message);
    else warnings.push(message);
  }
  if (context.earningsAt && expiration && context.earningsAt.slice(0, 10) <= expiration && Date.parse(context.earningsAt) >= now.getTime() - dayMs) {
    if (prefs.avoidEarnings) reasons.push('Publication de résultats avant l’échéance.');
    else warnings.push('Publication de résultats avant l’échéance.');
  }
  if (context.dividendAt && expiration && context.dividendAt.slice(0, 10) <= expiration && Date.parse(context.dividendAt) >= now.getTime() - dayMs) {
    warnings.push('Date de détachement du dividende avant l’échéance.');
  }

  for (const leg of input.legs) {
    const checked = validateQuote(leg, input.legs[0].symbol, now);
    if (!checked.valid) reasons.push(`${leg.id} · ${checked.reason}`);
    else if (checked.status === 'DEMO' && !context.allowDemo) reasons.push('Une cotation fictive est exclue de la recherche en direct.');
    else if (checked.status === 'VERIFIED_DELAYED') warnings.push('Cotation différée, prix indicatif.');
    if (prefs.minVolume > 0 && (leg.volume === undefined || leg.volume < prefs.minVolume)) reasons.push(`${leg.id} · volume insuffisant ou indisponible.`);
    if (prefs.minOpenInterest > 0 && (leg.openInterest === undefined || leg.openInterest < prefs.minOpenInterest)) reasons.push(`${leg.id} · intérêt ouvert insuffisant ou indisponible.`);
    if (leg.ask === 0 || spreadPercent(leg) > prefs.maxSpreadPercent) reasons.push(`${leg.id} · écart bid/ask supérieur au seuil.`);
    else if (spreadPercent(leg) >= 10) warnings.push(`${leg.id} · écart bid/ask élevé.`);
  }
  if (input.legs.length > 1) warnings.push('Le risque à l’échéance suppose que le spread reste intact. Une assignation anticipée ou une clôture partielle des jambes peut modifier l’exposition.');
  return { eligible: reasons.length === 0, reasons: [...new Set(reasons)], warnings: [...new Set(warnings)], maxTradeLoss, remainingPortfolioRisk };
}

const defaultWeights: Record<ScoreKey, number> = { liquidity: 30, payoff: 25, direction: 20, execution: 15, quality: 10 };

export function scoreOpportunity(input: StrategyInput, result: StrategyResult, direction: Direction, weights: ScoreWeights = {}): ScoreResult | null {
  const optionVolumes = input.legs.map(({ volume, openInterest }) => [volume, openInterest] as const);
  if (optionVolumes.some(([volume, openInterest]) => volume === undefined || openInterest === undefined) || direction === 'insufficient') return null;
  // A long call has no finite maximum payout, so its payoff component stays unavailable.
  if (result.rewardRisk === null || result.rewardRisk < 0) return null;
  const mergedWeights = { ...defaultWeights, ...weights };
  const weightTotal = Object.values(mergedWeights).reduce((sum, value) => sum + value, 0);
  if (!Number.isFinite(weightTotal) || weightTotal <= 0 || Object.values(mergedWeights).some((value) => value < 0)) return null;

  const liquidities = optionVolumes.map(([volume, openInterest]) => (Math.min((volume ?? 0) / 500, 1) * 0.45 + Math.min((openInterest ?? 0) / 1500, 1) * 0.55) * 100);
  const widestSpread = Math.max(...input.legs.map(spreadPercent));
  const bullish = input.strategy === 'long_call' || input.strategy === 'bull_call';
  const aligned = direction === (bullish ? 'bullish' : 'bearish');
  const qualified = input.legs.every(({ status }) => status === 'VERIFIED_FRESH' || status === 'VERIFIED_DELAYED' || status === 'DEMO');
  if (!qualified) return null;
  const quality = input.legs.some(({ status }) => status === 'VERIFIED_DELAYED') ? 65 : 100;

  const components: [ScoreKey, string, number, string][] = [
    ['liquidity', 'Liquidité', Math.min(...liquidities), 'Volume et intérêt ouvert de la jambe la moins liquide, plafonnés à 500 et 1 500.'],
    ['payoff', 'Profil rendement / risque', Math.min(result.rewardRisk / 2.5, 1) * 100, 'Rapport entre le meilleur résultat net à l’échéance et la perte maximale, plafonné à 2,5.'],
    ['direction', 'Cohérence directionnelle', aligned ? 100 : direction === 'mixed' ? 50 : direction === 'neutral' ? 35 : 0, 'Alignement de la stratégie sur la direction de la thèse de recherche.'],
    ['execution', 'Efficacité indicative', Math.max(0, 100 - widestSpread * 3), 'Pénalité de trois points par point de pourcentage de l’écart bid/ask le plus large.'],
    ['quality', 'Qualité des données', quality, 'Classification de fraîcheur de la jambe la moins récente. En démo, cette qualité est simulée.'],
  ];
  const breakdown = components.map(([key, label, value, reason]) => ({ key, label, value: Math.round(value), weight: mergedWeights[key] * 100 / weightTotal, reason }));
  return { total: Math.round(breakdown.reduce((sum, row) => sum + row.value * row.weight / 100, 0)), breakdown };
}

export function constructStrategies(quotes: ContractQuote[], preferences: RiskPreferences, context: ConstructionContext): { opportunities: Opportunity[]; rejections: string[] } {
  const { candidate } = context;
  if (candidate.status === 'DEMO' && !context.allowDemo) {
    return { opportunities: [], rejections: ['Une analyse fictive est exclue de la recherche en direct.'] };
  }
  const now = context.now ?? new Date();
  const opportunities: Opportunity[] = [];
  const reasons = new Set<string>();
  const uniqueQuotes = new Map<string, ContractQuote>();
  const conflicting = new Set<string>();
  for (const quote of quotes.slice(0, 48)) {
    const validation = validateQuote(quote, candidate.symbol, now);
    if (!validation.valid) {
      reasons.add(`${quote.id} · ${validation.reason}`);
      continue;
    }
    const normalized = { ...quote, id: makeOccSymbol(quote.symbol, quote.expiration, quote.type, quote.strike), status: validation.status };
    const existing = uniqueQuotes.get(normalized.id);
    if (existing && JSON.stringify(existing) !== JSON.stringify(normalized)) {
      const sameTime = existing.quoteAt === normalized.quoteAt;
      if (sameTime && (existing.bid !== normalized.bid || existing.ask !== normalized.ask || (existing.status === 'DEMO') !== (normalized.status === 'DEMO'))) {
        conflicting.add(normalized.id);
        reasons.add(`${normalized.id} · cotations contradictoires au même horodatage.`);
      }
      if (Date.parse(existing.quoteAt) > Date.parse(normalized.quoteAt)) continue;
    }
    uniqueQuotes.set(normalized.id, normalized);
  }
  for (const id of conflicting) uniqueQuotes.delete(id);
  if (uniqueQuotes.size === 0) reasons.add('Aucune cotation d’option vérifiée et exploitable pour cette recherche.');

  const quoteList = [...uniqueQuotes.values()];
  const allowed = preferences.strategies ?? defaultRiskPreferences.strategies;
  for (const long of quoteList) {
    const longStrategy: Strategy = long.type === 'call' ? 'long_call' : 'long_put';
    const spreadStrategy: Strategy = long.type === 'call' ? 'bull_call' : 'bear_put';
    const shortQuotes = quoteList.filter((quote) => quote.expiration === long.expiration && quote.type === long.type && (quote.status === 'DEMO') === (long.status === 'DEMO') && (long.type === 'call' ? quote.strike > long.strike : quote.strike < long.strike)).slice(0, 5);
    const combinations: [Strategy, ContractQuote[]][] = [[longStrategy, [long]], ...shortQuotes.map((short): [Strategy, ContractQuote[]] => [spreadStrategy, [long, short]])];
    for (const [strategy, legs] of combinations) {
      if (!allowed.includes(strategy)) continue;
      const input = { strategy, legs, quantity: context.quantity ?? 1, fees: context.fees ?? 0 };
      try {
        const result = calculateStrategy(input);
        const risk = assessRisk(input, result, preferences, context);
        if (!risk.eligible) {
          for (const reason of risk.reasons) reasons.add(reason);
          continue;
        }
        const status = long.status === 'DEMO' ? 'DEMO' : legs.some((leg) => leg.status === 'VERIFIED_DELAYED') ? 'VERIFIED_DELAYED' : 'VERIFIED_FRESH';
        opportunities.push({
          id: `${strategy}-${legs.map(({ id }) => id).join('-')}`, symbol: candidate.symbol, name: candidate.name, price: candidate.price,
          direction: candidate.direction, strategy, expiration: long.expiration, dte: daysToExpiration(long.expiration, now), input, result,
          score: scoreOpportunity(input, result, candidate.direction, context.weights), status, updatedAt: now.toISOString(), thesis: candidate.thesis,
          warnings: [...risk.warnings, ...(status === 'DEMO' ? [] : ['Cotation de recherche indicative. Confirmez les prix, la séance et les conditions auprès de votre courtier.'])],
        });
      } catch (error) {
        reasons.add((error as Error).message);
      }
    }
  }
  opportunities.sort((a, b) => (b.score?.total ?? -1) - (a.score?.total ?? -1) || a.result.maxLoss - b.result.maxLoss || a.id.localeCompare(b.id));
  if (!opportunities.length && !reasons.size) reasons.add('Aucune stratégie autorisée ne peut être construite avec les cotations disponibles.');
  return { opportunities, rejections: [...reasons].slice(0, 30) };
}
