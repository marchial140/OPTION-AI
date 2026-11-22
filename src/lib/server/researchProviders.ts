import { type ContractQuote, type EvidenceSource, contractQuoteSchema, makeOccSymbol, validateQuote } from "../quant";
import { makeDemoFixtures } from "../demo";
import { marketSession } from "./market";
import { z } from "zod";

export type ProviderCapabilities = {
  underlyingQuote: boolean;
  marketSession: boolean;
  optionExpirations: boolean;
  optionChain: "none" | "discovery-only" | "partial" | "complete";
  optionQuote: boolean;
  historicalPrices: boolean;
  corporateEvents: boolean;
  webResearch: boolean;
  demo: boolean;
};

export interface UnderlyingObservation {
  symbol: string;
  price: number;
  currency: "USD";
  quoteAt: string;
  source: EvidenceSource;
  change?: number | null;
}

export interface CorporateEvent {
  symbol: string;
  kind: "earnings" | "ex-dividend" | "announcement";
  date: string;
  source: EvidenceSource;
}

interface Context {
  now: Date;
  signal?: AbortSignal;
}

export interface MarketDataProvider {
  getDataCapabilities(): ProviderCapabilities;
  getMarketSession?(at?: Date): ReturnType<typeof marketSession>;
  getUnderlyingQuote?(symbol: string, context: Context): Promise<UnderlyingObservation | null>;
  getOptionExpirations?(symbol: string, context: Context): Promise<string[]>;
  getOptionsChain?(symbol: string, context: Context): Promise<ContractQuote[]>;
  getOptionQuote?(identifier: string, context: Context): Promise<ContractQuote | null>;
  getHistoricalUnderlyingPrices?(symbol: string, context: Context): Promise<UnderlyingObservation[]>;
  getCorporateEvents?(symbol: string, context: Context): Promise<CorporateEvent[]>;
}

const manualQuoteSchema = contractQuoteSchema.omit({ status: true, retrievedAt: true })
  .extend({ attested: z.literal(true) });

export type ManualQuoteInput = z.input<typeof manualQuoteSchema>;

export function validateManualQuote(value: unknown, expectedSymbol?: string, now = new Date()) {
  const parsed = manualQuoteSchema.safeParse(value);
  if (!parsed.success) {
    return { quote: null, status: "INSUFFICIENT", reason: "Renseignez la cotation du courtier et confirmez sa provenance." } as const;
  }
  const fields = parsed.data;
  const quote = contractQuoteSchema.parse({
    ...fields,
    retrievedAt: now.toISOString(),
    source: {
      url: fields.source.url,
      publisher: fields.source.publisher,
      method: "manual-broker",
      confidence: "user-attested",
      citation: "Cotation du courtier saisie et attestée par l’utilisateur.",
    },
    status: "MANUAL_ATTESTED",
  });
  const validation = validateQuote(quote, expectedSymbol ?? quote.symbol, now);
  if (!validation.valid) {
    return { quote: null, status: validation.status, reason: validation.reason ?? "Cotation non admissible." } as const;
  }
  const session = marketSession(new Date(quote.quoteAt));
  const closeTime = session.earlyClose ? "13:00" : "16:00";
  if (!session.optionsOpen && !(session.status === "after-hours" && session.time === closeTime)) {
    return { quote: null, status: "CONTRADICTORY", reason: "L’horodatage doit correspondre à la séance régulière US ou à sa clôture." } as const;
  }
  const id = makeOccSymbol(quote.symbol, quote.expiration, quote.type, quote.strike);
  return { quote: { ...quote, id, status: validation.status }, status: validation.status, reason: null } as const;
}

export class ManualVerifiedQuoteProvider implements MarketDataProvider {
  private readonly quotes: ContractQuote[];

  constructor(quotes: ContractQuote[]) {
    this.quotes = quotes.flatMap((quote) => {
      if (quote.source.method !== "manual-broker" || quote.source.confidence !== "user-attested") return [];
      if (quote.status !== "VERIFIED_DELAYED" && quote.status !== "MANUAL_ATTESTED") return [];
      return [{ ...quote, status: "MANUAL_ATTESTED" }];
    });
  }

  getDataCapabilities(): ProviderCapabilities {
    return {
      underlyingQuote: false, marketSession: true, optionExpirations: true, optionChain: "partial",
      optionQuote: true, historicalPrices: false, corporateEvents: false, webResearch: false, demo: false,
    };
  }

  getMarketSession = marketSession;

  async getOptionsChain(symbol: string) {
    return this.quotes.filter((quote) => quote.symbol === symbol);
  }

  async getOptionExpirations(symbol: string) {
    return [...new Set((await this.getOptionsChain(symbol)).map((quote) => quote.expiration))].sort();
  }

  async getOptionQuote(identifier: string) {
    return this.quotes.find((quote) => quote.id === identifier) ?? null;
  }
}

export class DemoDataProvider implements MarketDataProvider {
  constructor(private readonly fixtures: ReturnType<typeof makeDemoFixtures>) {}

  getDataCapabilities(): ProviderCapabilities {
    return {
      underlyingQuote: true, marketSession: true, optionExpirations: true, optionChain: "partial",
      optionQuote: true, historicalPrices: false, corporateEvents: false, webResearch: false, demo: true,
    };
  }

  getMarketSession = marketSession;

  getCandidate(symbol: string) {
    return this.fixtures.candidates.find((candidate) => candidate.symbol === symbol) ?? null;
  }

  async getUnderlyingQuote(symbol: string) {
    const candidate = this.getCandidate(symbol);
    const source = candidate?.sources[0];
    if (candidate?.price == null || !source?.quoteAt) return null;
    return {
      symbol, price: candidate.price, currency: "USD" as const, quoteAt: source.quoteAt,
      source, change: candidate.change,
    };
  }

  async getOptionsChain(symbol: string) {
    return this.fixtures.quotes.filter((quote) => quote.symbol === symbol);
  }

  async getOptionExpirations(symbol: string) {
    return [...new Set((await this.getOptionsChain(symbol)).map((quote) => quote.expiration))].sort();
  }

  async getOptionQuote(identifier: string) {
    return this.fixtures.quotes.find((quote) => quote.id === identifier) ?? null;
  }
}
