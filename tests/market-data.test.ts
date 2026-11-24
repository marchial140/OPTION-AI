import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeOccSymbol } from "../src/lib/quant";
import { fetchMarketQuotes, marketDataConfigured, MarketDataError } from "../src/lib/server/marketData";

const { isExchangeListed } = vi.hoisted(() => ({ isExchangeListed: vi.fn<(symbol: string, signal?: AbortSignal) => Promise<boolean>>() }));
vi.mock("../src/lib/server/marketDirectory", () => ({ isExchangeListed }));

const symbol = "NVDA";
const now = new Date("2026-11-24T15:15:00Z");
const expiry = "2026-12-04";
const expiresAt = Date.parse(`${expiry}T21:00:00Z`) / 1000;
const snapshotAt = Date.parse("2026-11-24T15:00:00Z") / 1000;
const optionSymbol = makeOccSymbol(symbol, expiry, "call", 175);
const limits = { minDte: 7, maxDte: 30 };
let sequence = 0;

function chain(overrides: Record<string, unknown> = {}) {
  return {
    s: "ok", optionSymbol: [optionSymbol], underlying: [symbol], side: ["call"],
    expiration: [expiresAt], strike: [175], bid: [1.7], ask: [1.9], updated: [snapshotAt],
    volume: [150], openInterest: [300], ...overrides,
  };
}

function setupFetch(payload = chain(), status = 203) {
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => Response.json(payload, { status }));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

function quotes(time = now, signal?: AbortSignal) {
  return fetchMarketQuotes(symbol, limits, { now: time, signal });
}

