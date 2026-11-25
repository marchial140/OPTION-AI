import {
  assessRisk, calculateStrategy, compareOpportunities, constructStrategies, daysToExpiration, makeOccSymbol,
  opportunityQuoteStatus, optionTradingCutoff, strategySchema, validateQuote, scoreOpportunity,
  type ConstructionContext, type ContractQuote, type Opportunity, type RiskPreferences, type Strategy,
} from '../../src/lib/quant';
import { phase1Protocol } from './config';
import type { Phase1Inputs } from './inputs';

export function enumerateEligible(
  quotes: ContractQuote[], preferences: RiskPreferences, context: ConstructionContext,
): Opportunity[] {
  const { candidate, now = new Date() } = context;
  const unique = new Map<string, ContractQuote>();
  for (const quote of quotes) {
    const validation = validateQuote(quote, candidate.symbol, now);
    if (!validation.valid || quote.status === 'DEMO') continue;
    const id = makeOccSymbol(quote.symbol, quote.expiration, quote.type, quote.strike);
    if (unique.has(id)) throw new Error(`The exhaustive audit needs an unambiguous quote per contract: ${id}`);
    unique.set(id, { ...quote, id, status: validation.status });
  }

  const opportunities: Opportunity[] = [];
  const allowed = preferences.strategies ?? strategySchema.options;
  const evaluate = (strategy: Strategy, legs: ContractQuote[]) => {
    if (!allowed.includes(strategy)) return;
    const input = { strategy, legs, fees: context.fees ?? 0, quantity: context.quantity ?? 1 };
    let result: ReturnType<typeof calculateStrategy>;
    try {
      result = calculateStrategy(input);
    } catch {
      return;
    }
    const risk = assessRisk(input, result, preferences, { ...context, now });
    if (!risk.eligible) return;
    const expiration = legs[0].expiration;
    opportunities.push({
      id: `${strategy}-${legs.map((leg) => leg.id).join('-')}`,
      symbol: candidate.symbol, name: candidate.name, price: candidate.price, direction: candidate.direction, strategy,
      expiration, dte: daysToExpiration(expiration, now), input, result,
      score: scoreOpportunity(input, result, candidate.direction, context.weights), status: opportunityQuoteStatus(legs),
      updatedAt: now.toISOString(), thesis: candidate.thesis, warnings: risk.warnings,
    });
  };

  const groups = new Map<string, ContractQuote[]>();
  for (const quote of unique.values()) {
    const key = `${quote.expiration}:${quote.type}`;
    const group = groups.get(key) ?? [];
    group.push(quote);
    groups.set(key, group);
    evaluate(quote.type === 'call' ? 'long_call' : 'long_put', [quote]);
  }
  for (const group of groups.values()) {
    group.sort((a, b) => a.strike - b.strike);
    for (const [index, lower] of group.entries()) {
      for (const upper of group.slice(index + 1)) {
        if (lower.strike === upper.strike) continue;
        if (lower.type === 'call') evaluate('bull_call', [lower, upper]);
        else evaluate('bear_put', [upper, lower]);
      }
    }
  }
  return opportunities.sort(compareOpportunities);
}

function countByStrategy(opportunities: Opportunity[]) {
  const counts = { long_call: 0, long_put: 0, bull_call: 0, bear_put: 0 };
  for (const opportunity of opportunities) counts[opportunity.strategy]++;
  return counts;
}

export function auditCandidates(quotes: ContractQuote[], preferences: RiskPreferences, context: ConstructionContext) {
  const exhaustive = enumerateEligible(quotes, preferences, context);
  const production = constructStrategies(quotes, preferences, context).opportunities;
  const reversed = constructStrategies([...quotes].reverse(), preferences, context).opportunities;
  const callsFirst = constructStrategies([...quotes].sort((a, b) => a.type.localeCompare(b.type)), preferences, context).opportunities;
  const retainedIds = new Set(production.map((item) => item.id));
  const eligibleIds = new Set(exhaustive.map((item) => item.id));
  const byLongLeg = new Map<string, number>();
  const afterLegCap = exhaustive.filter((item) => {
    if (item.input.legs.length === 1) return true;
    const long = item.input.legs[0].id;
    const count = (byLongLeg.get(long) ?? 0) + 1;
    byLongLeg.set(long, count);
    return count <= 5;
  });
  const top = exhaustive.find((item) => item.score);
  const retainedTop = production.find((item) => item.score);
  const scoreTies = top ? exhaustive.filter((item) => item.score?.total === top.score?.total) : [];
  const lexicalTop = [...scoreTies].sort((a, b) => a.id.localeCompare(b.id))[0];
  const neutralTop = exhaustive.map((item) => ({
    ...item, score: scoreOpportunity(item.input, item.result, 'neutral', { ...context.weights, direction: 20 }),
  })).sort(compareOpportunities).find((item) => item.score);
  return {
    rows: { calls: quotes.filter((quote) => quote.type === 'call').length, puts: quotes.filter((quote) => quote.type === 'put').length },
    expirations: new Set(quotes.map((quote) => quote.expiration)).size,
    eligible: countByStrategy(exhaustive), scored: countByStrategy(exhaustive.filter((item) => item.score)),
    retained: countByStrategy(production),
    removedByLegCap: exhaustive.length - afterLegCap.length,
    removedBySymbolCap: afterLegCap.length - production.length,
    omittedFromUncappedTop60: exhaustive.slice(0, 60).filter((item) => !retainedIds.has(item.id)).length,
    retainedOutsideExhaustive: production.filter((item) => !eligibleIds.has(item.id)).length,
    orderInvariant: production.every((item, index) => item.id === reversed[index]?.id && item.id === callsFirst[index]?.id)
      && production.length === reversed.length && production.length === callsFirst.length,
    bestUnchanged: retainedTop?.id === top?.id,
    topStrategy: top?.strategy ?? null, neutralTopStrategy: neutralTop?.strategy ?? null,
    neutralChangesTop: top?.id !== neutralTop?.id,
    topScore: top?.score?.total ?? null, scoreTieCount: scoreTies.length,
    lossTieBreakChangesTop: top?.id !== lexicalTop?.id,
    lossSavedVsLexical: top && lexicalTop ? lexicalTop.result.maxLoss - top.result.maxLoss : 0,
    singleLegs: exhaustive.filter((item) => item.input.legs.length === 1).map((item) => ({
      strategy: item.strategy, strike: item.input.legs[0].strike, spot: context.candidate.price,
      maxLoss: item.result.maxLoss, payoffRatio: item.result.rewardRisk, score: item.score?.total ?? null,
    })),
  };
}

