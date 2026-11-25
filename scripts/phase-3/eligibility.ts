import { defaultRiskPreferences, type RiskPreferences } from '../../src/lib/quant';
import { marketSession } from '../../src/lib/server/market';
import { phase3Protocol, type SignalSchedule } from './protocol';

export const phase3RiskPreferences: Readonly<RiskPreferences> = {
  ...defaultRiskPreferences,
  capital: phase3Protocol.portfolio.referenceCapital,
  maxRiskPercent: phase3Protocol.portfolio.maxRiskPercent,
  maxPortfolioRiskPercent: phase3Protocol.portfolio.maxPortfolioRiskPercent,
  maxPositions: phase3Protocol.portfolio.maxPositions,
  maxContracts: phase3Protocol.portfolio.quantityPerLeg,
  minDte: phase3Protocol.portfolio.minCalendarDte,
  maxDte: phase3Protocol.portfolio.maxCalendarDte,
  minVolume: phase3Protocol.candidates.minVolume,
  minOpenInterest: phase3Protocol.candidates.minOpenInterest,
  maxSpreadPercent: phase3Protocol.portfolio.maxSpreadPercent,
};

// Eligibility refers to the signal snapshot's date while the forecast clock stays at publication/selection.
export function signalRiskPreferences(schedule: SignalSchedule): RiskPreferences {
  const selectionDate = marketSession(new Date(schedule.signalAt)).date;
  const lag = (Date.parse(selectionDate) - Date.parse(schedule.signalDate)) / 86_400_000;
  if (!Number.isInteger(lag) || lag < 1 || lag >= phase3Protocol.portfolio.minCalendarDte) {
    throw new Error('Historical selection lag falls outside the approved signal-side expiry convention.');
  }
  return { ...phase3RiskPreferences, minDte: phase3Protocol.portfolio.minCalendarDte - lag,
    maxDte: phase3Protocol.portfolio.maxCalendarDte - lag };
}
