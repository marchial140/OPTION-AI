import Decimal from 'decimal.js';
import {
  assessRisk, calculateStrategy, daysToExpiration, defaultRiskPreferences, makeOccSymbol, optionTradingCutoff, payoffAt, validateQuote,
  type ContractQuote, type StrategyInput,
} from '../../src/lib/quant';
import { evaluateResearchCandidate, type Model, type Mode, type ResearchInputs } from '../phase-2/decision';
import { instant } from '../phase-2/history';
import { contractActionsThrough, type NormalizedActionReview, type NormalizedQuote } from './observations';
import { buildSignalSchedule, buildStudyCalendar, phase3Protocol, type SignalSchedule } from './protocol';

type Configuration = keyof typeof phase3Protocol.configurations;
type SignalState = 'selected' | 'submitted' | 'filled' | 'no_trade' | 'rejected' | 'missing_data';
type EconomicInputs = Pick<ResearchInputs, 'spot' | 'history'>;
export type DisplayedStrategyInput = Omit<StrategyInput, 'legs'> & {
  legs: (ContractQuote & { askSize?: number; bidSize?: number })[];
};
type State = {
  status: SignalState;
  reason?: string;
  selection?: StrategyInput;
  reserved?: Decimal;
  order?: StrategyInput;
};
type OpenPosition = { input: StrategyInput; symbol: string; expiration: string; cost: Decimal };

export interface ExpirationObservation {
  symbol: string;
  expiration: string;
  price: number;
  observedAt: string;
  availableAt: string;
}

interface NoBookObservation {
  role: 'revalidation' | 'fill';
  optionSymbol: string;
  observedAt: string;
  availableAt: string;
  disposition: 'no-quote' | 'halted';
  evidence: string;
}

const rules = phase3Protocol.portfolio;
const cutoff = instant(phase3Protocol.cutoffAt);
const preferences = {
  ...defaultRiskPreferences,
  capital: rules.referenceCapital,
  maxRiskPercent: rules.maxRiskPercent,
  maxPortfolioRiskPercent: rules.maxPortfolioRiskPercent,
  maxPositions: rules.maxPositions,
  maxContracts: rules.quantityPerLeg,
  minDte: rules.minCalendarDte,
  maxDte: rules.maxCalendarDte,
  maxSpreadPercent: rules.maxSpreadPercent,
};

const approvedSymbols = new Set<string>(phase3Protocol.symbols);
const economicRules: Partial<Record<Configuration, { model: Model; mode: Mode }>> = {
  C: { model: 'lognormal', mode: 'standard' }, D: { model: 'lognormal', mode: 'conservative' },
  E: { model: 'empirical', mode: 'standard' }, F: { model: 'empirical', mode: 'conservative' },
};
const compareId = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;

function knownTime(timestamp: string) {
  const value = instant(timestamp);
  if (!Number.isFinite(value)) throw new Error('An explicit, valid event timestamp is required.');
  return value;
}

function identity(leg: ContractQuote) {
  return makeOccSymbol(leg.symbol, leg.expiration, leg.type, leg.strike);
}

function sameLegs(expected: StrategyInput, actual: StrategyInput) {
  return expected.strategy === actual.strategy && expected.legs.length === actual.legs.length
    && expected.legs.every((leg, i) => identity(leg) === identity(actual.legs[i]));
}

function capitalUsed(positions: Iterable<OpenPosition>) {
  let total = new Decimal(0);
  for (const { cost } of positions) total = total.plus(cost);
  return total;
}

function displayedSizeFailure(input: DisplayedStrategyInput) {
  const [long, short] = input.legs;
  const sizes = [long.askSize, ...(short ? [short.bidSize] : [])];
  if (sizes.some((size) => size === undefined || !Number.isSafeInteger(size) || size < 0)) {
    return { status: 'missing_data' as const, reason: 'missing_or_invalid_executable_side_size' };
  }
  if (sizes.some((size) => (size ?? 0) < phase3Protocol.candidates.minDisplayedEntrySize)) {
    return { status: 'rejected' as const, reason: 'insufficient_displayed_size' };
  }
  return null;
}

/** In-memory research capital accounting. This records staged assumptions and outcomes without selecting trades. */
export class ResearchPortfolioLedger {
  readonly #schedule: Map<string, SignalSchedule>;
  readonly #configuration: Configuration;
  readonly #signals = new Map<string, State>();
  readonly #positions = new Map<string, OpenPosition>();
  #cash = new Decimal(rules.initialCapital);
  #settledPnl = new Decimal(0);
  #fees = new Decimal(0);
  #lastTime = -Infinity;
  #finished = false;

