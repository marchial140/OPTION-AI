import { createHash } from 'node:crypto';
import Decimal from 'decimal.js';
import {
  assessRisk, calculateStrategy, compareOpportunities, constructStrategies, daysToExpiration,
  optionTradingCutoff, payoffAt, scoreOpportunity, strategySchema,
} from '../../src/lib/quant';
import type {
  ConstructionContext, ContractQuote, Opportunity, RiskPreferences, ScoreResult, Strategy,
} from '../../src/lib/quant';
import { enumerateEligible } from './candidate-audit';
import { phase1Protocol as protocol } from './config';
import type { Phase1Inputs } from './inputs';

const msPerDay = 86_400_000;
const cents = (value: number) => new Decimal(value).toDecimalPlaces(2).toNumber();
const percent = (value: number) => new Decimal(value).times(100).toDecimalPlaces(6).toNumber();
const bullish = (strategy: Strategy) => strategy === 'long_call' || strategy === 'bull_call';
const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);

export const phase1Risk: RiskPreferences = { ...protocol.risk, strategies: [...protocol.risk.strategies] };

type StrategyCounts = Record<Strategy, number>;
type Model = 'A' | 'B' | 'C' | 'D' | 'E';
interface SessionPair { signalDate: string; entryDate: string }
interface Selection extends SessionPair { opportunity: Opportunity }
interface Gap {
  date: string;
  symbol: string;
  contract: string;
  reason: 'missing_entry_quote' | 'missing_expiry_close' | 'expiry_past_horizon';
}
interface Rejection extends Selection { reasons: string[] }

export interface Trade {
  signalDate: string;
  entryDate: string;
  expirationDate: string;
  strategy: Strategy;
  score: number | null;
  entryUnderlying: number;
  expiryUnderlying: number;
  longOcc: string;
  shortOcc: string | null;
  longStrike: number;
  shortStrike: number | null;
  longAsk: number;
  shortBid: number | null;
  quantity: number;
  multiplier: number;
  entryDebit: number;
  signalDte: number;
  entryDte: number;
  longMoneynessPct: number;
  shortMoneynessPct: number | null;
  maxLoss: number;
  maxProfit: number | null;
  breakEven: number | null;
  requiredMovePct: number | null;
  actualMovePct: number;
  expiryPayoff: number;
  fees: number;
  grossPnl: number;
  netPnl: number;
  favorable: boolean;
  maximumLoss: boolean;
}

interface ReplayRun {
  model: Model;
  seed?: number;
  selections: Selection[];
  rejections: Rejection[];
  trades: Trade[];
  gaps: Gap[];
  fills: { strategy: Strategy; fees: number }[];
  signalsWithMissingEntry: number;
  signalsWithMissingSettlement: number;
  openPastHorizon: number;
}

function closeTime(date: string): Date {
  const timestamp = optionTradingCutoff(date);
  if (timestamp === null) throw new Error(`Market calendar has no regular close on ${date}`);
  return new Date(timestamp);
}

export function buildSchedule(closes: ReadonlyMap<string, number>): SessionPair[] {
  const sessions = [...closes.keys()].filter((date) => date >= protocol.start && date <= protocol.horizon).sort();
  if (sessions.length !== protocol.expectedSessions || sessions[0] !== protocol.start || sessions.at(-1) !== protocol.horizon) {
    throw new Error(`Expected ${protocol.expectedSessions} AAPL closes between ${protocol.start} and ${protocol.horizon}`);
  }
  const pairs: SessionPair[] = [];
  for (let anchor = Date.parse(protocol.start); anchor <= Date.parse(protocol.horizon); anchor += protocol.scanEveryCalendarDays * msPerDay) {
    const anchorDate = new Date(anchor).toISOString().slice(0, 10);
    const index = sessions.findIndex((date) => date >= anchorDate);
    if (index < 0 || index >= sessions.length - 1) break;
    pairs.push({ signalDate: sessions[index], entryDate: sessions[index + 1] });
  }
  if (pairs.length !== protocol.expectedSignals) throw new Error(`Expected ${protocol.expectedSignals} scheduled signals`);
  return pairs;
}

export function createSignalContext(date: string, price: number): ConstructionContext {
  const now = closeTime(date);
  return {
    now,
    candidate: {
      symbol: protocol.symbol, name: protocol.symbol, price, direction: protocol.signalDirection,
      change: null, thesis: '', risks: [], bullishFactors: [], bearishFactors: [], sources: [],
      updatedAt: now.toISOString(), status: 'VERIFIED_DELAYED',
    },
    weights: protocol.weightsA,
    fees: protocol.entryFees,
    quantity: protocol.quantity,
  };
}

