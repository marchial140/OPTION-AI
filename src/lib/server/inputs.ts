import { z } from 'zod';
import { strategyInputSchema, strategySchema } from '@/lib/quant';

const money = z.number().finite().nonnegative().max(1_000_000_000);
const date = z.iso.datetime({offset:true});
const percentage = z.number().finite().min(0).max(100);
const id = z.string().min(1).max(120);
export const symbolInput = z.string().trim().toUpperCase().regex(/^[A-Z][A-Z0-9.]{0,9}$/);
const uniqueSymbols = z.array(symbolInput).max(60).transform((symbols) => [...new Set(symbols)]);
const schedule = z.object({
  enabled: z.boolean(),
  time: z.string().regex(/^(?:[0-1][0-9]|2[0-3]):[0-5][0-9]$/),
  weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7).transform((days) => [...new Set(days)]),
  watchlistId: id.nullable(),
});

export const settingsInput = z.object({
  accountCapital: money.positive(),
  riskPerTrade: percentage,
  maxPortfolioRisk: percentage,
  maxPositions: z.number().int().min(1).max(100),
  maxContracts: z.number().int().min(1).max(100),
  minDte: z.number().int().min(0).max(730),
  maxDte: z.number().int().min(0).max(730),
  strategies: z.array(strategySchema).min(1).max(4).transform((items) => [...new Set(items)]),
  minVolume: z.number().int().min(0).max(100_000_000),
  minOpenInterest: z.number().int().min(0).max(100_000_000),
  maxSpreadPercent: percentage,
  avoidEarnings: z.boolean(),
  avoidNearExpiration: z.boolean(),
  maxRequestsPerScan: z.number().int().min(1).max(60),
  dailyBudget: money.max(100),
  monthlyBudget: money.max(1000),
  dailySearchLimit: z.number().int().min(0).max(300),
  language: z.literal('fr'),
  currency: z.literal('USD'),
  theme: z.enum(['dark','contrast']),
  schedule,
  scoreWeights: z.object({
    liquidity:percentage,payoff:percentage,direction:percentage,execution:percentage,quality:percentage,
  }).refine((weights) => Math.abs(Object.values(weights).reduce((sum, weight) => sum + weight, 0) - 100) < 0.000001),
}).strict().partial();

export const scanInput = z.object({
  type: z.enum(['quick','deep','custom']),
  tickers: uniqueSymbols.optional(),
  overrides: settingsInput.optional(),
  watchlistId: id.optional(),
}).strict();

export const watchlistsInput = z.object({watchlists:z.array(z.object({
  id, name:z.string().trim().min(1).max(80), items:uniqueSymbols,
})).min(1).max(20).refine((items) => new Set(items.map((item) => item.id)).size === items.length)});
export const watchlistItemInput = z.object({symbol:symbolInput,watchlistId:id.optional()});
export const openTradeInput = z.object({input:strategyInputSchema,entryDebit:money.positive(),entryDate:date,
  notes:z.string().trim().max(4000).optional(),opportunityId:id.optional()});
export const exitTradeInput = z.object({quantity:z.number().int().min(1).max(100),exitCredit:money,fees:money,
  exitDate:date,notes:z.string().trim().max(4000).optional()});
export const chatInput = z.object({message:z.string().trim().min(1).max(2000),opportunityId:id.optional(),
  history:z.array(z.object({role:z.enum(['user','assistant']),text:z.string().min(1).max(3000)})).max(6).optional()});
export const authInput = z.object({action:z.enum(['login','signup']),email:z.email().max(254),password:z.string().min(8).max(256)});
