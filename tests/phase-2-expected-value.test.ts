import { describe, expect, it } from 'vitest';
import { defaultRiskPreferences, makeOccSymbol, payoffAt } from '../src/lib/quant';
import { phase2Protocol as protocol } from '../scripts/phase-2/config';
import { evaluateResearchCandidate, rankResearchChain, stressGrid } from '../scripts/phase-2/decision';
import { empiricalDistribution, empiricalWindows, lognormalDistribution } from '../scripts/phase-2/distributions';
import { prepareReturnHistory, tradingSessionsRemaining } from '../scripts/phase-2/history';
import { estimateEuropeanIv } from '../scripts/phase-2/implied-volatility';
import { controlledHistory, controlledInput, fixtureAsOf, runNumericalValidation, runStressValidation } from '../scripts/phase-2/validation';
import { evaluateExpectedValue } from '../scripts/phase-2/valuation';

const asOf = fixtureAsOf;
const asOfIso = asOf.toISOString();
const spot = { symbol: 'TEST', price: 100, observedAt: asOfIso, availableAt: asOfIso };
const request = { asOf, spot, history: controlledHistory(), preferences: defaultRiskPreferences };
const longCall = controlledInput('long_call', 100, 2.10);
const bearSpread = controlledInput('bear_put', 104, 5, { strike: 95, bid: 1.7 });

describe('Frozen Phase 2 inputs and market clock', () => {
  it('pins the full research policy and each stress pair', () => {
    expect(protocol).toMatchObject({ sessionsPerYear: 252, volatilityLookbackReturns: 252, minimumCloses: 253,
      empiricalLookbackReturns: 252, logReturnSampleDegreesOfFreedom: 1, baselineArithmeticDrift: 0,
      minExpectedNetPnlExclusive: 0, randomSeed: 42, simulationSizes: [10_000, 100_000, 1_000_000] });
    expect(stressGrid.map(({ volatilityMultiplier, driftAdjustment }) => [volatilityMultiplier, driftAdjustment])).toEqual([
      [0.8, -0.05], [0.8, 0], [0.8, 0.05], [1, -0.05], [1, 0], [1, 0.05], [1.2, -0.05], [1.2, 0], [1.2, 0.05],
    ]);
  });

  it('counts holiday closures, half sessions and New York daylight saving changes', () => {
    expect(tradingSessionsRemaining(asOf, '2026-12-11')).toBe(12);
    expect(tradingSessionsRemaining(new Date('2026-11-25T21:00Z'), '2026-11-27')).toBe(1);
    expect(tradingSessionsRemaining(new Date('2026-11-27T17:59Z'), '2026-11-27')).toBe(1);
    expect(tradingSessionsRemaining(new Date('2026-11-27T18:00Z'), '2026-11-27')).toBe(0);
    expect(tradingSessionsRemaining(new Date('2026-11-27T18:01Z'), '2026-11-27')).toBeNull();
    expect(tradingSessionsRemaining(asOf, '2026-11-26')).toBeNull();
    expect(tradingSessionsRemaining(asOf, '2026-11-28')).toBeNull();
    expect(tradingSessionsRemaining(new Date('2026-03-06T21:00Z'), '2026-03-09')).toBe(1);
    expect(tradingSessionsRemaining(new Date('2026-03-09T20:00Z'), '2026-03-09')).toBe(0);
  });

  it('retains exactly 252 completed log returns and estimates sample volatility', () => {
    const history = controlledHistory(100, (i) => i % 2 ? -0.01 : 0.01);
    const prepared = prepareReturnHistory(history, 'TEST', asOf);
    expect(prepared.status).toBe('ok');
    if (prepared.status !== 'ok') throw Error(prepared.reason);
    expect(prepared.history.logReturns).toHaveLength(252);
    expect(prepared.history.dailyMeanLogReturn).toBeCloseTo(0, 13);
    expect(prepared.history.annualizedVolatility).toBeCloseTo(0.01 * Math.sqrt(252 / 251) * Math.sqrt(252), 13);
    expect(prepareReturnHistory({ ...history, closes: history.closes.slice(1) }, 'TEST', asOf).status).toBe('insufficient_data');
    expect(prepareReturnHistory({ ...history, closes: history.closes.filter((_, i) => i !== 80) }, 'TEST', asOf).status).toBe('insufficient_data');
  });

  it('blocks future history, premature close prints and post-forecast adjustment factors', () => {
    const history = controlledHistory();
    const result = prepareReturnHistory(history, 'TEST', asOf);
    const future = { session: '2026-11-25', close: 1e12, availableAt: '2026-11-25T21:00:00Z' };
    const laterRevision = { ...history.closes.at(-1)!, close: 2, availableAt: '2026-11-24T21:01:00Z' };
    expect(prepareReturnHistory({ ...history, closes: [...history.closes, future, laterRevision] }, 'TEST', asOf)).toEqual(result);
    expect(prepareReturnHistory({ ...history, basisKnownAt: future.availableAt }, 'TEST', asOf).status).toBe('invalid_data');
    expect(prepareReturnHistory({ ...history, closes: [...history.closes.slice(0, -1), laterRevision] }, 'TEST', asOf).status).toBe('insufficient_data');
    expect(prepareReturnHistory({ ...history, closes: [...history.closes.slice(0, -1),
      { ...laterRevision, availableAt: '2026-11-24T20:59:59Z' }] }, 'TEST', asOf).status).toBe('invalid_data');
    expect(prepareReturnHistory({ ...history, closes: [...history.closes, { ...history.closes[50], close: 1 }] }, 'TEST', asOf).status).toBe('invalid_data');
  });
});

