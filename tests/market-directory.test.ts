import { afterEach, beforeEach, expect, it, vi } from "vitest";

const origin = "https://www.nasdaqtrader.com/dynamic/SymDir/";
const nasdaq = [
  "Symbol|Security Name|Test Issue",
  "AMD|Advanced Micro Devices|N",
  "ZZTEST|Test security|Y",
  "File Creation Time: 1124202612:00||",
].join("\n");
const others = [
  "ACT Symbol|CQS Symbol|NASDAQ Symbol|Test Issue",
  "SPY|SPY|SPY|N",
  "BRK.B|BRK.B|BRK-B|N",
  "File Creation Time: 1124202612:00|||",
].join("\n");

beforeEach(() => vi.resetModules());
afterEach(() => vi.unstubAllGlobals());

it("shares a catalog refresh and recognizes listed tickers and documented aliases", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(new Response(nasdaq))
    .mockResolvedValueOnce(new Response(others));
  vi.stubGlobal("fetch", fetch);
  const { isExchangeListed } = await import("../src/lib/server/marketDirectory");

  await expect(Promise.all([
    isExchangeListed("AMD"), isExchangeListed("SPY"), isExchangeListed("BRK-B"),
    isExchangeListed("SPX"), isExchangeListed("ZZTEST"), isExchangeListed("BRK.B"),
  ])).resolves.toEqual([true, true, true, false, false, true]);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(fetch).toHaveBeenCalledWith(origin + "nasdaqlisted.txt", expect.objectContaining({ redirect: "error" }));
  expect(fetch).toHaveBeenCalledWith(origin + "otherlisted.txt", expect.objectContaining({ redirect: "error" }));
});

it("fails closed if a directory response is malformed and shares the failure cooldown", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(new Response(nasdaq))
    .mockResolvedValueOnce(new Response(others.replace(/File Creation Time:.*/u, "")));
  vi.stubGlobal("fetch", fetch);
  const { isExchangeListed, MarketDirectoryError } = await import("../src/lib/server/marketDirectory");

  await expect(isExchangeListed("AMD")).rejects.toBeInstanceOf(MarketDirectoryError);
  await expect(isExchangeListed("SPY")).rejects.toBeInstanceOf(MarketDirectoryError);
  expect(fetch).toHaveBeenCalledTimes(2);
});
