import { assessRisk, type ContractQuote, type RiskContext, type RiskPreferences, type StrategyInput } from '../../src/lib/quant';
import { enumerateEligible } from '../phase-1/candidate-audit';
import { phase2Protocol as protocol } from './config';
import { empiricalDistribution, empiricalWindows, lognormalDistribution, positiveFinite, type TerminalDistribution } from './distributions';
import { instant, prepareReturnHistory, tradingSessionsRemaining, type DataFailure, type PriceHistory, type ReturnHistory, type SpotObservation } from './history';
import { evaluatePrepared, prepareStrategy, type ExpectedValue } from './valuation';

export type Model = TerminalDistribution['kind'];
export type Mode = 'standard' | 'conservative';

export const stressGrid = protocol.volatilityMultipliers.flatMap((volatilityMultiplier) => (
  protocol.arithmeticDriftShocks.map((driftAdjustment) => ({ volatilityMultiplier, driftAdjustment }))
));
const baselineIndex = stressGrid.findIndex(({ volatilityMultiplier, driftAdjustment }) => volatilityMultiplier === 1 && driftAdjustment === 0);

export function forecastDistributions(spot: number, history: ReturnHistory, horizonSessions: number) {
  const windows = empiricalWindows(history.logReturns, horizonSessions);
  const lognormal = stressGrid.map(({ volatilityMultiplier, driftAdjustment }) => lognormalDistribution(
    spot, horizonSessions, history.annualizedVolatility * volatilityMultiplier, protocol.baselineArithmeticDrift + driftAdjustment,
  ));
  const empirical = stressGrid.map(({ volatilityMultiplier, driftAdjustment }) => empiricalDistribution(
    spot, windows, volatilityMultiplier, driftAdjustment,
  ));
  return { horizonSessions, empiricalObservations: windows.logRatios.length,
    historicalHorizonMeanReturn: windows.horizonMeanReturn, historicalHorizonVolatility: windows.horizonSampleVolatility,
    historicalDailyMeanLogReturn: history.dailyMeanLogReturn, historicalAnnualizedVolatility: history.annualizedVolatility,
    baselineLognormal: lognormal[baselineIndex], baselineEmpirical: empirical[baselineIndex], lognormal, empirical };
}

type Forecasts = ReturnType<typeof forecastDistributions>;
type ModelEvaluation = ReturnType<typeof evaluateScenarios>;

function evaluateScenarios(strategy: ReturnType<typeof prepareStrategy>, distributions: TerminalDistribution[]) {
  const scenarios = distributions.map((distribution, i) => ({ ...stressGrid[i], ...evaluatePrepared(strategy, distribution) }));
  const baseline: ExpectedValue = scenarios[baselineIndex];
  const expected = scenarios.map(({ expectedNetPnl }) => expectedNetPnl);
  const probabilities = scenarios.map(({ probabilityOfProfit }) => probabilityOfProfit);
  const minimumExpectedNetPnl = Math.min(...expected);
  const positive = protocol.minExpectedNetPnlExclusive;
  return {
    baseline, scenarios, minimumExpectedNetPnl, maximumExpectedNetPnl: Math.max(...expected),
    minimumProbabilityOfProfit: Math.min(...probabilities), maximumProbabilityOfProfit: Math.max(...probabilities),
    positiveScenarios: expected.filter((value) => value > positive).length,
    decisions: {
      standard: baseline.expectedNetPnl > positive ? 'ELIGIBLE' : 'NO_TRADE',
      conservative: minimumExpectedNetPnl > positive ? 'ELIGIBLE' : 'NO_TRADE',
    } as const,
  };
}

export interface ResearchInputs {
  asOf: Date;
  spot?: SpotObservation;
  history?: PriceHistory;
  preferences: RiskPreferences;
  risk?: Omit<RiskContext, 'now' | 'allowDemo'>;
  additionalCosts?: number;
}

type NoTrade = { decision: 'NO_TRADE'; status: DataFailure['status'] | 'risk_rejected' | 'no_eligible_candidates'; reasons: string[] };
type Evaluated = { status: 'ok'; id: string; forecast: Forecasts; warnings: string[]; lognormal: ModelEvaluation; empirical: ModelEvaluation; disagreement: Record<Mode, boolean> };

function noTrade(status: NoTrade['status'], ...reasons: string[]): NoTrade {
  return { decision: 'NO_TRADE', status, reasons };
}

function prepareInputs({ asOf, spot, history }: ResearchInputs) {
  if (!Number.isFinite(asOf.getTime())) return noTrade('invalid_data', 'Invalid forecast timestamp.');
  if (!spot) return noTrade('insufficient_data', 'No underlying spot observation.');
  const observedAt = instant(spot.observedAt);
  const availableAt = instant(spot.availableAt);
  if (!/^[A-Z][A-Z0-9.]{0,9}$/u.test(spot.symbol) || !positiveFinite(spot.price)
    || !Number.isFinite(observedAt) || !Number.isFinite(availableAt) || observedAt > availableAt || availableAt > asOf.getTime()) {
    return noTrade('invalid_data', 'Spot is invalid or unavailable at the forecast instant.');
  }
  const prepared = prepareReturnHistory(history, spot.symbol, asOf);
  if (prepared.status !== 'ok') return noTrade(prepared.status, prepared.reason);
  if (observedAt < prepared.history.lastCloseTime) return noTrade('insufficient_data', 'Spot predates the latest completed session.');
  return { status: 'ok' as const, spot, history: prepared.history };
}