describe('Terminal models and analytical payoff', () => {
  it('preserves the mean at zero arithmetic drift and treats calls and puts with put-call parity', () => {
    const model = lognormalDistribution(102, 21, 0.3);
    const call = evaluateExpectedValue(longCall, model);
    const put = evaluateExpectedValue(controlledInput('long_put', 100, 2.10), model);
    expect(model.expectedTerminalPrice).toBe(102);
    expect(model.logMean).toBeLessThan(0);
    expect(call.expectedGrossPayoff - put.expectedGrossPayoff).toBeCloseTo(200, 9);
    expect(call.probabilityOfMaximumProfit).toBeNull();
    expect(call.maxProfit).toBeNull();
    expect(put.probabilityOfMaximumProfit).toBe(0);
    expect(call.expectedReturnOnRisk).toBeCloseTo(call.expectedNetPnl / 211.30, 12);
  });

  it('matches the difference of individual legs for both verticals and honors quantity and fees', () => {
    const model = lognormalDistribution(100, 22, 0.35);
    for (const [type, spread, long, short] of [
      ['call', 'bull_call', 98, 105], ['put', 'bear_put', 105, 97],
    ] as const) {
      const a = evaluateExpectedValue(controlledInput(`long_${type}`, long, 4), model);
      const b = evaluateExpectedValue(controlledInput(`long_${type}`, short, 1), model);
      const result = evaluateExpectedValue(controlledInput(spread, long, 4, { strike: short, bid: 1 }, 3, 4), model, 0.85);
      expect(result.expectedGrossPayoff).toBeCloseTo(3 * (a.expectedGrossPayoff - b.expectedGrossPayoff), 8);
      expect(result.modeledCosts).toBe(4.85);
      expect(result.entryDebit).toBe(900);
      expect(result.maxLoss).toBe(904.85);
      expect(result.maxProfit).toBe(Math.abs(short - long) * 300 - 904.85);
      expect(result.expectedNetPnl).toBeCloseTo(result.expectedGrossPayoff - 904.85, 9);
      expect(result.probabilityOfMaximumProfit).toBeGreaterThan(0);
    }
  });

  it('reduces exactly to the shared production payoff at zero time or volatility', () => {
    for (const input of [longCall, controlledInput('long_put', 100, 2.10), bearSpread,
      controlledInput('bull_call', 96, 5, { strike: 105, bid: 1.7 })]) {
      for (const price of [90, 100, 104, 110]) {
        for (const model of [lognormalDistribution(price, 0, 0.38), lognormalDistribution(price, 5, 0)]) {
          const value = evaluateExpectedValue(input, model);
          const expected = payoffAt(input, price);
          expect(value.expectedNetPnl).toBeCloseTo(expected, 10);
          expect(value.expectedShortfall5).toBeCloseTo(expected, 10);
          expect(value.medianNetPnl).toBeCloseTo(expected, 10);
          expect(value.probabilityOfProfit).toBe(Number(expected > 0));
        }
      }
    }
    expect(evaluateExpectedValue(longCall, lognormalDistribution(100, 1, 0.30)).expectedGrossPayoff)
      .toBeLessThan(evaluateExpectedValue(longCall, lognormalDistribution(100, 2, 0.30)).expectedGrossPayoff);
    expect(evaluateExpectedValue(longCall, lognormalDistribution(100, 1, 1e-9)).expectedGrossPayoff).toBeLessThan(0.000001);
  });

  it('matches normal-median probability and tail atoms for both payoff directions', () => {
    const medianSpotModel = lognormalDistribution(100 * Math.exp(0.3 ** 2 * (21 / 252) / 2), 21, 0.3);
    for (const input of [longCall, controlledInput('long_put', 100, 2.10)]) {
      const value = evaluateExpectedValue(input, medianSpotModel);
      expect(value.probabilityOfMaximumLoss).toBeCloseTo(0.5, 12);
      expect(value.medianNetPnl).toBeCloseTo(-value.maxLoss, 10);
      expect(value.percentile5NetPnl).toBe(-value.maxLoss);
      expect(value.expectedShortfall5).toBe(-value.maxLoss);
    }
  });

  it('uses contiguous compounded windows and preserves empirical expected price under relative volatility shocks', () => {
    const returns = Array.from({ length: 252 }, (_, i) => (i % 3 - 1) / 100);
    const windows = empiricalWindows([100, ...returns], 2);
    expect(windows.logRatios).toHaveLength(251);
    expect(windows.logRatios[0]).toBeCloseTo(-0.01, 14);
    expect(windows.logRatios[1]).toBeCloseTo(0.01, 14);
    const baseline = empiricalDistribution(100, windows);
    for (const { volatilityMultiplier, driftAdjustment } of stressGrid) {
      const stressed = empiricalDistribution(100, windows, volatilityMultiplier, driftAdjustment);
      const sampleMean = stressed.prices.reduce((sum, value) => sum + value / stressed.prices.length, 0);
      expect(sampleMean).toBeCloseTo(baseline.expectedTerminalPrice * Math.exp(driftAdjustment * 2 / 252), 10);
      const range = (prices: readonly number[]) => Math.log(prices.at(-1)!) - Math.log(prices[0]);
      expect(range(stressed.prices)).toBeCloseTo(volatilityMultiplier * range(baseline.prices), 12);
    }
    expect(empiricalDistribution(100, empiricalWindows(returns, 0)).prices).toEqual([100]);
    expect(empiricalWindows(returns, 252).horizonSampleVolatility).toBeNull();
    expect(() => empiricalWindows(returns, 253)).toThrow();
    expect(() => empiricalWindows(returns.slice(1), 1)).toThrow();
  });

  it('counts probability masses strictly and uses a fractional atom for the worst 5%', () => {
    const input = controlledInput('bull_call', 100, 2, { strike: 103, bid: 1 }, 1, 0);
    const prices = [99, 100.5, 101, ...Array<number>(22).fill(103)];
    const value = evaluateExpectedValue(input, { kind: 'empirical', prices, spot: 100, expectedTerminalPrice: 102.66, horizonSessions: 12, years: 12 / 252 });
    expect(value.maxLoss).toBe(100);
    expect(value.probabilityOfProfit).toBe(22 / 25);
    expect(value.probabilityOfMaximumProfit).toBe(22 / 25);
    expect(value.probabilityOfMaximumLoss).toBe(1 / 25);
    expect(value.percentile5NetPnl).toBe(-50);
    expect(value.percentile95NetPnl).toBe(200);
    expect(value.expectedShortfall5).toBe(-90);
    expect(value.breakEven).toBe(101);
    expect(value.requiredMoveToBreakEven).toBeCloseTo(0.01, 12);
  });

  it('rejects invalid financial/model inputs and keeps valid probabilities and values bounded', () => {
    expect(() => lognormalDistribution(0, 2, 0.1)).toThrow();
    expect(() => lognormalDistribution(100, 2.5, 0.1)).toThrow();
    expect(() => lognormalDistribution(100, 2, -0.1)).toThrow();
    const model = lognormalDistribution(100, 10, 0.03);
    expect(() => evaluateExpectedValue({ ...longCall, quantity: 1.1 }, model)).toThrow();
    expect(() => evaluateExpectedValue({ ...longCall, legs: [{ ...longCall.legs[0], multiplier: 10 }] }, model)).toThrow();
    expect(() => evaluateExpectedValue(longCall, model, -1)).toThrow();
    for (const spot of [38, 85, 104, 152, 100_000]) {
      const out = evaluateExpectedValue(bearSpread, lognormalDistribution(spot, 12, 0.35));
      expect(out.expectedNetPnl).toBeGreaterThanOrEqual(-out.maxLoss);
      expect(out.expectedNetPnl).toBeLessThanOrEqual(out.maxProfit!);
      for (const p of [out.probabilityOfProfit, out.probabilityOfMaximumLoss, out.probabilityOfMaximumProfit!]) {
        expect(p).toBeGreaterThanOrEqual(0);
        expect(p).toBeLessThanOrEqual(1);
      }
      expect(out.expectedShortfall5).toBeLessThanOrEqual(out.percentile5NetPnl + 1e-9);
    }
  });
});

