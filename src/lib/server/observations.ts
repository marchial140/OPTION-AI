import type { ContractQuote } from '@/lib/quant';
import type { Mode } from '@/lib/workspace';

export function sameContract(a: ContractQuote, b: ContractQuote) {
  return a.symbol === b.symbol && a.type === b.type && a.strike === b.strike &&
    a.expiration === b.expiration && a.multiplier === b.multiplier && a.currency === b.currency;
}

export function sameObservation(a: ContractQuote, b: ContractQuote) {
  return sameContract(a,b) && Date.parse(a.quoteAt) === Date.parse(b.quoteAt) &&
    a.bid === b.bid && a.ask === b.ask && a.volume === b.volume && a.openInterest === b.openInterest &&
    a.source.url === b.source.url && a.source.publisher === b.source.publisher;
}

export function currentLegSources(mode: Mode, legs: ContractQuote[], manualQuotes: ContractQuote[]) {
  if (mode === 'demo') return legs.every((leg) => leg.status === 'DEMO');
  return legs.every((leg) => {
    if (leg.status === 'DEMO') return false;
    if (leg.status !== 'MANUAL_ATTESTED' && leg.source.method !== 'manual-broker') return true;
    return manualQuotes.some((current) => current.source.method === 'manual-broker' && sameObservation(current,leg));
  });
}