function requireChain(inputs: Phase1Inputs, date: string): ContractQuote[] {
  const chain = inputs.signalChains.get(date);
  if (!chain?.length || !chain.some((row) => row.type === 'call') || !chain.some((row) => row.type === 'put')) {
    throw new Error(`Missing two-sided historical screening chain for ${date}`);
  }
  return chain;
}

function withScore(opportunity: Opportunity, score: ScoreResult | null): Opportunity {
  return { ...opportunity, score };
}

export function symmetricScore(opportunity: Opportunity, signalClose: number): ScoreResult | null {
  if (opportunity.input.legs.length > 1) return opportunity.score;
  const shift = bullish(opportunity.strategy) ? protocol.symmetricSpotMove : -protocol.symmetricSpotMove;
  const scenarioSpot = new Decimal(signalClose).times(new Decimal(1).plus(shift)).toNumber();
  const payoff = payoffAt(opportunity.input, scenarioSpot);
  const ratio = Math.min(protocol.payoffScoreRatioCap, Math.max(0, payoff / opportunity.result.maxLoss));
  const withPayoff = scoreOpportunity(
    opportunity.input,
    { ...opportunity.result, rewardRisk: ratio },
    protocol.signalDirection,
    protocol.weightsA,
  );
  if (!withPayoff) return null;
  return {
    ...withPayoff,
    breakdown: withPayoff.breakdown.map((component) => component.key === 'payoff'
      ? { ...component, reason: 'Expiry payoff for a favorable 10% move from signal close, divided by maximum loss.' }
      : component),
  };
}

export function drawUniform(seed: number, signalDate: string, size: number): number {
  if (!Number.isSafeInteger(size) || size < 1 || size > 0x1_0000_0000) {
    throw new Error('Random selection requires a nonempty supported candidate count');
  }
  const limit = 0x1_0000_0000 - (0x1_0000_0000 % size);
  for (let attempt = 0; ; attempt++) {
    const draw = createHash('sha256').update(`phase-1:${seed}:${signalDate}:${attempt}`).digest().readUInt32BE();
    if (draw < limit) return draw % size;
  }
}

function baselineSelections(inputs: Phase1Inputs, schedule: SessionPair[]): Selection[] {
  return schedule.flatMap((pair) => {
    const { signalDate } = pair;
    const context = createSignalContext(signalDate, inputs.closes.get(signalDate)!);
    const top = constructStrategies(requireChain(inputs, signalDate), phase1Risk, context).opportunities[0];
    return top?.score ? [{ ...pair, opportunity: top }] : [];
  });
}

function alternativeSelections(inputs: Phase1Inputs, schedule: SessionPair[]) {
  const B: Selection[] = [];
  const C: Selection[] = [];
  const D = protocol.randomSeeds.map((seed) => ({ seed, selections: [] as Selection[] }));
  for (const pair of schedule) {
    const { signalDate } = pair;
    const signalClose = inputs.closes.get(signalDate)!;
    const context = createSignalContext(signalDate, signalClose);
    const opportunities = enumerateEligible(requireChain(inputs, signalDate), phase1Risk, context);
    const firstB = opportunities.map((item) => withScore(item, scoreOpportunity(
      item.input, item.result, protocol.signalDirection, protocol.weightsB,
    ))).sort(compareOpportunities)[0];
    const firstC = opportunities.map((item) => withScore(item, symmetricScore(item, signalClose)))
      .sort(compareOpportunities)[0];
    if (firstB?.score) B.push({ ...pair, opportunity: firstB });
    if (firstC?.score) C.push({ ...pair, opportunity: firstC });
    const canonical = opportunities.sort((a, b) => a.id < b.id ? -1 : Number(a.id > b.id));
    if (canonical.length) {
      for (const { seed, selections } of D) {
        const opportunity = canonical[drawUniform(seed, signalDate, canonical.length)];
        selections.push({ ...pair, opportunity });
      }
    }
  }
  return { B, C, D };
}

