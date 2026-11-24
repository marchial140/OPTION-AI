import { createHash } from "node:crypto";
import { z } from "zod";
import {
  daysToExpiration, defaultRiskPreferences, makeOccSymbol, marketDataQuoteMaxAgeMs, optionTradingCutoff, validateQuote,
  type ContractQuote, type RiskPreferences,
} from "../quant";
import { marketSession } from "./market";
import { isExchangeListed } from "./marketDirectory";

const maxRows = 48;
const cacheLifetimeMs = 30_000;
const maxCacheEntries = 64;
const maxConcurrentRequests = 4;
const maxResponseBytes = 256 * 1024;

type DteLimits = Pick<RiskPreferences, "minDte" | "maxDte">;
type FetchContext = { now: Date; signal?: AbortSignal };
type Chain = { quotes: ContractQuote[]; retrievedAt: number };

const cache = new Map<string, { expiresAt: number; chain: Chain }>();
const inFlight = new Map<string, Promise<Chain>>();

const column = z.array(z.unknown()).max(maxRows);
const chainSchema = z.object({
  s: z.literal("ok"),
  optionSymbol: column,
  underlying: column,
  side: column,
  expiration: column,
  strike: column,
  bid: column,
  ask: column,
  updated: column,
  volume: column.optional(),
  openInterest: column.optional(),
});
const responseStatus = z.object({ s: z.enum(["ok", "no_data", "error"]) });
const positiveNumber = z.number().finite().positive();
const nonnegativeNumber = z.number().finite().nonnegative();
const nonnegativeInteger = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export class MarketDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MarketDataError";
  }
}

export function marketDataConfigured(): boolean {
  return Boolean(process.env.MARKETDATA_API_TOKEN?.trim());
}

function invalidChain() {
  return new MarketDataError("La chaîne Market Data est incomplète ou incohérente.");
}

function epochSeconds(value: unknown) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) return null;
  const date = new Date(value * 1000);
  return Number.isFinite(date.getTime()) ? date : null;
}

function hasCurrentSession(referenceTime: Date, snapshot: Date) {
  const age = referenceTime.getTime() - snapshot.getTime();
  if (age < 0 || age > marketDataQuoteMaxAgeMs) return false;
  const session = marketSession(snapshot);
  if (session.optionsOpen) return true;
  return session.status === "after-hours" && snapshot.getTime() === optionTradingCutoff(session.date);
}

function chainUrl(symbol: string, minDte: number, maxDte: number) {
  const url = new URL(`https://api.marketdata.app/v1/options/chain/${encodeURIComponent(symbol)}/`);
  url.search = new URLSearchParams({
    mode: "cached",
    maxage: `${marketDataQuoteMaxAgeMs / 60_000}min`,
    nonstandard: "false",
    dateformat: "unix",
    dte: `${minDte}-${maxDte}`,
    limit: String(maxRows),
  }).toString();
  return url;
}

async function limitedJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw invalidChain();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxResponseBytes) {
        await reader.cancel();
        throw invalidChain();
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } catch {
    throw invalidChain();
  } finally {
    reader.releaseLock();
  }
}

function readChain(
  payload: unknown, symbol: string, url: URL, retrieved: Date, now: Date, minDte: number, maxDte: number,
): ContractQuote[] {
  const envelope = responseStatus.safeParse(payload);
  if (!envelope.success) throw invalidChain();
  if (envelope.data.s === "no_data") return [];
  if (envelope.data.s !== "ok") throw new MarketDataError("Le fournisseur n’a pas retourné de chaîne exploitable.");

  const parsed = chainSchema.safeParse(payload);
  if (!parsed.success) throw invalidChain();
  const data = parsed.data;
  if (Object.values(data).some((values) => Array.isArray(values) && values.length !== data.optionSymbol.length)) {
    throw invalidChain();
  }

  const quotes: ContractQuote[] = [];
  for (const [index, id] of data.optionSymbol.entries()) {
    const side = data.side[index];
    if (data.underlying[index] !== symbol || typeof id !== "string" || (side !== "call" && side !== "put")) continue;
    const expiryTime = epochSeconds(data.expiration[index]);
    const snapshot = epochSeconds(data.updated[index]);
    if (!expiryTime || !snapshot || !hasCurrentSession(now, snapshot)) continue;
    const expiration = marketSession(expiryTime).date;
    if (expiryTime.getTime() !== optionTradingCutoff(expiration)) continue;
    const dte = daysToExpiration(expiration, now);
    if (dte < minDte || dte > maxDte) continue;
    const strike = positiveNumber.safeParse(data.strike[index]);
    const ask = positiveNumber.safeParse(data.ask[index]);
    const bid = nonnegativeNumber.safeParse(data.bid[index]);
    if (!strike.success || !ask.success || !bid.success || bid.data > ask.data) continue;
    const quote: ContractQuote = {
      id, symbol, type: side, strike: strike.data, expiration,
      // On a listed equity/ETF, the provider's standard-only filter identifies the OCC unit of 100 shares.
      multiplier: 100, currency: "USD", bid: bid.data, ask: ask.data,
      quoteAt: snapshot.toISOString(), retrievedAt: retrieved.toISOString(),
      status: "VERIFIED_DELAYED",
      source: {
        url: url.href,
        publisher: "Market Data",
        method: "marketdata-cached",
        confidence: "provider-snapshot",
        citation: "Snapshot en cache, séries standards. Unité de 100 actions ou parts selon les spécifications de l’OCC.",
      },
      volume: nonnegativeInteger.safeParse(data.volume?.[index]).data,
      openInterest: nonnegativeInteger.safeParse(data.openInterest?.[index]).data,
    };
    if (!validateQuote(quote, symbol, now).valid) continue;
    quotes.push({ ...quote, id: makeOccSymbol(symbol, expiration, side, strike.data) });
  }
  return quotes;
}

