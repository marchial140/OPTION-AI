import {
  compareOpportunities, constructStrategies, defaultRiskPreferences, makeOccSymbol, optionTradingCutoff,
  type ContractQuote, type Direction, type ResearchCandidate,
} from './quant';

const day = 86_400_000;
const demoPublisher = 'Jeu de données fictives Options AI Pro';
const demoSourceUrl = '/settings#data-sources';

const universe = [
  {
    symbol: 'NVDA', name: 'NVIDIA', price: 142.68, change: 2.34, direction: 'bullish',
    thesis: 'Dans ce scénario, la demande en infrastructures IA soutient une reprise au-dessus de la zone de consolidation. Un spread de calls définit le risque du scénario.',
    bullish: 'Rebond du titre avec participation du secteur des semi-conducteurs.',
    bearish: 'Valorisation sensible à une révision des dépenses d’infrastructure.',
    risk: 'Retournement de la demande et volatilité sectorielle.',
    history: [136.1, 136.8, 136.5, 137.4, 137.9, 137.6, 138.8, 138.1, 138.9, 139.2, 139.9, 139.5, 140.6, 141.1, 140.7, 142.68],
  },
  {
    symbol: 'AMD', name: 'Advanced Micro Devices', price: 164.52, change: 1.18, direction: 'bullish',
    thesis: 'La reprise simulée des semi-conducteurs favorise une exposition haussière mesurée. Le scénario dépend d’une poursuite de la demande pour les centres de données.',
    bullish: 'Participation à la hausse du secteur dans le scénario de test.',
    bearish: 'La concurrence augmente le risque de compression des marges.',
    risk: 'Dépendance au rythme de lancement des nouveaux produits.',
    history: [160.0, 159.8, 160.4, 159.5, 160.3, 161.7, 161.6, 160.9, 162.0, 162.6, 162.0, 163.1, 162.8, 163.7, 163.5, 164.52],
  },
  {
    symbol: 'TSLA', name: 'Tesla', price: 248.31, change: -1.42, direction: 'bearish',
    thesis: 'Le scénario hypothétique retient une baisse modérée après plusieurs échecs de rebond. Un spread baissier limite le capital engagé si le mouvement s’inverse.',
    bullish: 'Une surprise positive sur les livraisons pourrait relancer le titre.',
    bearish: 'Échecs de rebond répétés dans le scénario.',
    risk: 'Annonces susceptibles de provoquer d’importants écarts de prix.',
    history: [254.4, 255.3, 253.1, 253.8, 252.5, 251.9, 253.2, 251.6, 250.8, 251.1, 249.9, 250.4, 248.8, 249.3, 249.1, 248.31],
  },
  {
    symbol: 'SPY', name: 'SPDR S&P 500 ETF', price: 589.74, change: 0.42, direction: 'bullish',
    thesis: 'Dans cette simulation, une progression diffuse de l’indice justifie l’examen d’un spread haussier de largeur limitée.',
    bullish: 'Progression répartie sur plusieurs secteurs simulés.',
    bearish: 'Concentration de l’indice sur de grandes capitalisations.',
    risk: 'Sensibilité aux publications macroéconomiques.',
    history: [584.2, 584.8, 584.1, 585.4, 585.3, 586.0, 586.8, 586.3, 587.4, 587.2, 588.1, 587.7, 588.5, 588.7, 588.9, 589.74],
  },
  {
    symbol: 'QQQ', name: 'Invesco QQQ Trust', price: 509.28, change: 0.86, direction: 'bullish',
    thesis: 'Le scénario montre une reprise du Nasdaq-100 portée par les mégacapitalisations. Un spread permet de chiffrer le coût d’une poursuite du mouvement.',
    bullish: 'Force relative du groupe technologique dans la simulation.',
    bearish: 'Vulnérabilité à la hausse simulée des taux réels.',
    risk: 'Concentration et exposition aux résultats des grandes sociétés.',
    history: [503.1, 502.4, 503.8, 504.3, 503.6, 504.7, 505.3, 504.4, 506.2, 506.8, 507.9, 507.2, 508.4, 508.0, 508.5, 509.28],
  },
  {
    symbol: 'SOFI', name: 'SoFi Technologies', price: 15.82, change: -0.63, direction: 'mixed',
    thesis: 'Les signaux du scénario de test sont contrastés. La croissance des dépôts et le risque de crédit méritent une observation supplémentaire.',
    bullish: 'Croissance des dépôts retenue dans les hypothèses de test.',
    bearish: 'Dégradation du crédit à la consommation dans le scénario défavorable.',
    risk: 'Dégradation du crédit à la consommation.',
    history: [16.10, 16.02, 16.13, 15.97, 15.93, 16.00, 15.92, 16.04, 15.93, 15.81, 15.84, 15.88, 15.78, 15.90, 15.88, 15.82],
  },
] satisfies { symbol: string; name: string; price: number; change: number; direction: Direction; thesis: string; bullish: string; bearish: string; risk: string; history: number[] }[];

