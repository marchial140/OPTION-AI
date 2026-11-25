import type { RiskPreferences, ScoreWeights } from '../../src/lib/quant';

/** Phase 1 protocol fixed before computing the comparative performance. */
export const phase1Protocol = {
  symbol: 'AAPL',
  start: '2025-11-24',
  horizon: '2026-11-23',
  expectedSessions: 251,
  expectedSignals: 26,
  scanEveryCalendarDays: 14,
  quantity: 1,
  entryFees: 1.30,
  signalDirection: 'insufficient',
  // Advance each anchored signal date to the first trading session on or after
  // that date. Use the next trading session's EOD ask (long) and bid (short).
  // Hold to expiry, valuing intrinsic at the unadjusted underlying close.
  risk: {
    capital: 10_000,
    maxRiskPercent: 5,
    maxPortfolioRiskPercent: 20,
    minDte: 7,
    maxDte: 30,
    maxContracts: 1,
    maxPositions: 8,
    strategies: ['long_call', 'long_put', 'bull_call', 'bear_put'],
    minVolume: 0,
    minOpenInterest: 0,
    maxSpreadPercent: 35,
    avoidEarnings: true,
    avoidNearExpiration: true,
  } satisfies Required<RiskPreferences>,
  weightsA: { liquidity: 30, payoff: 25, direction: 0, execution: 15, quality: 10 } satisfies ScoreWeights,
  weightsB: { liquidity: 30, payoff: 0, direction: 0, execution: 15, quality: 10 } satisfies ScoreWeights,
  // C applies the same finite payoff score to both types of single-leg option:
  // move signal spot +10% for calls or -10% for puts, compute hypothetical
  // expiry net payoff divided by max loss, floor at zero and cap at 2.5.
  // Vertical-spread components stay unchanged. The shock is a scoring
  // convention, not an expected move, probability, or volatility estimate.
  symmetricSpotMove: 0.10,
  payoffScoreRatioCap: 2.5,
  // D is uniform over all eligible strategies (including unscored calls),
  // in canonical ID order. Each date has an independent SHA-256-based draw.
  randomSeeds: [
    104729, 104743, 104759, 104761, 104773, 104779, 104789, 104801, 104803, 104827,
    104831, 104849, 104851, 104869, 104879, 104891, 104911, 104917, 104933, 104947,
  ],
  // E holds non-interest-bearing cash.
} as const;