async function requestChain(
  url: URL, token: string, symbol: string, now: Date, minDte: number, maxDte: number,
): Promise<Chain> {
  const signal = AbortSignal.timeout(8_000);
  let listed: boolean;
  try {
    listed = await isExchangeListed(symbol, signal);
  } catch {
    throw new MarketDataError("La classification boursière du symbole est temporairement indisponible.");
  }
  if (!listed) throw new MarketDataError("Impossible de confirmer que le symbole est une action ou un FNB américain admissible.");
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      cache: "no-store",
      redirect: "error",
      signal,
    });
  } catch {
    throw new MarketDataError("Le service de cotations Market Data est temporairement indisponible.");
  }
  if (response.status === 204) return { quotes: [], retrievedAt: Date.now() };
  if (response.status === 401 || response.status === 403) {
    throw new MarketDataError("Le fournisseur Market Data a refusé le jeton ou l’accès.");
  }
  if (response.status === 402) throw new MarketDataError("Le forfait Market Data ne permet pas l’accès au cache des cotations.");
  if (response.status === 429) throw new MarketDataError("La limite de requêtes Market Data est atteinte.");
  if (response.status !== 203) throw new MarketDataError("Market Data n’a pas retourné de snapshot en cache valide.");

  const payload = await limitedJson(response);
  const retrievedAt = Date.now();
  const validationTime = new Date(Math.max(now.getTime(), retrievedAt));
  return { quotes: readChain(payload, symbol, url, new Date(retrievedAt), validationTime, minDte, maxDte), retrievedAt };
}

function waitForChain(pending: Promise<Chain>, signal?: AbortSignal): Promise<Chain> {
  if (!signal) return pending;
  return new Promise((resolve, reject) => {
    const abort = () => reject(new MarketDataError("Lecture des cotations annulée."));
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    // A caller's cancellation must not interrupt a different caller sharing the same request.
    pending.then(
      (result) => { signal.removeEventListener("abort", abort); resolve(result); },
      (error: unknown) => { signal.removeEventListener("abort", abort); reject(error); },
    );
  });
}

export async function fetchMarketQuotes(
  symbol: string, limits: DteLimits, context: FetchContext,
): Promise<ContractQuote[]> {
  const token = process.env.MARKETDATA_API_TOKEN?.trim();
  if (!token) return [];
  const requested = symbol.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9]{0,5}(?:\.[A-Z])?$/.test(requested) || !Number.isFinite(context.now.getTime())) {
    throw new MarketDataError("Le symbole ou l’heure de recherche est invalide.");
  }
  const { minDte = defaultRiskPreferences.minDte, maxDte = defaultRiskPreferences.maxDte } = limits;
  if (!Number.isInteger(minDte) || !Number.isInteger(maxDte) || minDte < 0 || maxDte < minDte || maxDte > 730) {
    throw new MarketDataError("L’intervalle d’échéances est invalide.");
  }
  if (context.signal?.aborted) throw new MarketDataError("Lecture des cotations annulée.");
  const now = context.now;
  const session = marketSession(now);
  const close = optionTradingCutoff(session.date);
  if (!session.optionsOpen && (close === null || now.getTime() < close || now.getTime() - close > marketDataQuoteMaxAgeMs)) return [];
  const url = chainUrl(requested, minDte, maxDte);
  const credentialKey = createHash("sha256").update(token).digest("hex");
  const key = `${credentialKey}:${session.date}:${url.href}`;
  const liveCacheTime = Date.now();
  const cached = cache.get(key);
  let pending = inFlight.get(key);
  if (!pending && (!cached || cached.expiresAt <= liveCacheTime)) {
    if (inFlight.size >= maxConcurrentRequests) throw new MarketDataError("Toutes les connexions Market Data sont occupées.");
    pending = requestChain(url, token, requested, now, minDte, maxDte)
      .then((chain) => {
        for (const [entryKey, entry] of cache) {
          if (entry.expiresAt <= chain.retrievedAt) cache.delete(entryKey);
        }
        if (cache.size >= maxCacheEntries) {
          const oldest = cache.keys().next().value;
          if (oldest) cache.delete(oldest);
        }
        cache.set(key, { expiresAt: chain.retrievedAt + cacheLifetimeMs, chain });
        return chain;
      })
      .finally(() => { inFlight.delete(key); });
    inFlight.set(key, pending);
  }
  const chain = pending ? await waitForChain(pending, context.signal) : cached!.chain;
  const validationTime = new Date(Math.max(now.getTime(), chain.retrievedAt));
  return chain.quotes
    .filter((quote) => hasCurrentSession(validationTime, new Date(quote.quoteAt)) && validateQuote(quote, requested, validationTime).valid)
    .map((quote) => ({ ...quote, source: { ...quote.source } }));
}