export function replaySelections(
  model: Model, inputs: Pick<Phase1Inputs, 'closes'>, selections: Selection[],
  entryQuotes: Phase1Inputs['entryQuotes'], seed?: number,
): ReplayRun {
  const run: ReplayRun = {
    model, seed, selections, trades: [], rejections: [], gaps: [], fills: [],
    signalsWithMissingEntry: 0, signalsWithMissingSettlement: 0, openPastHorizon: 0,
  };
  const positions: { expiration: string; risk: number }[] = [];
  for (const selection of selections) {
    const { opportunity, signalDate, entryDate } = selection;
    const quotes = entryQuotes.get(entryDate);
    const missing = opportunity.input.legs.filter(({ id }) => !quotes?.has(id));
    if (missing.length) {
      run.signalsWithMissingEntry++;
      for (const { id } of missing) {
        run.gaps.push({ date: entryDate, symbol: protocol.symbol, contract: id, reason: 'missing_entry_quote' });
      }
      continue;
    }
    const legs = opportunity.input.legs.map(({ id }) => quotes!.get(id)!);
    const input = { ...opportunity.input, legs };
    const now = closeTime(entryDate);
    let value;
    try {
      value = calculateStrategy(input);
    } catch (error) {
      run.rejections.push({ ...selection, reasons: [error instanceof Error ? error.message : String(error)] });
      continue;
    }
    // Include today's expiring positions conservatively at the closing auction.
    // With biweekly signals and 30 DTE the 8-position / 20% caps cannot bind:
    // at most three positions, each at no more than 5% of reference capital.
    const open = positions.filter(({ expiration }) => expiration >= entryDate);
    const risk = assessRisk(input, value, phase1Risk, {
      now, existingRisk: sum(open.map((position) => position.risk)), openPositions: open.length,
    });
    if (!risk.eligible) {
      run.rejections.push({ ...selection, reasons: risk.reasons });
      continue;
    }
    run.fills.push({ strategy: input.strategy, fees: input.fees });
    const expirationDate = opportunity.expiration;
    positions.push({ expiration: expirationDate, risk: value.maxLoss });
    const expiryUnderlying = inputs.closes.get(expirationDate);
    if (expirationDate > protocol.horizon || expiryUnderlying === undefined) {
      if (expirationDate > protocol.horizon) run.openPastHorizon++;
      else run.signalsWithMissingSettlement++;
      run.gaps.push({
        date: expirationDate, symbol: protocol.symbol, contract: legs[0].id,
        reason: expirationDate > protocol.horizon ? 'expiry_past_horizon' : 'missing_expiry_close',
      });
      continue;
    }
    const [long, short] = legs;
    const entryUnderlying = inputs.closes.get(entryDate)!;
    const rawNetPnl = payoffAt(input, expiryUnderlying);
    const netPnl = cents(rawNetPnl);
    const fees = input.fees;
    const direction = bullish(opportunity.strategy) ? 1 : -1;
    run.trades.push({
      signalDate, entryDate, expirationDate, strategy: input.strategy, score: opportunity.score?.total ?? null,
      entryUnderlying, expiryUnderlying, longOcc: long.id, shortOcc: short?.id ?? null,
      longStrike: long.strike, shortStrike: short?.strike ?? null, longAsk: long.ask, shortBid: short?.bid ?? null,
      quantity: input.quantity, multiplier: value.multiplier, entryDebit: value.entryDebit,
      signalDte: opportunity.dte, entryDte: daysToExpiration(expirationDate, now),
      longMoneynessPct: percent((entryUnderlying / long.strike - 1) * direction),
      shortMoneynessPct: short ? percent((entryUnderlying / short.strike - 1) * direction) : null,
      maxLoss: value.maxLoss, maxProfit: value.maxProfit, breakEven: value.breakEven,
      requiredMovePct: value.breakEven === null ? null : percent(value.breakEven / entryUnderlying - 1),
      actualMovePct: percent(expiryUnderlying / entryUnderlying - 1),
      expiryPayoff: cents(rawNetPnl + value.entryDebit + fees), fees, grossPnl: cents(rawNetPnl + fees), netPnl,
      favorable: (expiryUnderlying - entryUnderlying) * direction > 0,
      maximumLoss: Math.abs(rawNetPnl + value.maxLoss) < 1e-8,
    });
  }
  return run;
}