describe('Independent validation and research decisions', () => {
  it('matches deterministic quadrature and stays within four Monte Carlo standard errors', () => {
    const result = runNumericalValidation();
    expect(result.analytical).toHaveLength(10);
    expect(result.convergence).toHaveLength(12);
    for (const { absoluteError, tolerance } of result.analytical) expect(absoluteError).toBeLessThanOrEqual(tolerance);
    for (const { errorInStandardErrors, standardError } of result.convergence) {
      expect(standardError).toBeGreaterThan(0);
      expect(Math.abs(errorInStandardErrors)).toBeLessThanOrEqual(protocol.validation.monteCarloStandardErrorLimit);
    }
  });

  it('returns NO TRADE for missing, future, invalid, risk-rejected, zero and negative inputs', () => {
    expect(evaluateResearchCandidate({ ...request, history: undefined }, longCall)).toMatchObject({ decision: 'NO_TRADE', status: 'insufficient_data' });
    expect(evaluateResearchCandidate({ ...request, spot: { ...spot, price: Number.NaN } }, longCall)).toMatchObject({ decision: 'NO_TRADE', status: 'invalid_data' });
    expect(evaluateResearchCandidate(request, { ...longCall, legs: [{ ...longCall.legs[0], retrievedAt: '2026-11-24T21:00:01Z' }] }))
      .toMatchObject({ decision: 'NO_TRADE', status: 'invalid_data' });
    expect(evaluateResearchCandidate({ ...request, additionalCosts: 300 }, longCall)).toMatchObject({ decision: 'NO_TRADE', status: 'risk_rejected' });
    expect(evaluateResearchCandidate({ ...request, risk: { existingRisk: 1950 } }, longCall)).toMatchObject({ decision: 'NO_TRADE', status: 'risk_rejected' });
    const zero = evaluateResearchCandidate({ ...request, history: controlledHistory(102, () => 0), spot: { ...spot, price: 102 } },
      controlledInput('long_call', 100, 2, undefined, 1, 0));
    expect(zero).toMatchObject({ status: 'ok', lognormal: { baseline: { expectedNetPnl: 0 }, decisions: { standard: 'NO_TRADE' } },
      empirical: { baseline: { expectedNetPnl: 0 }, decisions: { standard: 'NO_TRADE' } } });
    expect(evaluateResearchCandidate(request, longCall)).toMatchObject({ lognormal: { decisions: { standard: 'NO_TRADE' } } });
  });

  it('keeps the two models and nine sensitivity scenarios separate in conservative mode', () => {
    const cases = runStressValidation();
    const bear = cases.find(({ strategy }) => strategy === 'bear_put')!;
    expect(bear.lognormal.positiveScenarios).toBe(9);
    expect(bear.empirical.positiveScenarios).toBe(6);
    expect(bear.empirical.baselineExpectedNetPnl).toBeGreaterThan(0);
    expect(bear.empirical.minimumExpectedNetPnl).toBeLessThan(0);
    expect(bear.empirical.decisions).toEqual({ standard: 'ELIGIBLE', conservative: 'NO_TRADE' });
    expect(bear.disagreement).toEqual({ standard: false, conservative: true });
  });

  it('evaluates the complete eligible chain, retains long calls and ranks reproducibly after reordering', () => {
    const quotes = Array.from({ length: 10 }, (_, i) => [
      controlledInput('long_call', 95 + i, 3.8 - i * 0.35).legs[0],
      controlledInput('long_put', 95 + i, 0.45 + i * 0.35).legs[0],
    ]).flat();
    const result = rankResearchChain(request, quotes, { quantity: 1, fees: 1.3 });
    const reversed = rankResearchChain(request, quotes.toReversed(), { quantity: 1, fees: 1.3 });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok' || reversed.status !== 'ok') throw Error('Missing research output.');
    expect(result.universeSize).toBeGreaterThan(60);
    expect(result.evaluations).toHaveLength(result.universeSize);
    expect(result.evaluations.filter(({ id }) => id.startsWith('long_call-'))).toHaveLength(10);
    expect(result.lognormal).toEqual(reversed.lognormal);
    expect(result.empirical).toEqual(reversed.empirical);
    expect(result.lognormal.standard.ranked.length).toBeGreaterThan(0);
  });

  it('applies max-loss and stable-ID tie-breaks after equal baseline expected dollars', () => {
    const first = controlledInput('long_call', 96, 1).legs[0];
    const second = { ...first, expiration: '2026-12-18', id: makeOccSymbol('TEST', '2026-12-18', 'call', 96) };
    const expensive = controlledInput('long_call', 95, 2).legs[0];
    const result = rankResearchChain({ ...request, history: controlledHistory(100, () => 0),
      preferences: { ...defaultRiskPreferences, strategies: ['long_call'] } }, [second, expensive, first], { fees: 0, quantity: 1 });
    if (result.status !== 'ok') throw Error(result.reasons.join(' '));
    for (const model of [result.lognormal, result.empirical]) {
      expect(model.standard.ranked.map(({ id }) => id)).toEqual([first.id, second.id, expensive.id].map((id) => `long_call-${id}`));
      expect(model.standard.ranked.map(({ expectedNetPnl }) => expectedNetPnl)).toEqual([300, 300, 300]);
    }
  });

  it('uses explicit European IV inputs and rejects premiums outside strict bounds', () => {
    const inputs = { spot: 100, strike: 100, premiumPerShare: 3.45386212908547, horizonSessions: 21,
      annualizedRate: 0, annualizedContinuousDividendYield: 0 };
    for (const type of ['call', 'put'] as const) {
      const result = estimateEuropeanIv({ ...inputs, type });
      if (result.status !== 'ok') throw Error(result.reason);
      expect(result.annualizedImpliedVolatility).toBeCloseTo(0.3, 12);
      expect(result.repricingErrorPerShare).toBeCloseTo(0, 12);
    }
    expect(estimateEuropeanIv(undefined).status).toBe('unavailable');
    const benchmark = estimateEuropeanIv({ ...inputs, type: 'call', premiumPerShare: 10.450583572185565,
      horizonSessions: 252, annualizedRate: 0.05 });
    expect(benchmark.status).toBe('ok');
    if (benchmark.status === 'ok') expect(benchmark.annualizedImpliedVolatility).toBeCloseTo(0.2, 12);
    expect(estimateEuropeanIv({ ...inputs, type: 'call', premiumPerShare: 100 }).status).toBe('unavailable');
    expect(estimateEuropeanIv({ ...inputs, type: 'put', annualizedRate: Number.NaN }).status).toBe('unavailable');
  });
});
