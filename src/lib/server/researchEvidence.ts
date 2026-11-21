import type { Response } from "openai/resources/responses/responses";
import { z } from "zod";
import type { EvidenceSource } from "../quant";

const publishers: Record<string, string> = {
  "sec.gov": "SEC",
  "federalreserve.gov": "Réserve fédérale",
  "bls.gov": "Bureau of Labor Statistics",
  "bea.gov": "Bureau of Economic Analysis",
  "nyse.com": "NYSE",
  "nasdaq.com": "Nasdaq",
  "cboe.com": "Cboe",
  "theocc.com": "Options Clearing Corporation",
  "optionseducation.org": "Options Industry Council",
  "reuters.com": "Reuters",
  "bloomberg.com": "Bloomberg",
  "wsj.com": "The Wall Street Journal",
  "ft.com": "Financial Times",
  "cnbc.com": "CNBC",
  "finance.yahoo.com": "Yahoo Finance",
  "marketwatch.com": "MarketWatch",
  "nvidia.com": "NVIDIA",
  "amd.com": "AMD",
  "sofi.com": "SoFi",
  "tesla.com": "Tesla",
  "ssga.com": "State Street",
  "invesco.com": "Invesco",
};

export const trustedResearchDomains = Object.keys(publishers);

const unsafeText = /ignore (?:all|prior|previous|the|your)|ignorez? (?:les|toutes)|system prompt|developer (?:message|instructions)|instructions? système|sk-(?:proj-)?[a-z0-9]{10,}|<\/?(?:script|iframe|system|developer|instruction)\b|javascript:|\bexfiltrat\w*|\b(?:garanti\w*|guarantee\w*)\b|\bsans (?:aucun )?risque\b|\brisk[- ]free\b|\b(?:insider tip|tuyau d['’]initié)\b/iu;
const financialNumber = /(?:[$€£]\s*\d|\d(?:[\d ,.]*)\s*(?:[$€£%]|USD\b|CAD\b|EUR\b|dollars?\b|pour cent\b)|\b(?:prix|cote|cours|strike|bid|ask|prime|price|open interest|volatilité|volume)\s*(?:(?:de|à|est|at|of|is)\s+)?\d+\b)/iu;

function normalizeLink(value: string) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/^utm_|^(?:fbclid|gclid)$/i.test(key)) url.searchParams.delete(key);
    }
    return url.href;
  } catch {
    return null;
  }
}

function publisherOf(link: string) {
  const host = new URL(link).hostname;
  const match = Object.keys(publishers).find((domain) => host === domain || host.endsWith("." + domain));
  return match ? publishers[match] : null;
}

export function cleanText(value: string, maxLength: number) {
  const text = value.trim().replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/g, " ");
  return !text || unsafeText.test(text) ? null : text.slice(0, maxLength);
}

export function checkNumericAssertion(text: string) {
  return financialNumber.test(text);
}

const sourceReferenceSchema = z.object({
  url: z.string(),
  publishedAt: z.string().nullable(),
});

const claimSchema = z.object({
  text: z.string(),
  source: sourceReferenceSchema,
});

export const screenSchema = z.object({
  ticker: z.string(),
  companyName: z.string(),
  direction: z.enum(["bullish", "bearish", "neutral", "mixed", "insufficient"]),
  thesis: claimSchema.nullable(),
  bullishFactors: z.array(claimSchema),
  bearishFactors: z.array(claimSchema),
  eventRisks: z.array(claimSchema),
  sectorRisks: z.array(claimSchema),
  volatilityContext: claimSchema.nullable(),
  news: z.array(claimSchema),
  uncertainty: z.array(z.string()),
  earnings: z.object({ date: z.string(), source: sourceReferenceSchema }).nullable(),
  underlyingQuote: z.object({
    price: z.number(),
    currency: z.string(),
    quoteAt: z.string().nullable(),
    source: sourceReferenceSchema,
  }).nullable(),
});

export const discoverySchema = z.object({
  ticker: z.string(),
  contracts: z.array(z.object({
    identifier: z.string(),
    type: z.enum(["call", "put"]),
    expiration: z.string(),
    strike: z.number(),
    multiplier: z.number().nullable(),
    bid: z.number().nullable(),
    ask: z.number().nullable(),
    quoteAt: z.string().nullable(),
    currency: z.string().nullable(),
    volume: z.number().nullable(),
    openInterest: z.number().nullable(),
    impliedVolatility: z.number().nullable(),
    source: sourceReferenceSchema,
  })),
  warnings: z.array(claimSchema),
  uncertainty: z.array(z.string()),
});

export type Claim = z.infer<typeof claimSchema>;
export type SourceReference = z.infer<typeof sourceReferenceSchema>;

export function gatherSources(response: Response, retrieval: Date) {
  const sources = new Map<string, EvidenceSource>();
  function add(raw: string, title?: string) {
    const url = normalizeLink(raw);
    const publisher = url ? publisherOf(url) : null;
    if (!url || !publisher) return;
    const existing = sources.get(url);
    sources.set(url, {
      url,
      publisher,
      retrievedAt: retrieval.toISOString(),
      confidence: "recognized-publisher",
      method: "openai-web-search",
      citation: (title && cleanText(title, 160)) || existing?.citation,
    });
  }

  for (const item of response.output) {
    if (item.type === "web_search_call" && item.status === "completed") {
      const action = item.action;
      if (action.type === "search") {
        for (const result of action.sources ?? []) add(result.url);
      } else if (action.url) add(action.url);
    }
    if (item.type !== "message") continue;
    for (const block of item.content) {
      if (block.type !== "output_text") continue;
      for (const annotation of block.annotations) {
        if (annotation.type === "url_citation") add(annotation.url, annotation.title);
      }
    }
  }
  return sources;
}

export function boundSource(
  reference: SourceReference,
  sources: Map<string, EvidenceSource>,
  now: Date,
) {
  const url = normalizeLink(reference.url);
  const source = url ? sources.get(url) : null;
  if (!source) return null;
  const publication = reference.publishedAt;
  const publishedAt = publication && z.iso.datetime({ offset: true }).safeParse(publication).success &&
    Date.parse(publication) <= now.getTime() + 60_000 ? publication : undefined;
  return { ...source, publishedAt };
}

export function boundClaim(claim: Claim, sources: Map<string, EvidenceSource>, now: Date) {
  const source = boundSource(claim.source, sources, now);
  const text = cleanText(claim.text, 360);
  if (!source || !text || checkNumericAssertion(text)) return null;
  return { text, source };
}

export function mergeSources(sources: EvidenceSource[]) {
  const unique = new Map<string, EvidenceSource>();
  for (const source of sources) {
    const existing = unique.get(source.url);
    unique.set(source.url, { ...existing, ...source });
  }
  return [...unique.values()];
}
