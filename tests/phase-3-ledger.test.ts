import { describe, expect, it } from 'vitest';
import { makeOccSymbol, optionTradingCutoff } from '../src/lib/quant';
import { ResearchPortfolioLedger, type DisplayedStrategyInput, type ExpirationObservation } from '../scripts/phase-3/ledger';
import { normalizeCorporateActionReview, normalizeMarketDataChain, toStudyQuote } from '../scripts/phase-3/observations';
import { addCalendarDays, buildSignalSchedule, buildStudyCalendar, nextStudySession, phase3Protocol as protocol, studyMorning, type SignalSchedule } from '../scripts/phase-3/protocol';

const calendar = buildStudyCalendar();
const first = calendar.signals[0];
const expiry = '2024-11-15';
const minuteMs = 60_000;
const iso = (at: number) => new Date(at).toISOString();

type Stage = 'selection' | 'revalidation' | 'execution';
function position(signal: SignalSchedule, stage: Stage, options: { ask: number; shortBid?: number; symbol?: string; expiration?: string } = { ask: 1 }) {
  const { ask, shortBid, symbol = 'SPY', expiration = expiry } = options;
  const quoteAt = stage === 'selection' ? iso(optionTradingCutoff(signal.signalDate)!)
    : stage === 'revalidation' ? signal.revalidationObservedAt : signal.fillAt;
  const retrievedAt = stage === 'selection' ? studyMorning(signal.revalidationDate, 31)
    : stage === 'revalidation' ? studyMorning(signal.entryDate, 31) : studyMorning(nextStudySession(signal.entryDate), 31);
  const quote = (strike: number, ask: number, bid: number): DisplayedStrategyInput['legs'][number] => ({
    id: makeOccSymbol(symbol, expiration, 'call', strike), symbol, expiration, type: 'call', strike, currency: 'USD', multiplier: 100,
    bid, ask, quoteAt, retrievedAt, source: { url: 'https://example.test/quotes', publisher: 'Synthetic ledger fixture' }, status: 'VERIFIED_DELAYED',
    ...(stage === 'selection' ? {} : { askSize: 1, bidSize: 1 }),
  });
  return {
    strategy: shortBid === undefined ? 'long_call' : 'bull_call', quantity: 1, fees: 1.30,
    legs: [quote(100, ask, Number((ask * 0.95).toFixed(4))), ...(shortBid === undefined ? [] : [quote(105, shortBid + 0.05, shortBid)])],
  } satisfies DisplayedStrategyInput;
}

function settlement(symbol: string, expiration: string, price: number): ExpirationObservation {
  const observed = optionTradingCutoff(expiration)!;
  return { symbol, expiration, price, observedAt: iso(observed), availableAt: iso(observed + 16 * minuteMs) };
}

function book(ledger: ResearchPortfolioLedger, signal: SignalSchedule, options: Parameters<typeof position>[2] = { ask: 1 }) {
  const { signalDate } = signal;
  expect(ledger.select(signalDate, position(signal, 'selection', options)).status).toBe('selected');
  expect(ledger.submit(signalDate, position(signal, 'revalidation', options)).status).toBe('submitted');
  expect(ledger.observeEntry(signalDate, position(signal, 'execution', options)).status).toBe('filled');
}

function evidence(signal: SignalSchedule, price: number) {
  const dates = calendar.closeDates.filter((date) => date <= signal.revalidationDate).slice(-253);
  const closes = dates.map((session) => ({ session, close: session === signal.revalidationDate ? price : 100,
    availableAt: iso(optionTradingCutoff(session)! + 16 * minuteMs) }));
  return {
    spot: { symbol: 'SPY', price, observedAt: signal.revalidationObservedAt, availableAt: closes.at(-1)!.availableAt },
    history: { symbol: 'SPY', basis: 'point-in-time-split-consistent-price' as const, basisKnownAt: closes.at(-1)!.availableAt, closes },
  };
}

