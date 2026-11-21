import { randomUUID } from 'node:crypto';
import Decimal from 'decimal.js';
import { calculateStrategy, daysToExpiration, type StrategyInput } from '@/lib/quant';
import type { Mode, PaperTrade, Settings, WorkspaceState } from '@/lib/workspace';

export class PaperError extends Error {}

function money(value: Decimal.Value) {
  return new Decimal(value).toDecimalPlaces(2);
}

function proportional(value: number, quantity: number, total: number) {
  return money(new Decimal(value).times(quantity).div(total));
}

export function portfolioExposure(portfolio: PaperTrade[]) {
  return portfolio.filter((trade) => trade.status === 'open').reduce((total, trade) => {
    const closedQuantity = trade.quantity - trade.remainingQuantity;
    const closedCost = proportional(trade.maxLoss, closedQuantity, trade.quantity);
    return total.plus(money(trade.maxLoss).minus(closedCost));
  }, new Decimal(0)).toNumber();
}

export function openPaperTrade(state: WorkspaceState, mode: Mode, data: {
  input: StrategyInput; entryDebit: number; entryDate: string; notes?: string; opportunityId?: string; requestKey?: string;
}) {
  const {input, entryDate, notes, opportunityId, requestKey} = data;
  const duplicate = requestKey ? state.portfolio.find((trade) => trade.requestKey === requestKey) : undefined;
  if (duplicate) return duplicate;
  const candidate = opportunityId ? state.scans.flatMap((scan) => scan.opportunities).find((item) => item.id === opportunityId) : undefined;
  const [long, short] = input.legs;
  const expiration = long.expiration;
  if (Date.parse(entryDate) > Date.now() + 60_000 || daysToExpiration(expiration, new Date(entryDate)) < 0) {
    throw new PaperError('La date d’entrée doit précéder l’échéance et ne peut être future.');
  }
  if (mode === 'live' && input.legs.some((leg) => leg.status === 'DEMO')) throw new PaperError('Cette cotation appartient à la démonstration.');
  if (opportunityId && (!candidate || candidate.strategy !== input.strategy ||
    candidate.input.legs.map((leg) => leg.id).join(',') !== input.legs.map((leg) => leg.id).join(','))) {
    throw new PaperError('La position ne correspond pas à l’opportunité sélectionnée.');
  }
  calculateStrategy(input);
  const entryDebit = money(data.entryDebit);
  const fees = money(input.fees);
  const maxLoss = entryDebit.plus(fees);
  const maxIntrinsic = short ? new Decimal(short.strike).minus(long.strike).abs() :
    input.strategy === 'long_put' ? new Decimal(long.strike) : null;
  if (entryDebit.lte(0) || (maxIntrinsic && entryDebit.gte(maxIntrinsic.times(input.quantity).times(long.multiplier)))) {
    throw new PaperError('Le débit hypothétique doit être positif et inférieur à la valeur maximale de la stratégie.');
  }

  if (Date.parse(expiration + 'T23:59:59Z') >= Date.now()) {
    verifyPaperRisk(state.settings, state.portfolio, input, maxLoss, new Date(entryDate));
  } else {
    throw new PaperError('L’échéance de cette position est passée.');
  }
  const trade: PaperTrade = {
    id: randomUUID(), symbol: long.symbol, strategy: input.strategy, input: {
      ...input,
      fees: fees.toNumber(),
      legs: candidate?.input.legs ?? input.legs.map((leg) => mode === 'live' ? {
        ...leg, status:'UNVERIFIED', source:{url:'/portfolio',publisher:'Saisie du portefeuille papier'},
      } : leg),
    },
    entryDebit: entryDebit.toNumber(), entryDate, expiration, quantity: input.quantity, remainingQuantity: input.quantity,
    fees: fees.toNumber(), maxLoss: maxLoss.toNumber(), notes, thesis: candidate?.thesis, opportunityId,
    researchScore: candidate?.score?.total, status: 'open', exits: [], realizedPnl: 0, mode, requestKey,
  };
  state.portfolio.unshift(trade);
  return trade;
}

function verifyPaperRisk(settings: Settings, portfolio: PaperTrade[], input: StrategyInput, maxLoss: Decimal, entered: Date) {
  const capital = new Decimal(settings.accountCapital);
  if (maxLoss.gt(capital.times(settings.riskPerTrade).div(100))) throw new PaperError('La perte maximale dépasse votre limite par position.');
  if (maxLoss.plus(portfolioExposure(portfolio)).gt(capital.times(settings.maxPortfolioRisk).div(100))) {
    throw new PaperError('La perte maximale dépasse votre enveloppe de risque totale.');
  }
  if (!settings.strategies.includes(input.strategy)) throw new PaperError('Cette stratégie est désactivée dans vos préférences.');
  if (input.quantity > settings.maxContracts) throw new PaperError('La quantité dépasse votre limite par position.');
  if (portfolio.filter((trade) => trade.status === 'open').length >= settings.maxPositions) {
    throw new PaperError('Vous avez atteint votre limite de positions ouvertes.');
  }
  const dte = daysToExpiration(input.legs[0].expiration, entered);
  if (dte < settings.minDte || dte > settings.maxDte || (settings.avoidNearExpiration && dte < 3)) {
    throw new PaperError('L’échéance est hors de votre plage autorisée.');
  }
}

export function exitPaperTrade(trade: PaperTrade, data: { quantity: number; exitCredit: number; exitDate: string; fees: number; notes?: string; requestKey?: string }) {
  const { quantity, exitDate, notes, requestKey } = data;
  if (requestKey && trade.exits.some((exit) => exit.requestKey === requestKey)) return trade;
  const date = Date.parse(exitDate);
  const previous = trade.exits.at(-1)?.exitDate ?? trade.entryDate;
  if (trade.status !== 'open' || quantity > trade.remainingQuantity) throw new PaperError('La quantité dépasse la position restante.');
  if (date < Date.parse(previous) || date > Date.now() + 60_000) throw new PaperError('La date de clôture doit suivre les opérations déjà enregistrées.');
  const fees = money(data.fees);
  const exitCredit = money(data.exitCredit);
  const alreadyClosed = trade.quantity - trade.remainingQuantity;
  const entryCost = money(trade.entryDebit).plus(trade.fees);
  const allocatedCost = proportional(entryCost.toNumber(), alreadyClosed + quantity, trade.quantity)
    .minus(proportional(entryCost.toNumber(), alreadyClosed, trade.quantity));
  const realizedPnl = exitCredit.minus(fees).minus(allocatedCost);
  trade.exits.push({id:randomUUID(),quantity,exitCredit:exitCredit.toNumber(),exitDate,fees:fees.toNumber(),realizedPnl:realizedPnl.toNumber(),notes,requestKey});
  trade.realizedPnl = money(trade.realizedPnl).plus(realizedPnl).toNumber();
  trade.remainingQuantity -= quantity;
  if (trade.remainingQuantity === 0) trade.status = 'closed';
  return trade;
}
