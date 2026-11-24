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
const standardReference = /\b(?:S\s*&\s*P\s*500|NASDAQ[-\s]+100|8-K|10-K|10-Q|3M|5G)\b/giu;
const financialNumber = /[\p{Nd}$€£%]|\b(?:dollars?|euros?|percent|pour cent|points de base)\b/iu;

function normalizeLink(value: string) {
  if (typeof value !== "string" || value.length > 2048) return null;
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
  return financialNumber.test(text.replace(standardReference, ""));
}

const sourceReferenceSchema = z.object({
  url: z.string(),
  publishedAt: z.string().nullable().default(null),
});

const claimSchema = z.object({
  text: z.string(),
  source: sourceReferenceSchema,
});

// A malformed qualitative observation carries no evidence and can be dropped on its own.
const optionalClaimSchema = claimSchema.nullable().catch(null);
const optionalClaimsSchema = z.array(optionalClaimSchema).default([]).catch([]);

export const screenSchema = z.object({
  ticker: z.string(),
  companyName: z.string(),
  direction: z.enum(["bullish", "bearish", "neutral", "mixed", "insufficient"]),
  thesis: optionalClaimSchema.default(null),
  bullishFactors: optionalClaimsSchema,
  bearishFactors: optionalClaimsSchema,
  eventRisks: optionalClaimsSchema,
  sectorRisks: optionalClaimsSchema,
  volatilityContext: optionalClaimSchema.default(null),
  news: optionalClaimsSchema,
  uncertainty: z.array(z.string()).default([]).catch([]),
  // An unusable event report must not discard independently sourced research.
  earnings: z.object({ date: z.iso.date(), source: sourceReferenceSchema }).nullable().default(null).catch(null),
  underlyingQuote: z.object({
    price: z.number(),
    currency: z.string(),
    quoteAt: z.string().nullable().default(null),
    source: sourceReferenceSchema,
  }).nullable().default(null),
});

export const discoverySchema = z.object({
  ticker: z.string(),
  contracts: z.array(z.object({
    identifier: z.string(),
    type: z.enum(["call", "put"]),
    expiration: z.string(),
    strike: z.number(),
    multiplier: z.number().nullable().default(null),
    bid: z.number().nullable().default(null),
    ask: z.number().nullable().default(null),
    quoteAt: z.string().nullable().default(null),
    currency: z.string().nullable().default(null),
    volume: z.number().nullable().default(null),
    openInterest: z.number().nullable().default(null),
    impliedVolatility: z.number().nullable().default(null),
    source: sourceReferenceSchema,
  })),
  warnings: z.array(claimSchema).default([]),
  uncertainty: z.array(z.string()).default([]),
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
    if (item.type !== "message" || item.phase === "commentary" || item.status !== "completed") continue;
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
) {
  const url = normalizeLink(reference.url);
  // The search wire metadata confirms URLs and titles. Publication times in the model JSON remain provisional.
  return url ? sources.get(url) ?? null : null;
}

export function boundClaim(claim: Claim, sources: Map<string, EvidenceSource>) {
  const source = boundSource(claim.source, sources);
  const text = cleanText(claim.text, 360);
  if (!source || !text || checkNumericAssertion(text)) return null;
  return { text, source };
}

export function mergeSources(sources: EvidenceSource[]) {
  const unique = new Map<string, EvidenceSource>();
  for (const source of sources) {
    const existing = unique.get(source.url);
    unique.set(source.url, existing ? {
      ...existing, ...source,
      citation: source.citation ?? existing.citation,
      publishedAt: source.publishedAt ?? existing.publishedAt,
      quoteAt: source.quoteAt ?? existing.quoteAt,
    } : source);
  }
  return [...unique.values()];
}