  constructor(configuration: Configuration, schedule: readonly SignalSchedule[] = buildStudyCalendar().signals) {
    this.#configuration = configuration;
    this.#schedule = new Map(schedule.map((signal) => {
      const expected = buildSignalSchedule(signal.signalDate);
      if ((Object.keys(expected) as (keyof SignalSchedule)[]).some((key) => expected[key] !== signal[key])) {
        throw new Error('Portfolio schedule differs from the frozen two-session execution timeline.');
      }
      return [signal.signalDate, expected];
    }));
    if (this.#schedule.size !== schedule.length) throw new Error('Duplicate signal in portfolio schedule.');
  }

  #date(signalDate: string) {
    const schedule = this.#schedule.get(signalDate);
    if (!schedule) throw new Error(`Signal date is outside the portfolio schedule: ${signalDate}.`);
    return schedule;
  }

  #event(at: string, advance = true) {
    if (this.#finished) throw new Error('The portfolio ledger is closed.');
    const time = knownTime(at);
    if (time < this.#lastTime || time > cutoff) throw new Error('Portfolio events must be chronological and within the final cutoff.');
    if (advance) this.#lastTime = time;
    return time;
  }

  #state(signalDate: string, expected: SignalState) {
    const state = this.#signals.get(signalDate);
    if (state?.status !== expected) throw new Error(`Signal ${signalDate} has no current ${expected} event.`);
    return state;
  }

  #reservedExcept(signalDate?: string) {
    let reserved = new Decimal(0);
    let slots = 0;
    for (const [key, state] of this.#signals) {
      if (key !== signalDate && state.status === 'submitted' && state.reserved) {
        reserved = reserved.plus(state.reserved);
        slots++;
      }
    }
    return { reserved, slots };
  }

  #endSignal(signalDate: string, status: 'rejected' | 'missing_data', reason: string) {
    const state = this.#signals.get(signalDate)!;
    this.#signals.set(signalDate, { status, reason, selection: state.selection });
    return { status, reason } as const;
  }

  #checkInputs(input: StrategyInput, bookedAt: number, observedAt: number, executionOutcome = false) {
    if (!approvedSymbols.has(input.legs[0]?.symbol) || input.quantity !== rules.quantityPerLeg || input.fees !== rules.entryFees
      || input.legs.some((leg) => leg.multiplier !== rules.multiplier)) {
      throw new Error('The portfolio requires an approved symbol, standard contract quantity and frozen entry commission.');
    }
    for (const leg of input.legs) {
      const availableOrRetrievedAt = knownTime(leg.retrievedAt);
      if (leg.status === 'DEMO' || knownTime(leg.quoteAt) !== observedAt || availableOrRetrievedAt < observedAt
        || (!executionOutcome && availableOrRetrievedAt > bookedAt)) {
        throw new Error('Option observation or availability does not match the scheduled event.');
      }
    }
  }

  #checkRisk(input: StrategyInput, at: number, signalDate: string, mode: 'selection' | 'order' | 'execution') {
    const result = calculateStrategy(input);
    const { reserved } = this.#reservedExcept(signalDate);
    const cost = new Decimal(result.positionCost);
    if (this.#cash.minus(reserved).lt(cost)) return { reason: 'insufficient_available_cash' };
    // Execution evidence is used only to test the previously locked terms at the observation, never to value or select.
    const riskInput = mode === 'execution' ? {
      ...input, legs: input.legs.map((leg) => ({ ...leg, retrievedAt: leg.quoteAt })),
    } : input;
    const risk = assessRisk(riskInput, result, mode === 'selection' ? { ...preferences, minDte: 0 } : preferences,
      { now: new Date(at), ...this.#riskContext(signalDate) });
    if (!risk.eligible) return { reason: risk.reasons.join(' | ') };
    if (input.legs[0].ask <= 0 || (input.legs[1] && input.legs[1].bid <= 0)) return { reason: 'no_executable_side' };
    return { cost };
  }

  #riskContext(signalDate: string) {
    const { reserved, slots } = this.#reservedExcept(signalDate);
    return { existingRisk: capitalUsed(this.#positions.values()).plus(reserved).toNumber(), openPositions: this.#positions.size + slots };
  }

  #priorSettlementDue(time: number) {
    for (const position of this.#positions.values()) {
      const close = optionTradingCutoff(position.expiration);
      if (close !== null && close + phase3Protocol.timeline.stockAvailabilityLagMinutes * 60_000 <= time) return true;
    }
    return false;
  }

  recordNoTrade(signalDate: string, reason: string, dataGap = false) {
    const schedule = this.#date(signalDate);
    if (this.#signals.has(signalDate)) throw new Error('A signal cannot be selected or replaced twice.');
    const time = this.#event(schedule.signalAt);
    const priorSettlementDue = this.#priorSettlementDue(time);
    this.#signals.set(signalDate, { status: dataGap || priorSettlementDue ? 'missing_data' : 'no_trade',
      reason: priorSettlementDue ? 'prior_expiration_settlement_unprocessed' : reason });
  }

  // The replay caller checks the verified action review against each selected signal leg before submission.
  rejectKnownAdjustment(signalDate: string, review: NormalizedActionReview, signalLeg: NormalizedQuote) {
    const schedule = this.#date(signalDate);
    const selected = this.#state(signalDate, 'selected');
    const orderTime = this.#event(schedule.orderAt, false);
    if (signalLeg.session !== signalDate || !selected.selection!.legs.some((leg) => identity(leg) === signalLeg.optionSymbol)
      || !contractActionsThrough(review, signalLeg, new Date(orderTime)).length) {
      throw new Error('No documented adjustment for a selected leg was known by order lock.');
    }
    this.#event(schedule.orderAt);
    if (this.#priorSettlementDue(orderTime)) return this.#endSignal(signalDate, 'missing_data', 'prior_expiration_settlement_unprocessed');
    return this.#endSignal(signalDate, 'rejected', 'known_contract_adjustment');
  }

  // The readiness gate independently verifies the no-book disposition and its raw evidence.
  rejectKnownNoBook(signalDate: string, evidence: NoBookObservation) {
    const schedule = this.#date(signalDate);
    const isFill = evidence.role === 'fill';
    const state = this.#state(signalDate, isFill ? 'submitted' : 'selected');
    const at = isFill ? schedule.fillAt : schedule.orderAt;
    const time = this.#event(at, false);
    const observedAt = knownTime(evidence.observedAt);
    const availableAt = knownTime(evidence.availableAt);
    if (observedAt !== knownTime(isFill ? schedule.fillAt : schedule.revalidationObservedAt)
      || availableAt < observedAt || availableAt > (isFill ? cutoff : time)
      || !evidence.evidence.trim() || (evidence.disposition !== 'halted' && evidence.disposition !== 'no-quote')
      || !state.selection?.legs.some((leg) => identity(leg) === evidence.optionSymbol)) {
      throw new Error('No matching, timely no-book evidence exists for a selected leg.');
    }
    this.#event(at);
    if (this.#priorSettlementDue(time)) return this.#endSignal(signalDate, 'missing_data', 'prior_expiration_settlement_unprocessed');
    return this.#endSignal(signalDate, 'rejected', `${evidence.role}_${evidence.disposition === 'halted' ? 'halted' : 'no_quote'}`);
  }

  select(signalDate: string, input: StrategyInput) {
    if (this.#configuration === 'H') throw new Error('The cash benchmark cannot select a position.');
    const schedule = this.#date(signalDate);
    if (this.#signals.has(signalDate)) throw new Error('A signal cannot be selected or replaced twice.');
    const signalClose = optionTradingCutoff(signalDate);
    if (signalClose === null) throw new Error('Signal date has no regular close.');
    const time = this.#event(schedule.signalAt);
    const selection = structuredClone(input);
    this.#signals.set(signalDate, { status: 'selected', selection });
    if (this.#priorSettlementDue(time)) return this.#endSignal(signalDate, 'missing_data', 'prior_expiration_settlement_unprocessed');
    try {
      this.#checkInputs(selection, time, signalClose);
      const expiration = selection.legs[0].expiration;
      const dte = daysToExpiration(expiration, new Date(signalClose));
      if (dte < rules.minCalendarDte || dte > rules.maxCalendarDte || expiration > schedule.latestExpiryDate
        || expiration > phase3Protocol.cutoffDate) return this.#endSignal(signalDate, 'rejected', 'expiration_outside_signal_window');
      const { reason } = this.#checkRisk(selection, time, signalDate, 'selection');
      if (reason) return this.#endSignal(signalDate, 'rejected', reason);
      return { status: 'selected' as const };
    } catch (error) {
      return this.#endSignal(signalDate, 'missing_data', error instanceof Error ? error.message : 'Invalid signal observation.');
    }
  }

  submit(signalDate: string, input: DisplayedStrategyInput | undefined, economics?: EconomicInputs) {
    const schedule = this.#date(signalDate);
    const current = this.#state(signalDate, 'selected');
    const time = this.#event(schedule.orderAt);
    if (this.#priorSettlementDue(time)) return this.#endSignal(signalDate, 'missing_data', 'prior_expiration_settlement_unprocessed');
    if (!input) return this.#endSignal(signalDate, 'missing_data', 'missing_revalidation_quote');
    try {
      const observedAt = knownTime(schedule.revalidationObservedAt);
      this.#checkInputs(input, time, observedAt);
      if (!sameLegs(current.selection!, input)) return this.#endSignal(signalDate, 'missing_data', 'selected_legs_changed');
      const sizeFailure = displayedSizeFailure(input);
      if (sizeFailure) return this.#endSignal(signalDate, sizeFailure.status, sizeFailure.reason);
      if (input.legs.some((leg) => validateQuote(leg, input.legs[0].symbol, new Date(time)).status === 'STALE')) {
        return this.#endSignal(signalDate, 'rejected', 'stale_revalidation_quote');
      }
      const result = this.#checkRisk(input, time, signalDate, 'order');
      if (!result.cost) return this.#endSignal(signalDate, 'rejected', result.reason!);
      const economicRule = economicRules[this.#configuration];
      if (economicRule) {
        const spot = economics?.spot;
        if (!spot || instant(spot.observedAt) !== observedAt || !economics?.history?.closes.some((close) => (
          close.session === schedule.revalidationDate && close.close === spot.price && instant(close.availableAt) <= time
        ))) {
          return this.#endSignal(signalDate, 'missing_data', 'missing_or_inconsistent_revalidation_close');
        }
        const evaluation = evaluateResearchCandidate({ ...economics, asOf: new Date(time), preferences, risk: this.#riskContext(signalDate) }, input);
        if (evaluation.status !== 'ok') return this.#endSignal(signalDate, 'missing_data', evaluation.reasons.join(' | '));
        if (evaluation[economicRule.model].decisions[economicRule.mode] !== 'ELIGIBLE') {
          return this.#endSignal(signalDate, 'rejected', 'economic_revalidation_no_trade');
        }
      }
      const order = structuredClone(input);
      this.#signals.set(signalDate, { ...current, status: 'submitted', reserved: result.cost, order });
      return { status: 'submitted' as const, longAskCeiling: order.legs[0].ask, shortBidFloor: order.legs[1]?.bid ?? null };
    } catch (error) {
      return this.#endSignal(signalDate, 'missing_data', error instanceof Error ? error.message : 'Invalid entry revalidation.');
    }
  }

  observeEntry(signalDate: string, input: DisplayedStrategyInput | undefined) {
    const schedule = this.#date(signalDate);
    const current = this.#state(signalDate, 'submitted');
    const time = this.#event(schedule.fillAt);
    if (this.#priorSettlementDue(time)) return this.#endSignal(signalDate, 'missing_data', 'prior_expiration_settlement_unprocessed');
    if (!input) return this.#endSignal(signalDate, 'missing_data', 'missing_execution_quote');
    try {
      this.#checkInputs(input, time, time, true);
      const order = current.order!;
      if (!sameLegs(order, input)) return this.#endSignal(signalDate, 'missing_data', 'selected_legs_changed');
      const sizeFailure = displayedSizeFailure(input);
      if (sizeFailure) return this.#endSignal(signalDate, sizeFailure.status, sizeFailure.reason);
      if (input.legs[0].ask > order.legs[0].ask || (input.legs[1] && input.legs[1].bid < order.legs[1].bid)) {
        return this.#endSignal(signalDate, 'rejected', 'order_leg_price_limit');
      }
      const result = this.#checkRisk(input, time, signalDate, 'execution');
      if (!result.cost) return this.#endSignal(signalDate, 'rejected', result.reason!);
      const filled = structuredClone(input);
      this.#positions.set(signalDate, { input: filled, symbol: filled.legs[0].symbol, expiration: filled.legs[0].expiration, cost: result.cost });
      this.#cash = this.#cash.minus(result.cost);
      this.#fees = this.#fees.plus(filled.fees);
      this.#signals.set(signalDate, { status: 'filled', selection: current.selection });
      return { status: 'filled' as const, positionCost: result.cost.toNumber() };
    } catch (error) {
      return this.#endSignal(signalDate, 'missing_data', error instanceof Error ? error.message : 'Invalid execution observation.');
    }
  }

  settleBatch(processedAt: string, observations: readonly ExpirationObservation[]) {
    const time = this.#event(processedAt, false);
    const evidence = new Map<string, ExpirationObservation>();
    for (const item of observations) {
      const observed = knownTime(item.observedAt);
      const available = knownTime(item.availableAt);
      if (!approvedSymbols.has(item.symbol) || !Number.isFinite(item.price) || item.price < 0
        || observed !== optionTradingCutoff(item.expiration)
        || available < observed + phase3Protocol.timeline.stockAvailabilityLagMinutes * 60_000 || available > time) {
        throw new Error('Expiration cash is unavailable or does not match the official close.');
      }
      const key = `${item.symbol}/${item.expiration}`;
      const previous = evidence.get(key);
      if (previous && (previous.price !== item.price || instant(previous.availableAt) !== available)) {
        throw new Error('Conflicting expiration settlements.');
      }
      evidence.set(key, item);
    }
    const settled = [...this.#positions].filter(([, position]) => evidence.has(`${position.symbol}/${position.expiration}`))
      .sort(([a, left], [b, right]) => compareId(left.expiration, right.expiration) || compareId(left.symbol, right.symbol) || compareId(a, b))
      .map(([signalDate, position]) => {
        const item = evidence.get(`${position.symbol}/${position.expiration}`)!;
        const netPnl = new Decimal(payoffAt(position.input, item.price));
        const cashProceeds = position.cost.plus(netPnl);
        if (cashProceeds.isNeg()) throw new Error('An intact debit strategy cannot owe expiration cash.');
        return { signalDate, netPnl, cashProceeds };
      });
    this.#lastTime = time;
    for (const item of settled) {
      this.#positions.delete(item.signalDate);
      this.#cash = this.#cash.plus(item.cashProceeds);
      this.#settledPnl = this.#settledPnl.plus(item.netPnl);
    }
    return settled.map(({ signalDate, netPnl, cashProceeds }) => ({ signalDate, netPnl: netPnl.toNumber(), cashProceeds: cashProceeds.toNumber() }));
  }

  snapshot() {
    const { reserved, slots } = this.#reservedExcept();
    return {
      cash: this.#cash.toNumber(), availableCash: this.#cash.minus(reserved).toNumber(),
      referenceCapital: rules.referenceCapital, openRisk: capitalUsed(this.#positions.values()).toNumber(),
      pendingRisk: reserved.toNumber(), openPositions: this.#positions.size, pendingOrders: slots,
      fees: this.#fees.toNumber(), settledPnl: this.#settledPnl.toNumber(),
    };
  }

  finish() {
    this.#event(phase3Protocol.cutoffAt);
    this.#finished = true;
    const dates = [...this.#schedule.keys()].sort(compareId);
    const pendingSignals = this.#configuration === 'H' ? [] : dates.filter((date) => {
      const state = this.#signals.get(date)?.status;
      return state === undefined || state === 'selected' || state === 'submitted' || state === 'missing_data';
    });
    const unresolvedSettlements = [...this.#positions.keys()].sort(compareId);
    const complete = pendingSignals.length === 0 && unresolvedSettlements.length === 0;
    const netTerminalPnl = complete ? this.#cash.minus(rules.initialCapital) : null;
    return {
      status: complete ? 'complete' as const : 'incomplete' as const,
      pendingSignals, unresolvedSettlements,
      signals: [...this.#signals].sort(([a], [b]) => compareId(a, b)).map(([signalDate, { status, reason }]) => ({ signalDate, status, reason })),
      netTerminalPnl: netTerminalPnl?.toNumber() ?? null, endingCapital: complete ? this.#cash.toNumber() : null,
      totalReturn: netTerminalPnl?.div(rules.initialCapital).toNumber() ?? null,
      ...this.snapshot(),
    };
  }
}