function assertBaseline(inputs: Phase1Inputs, run: ReplayRun) {
  const artifact = inputs.baseline;
  if (artifact.sessions !== protocol.expectedSessions || artifact.signals !== protocol.expectedSignals
    || run.selections.length !== artifact.signals || run.gaps.length
    || run.trades.length !== artifact.outcomes.length || run.rejections.length !== artifact.skipped.length) {
    throw new Error('Original baseline counts do not reconcile with the offline replay');
  }
  for (const { opportunity, entryDate, signalDate } of run.selections) {
    const originalQuotes = inputs.originalEntryQuotes.get(entryDate);
    const exactLegs = originalQuotes?.size === opportunity.input.legs.length
      && opportunity.input.legs.every(({ id }) => originalQuotes.has(id));
    if (!exactLegs) throw new Error(`Original winning candidate differs for ${signalDate}`);
  }
  for (const trade of run.trades) {
    const original = artifact.outcomes.find(({ signal }) => signal === trade.signalDate);
    if (!original || original.entry !== trade.entryDate || original.expiry !== trade.expirationDate
      || original.strategy !== trade.strategy || original.score !== trade.score
      || original.maxLoss !== trade.maxLoss || original.pnl !== trade.netPnl) {
      throw new Error(`Original settled trade differs for ${trade.signalDate}`);
    }
  }
  for (const rejection of run.rejections) {
    if (!artifact.skipped.some(({ date }) => date === rejection.signalDate)) {
      throw new Error(`Original entry-rejection date differs for ${rejection.signalDate}`);
    }
  }
}

function countStrategies(strategies: Strategy[]): StrategyCounts {
  return Object.fromEntries(strategySchema.options.map((strategy) => [
    strategy, strategies.filter((value) => value === strategy).length,
  ])) as StrategyCounts;
}

function coverage(run: ReplayRun) {
  return {
    selected_signals: run.selections.length,
    verified_entry_fills: run.fills.length,
    verified_entry_rejections: run.rejections.length,
    signals_missing_entry: run.signalsWithMissingEntry,
    signals_missing_settlement: run.signalsWithMissingSettlement,
    verified_open_at_horizon: run.openPastHorizon,
    ...Object.fromEntries(Object.entries(countStrategies(run.selections.map(({ opportunity }) => opportunity.strategy)))
      .map(([strategy, count]) => [`selected_${strategy}`, count])),
  };
}

export function summarizeRun(run: ReplayRun) {
  const blocked = run.gaps.length > 0;
  const { trades } = run;
  const byStrategy = countStrategies(run.fills.map(({ strategy }) => strategy));
  const winning = trades.filter(({ netPnl }) => netPnl > 0);
  const losing = trades.filter(({ netPnl }) => netPnl < 0);
  const winners = sum(winning.map(({ netPnl }) => netPnl));
  const losses = -sum(losing.map(({ netPnl }) => netPnl));
  const gross = cents(sum(trades.map(({ grossPnl }) => grossPnl)));
  const net = cents(sum(trades.map(({ netPnl }) => netPnl)));
  const maxLoss = trades.filter(({ maximumLoss }) => maximumLoss).length;
  const entryKnown = run.signalsWithMissingEntry === 0;
  const canReportRealized = entryKnown && run.signalsWithMissingSettlement === 0;
  return {
    executed_trades: entryKnown ? run.fills.length : null,
    rejected_trades: entryKnown ? run.rejections.length : null,
    long_call: entryKnown ? byStrategy.long_call : null,
    long_put: entryKnown ? byStrategy.long_put : null,
    bull_call: entryKnown ? byStrategy.bull_call : null,
    bear_put: entryKnown ? byStrategy.bear_put : null,
    winning_trades: blocked ? null : winning.length,
    losing_trades: blocked ? null : losing.length,
    breakeven_trades: blocked ? null : trades.length - winning.length - losing.length,
    win_rate_pct: !blocked && trades.length ? percent(winning.length / trades.length) : null,
    maximum_loss_trades: blocked ? null : maxLoss,
    maximum_loss_frequency_pct: !blocked && trades.length ? percent(maxLoss / trades.length) : null,
    gross_pnl_usd: blocked ? null : gross,
    transaction_costs_usd: entryKnown ? cents(sum(run.fills.map(({ fees }) => fees))) : null,
    net_pnl_usd: blocked ? null : net,
    return_pct: blocked ? null : percent(net / protocol.risk.capital),
    avg_net_pnl_usd: !blocked && trades.length ? cents(net / trades.length) : null,
    profit_factor: !blocked && losses > 0 ? new Decimal(winners).div(losses).toDecimalPlaces(6).toNumber() : null,
    max_drawdown_pct: run.model === 'E' ? 0 : null,
    settled_trades_through_horizon: canReportRealized ? trades.length : null,
    settled_winning_trades: canReportRealized ? winning.length : null,
    settled_losing_trades: canReportRealized ? losing.length : null,
    settled_win_rate_pct: canReportRealized && trades.length ? percent(winning.length / trades.length) : null,
    settled_maximum_loss_trades: canReportRealized ? maxLoss : null,
    settled_maximum_loss_frequency_pct: canReportRealized && trades.length ? percent(maxLoss / trades.length) : null,
    settled_gross_pnl_usd: canReportRealized ? gross : null,
    settled_entry_fees_usd: canReportRealized ? cents(sum(trades.map(({ fees }) => fees))) : null,
    settled_avg_net_pnl_usd: canReportRealized && trades.length ? cents(net / trades.length) : null,
    settled_profit_factor: canReportRealized && losses > 0
      ? new Decimal(winners).div(losses).toDecimalPlaces(6).toNumber() : null,
    realized_net_pnl_usd_through_horizon: canReportRealized ? net : null,
  };
}