export function runCandidateDiagnostics(inputs: Phase1Inputs) {
  const dates = inputs.coverage.expectedSignalDates;
  const scans = dates.map((date) => {
    const quotes = inputs.signalChains.get(date);
    const spot = inputs.closes.get(date);
    const cutoff = optionTradingCutoff(date);
    if (!quotes || spot === undefined || cutoff === null) throw new Error(`Missing candidate audit inputs on ${date}.`);
    const now = new Date(cutoff);
    const open = inputs.baseline.outcomes.filter((item) => item.entry <= date && item.exit > date);
    const context: ConstructionContext = {
      now, fees: phase1Protocol.entryFees, quantity: phase1Protocol.quantity, weights: phase1Protocol.weightsA,
      existingRisk: open.reduce((cents, item) => cents + Math.round(item.maxLoss * 100), 0) / 100,
      openPositions: open.length,
      candidate: {
        symbol: phase1Protocol.symbol, name: phase1Protocol.symbol, price: spot, change: null,
        direction: phase1Protocol.signalDirection, thesis: '', risks: [], bullishFactors: [], bearishFactors: [],
        sources: [], updatedAt: now.toISOString(), status: 'VERIFIED_DELAYED',
      },
    };
    return { date, ...auditCandidates(quotes, phase1Protocol.risk, context) };
  });
  const sum = (select: (scan: typeof scans[number]) => number) => scans.reduce((total, scan) => total + select(scan), 0);
  const tally = (select: (scan: typeof scans[number]) => Strategy | null) => Object.fromEntries(
    strategySchema.options.map((strategy) => [strategy, scans.filter((scan) => select(scan) === strategy).length]),
  );
  const singles = scans.flatMap((scan) => scan.singleLegs);
  const mean = (items: number[]) => items.length ? items.reduce((total, value) => total + value, 0) / items.length : null;
  const median = (items: number[]) => {
    const sorted = items.toSorted((a, b) => a - b);
    const midpoint = Math.floor(sorted.length / 2);
    return sorted.length === 0 ? null : sorted.length % 2 ? sorted[midpoint] : (sorted[midpoint - 1] + sorted[midpoint]) / 2;
  };
  const singlesByMoneyness = (['long_call', 'long_put'] as const).flatMap((strategy) => (
    [true, false].map((otm) => {
      const items = singles.filter((item) => item.strategy === strategy && item.spot !== null
        && (strategy === 'long_call' ? item.strike > item.spot : item.strike < item.spot) === otm);
      const scored = items.flatMap((item) => item.score === null ? [] : [item.score]);
      return {
        strategy, otm, eligible: items.length, scored: scored.length, meanScore: mean(scored),
        medianRisk: median(items.map((item) => item.maxLoss)),
        payoffSaturated: items.filter((item) => item.payoffRatio !== null && item.payoffRatio >= phase1Protocol.payoffScoreRatioCap).length,
      };
    })
  ));
  return {
    summary: {
      scans: scans.length, calls: sum((scan) => scan.rows.calls), puts: sum((scan) => scan.rows.puts),
      minExpirations: Math.min(...scans.map((scan) => scan.expirations)), maxExpirations: Math.max(...scans.map((scan) => scan.expirations)),
      eligible: Object.fromEntries(strategySchema.options.map((strategy) => [strategy, sum((scan) => scan.eligible[strategy])] )),
      scored: Object.fromEntries(strategySchema.options.map((strategy) => [strategy, sum((scan) => scan.scored[strategy])] )),
      retained: Object.fromEntries(strategySchema.options.map((strategy) => [strategy, sum((scan) => scan.retained[strategy])] )),
      removedByLegCap: sum((scan) => scan.removedByLegCap), removedBySymbolCap: sum((scan) => scan.removedBySymbolCap),
      omittedFromUncappedTop60: sum((scan) => scan.omittedFromUncappedTop60),
      retainedOutsideExhaustive: sum((scan) => scan.retainedOutsideExhaustive),
      orderInvariant: scans.filter((scan) => scan.orderInvariant).length,
      bestUnchanged: scans.filter((scan) => scan.bestUnchanged).length,
      topTies: scans.filter((scan) => scan.scoreTieCount > 1).length,
      lossTieBreakChangesTop: scans.filter((scan) => scan.lossTieBreakChangesTop).length,
      lossSavedVsLexical: sum((scan) => scan.lossSavedVsLexical),
      topStrategies: tally((scan) => scan.topStrategy),
      neutralTopStrategies: tally((scan) => scan.neutralTopStrategy),
      neutralChangesTop: scans.filter((scan) => scan.neutralChangesTop).length,
      singlesByMoneyness,
    },
    scans,
  };
}
