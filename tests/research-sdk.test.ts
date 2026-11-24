import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { researchAsset } from "../src/lib/server/research";

const secUrl = "https://www.sec.gov/Archives/edgar/data/1045810/nvda.htm";
const issuerUrl = "https://investor.nvidia.com/news/announcements/default.aspx";
const source = { url: secUrl, publishedAt: "2026-11-19T16:00:00.000Z" };
const analysis = {
  ticker: "NVDA", companyName: "NVIDIA", direction: "bullish",
  thesis: { text: "Les investissements soutiennent une thèse haussière conditionnelle.", source },
  bullishFactors: [{ text: "Les annonces renforcent les perspectives de demande.", source }],
  bearishFactors: [], eventRisks: [], sectorRisks: [], volatilityContext: null, news: [],
  uncertainty: [], earnings: null, underlyingQuote: null,
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function message(phase: "commentary" | "final_answer", content: unknown[]) {
  return { id: "response-message-" + phase, type: "message", role: "assistant", phase, status: "completed", content };
}

function text(text: string, annotations: unknown[] = []) {
  return { type: "output_text", text, annotations };
}

describe("official SDK request and response contract", () => {
  beforeEach(() => {
    vi.stubEnv("OPENAI_API_KEY", "local-test-secret");
    vi.stubEnv("OPENAI_BASE_URL", "https://override.invalid");
    vi.stubEnv("OPENAI_MODEL", "configured-test-model");
    vi.stubEnv("OPENAI_DEEP_MODEL", "");
    vi.stubEnv("AI_INPUT_USD_PER_MILLION", "1");
    vi.stubEnv("AI_OUTPUT_USD_PER_MILLION", "2");
    vi.stubEnv("AI_SEARCH_USD_PER_CALL", "0.01");
    vi.stubEnv("AI_MAX_RETRIES", "0");
    vi.stubEnv("AI_MAX_CALLS_PER_TICKER", "3");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("serializes search-compatible Responses parameters and reads final JSON separately from commentary", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json({
      id: "resp_wire_test", object: "response", status: "completed",
      usage: { input_tokens: 100, output_tokens: 30 },
      output: [
        { type: "web_search_call", status: "completed", id: "ws_wire", action: {
          type: "search", queries: ["NVDA official filing"],
        } },
        message("commentary", [text("Vérification des références en cours.", [{
          type: "url_citation", url: issuerUrl, title: "Page de l’émetteur", start_index: 0, end_index: 10,
        }])]),
        message("final_answer", [text(JSON.stringify(analysis), [{
          type: "url_citation", url: secUrl, title: "Rapport d’émetteur", start_index: 0, end_index: 10,
        }])]),
      ],
    }));
    vi.stubGlobal("fetch", fetch);

    const result = await researchAsset({ symbol: "NVDA", mode: "quick", dataMode: "live" });
    expect(result).toMatchObject({ status: "completed", requestCount: 1, estimatedCost: 0.01016 });
    expect(result.candidate?.sources).toEqual([
      expect.objectContaining({ url: secUrl, publisher: "SEC", citation: "Rapport d’émetteur" }),
    ]);
    expect(result.candidate?.sources[0]?.publishedAt).toBeUndefined();
    expect(result.examinedSources?.map(({ url }) => url)).toEqual([secUrl]);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, options] = fetch.mock.calls[0];
    expect(String(url)).toBe("https://api.openai.com/v1/responses");
    expect(options?.method).toBe("POST");
    expect(new Headers(options?.headers).get("Authorization")).toBe("Bearer local-test-secret");
    const body = JSON.parse(String(options?.body));
    expect(body).toMatchObject({
      model: "configured-test-model",
      store: false,
      tool_choice: "required",
      max_tool_calls: 2,
      instructions: expect.stringContaining('"underlyingQuote"'),
    });
    expect(body.tools).toEqual([{ type: "web_search" }]);
    expect(body.include).toEqual(["web_search_call.action.sources"]);
    expect(body).not.toHaveProperty("text");
  });

  it.each([
    { label: "fenced JSON between prose and a citation", format: (body: string) => "Analyse NVDA\n\n```json\n" + body + "\n```\n\nSource : SEC", expected: "completed" },
    { label: "bare JSON between prose and a citation", format: (body: string) => "Analyse NVDA\n" + body + "\nSource : SEC", expected: "completed" },
    { label: "duplicate JSON", format: (body: string) => body + "\n" + body, expected: "completed" },
    { label: "equivalent fenced and bare JSON", format: (body: string) => "```json\n" + body + "\n```\n" + JSON.stringify({
      direction: "bullish", companyName: "NVIDIA", ticker: " nvda ", thesis: analysis.thesis, news: [],
    }), expected: "completed" },
    { label: "a schema example beside the analysis", format: (body: string) => '{"ticker":"NVDA","type":"example"}\n' + body, expected: "completed" },
    { label: "another symbol beside the analysis", format: (body: string) => JSON.stringify([{
      ...analysis, ticker: "AMD", direction: "bearish",
    }, JSON.parse(body)]), expected: "completed" },
    { label: "one relevant object with escaped quotation marks and braces", format: (body: string) => "Intro {reference}\n" +
      JSON.stringify({ ...JSON.parse(body), thesis: { text: 'L’annonce « produit » est un "catalyseur {conditionnel}".', source } }),
    expected: "completed" },
    { label: "no matching symbol", format: () => JSON.stringify({ ...analysis, ticker: "AMD" }), expected: "failed", field: "ne correspond au symbole demandé" },
    { label: "too many objects", format: (body: string) => Array(33).fill(body).join("\n"), expected: "failed", field: "trop d’objets" },
    { label: "a missing array value", format: (body: string) => body.slice(0, -1) + ',"news":[,]}', expected: "failed", field: "plafond de requêtes par symbole" },
    { label: "invalid quote types", format: () => JSON.stringify({ ...analysis, underlyingQuote: { price: "123", currency: "USD", source } }), expected: "failed", field: "underlyingQuote" },
  ])("validates $label", async ({ format, expected, field }) => {
    const payload = { ticker: "NVDA", companyName: "NVIDIA", direction: "bullish", thesis: analysis.thesis };
    const citation = { type: "url_citation", url: secUrl, title: "SEC", start_index: 0, end_index: 10 };
    vi.stubGlobal("fetch", vi.fn<typeof globalThis.fetch>().mockResolvedValue(json({
      id: "resp_fenced", object: "response", status: "completed",
      usage: { input_tokens: 100, output_tokens: 30 },
      output: [
        { type: "web_search_call", status: "completed", id: "ws_fenced", action: { type: "search" } },
        message("final_answer", [text(format(JSON.stringify(payload)), [citation])]),
      ],
    })));
    const result = await researchAsset({ symbol: "NVDA", mode: "quick", dataMode: "live", maxRequests: 1 });
    expect(result.status).toBe(expected);
    expect(result.requestCount).toBe(1);
    if (expected === "completed") {
      expect(result.candidate).toMatchObject({ price: null, sources: [expect.objectContaining({ url: secUrl })] });
    } else {
      expect(result.error).toContain(field ?? "réponse illisible");
    }
  });

  it("keeps an existing more complete result that agrees with the shorter result", async () => {
    const { bullishFactors, ...shorter } = analysis;
    vi.stubGlobal("fetch", vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(json({
      status: "completed",
      usage: { input_tokens: 100, output_tokens: 30 },
      output: [
        { type: "web_search_call", status: "completed", action: { type: "search", sources: [{ type: "url", url: secUrl }] } },
        message("final_answer", [text(JSON.stringify(shorter) + "\n" + JSON.stringify(analysis))]),
      ],
    })));

    const result = await researchAsset({ symbol: "NVDA", mode: "quick", dataMode: "live", maxRequests: 1 });

    expect(result).toMatchObject({
      status: "completed", requestCount: 1, candidate: {
        direction: "bullish", bullishFactors: bullishFactors.map(({ text }) => text),
      },
    });
  });

  it("withholds conflicting answers even when only one is fenced and keeps the original sources", async () => {
    const conflicting = { ...analysis, direction: "bearish" };
    const answer = "```json\n" + JSON.stringify(analysis) + "\n```\n" + JSON.stringify(conflicting);
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(json({
      status: "completed",
      usage: { input_tokens: 100, output_tokens: 30 },
      output: [
        { type: "web_search_call", status: "completed", action: { type: "search", sources: [{ type: "url", url: secUrl }] } },
        message("final_answer", [text(answer)]),
      ],
    }));
    vi.stubGlobal("fetch", fetch);

    const result = await researchAsset({ symbol: "NVDA", mode: "quick", dataMode: "live", maxRequests: 2 });

    expect(result).toMatchObject({
      status: "failed", candidate: null, opportunities: [], requestCount: 1, estimatedCost: 0.01016,
      error: expect.stringContaining("des analyses différentes pour le même symbole"),
      examinedSources: [expect.objectContaining({ url: secUrl, publisher: "SEC" })],
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  function unreadableResearch(url = secUrl, withToolSources = false) {
    const answer = JSON.stringify(analysis).replace('"ticker":"NVDA"', '"ticker":NVDA');
    return json({
      id: "resp_unreadable", status: "completed",
      usage: { input_tokens: 100, output_tokens: 30 },
      output: [
        {
          type: "web_search_call", status: "completed", id: "ws_unreadable",
          action: { type: "search", ...(withToolSources ? { sources: [{ type: "url", url }] } : {}) },
        },
        message("final_answer", [text(answer, withToolSources ? [] : [{
          type: "url_citation", url, title: "Source originale", start_index: 0, end_index: 10,
        }])]),
      ],
    });
  }

  it("removes trailing commas locally without modifying quoted claim text", async () => {
    const claim = { text: 'Le rapport utilise le libellé « note,} ».', source };
    const body = JSON.stringify({ ...analysis, thesis: claim })
      .replace('"source":' + JSON.stringify(source) + '}', '"source":' + JSON.stringify(source) + ',}')
      .replace('],"bearishFactors"', ',],"bearishFactors"');
    const answer = "Rapport\n```json\n" + body.slice(0, -1) + ",}\n```";
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(json({
      status: "completed", usage: { input_tokens: 100, output_tokens: 30 },
      output: [
        { type: "web_search_call", status: "completed", action: { type: "search", sources: [{ type: "url", url: secUrl }] } },
        message("final_answer", [text(answer)]),
      ],
    }));
    vi.stubGlobal("fetch", fetch);

    const result = await researchAsset({ symbol: "NVDA", mode: "quick", dataMode: "live", maxRequests: 1 });

    expect(result).toMatchObject({ status: "completed", requestCount: 1, candidate: { thesis: claim.text, price: null } });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("repairs malformed research once without search and keeps only original citations", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockImplementationOnce(async (_url, options) => {
        const body = JSON.parse(String(options?.body));
        return unreadableResearch(secUrl, body.include?.includes("web_search_call.action.sources"));
      })
      .mockResolvedValueOnce(json({
        id: "resp_repair", status: "completed",
        usage: { input_tokens: 200, output_tokens: 60 },
        output: [message("final_answer", [text(JSON.stringify({
          ...analysis,
          news: [{ ...analysis.thesis, source: { url: issuerUrl } }],
        }), [{ type: "url_citation", url: issuerUrl, title: "Added during repair" }])])],
      }));
    vi.stubGlobal("fetch", fetch);
    const allowRequest = vi.fn(async () => true);
    const recordUsage = vi.fn(async () => {});

    const result = await researchAsset({
      symbol: "NVDA", mode: "quick", dataMode: "live", maxRequests: 2, allowRequest, recordUsage,
    });

    expect(result).toMatchObject({ status: "completed", requestCount: 2, estimatedCost: 0.01048, opportunities: [] });
    expect(result.candidate?.sources).toEqual([expect.objectContaining({ url: secUrl, publisher: "SEC" })]);
    expect(result.candidate?.evidence?.map(({ kind }) => kind)).toEqual(["thesis", "bullish"]);
    expect(allowRequest).toHaveBeenNthCalledWith(2, expect.objectContaining({ requestType: "screen", estimatedSearches: 0 }));
    expect(recordUsage).toHaveBeenNthCalledWith(2, expect.objectContaining({ searchUsage: 0, estimatedCost: 0.00032 }));
    expect(fetch).toHaveBeenCalledTimes(2);
    const body = JSON.parse(String(fetch.mock.calls[1][1]?.body));
    expect(body).toMatchObject({
      model: "configured-test-model", store: false,
      text: { format: { type: "json_schema", strict: true } },
    });
    expect(body).not.toHaveProperty("tools");
    expect(body).not.toHaveProperty("max_tool_calls");
    expect(body.text.format.schema.properties.bullishFactors).not.toHaveProperty("default");
    expect(JSON.parse(body.input)).toMatchObject({ sourceUrls: [secUrl], answer: expect.stringContaining('"ticker":NVDA') });
  });

  it.each([
    { label: "the request cap has been reached", maxRequests: 1, url: secUrl, budgetAllowsRepair: true, reason: "plafond de requêtes par symbole" },
    { label: "the budget denies the follow-up", maxRequests: 2, url: secUrl, budgetAllowsRepair: false, reason: "Reformatage de la réponse Web · Budget" },
    { label: "the Web response lacks a recognized source", maxRequests: 2, url: "https://example.com/nvda", budgetAllowsRepair: true, reason: "aucune source reconnue" },
  ])("makes no second request when $label", async ({ maxRequests, url, budgetAllowsRepair, reason }) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(unreadableResearch(url));
    vi.stubGlobal("fetch", fetch);
    const allowRequest = vi.fn(async () => budgetAllowsRepair).mockResolvedValueOnce(true);

    const result = await researchAsset({
      symbol: "NVDA", mode: "quick", dataMode: "live", maxRequests, allowRequest,
    });

    expect(result).toMatchObject({ status: "failed", requestCount: 1, estimatedCost: 0.01016, error: expect.stringContaining(reason) });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not retry a failed repair even when transient retries are enabled", async () => {
    vi.stubEnv("AI_MAX_RETRIES", "2");
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(unreadableResearch())
      .mockResolvedValueOnce(json({ error: { message: "temporarily unavailable" } }, 503));
    vi.stubGlobal("fetch", fetch);

    const result = await researchAsset({ symbol: "NVDA", mode: "quick", dataMode: "live", maxRequests: 3 });

    expect(result).toMatchObject({ status: "failed", requestCount: 2, error: expect.stringContaining("Reformatage de la réponse Web") });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("preserves Web sources and the retry delay when reformatting is rate-limited", async () => {
    vi.stubEnv("AI_MAX_RETRIES", "2");
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(unreadableResearch())
      .mockResolvedValueOnce(Response.json({
        error: { code: "rate_limit_exceeded", message: "Raw provider data" },
      }, { status: 429, headers: { "Retry-After": "1.25" } }));
    vi.stubGlobal("fetch", fetch);

    const result = await researchAsset({ symbol: "NVDA", mode: "quick", dataMode: "live", maxRequests: 3 });

    expect(result).toMatchObject({
      status: "failed", requestCount: 2, estimatedCost: 0.01016, candidate: null, opportunities: [],
      error: "Reformatage de la réponse Web · OpenAI limite les requêtes. Réessayez dans au moins 2 s.",
      examinedSources: [expect.objectContaining({ url: secUrl, citation: "Source originale" })],
    });
    expect(JSON.stringify(result)).not.toContain("Raw provider data");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("keeps recorded usage for provider refusals and returns a bounded error", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json({
      id: "resp_refusal", object: "response", status: "completed",
      usage: { input_tokens: 100, output_tokens: 20 },
      output: [message("final_answer", [{ type: "refusal", refusal: "A private refusal message" }])],
    }));
    vi.stubGlobal("fetch", fetch);

    const result = await researchAsset({ symbol: "NVDA", mode: "quick", dataMode: "live" });
    expect(result).toMatchObject({
      status: "failed", requestCount: 1, estimatedCost: 0.00014, error: expect.stringContaining("a refusé"),
    });
    expect(JSON.stringify(result)).not.toContain("A private refusal message");
  });

  it("does not parse intermediate commentary as a final result", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof globalThis.fetch>().mockResolvedValue(json({
      id: "resp_commentary_only", object: "response", status: "completed",
      usage: { input_tokens: 100, output_tokens: 20 },
      output: [
        { type: "web_search_call", status: "completed", id: "ws_wire", action: { type: "search", sources: [
          { type: "url", url: secUrl },
        ] } },
        message("commentary", [text(JSON.stringify(analysis))]),
      ],
    })));
    expect(await researchAsset({ symbol: "NVDA", mode: "quick", dataMode: "live" })).toMatchObject({
      status: "failed", requestCount: 1, candidate: null, error: expect.stringContaining("structurée complète"),
    });
  });
});

it("tests the connection with one hosted tool call and tracks its cost", async () => {
  const { testOpenAIConnection } = await import("../src/lib/server/researchOpenAI");
  vi.stubEnv("OPENAI_API_KEY","test-only");
  vi.stubEnv("OPENAI_MODEL","test-model");
  vi.stubEnv("AI_INPUT_USD_PER_MILLION","1");
  vi.stubEnv("AI_OUTPUT_USD_PER_MILLION","2");
  vi.stubEnv("AI_SEARCH_USD_PER_CALL","0.01");
  vi.stubEnv("AI_MAX_RETRIES","2");
  const transport = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(json({
      id:"resp_test",object:"response",status:"completed",usage:{input_tokens:100,output_tokens:20},
      output:[{type:"web_search_call",status:"completed",id:"ws_test",action:{type:"search"}},
        message("final_answer",[text("OpenAI API documentation")])],
    }))
    .mockResolvedValueOnce(json({error:{message:"Private provider payload",code:"unsupported_parameter",param:"tool_choice"}},400));
  vi.stubGlobal("fetch",transport);
  try {
    const allowRequest = vi.fn().mockResolvedValue(true);
    const recordUsage = vi.fn().mockResolvedValue(undefined);
    expect(await testOpenAIConnection({allowRequest,recordUsage})).toMatchObject({ok:true,estimatedCost:0.01014});
    expect(transport).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(String(transport.mock.calls[0][1]?.body));
    expect(payload).toEqual({
      model:"test-model", input:"Find the title of the official OpenAI API documentation.",
      store:false,max_tool_calls:1,max_output_tokens:256,tool_choice:"required",tools:[{type:"web_search"}],
    });
    const rejected = await testOpenAIConnection({allowRequest,recordUsage});
    expect(rejected).toMatchObject({ok:false,estimatedCost:null});
    expect(rejected.message).toContain("unsupported_parameter · tool_choice");
    expect(rejected.message).not.toContain("Private provider payload");
    expect(transport).toHaveBeenCalledTimes(2);
  } finally {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  }
});