export const demoSymbols: string[] = ['NVDA', 'AMD', 'SOFI', 'TSLA', 'SPY', 'QQQ'];
export const demoMarket = universe.map(({ symbol, name, price, change, history }) => ({ symbol, name, price, change, history }));

const chainFixtures: { symbol: string; type: 'call' | 'put'; baseDays: number; legs: [number, number, number, number, number][] }[] = [
  { symbol: 'NVDA', type: 'call', baseDays: 14, legs: [[140, 5.28, 5.4, 1980, 6420], [145, 3.35, 3.46, 1600, 5120]] },
  { symbol: 'AMD', type: 'call', baseDays: 12, legs: [[160, 7.24, 7.49, 860, 3010], [165, 4.98, 5.16, 660, 1835]] },
  { symbol: 'TSLA', type: 'put', baseDays: 20, legs: [[250, 8.03, 8.24, 920, 3280], [245, 5.65, 5.83, 735, 2100]] },
  { symbol: 'SPY', type: 'call', baseDays: 9, legs: [[590, 4.18, 4.31, 2470, 9020], [595, 2.17, 2.24, 1940, 6424]] },
  { symbol: 'QQQ', type: 'call', baseDays: 13, legs: [[510, 4.72, 4.83, 1180, 3230], [515, 2.4, 2.5, 750, 2100]] },
  { symbol: 'SOFI', type: 'put', baseDays: 16, legs: [[16, 0.63, 0.72, 359, 1080], [15, 0.23, 0.31, 214, 690]] },
];

function fixtureExpiration(now: Date, baseDays: number) {
  const date = new Date(now.getTime() + baseDays * day);
  date.setUTCDate(date.getUTCDate() + (12 - date.getUTCDay()) % 7);
  while (optionTradingCutoff(date.toISOString().slice(0, 10)) === null) {
    date.setUTCDate(date.getUTCDate() - 1);
  }
  return date.toISOString().slice(0, 10);
}

export function makeDemoFixtures(now = new Date()) {
  const retrievedAt = now.toISOString();
  const quoteAt = new Date(now.getTime() - 7 * 60_000).toISOString();
  const source = { url: demoSourceUrl, publisher: demoPublisher, method: 'Démonstration synthétique' };
  const candidates: ResearchCandidate[] = universe.map((entry) => ({
    symbol: entry.symbol, name: entry.name, price: entry.price, change: entry.change, direction: entry.direction, thesis: entry.thesis,
    risks: [entry.risk], bullishFactors: [entry.bullish], bearishFactors: [entry.bearish],
    sources: [{ ...source, retrievedAt, quoteAt, citation: 'Prix de référence, variation et contexte entièrement fictifs.' }],
    updatedAt: retrievedAt, status: 'DEMO',
  }));

  const quotes: ContractQuote[] = chainFixtures.flatMap(({ symbol, type, baseDays, legs }) => {
    const expiration = fixtureExpiration(now, baseDays);
    return legs.map(([strike, bid, ask, volume, openInterest]) => ({
      id: makeOccSymbol(symbol, expiration, type, strike), symbol, type, strike, bid, ask, volume, openInterest, expiration,
      multiplier: 100, currency: 'USD', quoteAt, retrievedAt, source, status: 'DEMO',
    }));
  });

  const opportunities = candidates.flatMap((candidate) => constructStrategies(quotes.filter(({ symbol }) => symbol === candidate.symbol), {
    ...defaultRiskPreferences, strategies: ['bull_call', 'bear_put'],
  }, { candidate, now, fees: 1.3, allowDemo: true }).opportunities)
    .sort(compareOpportunities);

  const sampleCounts = [[4, 2], [6, 3], [5, 2], [7, 4], [5, 3], [8, 5], [6, 5]];
  const scanHistory = sampleCounts.map(([count, approved], index) => ({
    date: new Date(now.getTime() - (sampleCounts.length - 1 - index) * day).toISOString().slice(0, 10),
    candidates: count, opportunities: approved,
  }));

  return { candidates, opportunities, quotes, market: demoMarket, scanHistory };
}

const fixtures = makeDemoFixtures();
export const demoCandidates = fixtures.candidates;
export const demoOpportunities = fixtures.opportunities;
export const demoQuotes = fixtures.quotes;
export const demoScanHistory = fixtures.scanHistory;