function quoteAvailable(quote: ContractQuote, symbol: string, asOf: Date) {
  return quote.symbol === symbol && quote.status !== 'DEMO'
    && instant(quote.quoteAt) <= asOf.getTime() && instant(quote.retrievedAt) <= asOf.getTime();
}

export function evaluateResearchCandidate(request: ResearchInputs, input: StrategyInput): Evaluated | NoTrade {
  const prepared = prepareInputs(request);
  if (prepared.status !== 'ok') return prepared;
  return evaluateCandidate(request, prepared, input, new Map());
}

function evaluateCandidate(
  request: ResearchInputs, prepared: Extract<ReturnType<typeof prepareInputs>, { status: 'ok' }>, input: StrategyInput,
  byExpiration: Map<string, Forecasts>,
): Evaluated | NoTrade {
  const { asOf, preferences, risk, additionalCosts } = request;
  if (!input.legs.length) return noTrade('insufficient_data', 'No entry quote.');
  if (!input.legs.every((quote) => quoteAvailable(quote, prepared.spot.symbol, asOf))) {
    return noTrade('invalid_data', 'Entry quotes are inconsistent with the symbol or forecast timestamp.');
  }
  try {
    const strategy = prepareStrategy(input, additionalCosts);
    const assessment = assessRisk(strategy.input, strategy.result, preferences, { ...risk, now: asOf });
    if (!assessment.eligible) return noTrade('risk_rejected', ...assessment.reasons);
    const expiration = input.legs[0].expiration;
    let forecast = byExpiration.get(expiration);
    if (!forecast) {
      const horizon = tradingSessionsRemaining(asOf, expiration);
      if (horizon === null) return noTrade('invalid_data', 'Expiration is outside the supported session calendar.');
      if (horizon > protocol.empiricalLookbackReturns) return noTrade('insufficient_data', 'Horizon exceeds the empirical return window.');
      forecast = forecastDistributions(prepared.spot.price, prepared.history, horizon);
      byExpiration.set(expiration, forecast);
    }
    const lognormal = evaluateScenarios(strategy, forecast.lognormal);
    const empirical = evaluateScenarios(strategy, forecast.empirical);
    return {
      status: 'ok', id: `${input.strategy}-${input.legs.map(({ id }) => id).join('-')}`, forecast, warnings: assessment.warnings,
      lognormal, empirical, disagreement: {
        standard: lognormal.decisions.standard !== empirical.decisions.standard,
        conservative: lognormal.decisions.conservative !== empirical.decisions.conservative,
      },
    };
  } catch (error) {
    return noTrade('invalid_data', error instanceof Error ? error.message : 'Expected value inputs could not be evaluated.');
  }
}

export function rankResearchChain(
  request: ResearchInputs, quotes: readonly ContractQuote[], position: Pick<StrategyInput, 'quantity' | 'fees'>,
) {
  const prepared = prepareInputs(request);
  if (prepared.status !== 'ok') return prepared;
  const byExpiration = new Map<string, Forecasts>();
  const { asOf, preferences, risk } = request;
  const { symbol, price } = prepared.spot;
  const available = quotes.filter((quote) => quoteAvailable(quote, symbol, asOf));
  if (!available.length) return noTrade('insufficient_data', 'No contemporaneous entry quotes for this underlying.');
  let universe: ReturnType<typeof enumerateEligible>;
  try {
    universe = enumerateEligible(available, preferences, {
      ...risk, now: asOf, ...position,
      weights: { liquidity: 0, payoff: 0, direction: 0, quality: 0, execution: 0 },
      candidate: { symbol, price, name: symbol, change: null, direction: 'insufficient', thesis: '', risks: [],
        bullishFactors: [], bearishFactors: [], sources: [], updatedAt: asOf.toISOString(), status: 'VERIFIED_DELAYED' },
    });
  } catch (error) {
    return noTrade('invalid_data', error instanceof Error ? error.message : 'Ambiguous candidate universe.');
  }
  if (!universe.length) return noTrade('no_eligible_candidates', 'No strategy satisfies the existing eligibility restrictions.');
  const evaluations: Evaluated[] = [];
  const excluded: { id: string; failure: NoTrade }[] = [];
  for (const item of universe) {
    const result = evaluateCandidate(request, prepared, item.input, byExpiration);
    if (result.status === 'ok') evaluations.push({ ...result, id: item.id });
    else excluded.push({ id: item.id, failure: result });
  }
  const rank = (model: Model, mode: Mode) => {
    const ranked = evaluations.filter((item) => item[model].decisions[mode] === 'ELIGIBLE').sort((a, b) => (
      b[model].baseline.expectedNetPnl - a[model].baseline.expectedNetPnl || a[model].baseline.maxLoss - b[model].baseline.maxLoss
      || (a.id === b.id ? 0 : a.id < b.id ? -1 : 1)
    )).map(({ id, [model]: value }) => ({ id, expectedNetPnl: value.baseline.expectedNetPnl,
      maxLoss: value.baseline.maxLoss, expectedReturnOnRisk: value.baseline.expectedReturnOnRisk }));
    return { decision: ranked.length ? 'ELIGIBLE' : 'NO_TRADE', ranked } as const;
  };
  const lognormal = { standard: rank('lognormal', 'standard'), conservative: rank('lognormal', 'conservative') };
  const empirical = { standard: rank('empirical', 'standard'), conservative: rank('empirical', 'conservative') };
  return { status: 'ok' as const, universeSize: universe.length, evaluations, excluded, lognormal, empirical,
    disagreement: { standard: lognormal.standard.ranked[0]?.id !== empirical.standard.ranked[0]?.id,
      conservative: lognormal.conservative.ranked[0]?.id !== empirical.conservative.ranked[0]?.id } };
}
