import { phase2Protocol } from './config';
import { positiveFinite } from './distributions';
import { normalTail } from './normal';

export interface EuropeanIvInputs {
  type: 'call' | 'put';
  spot: number;
  strike: number;
  premiumPerShare: number;
  horizonSessions: number;
  annualizedRate: number;
  annualizedContinuousDividendYield: number;
}

export function estimateEuropeanIv(input: EuropeanIvInputs | undefined):
  { status: 'ok'; annualizedImpliedVolatility: number; repricingErrorPerShare: number }
  | { status: 'unavailable'; reason: string } {
  if (!input) return { status: 'unavailable', reason: 'Explicit pricing inputs are required.' };
  const { type, spot, strike, premiumPerShare, horizonSessions, annualizedRate, annualizedContinuousDividendYield } = input;
  if ((type !== 'call' && type !== 'put') || ![spot, strike, premiumPerShare].every(positiveFinite)
    || !Number.isSafeInteger(horizonSessions) || horizonSessions <= 0
    || !Number.isFinite(annualizedRate) || !Number.isFinite(annualizedContinuousDividendYield) || annualizedContinuousDividendYield < 0) {
    return { status: 'unavailable', reason: 'Invalid European pricing inputs.' };
  }
  const years = horizonSessions / phase2Protocol.sessionsPerYear;
  const pvSpot = spot * Math.exp(-annualizedContinuousDividendYield * years);
  const pvStrike = strike * Math.exp(-annualizedRate * years);
  const isCall = type === 'call';
  const lower = Math.max(0, isCall ? pvSpot - pvStrike : pvStrike - pvSpot);
  const upper = isCall ? pvSpot : pvStrike;
  if (!positiveFinite(pvSpot) || !positiveFinite(pvStrike) || !(premiumPerShare > lower && premiumPerShare < upper)) {
    return { status: 'unavailable', reason: 'Premium is outside strict European no-arbitrage bounds.' };
  }

  const price = (volatility: number) => {
    const deviation = volatility * Math.sqrt(years);
    const d1 = (Math.log(pvSpot) - Math.log(pvStrike)) / deviation + deviation / 2;
    const d2 = d1 - deviation;
    return isCall ? pvSpot * normalTail(-d1) - pvStrike * normalTail(-d2)
      : pvStrike * normalTail(d2) - pvSpot * normalTail(d1);
  };
  let low = 0;
  let high = 1;
  while (price(high) < premiumPerShare && high < 1024) high *= 2;
  if (!(price(high) >= premiumPerShare)) return { status: 'unavailable', reason: 'A numerical root could not be bracketed.' };
  for (let i = 0; i < 80; i++) {
    const midpoint = (low + high) / 2;
    if (price(midpoint) < premiumPerShare) low = midpoint;
    else high = midpoint;
  }
  const annualizedImpliedVolatility = (low + high) / 2;
  const repricingErrorPerShare = price(annualizedImpliedVolatility) - premiumPerShare;
  if (!positiveFinite(annualizedImpliedVolatility) || !Number.isFinite(repricingErrorPerShare)
    || Math.abs(repricingErrorPerShare) > Math.max(1e-9, premiumPerShare * 1e-9)) {
    return { status: 'unavailable', reason: 'European repricing failed to converge.' };
  }
  return { status: 'ok', annualizedImpliedVolatility, repricingErrorPerShare };
}