function comparison(A: ReplayRun, E: ReplayRun, B?: ReplayRun, C?: ReplayRun, D: ReplayRun[] = []) {
  const row = (run: ReplayRun) => ({
    config: run.model,
    status: run.signalsWithMissingEntry || run.signalsWithMissingSettlement
      ? 'incomplete_data' : run.openPastHorizon ? 'open_at_horizon' : 'complete',
    statistic: 'observed', random_seeds: null, ...coverage(run), ...summarizeRun(run),
  });
  const randomNumbers = D.map((run) => ({ ...coverage(run), ...summarizeRun(run) }));
  const randomIncomplete = D.some((run) => run.signalsWithMissingEntry || run.signalsWithMissingSettlement);
  const randomOpen = D.some((run) => run.openPastHorizon);
  const columns = [...Object.keys(coverage(A)), ...Object.keys(summarizeRun(A))];
  const median = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  };
  const randomSummary = Object.entries({
    minimum: (values: number[]) => Math.min(...values),
    median,
    mean: (values: number[]) => sum(values) / values.length,
    maximum: (values: number[]) => Math.max(...values),
  });
  const random = D.length ? randomSummary.map(([statistic, compute]) => ({
    config: 'D', status: randomIncomplete ? 'incomplete_data' : randomOpen ? 'open_at_horizon' : 'complete',
    statistic, random_seeds: D.length,
    ...Object.fromEntries(columns.map((key) => {
      const values = randomNumbers.map((entry) => entry[key as keyof typeof entry]);
      return [key, values.every((value): value is number => typeof value === 'number')
        ? new Decimal(compute(values)).toDecimalPlaces(6).toNumber() : null];
    })),
  })) : [];
  return [row(A), ...(B ? [row(B)] : []), ...(C ? [row(C)] : []), ...random, row(E)];
}

export function replayPhase1(inputs: Phase1Inputs, baselineOnly = false) {
  const schedule = buildSchedule(inputs.closes);
  const A = replaySelections('A', inputs, baselineSelections(inputs, schedule), inputs.originalEntryQuotes);
  assertBaseline(inputs, A);
  const E = replaySelections('E', inputs, [], inputs.entryQuotes);
  if (baselineOnly) return { A, E, B: undefined, C: undefined, D: [], comparison: comparison(A, E) };
  const alternatives = alternativeSelections(inputs, schedule);
  const B = replaySelections('B', inputs, alternatives.B, inputs.entryQuotes);
  const C = replaySelections('C', inputs, alternatives.C, inputs.entryQuotes);
  const D = alternatives.D.map(({ seed, selections }) => replaySelections('D', inputs, selections, inputs.entryQuotes, seed));
  return { A, B, C, D, E, comparison: comparison(A, E, B, C, D) };
}

export function missingEntryPlan(runs: ReplayRun[]) {
  const requests = new Map<string, { date: string; symbol: string; contract: string; configs: Set<Model> }>();
  for (const run of runs) {
    for (const { date, symbol, contract, reason } of run.gaps) {
      if (reason !== 'missing_entry_quote') continue;
      const key = `${date}:${contract}`;
      const request = requests.get(key) ?? { date, symbol, contract, configs: new Set() };
      request.configs.add(run.model);
      requests.set(key, request);
    }
  }
  return [...requests.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, request]) => ({
    ...request, configs: [...request.configs].sort(),
  }));
}
