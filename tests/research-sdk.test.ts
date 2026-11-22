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
    expect(body).not.toHaveProperty("include");
    expect(body).not.toHaveProperty("text");
  });

  it.each([
    { label: "omitted unavailable fields", payload: { ticker: "NVDA", companyName: "NVIDIA", direction: "bullish", thesis: analysis.thesis }, expected: "completed" },
    { label: "invalid quote types", payload: { ...analysis, underlyingQuote: { price: "123", currency: "USD", source } }, expected: "failed" },
  ])("handles fenced research JSON with $label", async ({ payload, expected }) => {
    const citation = { type: "url_citation", url: secUrl, title: "SEC", start_index: 0, end_index: 10 };
    vi.stubGlobal("fetch", vi.fn<typeof globalThis.fetch>().mockResolvedValue(json({
      id: "resp_fenced", object: "response", status: "completed",
      usage: { input_tokens: 100, output_tokens: 30 },
      output: [
        { type: "web_search_call", status: "completed", id: "ws_fenced", action: { type: "search" } },
        message("final_answer", [text("```json\n" + JSON.stringify(payload) + "\n```", [citation])]),
      ],
    })));
    const result = await researchAsset({ symbol: "NVDA", mode: "quick", dataMode: "live" });
    expect(result.status).toBe(expected);
    expect(result.requestCount).toBe(1);
    if (expected === "completed") {
      expect(result.candidate).toMatchObject({ price: null, sources: [expect.objectContaining({ url: secUrl })] });
    } else {
      expect(result.error).toContain("underlyingQuote");
    }
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