describe('D+2 research portfolio ledger (synthetic market observations)', () => {
  it('reserves and books exact debit plus fees, then settles an intact vertical at its capped payoff', () => {
    const ledger = new ResearchPortfolioLedger('A', [first]);
    const { signalDate } = first;
    expect(ledger.select(signalDate, position(first, 'selection', { ask: 2.9, shortBid: 1.5 })).status).toBe('selected');
    expect(ledger.submit(signalDate, position(first, 'revalidation', { ask: 2.9, shortBid: 1.5 })))
      .toEqual({ status: 'submitted', longAskCeiling: 2.9, shortBidFloor: 1.5 });
    expect(ledger.snapshot()).toMatchObject({ cash: 10_000, availableCash: 9858.70, pendingRisk: 141.30, pendingOrders: 1, openPositions: 0 });
    expect(ledger.observeEntry(signalDate, position(first, 'execution', { ask: 2.8, shortBid: 1.6 })))
      .toEqual({ status: 'filled', positionCost: 121.30 });
    expect(ledger.snapshot()).toMatchObject({ cash: 9878.70, openRisk: 121.30, pendingRisk: 0, fees: 1.30 });
    const close = settlement('SPY', expiry, 110);
    expect(ledger.settleBatch(close.availableAt, [close])).toEqual([{ signalDate, netPnl: 378.70, cashProceeds: 500 }]);
    expect(ledger.finish()).toMatchObject({ status: 'complete', endingCapital: 10378.70, netTerminalPnl: 378.70, totalReturn: 0.03787 });
  });

  it('does not substitute a different leg or retry a signal after an entry rejection', () => {
    const ledger = new ResearchPortfolioLedger('G', [first]);
    const { signalDate } = first;
    const options = { ask: 3, shortBid: 1.5 };
    expect(ledger.select(signalDate, position(first, 'selection', options)).status).toBe('selected');
    expect(ledger.submit(signalDate, position(first, 'revalidation', options)).status).toBe('submitted');
    expect(ledger.observeEntry(signalDate, position(first, 'execution', { ask: 3.1, shortBid: 2 })))
      .toEqual({ status: 'rejected', reason: 'order_leg_price_limit' });
    expect(() => ledger.select(signalDate, position(first, 'selection', { ...options, symbol: 'AMD' }))).toThrow(/selected or replaced twice/u);
    expect(() => ledger.observeEntry(signalDate, position(first, 'execution', options))).toThrow(/submitted/u);
    expect(ledger.finish()).toMatchObject({ status: 'complete', fees: 0, pendingOrders: 0, netTerminalPnl: 0 });
  });

  it.each(['revalidation', 'execution'] as const)('requires adequate displayed size on each executable side at %s', (stage) => {
    const { signalDate } = first;
    const options = { ask: 3, shortBid: 1.5 };
    for (const [leg, side] of [[0, 'askSize'], [1, 'bidSize']] as const) {
      for (const size of [undefined, 0]) {
        const ledger = new ResearchPortfolioLedger('A', [first]);
        const signal = position(first, 'selection', options);
        expect(signal.legs[0].askSize).toBeUndefined();
        expect(ledger.select(signalDate, signal).status).toBe('selected');
        const displayed = position(first, stage, options);
        displayed.legs[leg][side] = size;
        if (stage === 'execution') expect(ledger.submit(signalDate, position(first, 'revalidation', options)).status).toBe('submitted');
        const result = stage === 'revalidation' ? ledger.submit(signalDate, displayed) : ledger.observeEntry(signalDate, displayed);
        expect(result).toEqual(size === undefined ? { status: 'missing_data', reason: 'missing_or_invalid_executable_side_size' }
          : { status: 'rejected', reason: 'insufficient_displayed_size' });
        expect(ledger.finish()).toMatchObject({ status: size === undefined ? 'incomplete' : 'complete', fees: 0 });
      }
    }
  });

  it('requires the exact preset signal, revalidation and execution observation clocks', () => {
    expect(() => new ResearchPortfolioLedger('B', [{ ...first, orderAt: first.fillAt }])).toThrow(/frozen two-session/u);
    const ledger = new ResearchPortfolioLedger('B', [first]);
    const later = position(first, 'selection');
    later.legs[0].retrievedAt = iso(Date.parse(first.signalAt) + 1);
    expect(ledger.select(first.signalDate, later)).toMatchObject({ status: 'missing_data' });
    const second = new ResearchPortfolioLedger('B', [first]);
    expect(second.select(first.signalDate, position(first, 'selection')).status).toBe('selected');
    expect(second.submit(first.signalDate, position(first, 'execution'))).toMatchObject({ status: 'missing_data' });
    const third = new ResearchPortfolioLedger('B', [first]);
    expect(third.select(first.signalDate, position(first, 'selection')).status).toBe('selected');
    expect(third.submit(first.signalDate, position(first, 'revalidation')).status).toBe('submitted');
    expect(third.observeEntry(first.signalDate, position(first, 'revalidation'))).toMatchObject({ status: 'missing_data' });
    expect(third.finish()).toMatchObject({ status: 'incomplete', pendingSignals: [first.signalDate], netTerminalPnl: null });
  });

  it('rejects delayed availability even when the D+1 quote timestamp matches', () => {
    const ledger = new ResearchPortfolioLedger('A', [first]);
    expect(ledger.select(first.signalDate, position(first, 'selection')).status).toBe('selected');
    const late = position(first, 'revalidation');
    late.legs[0].retrievedAt = iso(Date.parse(first.orderAt) + 1);
    expect(ledger.submit(first.signalDate, late)).toMatchObject({ status: 'missing_data' });
    expect(ledger.finish()).toMatchObject({ status: 'incomplete', netTerminalPnl: null, pendingOrders: 0 });
  });

  it('records the New Year 36-hour freshness breach as a common rejection without replacement', () => {
    const planned = calendar.signals.find(({ signalDate }) => signalDate === '2024-12-30')!;
    expect(planned).toMatchObject({ revalidationDate: '2024-12-31', entryDate: '2025-01-02' });
    expect((Date.parse(planned.orderAt) - Date.parse(planned.revalidationObservedAt)) / 3_600_000).toBe(41.75);
    const options = { ask: 1, expiration: '2025-01-17' };
    const rawQuote = position(planned, 'revalidation', options).legs[0];
    const sourceUrl = `https://api.marketdata.app/v1/options/chain/SPY/?date=${planned.revalidationDate}&nonstandard=false&dateformat=unix&limit=4001`;
    const chain = normalizeMarketDataChain({ s: 'ok', optionSymbol: [rawQuote.id], underlying: ['SPY'], side: ['call'], strike: [100],
      bid: [rawQuote.bid], ask: [rawQuote.ask], bidSize: [1], askSize: [1], expiration: [optionTradingCutoff(options.expiration)! / 1000],
      updated: [Date.parse(rawQuote.quoteAt) / 1000],
    }, { requestedSymbol: 'SPY', rawSha256: 'a'.repeat(64), retrievedAt: '2026-11-25T17:00:00Z',
      requestedDate: planned.revalidationDate, sourceUrl });
    const revalidation = { ...position(planned, 'revalidation', options), legs: [toStudyQuote(chain.rows[0], chain, planned, 'revalidation')] };
    for (const rule of ['A', 'B', 'C', 'D', 'E', 'F', 'G'] as const) {
      const ledger = new ResearchPortfolioLedger(rule, [planned]);
      expect(ledger.select(planned.signalDate, position(planned, 'selection', options)).status).toBe('selected');
      expect(ledger.submit(planned.signalDate, revalidation))
        .toEqual({ status: 'rejected', reason: 'stale_revalidation_quote' });
      expect(() => ledger.observeEntry(planned.signalDate, position(planned, 'execution', options))).toThrow(/submitted/u);
      expect(() => ledger.select(planned.signalDate, position(planned, 'selection', options))).toThrow(/replaced twice/u);
      expect(ledger.finish()).toMatchObject({ status: 'complete', endingCapital: 10_000, fees: 0 });
    }
  });

  it.each(['revalidation', 'fill'] as const)('records a documented %s halt separately from missing data', (role) => {
    const ledger = new ResearchPortfolioLedger('A', [first]);
    const { signalDate, orderAt, fillAt, revalidationObservedAt } = first;
    const selection = position(first, 'selection');
    expect(ledger.select(signalDate, selection).status).toBe('selected');
    if (role === 'fill') expect(ledger.submit(signalDate, position(first, 'revalidation')).status).toBe('submitted');
    const evidence = { role, optionSymbol: selection.legs[0].id, disposition: 'halted' as const,
      evidence: 'Synthetic certified halt', observedAt: role === 'fill' ? fillAt : revalidationObservedAt,
      availableAt: role === 'fill' ? studyMorning(nextStudySession(first.entryDate), 31) : orderAt };
    expect(() => ledger.rejectKnownNoBook(signalDate, { ...evidence, observedAt: role === 'fill' ? orderAt : fillAt }))
      .toThrow(/timely no-book/u);
    expect(ledger.rejectKnownNoBook(signalDate, evidence)).toEqual({ status: 'rejected', reason: `${role}_halted` });
    expect(ledger.finish()).toMatchObject({ status: 'complete', fees: 0, pendingOrders: 0 });
  });

  it('rechecks DTE at order lock and rejects expired or no-longer-eligible terms', () => {
    const shortWindow = new ResearchPortfolioLedger('A', [first]);
    const options = { ask: 1, expiration: '2024-10-28' };
    expect(shortWindow.select(first.signalDate, position(first, 'selection', options)).status).toBe('selected');
    expect(shortWindow.submit(first.signalDate, position(first, 'revalidation', options))).toMatchObject({
      status: 'rejected', reason: expect.stringContaining('hors de l’intervalle') });
    const expired = new ResearchPortfolioLedger('A', [first]);
    expect(expired.select(first.signalDate, position(first, 'selection', { ask: 1, expiration: '2024-10-18' })))
      .toEqual({ status: 'rejected', reason: 'expiration_outside_signal_window' });
  });

  it('rejects a selected contract with a documented adjustment known at lock and ignores a later announcement', () => {
    const { signalDate } = first;
    const selection = position(first, 'selection');
    const contract = selection.legs[0];
    const proofUrl = 'https://example.test/synthetic-action';
    const receipt = { requestedSymbol: 'SPY', rawSha256: 'a'.repeat(64), retrievedAt: '2026-11-25T17:00:00Z' };
    const [signalLeg] = normalizeMarketDataChain({ s: 'ok', optionSymbol: [contract.id], underlying: ['SPY'], side: ['call'], strike: [100],
      bid: [contract.bid], ask: [contract.ask], expiration: [optionTradingCutoff(expiry)! / 1000], updated: [Date.parse(contract.quoteAt) / 1000],
    }, { ...receipt, requestedDate: signalDate,
      sourceUrl: `https://api.marketdata.app/v1/options/chain/SPY/?date=${signalDate}&nonstandard=false&dateformat=unix&limit=4001` }).rows;
    const action = normalizeCorporateActionReview({ reviewedFrom: signalDate, reviewedTo: expiry, complete: true, coverageEvidence: proofUrl,
      actions: [{ kind: 'contract-adjustment', optionSymbol: contract.id, reason: 'Synthetic fixture', effectiveSession: '2024-11-01',
        availableAt: iso(Date.parse(first.orderAt) - 1), evidence: proofUrl }],
    }, { ...receipt, provider: 'OCC fixture', sourceUrl: proofUrl });
    const ledger = new ResearchPortfolioLedger('C', [first]);
    expect(ledger.select(signalDate, selection).status).toBe('selected');
    const future = { ...action, actions: action.actions.map((item) => ({ ...item, availableAt: iso(Date.parse(first.orderAt) + 1) })) };
    expect(() => ledger.rejectKnownAdjustment(signalDate, future, signalLeg)).toThrow(/known by order lock/u);
    expect(ledger.rejectKnownAdjustment(signalDate, action, signalLeg)).toEqual({ status: 'rejected', reason: 'known_contract_adjustment' });
    expect(() => ledger.submit(signalDate, position(first, 'revalidation'))).toThrow(/selected/u);
    expect(ledger.finish()).toMatchObject({ status: 'complete', netTerminalPnl: 0 });
  });

  it('rechecks D using the D+1 closing evidence and the frozen Phase 2 conservative rule', () => {
    for (const outcome of [100, 120]) {
      const ledger = new ResearchPortfolioLedger('D', [first]);
      const { signalDate } = first;
      expect(ledger.select(signalDate, position(first, 'selection')).status).toBe('selected');
      const result = ledger.submit(signalDate, position(first, 'revalidation'), evidence(first, outcome));
      if (outcome === 100) expect(result).toEqual({ status: 'rejected', reason: 'economic_revalidation_no_trade' });
      else expect(result.status).toBe('submitted');
    }
    const ledger = new ResearchPortfolioLedger('D', [first]);
    ledger.select(first.signalDate, position(first, 'selection'));
    const postOrder = evidence(first, 120);
    postOrder.spot.availableAt = iso(Date.parse(first.orderAt) + 1);
    expect(ledger.submit(first.signalDate, position(first, 'revalidation'), postOrder).status).toBe('missing_data');
  });

  it('rejects a future spot and keeps later closes out of the economic decision', () => {
    const futureSpot = new ResearchPortfolioLedger('D', [first]);
    expect(futureSpot.select(first.signalDate, position(first, 'selection')).status).toBe('selected');
    const futureEvidence = evidence(first, 120);
    futureEvidence.spot.observedAt = first.fillAt;
    futureEvidence.spot.availableAt = iso(Date.parse(first.fillAt) + 16 * minuteMs);
    expect(futureSpot.submit(first.signalDate, position(first, 'revalidation'), futureEvidence))
      .toEqual({ status: 'missing_data', reason: 'missing_or_inconsistent_revalidation_close' });

    const mismatchedSpot = new ResearchPortfolioLedger('D', [first]);
    mismatchedSpot.select(first.signalDate, position(first, 'selection'));
    const inconsistent = evidence(first, 120);
    inconsistent.history.closes.at(-1)!.close = 100;
    expect(mismatchedSpot.submit(first.signalDate, position(first, 'revalidation'), inconsistent))
      .toEqual({ status: 'missing_data', reason: 'missing_or_inconsistent_revalidation_close' });

    const laterClose = new ResearchPortfolioLedger('D', [first]);
    expect(laterClose.select(first.signalDate, position(first, 'selection')).status).toBe('selected');
    const evidenceWithLaterClose = evidence(first, 100);
    evidenceWithLaterClose.history.closes.push({ session: first.entryDate, close: 1_000,
      availableAt: iso(Date.parse(first.fillAt) + 16 * minuteMs) });
    expect(laterClose.submit(first.signalDate, position(first, 'revalidation'), evidenceWithLaterClose))
      .toEqual({ status: 'rejected', reason: 'economic_revalidation_no_trade' });
  });

  it('counts commission toward both fixed per-trade risk and cash', () => {
    const ledger = new ResearchPortfolioLedger('A', [first]);
    expect(ledger.select(first.signalDate, position(first, 'selection', { ask: 4.9871 })).status).toBe('rejected');
    expect(ledger.finish()).toMatchObject({ status: 'complete', availableCash: 10_000, openPositions: 0 });
    const atLimit = new ResearchPortfolioLedger('A', [first]);
    book(atLimit, first, { ask: 4.987 });
    expect(atLimit.snapshot()).toMatchObject({ openRisk: 500, availableCash: 9500, referenceCapital: 10_000 });
  });

  it('enforces aggregate open loss and positions across symbols', () => {
    const dates = calendar.closeDates.slice(252).map(buildSignalSchedule)
      .filter(({ signalDate, entryDate }) => entryDate === addCalendarDays(signalDate, 2)).slice(0, 11);
    const symbols = protocol.symbols;
    const bookTogether = (ledger: ResearchPortfolioLedger, signals: SignalSchedule[], ask: number) => {
      signals.flatMap((signal, i) => {
        const { signalDate, signalAt, orderAt, fillAt } = signal;
        const options = { ask, symbol: symbols[i % symbols.length] };
        return [
          { at: signalAt, record: () => expect(ledger.select(signalDate, position(signal, 'selection', options)).status).toBe('selected') },
          { at: orderAt, record: () => expect(ledger.submit(signalDate, position(signal, 'revalidation', options)).status).toBe('submitted') },
          { at: fillAt, record: () => expect(ledger.observeEntry(signalDate, position(signal, 'execution', options)).status).toBe('filled') },
        ];
      }).sort((a, b) => a.at.localeCompare(b.at)).forEach(({ record }) => record());
    };
    const nextAfterFills = (index: number) => dates.find((row) => row.signalAt > dates[index].fillAt)!;
    const riskCheck = nextAfterFills(3);
    const totalRisk = new ResearchPortfolioLedger('B', [...dates.slice(0, 4), riskCheck]);
    bookTogether(totalRisk, dates.slice(0, 4), 4.987);
    expect(totalRisk.snapshot()).toMatchObject({ openRisk: 2000, openPositions: 4 });
    expect(totalRisk.select(riskCheck.signalDate, position(riskCheck, 'selection', { ask: 1, symbol: symbols[4] })))
      .toMatchObject({ status: 'rejected', reason: expect.stringContaining('exposition cumulée') });

    const positionCheck = nextAfterFills(7);
    const positions = new ResearchPortfolioLedger('B', [...dates.slice(0, 8), positionCheck]);
    bookTogether(positions, dates.slice(0, 8), 1);
    expect(positions.snapshot()).toMatchObject({ openRisk: 810.40, openPositions: 8 });
    expect(positions.select(positionCheck.signalDate, position(positionCheck, 'selection', {
      ask: 1, symbol: symbols[4], expiration: nextStudySession(addCalendarDays(positionCheck.signalDate, 14)),
    }))).toMatchObject({ status: 'rejected', reason: expect.stringContaining('nombre maximal de positions') });
  });

  it('does not use the fixed reference balance as available cash after settled losses', () => {
    const dates = calendar.signals.filter(({ revalidationDate, entryDate }) => entryDate === addCalendarDays(revalidationDate, 1)).slice(0, 21);
    const ledger = new ResearchPortfolioLedger('A', dates);
    for (const signal of dates.slice(0, 20)) {
      const expiration = nextStudySession(addCalendarDays(signal.entryDate, 6));
      book(ledger, signal, { ask: 4.987, expiration });
      const close = settlement('SPY', expiration, 95);
      ledger.settleBatch(close.availableAt, [close]);
    }
    expect(ledger.snapshot()).toMatchObject({ availableCash: 0, openRisk: 0, referenceCapital: 10_000, settledPnl: -10_000 });
    const last = dates[20];
    const expiration = nextStudySession(addCalendarDays(last.entryDate, 6));
    expect(ledger.select(last.signalDate, position(last, 'selection', { ask: 0.1, expiration })))
      .toEqual({ status: 'rejected', reason: 'insufficient_available_cash' });
    expect(ledger.finish()).toMatchObject({ status: 'complete', endingCapital: 0, totalReturn: -1, fees: 26 });
  });

  it('credits simultaneous expirations by expiry, symbol, and signal only after cash is available', () => {
    const second = calendar.signals[1];
    const ledger = new ResearchPortfolioLedger('A', [first, second]);
    book(ledger, first, { ask: 1, symbol: 'SPY' });
    book(ledger, second, { ask: 1, symbol: 'AMD' });
    const closes = [settlement('SPY', expiry, 95), settlement('AMD', expiry, 105)];
    expect(() => ledger.settleBatch(closes[0].observedAt, closes)).toThrow(/unavailable/u);
    expect(() => ledger.settleBatch(closes[0].availableAt, [...closes, { ...closes[0], price: 97 }])).toThrow(/Conflicting/u);
    expect(ledger.snapshot()).toMatchObject({ openRisk: 202.60, settledPnl: 0 });
    const settlements = ledger.settleBatch(closes[0].availableAt, closes);
    expect(settlements.map(({ signalDate }) => signalDate)).toEqual([second.signalDate, first.signalDate]);
    expect(ledger.finish()).toMatchObject({ status: 'complete', netTerminalPnl: 297.40, endingCapital: 10297.40 });
  });

  it('withholds full returns if any identified entry or expiration outcome is unavailable', () => {
    const second = calendar.signals[1];
    const ledger = new ResearchPortfolioLedger('A', [first, second]);
    book(ledger, first);
    expect(ledger.select(second.signalDate, position(second, 'selection')).status).toBe('selected');
    expect(ledger.submit(second.signalDate, position(second, 'revalidation')).status).toBe('submitted');
    expect(ledger.observeEntry(second.signalDate, undefined)).toMatchObject({ status: 'missing_data' });
    expect(ledger.finish()).toMatchObject({ status: 'incomplete', pendingSignals: [second.signalDate],
      unresolvedSettlements: [first.signalDate], netTerminalPnl: null, endingCapital: null, totalReturn: null });
  });

  it('requires due earlier settlements to be posted before the next scheduled selection', () => {
    const second = calendar.signals[1];
    const expiration = nextStudySession(addCalendarDays(first.entryDate, 6));
    const firstBook = new ResearchPortfolioLedger('A', [first, second]);
    book(firstBook, first, { ask: 1, expiration });
    expect(firstBook.select(second.signalDate, position(second, 'selection')))
      .toEqual({ status: 'missing_data', reason: 'prior_expiration_settlement_unprocessed' });
    expect(firstBook.finish()).toMatchObject({ status: 'incomplete', netTerminalPnl: null });
    const secondBook = new ResearchPortfolioLedger('A', [first, second]);
    book(secondBook, first, { ask: 1, expiration });
    const close = settlement('SPY', expiration, 104);
    secondBook.settleBatch(close.availableAt, [close]);
    secondBook.recordNoTrade(second.signalDate, 'synthetic empty opportunity universe');
    expect(secondBook.finish()).toMatchObject({ status: 'complete', netTerminalPnl: 298.70 });
  });

  it('keeps the cash benchmark at fixed capital and enforces chronological event records', () => {
    const cash = new ResearchPortfolioLedger('H');
    expect(() => cash.select(first.signalDate, position(first, 'selection'))).toThrow(/cash benchmark/u);
    expect(cash.finish()).toMatchObject({ status: 'complete', endingCapital: 10_000, totalReturn: 0, netTerminalPnl: 0, fees: 0 });
    const second = calendar.signals[1];
    const ledger = new ResearchPortfolioLedger('B', [first, second]);
    ledger.recordNoTrade(second.signalDate, 'synthetic empty opportunity universe');
    expect(() => ledger.select(first.signalDate, position(first, 'selection'))).toThrow(/chronological/u);
    expect(ledger.finish().pendingSignals).toEqual([first.signalDate]);
  });
});