describe("Market Data cached option chains", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    vi.stubEnv("MARKETDATA_API_TOKEN", "test-token-" + ++sequence);
    isExchangeListed.mockReset().mockResolvedValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("returns an empty result without querying any service when no token is configured", async () => {
    vi.stubEnv("MARKETDATA_API_TOKEN", "   ");
    const fetch = setupFetch();
    expect(marketDataConfigured()).toBe(false);
    await expect(quotes()).resolves.toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
    expect(isExchangeListed).not.toHaveBeenCalled();
  });

  it("requests a bounded cache-only standard chain and keeps the original snapshot time", async () => {
    const fetch = setupFetch();
    expect(marketDataConfigured()).toBe(true);
    const [quote] = await quotes();
    expect(quote).toMatchObject({
      id: optionSymbol, symbol, type: "call", expiration: expiry, strike: 175, currency: "USD",
      multiplier: 100, bid: 1.7, ask: 1.9, quoteAt: "2026-11-24T15:00:00.000Z", retrievedAt: now.toISOString(),
      volume: 150, openInterest: 300, status: "VERIFIED_DELAYED",
      source: { publisher: "Market Data", method: "marketdata-cached" },
    });
    expect(isExchangeListed).toHaveBeenCalledWith(symbol, expect.any(AbortSignal));
    expect(fetch).toHaveBeenCalledTimes(1);
    const url = new URL(String(fetch.mock.calls[0][0]));
    expect(url.origin + url.pathname).toBe("https://api.marketdata.app/v1/options/chain/NVDA/");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      mode: "cached", maxage: "30min", nonstandard: "false", dateformat: "unix", dte: "7-30", strikeLimit: "12", limit: "256",
    });
    expect(fetch.mock.calls[0][1]).toMatchObject({
      cache: "no-store", redirect: "error",
      headers: { Authorization: "Bearer test-token-" + sequence, Accept: "application/json" },
    });
    expect(quote.source.url).toBe(url.href);
    expect(quote.source.url).not.toContain("test-token");
  });

  it("classifies even a recently observed cached quote as delayed", async () => {
    setupFetch(chain({ updated: [Date.parse("2026-11-24T15:14:00Z") / 1000] }));
    expect((await quotes())[0]).toMatchObject({ status: "VERIFIED_DELAYED" });
  });

  it("skips absent equity/ETF symbols and directory failures", async () => {
    const fetch = setupFetch();
    isExchangeListed.mockResolvedValueOnce(false).mockRejectedValueOnce(new Error("raw directory error"));
    await expect(quotes()).rejects.toThrow("action ou un FNB américain");
    await expect(quotes()).rejects.toThrow("classification boursière");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("skips weekends before retrieving the directory or contacting the provider", async () => {
    const fetch = setupFetch();
    await expect(quotes(new Date("2026-11-28T15:15:00Z"))).resolves.toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
    expect(isExchangeListed).not.toHaveBeenCalled();
  });

  it("returns a cache miss without asking for a live chain", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetch);
    await expect(quotes()).resolves.toEqual([]);
    await expect(quotes()).resolves.toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    { status: 401, message: "refusé le jeton" },
    { status: 402, message: "forfait Market Data" },
    { status: 429, message: "limite de requêtes" },
    { status: 200, message: "snapshot en cache valide" },
  ])("reports a bounded diagnostic for provider status $status", async ({ status, message }) => {
    const fetch = setupFetch(chain({ errmsg: "confidential provider details" }), status);
    const error = await quotes().catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(MarketDataError);
    expect(String(error)).toContain(message);
    expect(String(error)).not.toContain("confidential provider details");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    { name: "another underlying", row: { underlying: ["AMD"] } },
    { name: "an adjusted OCC root", row: { optionSymbol: ["NVDA1" + optionSymbol.slice(4)] } },
    { name: "a mismatched option type", row: { side: ["put"] } },
    { name: "an unsupported expiry settlement time", row: { expiration: [expiresAt - 31 * 60] } },
    { name: "a crossed quote", row: { bid: [3] } },
    { name: "an absent ask", row: { ask: [null] } },
    { name: "an invalid price type", row: { ask: ["1.90"] } },
    { name: "a stale snapshot", row: { updated: [snapshotAt - 16 * 60] } },
    { name: "a future snapshot", row: { updated: [now.getTime() / 1000 + 1] } },
  ])("rejects $name", async ({ row }) => {
    setupFetch(chain(row));
    await expect(quotes()).resolves.toEqual([]);
  });

  it("rejects an out-of-session timestamp even if it is only minutes old", async () => {
    const opening = new Date("2026-11-24T14:35:00Z");
    vi.setSystemTime(opening);
    setupFetch(chain({ updated: [Date.parse("2026-11-24T14:29:00Z") / 1000] }));
    await expect(quotes(opening)).resolves.toEqual([]);
  });

  it("accepts the closing snapshot on an early-close day", async () => {
    const early = new Date("2026-11-27T18:12:00Z");
    vi.setSystemTime(early);
    setupFetch(chain({ updated: [Date.parse("2026-11-27T18:00:00Z") / 1000] }));
    await expect(quotes(early)).resolves.toEqual([expect.objectContaining({ quoteAt: "2026-11-27T18:00:00.000Z" })]);
  });

  it("revalidates the requested DTE range rather than relying only on the vendor filter", async () => {
    setupFetch();
    await expect(fetchMarketQuotes(symbol, { minDte: 12, maxDte: 30 }, { now })).resolves.toEqual([]);
  });

  it("uses a bounded default DTE range and rejects reversed ranges before connecting", async () => {
    const fetch = setupFetch();
    await expect(fetchMarketQuotes(symbol, { minDte: 31, maxDte: 30 }, { now })).rejects.toThrow("intervalle");
    expect(fetch).not.toHaveBeenCalled();
    await expect(fetchMarketQuotes(symbol, {}, { now })).resolves.toHaveLength(1);
    expect(new URL(String(fetch.mock.calls[0][0])).searchParams.get("dte")).toBe("7-30");
  });

  it("rejects misaligned tables and provider bodies exceeding the configured reach", async () => {
    const fetch = setupFetch(chain({ bid: [] }));
    await expect(quotes()).rejects.toThrow("incomplète ou incohérente");
    fetch.mockImplementation(async () => Response.json(chain({ optionSymbol: Array(257).fill(optionSymbol) }), { status: 203 }));
    await expect(quotes()).rejects.toThrow("incomplète ou incohérente");
  });

  it("keeps absent liquidity fields absent and leaves valid adjacent rows usable", async () => {
    setupFetch(chain({
      optionSymbol: ["invalid", optionSymbol], underlying: [symbol, symbol], side: ["call", "call"],
      expiration: [expiresAt, expiresAt], strike: [175, 175], bid: [1.7, 1.7], ask: [1.9, 1.9],
      updated: [snapshotAt, snapshotAt], volume: [150, null], openInterest: undefined,
    }));
    const result = await quotes();
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: optionSymbol, volume: undefined, openInterest: undefined });
  });

  it("shares in-flight requests, lets callers cancel independently and refreshes after TTL", async () => {
    const fetch = setupFetch();
    const aborted = new AbortController();
    const first = quotes(now, aborted.signal);
    const second = quotes();
    aborted.abort();
    await expect(first).rejects.toThrow("annulée");
    const [quote] = await second;
    quote.source.publisher = "mutated input";
    const [cached] = await quotes();
    expect(cached.source.publisher).toBe("Market Data");
    expect(cached.retrievedAt).toBe(now.toISOString());
    expect(fetch).toHaveBeenCalledTimes(1);

    const later = new Date(now.getTime() + 31_000);
    vi.setSystemTime(later);
    await expect(quotes(later)).resolves.toEqual([expect.objectContaining({ retrievedAt: later.toISOString() })]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does not reuse a cached chain after token rotation", async () => {
    const fetch = setupFetch();
    await expect(quotes()).resolves.toHaveLength(1);
    vi.stubEnv("MARKETDATA_API_TOKEN", "test-token-rotated");
    await expect(quotes()).resolves.toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
