import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import type { Response } from "openai/resources/responses/responses";
import type { ZodType, output } from "zod";

export type ResearchRequestType = "screen" | "contract" | "chat";

export interface UsageReservation {
  model: string;
  requestType: ResearchRequestType;
  estimatedCost: number;
  estimatedSearches?: number;
}

export interface ResearchUsage extends UsageReservation {
  inputTokens: number;
  outputTokens: number;
  searchUsage: number;
  createdAt: string;
  usageAvailable?: boolean;
}

export interface BudgetHooks {
  allowRequest?: (reservation: UsageReservation) => Promise<boolean>;
  recordUsage?: (usage: ResearchUsage) => Promise<void>;
}

type ResearchErrorCode = "CONFIG" | "BUDGET" | "INPUT" | "TIMEOUT" | "RATE_LIMIT" |
  "PROVIDER" | "SCHEMA" | "NO_SOURCES" | "CANCELLED";

export class ResearchError extends Error {
  constructor(readonly code: ResearchErrorCode, message: string) {
    super(message);
    this.name = "ResearchError";
  }
}

interface Pricing {
  input: number;
  output: number;
  search: number;
}

interface ModelConfig {
  name: string;
  pricing: Pricing | null;
}

function envNumber(name: string): number | null {
  const raw = process.env[name]?.trim();
  if (!raw) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function envInteger(name: string, fallback: number, min: number, max: number) {
  const value = envNumber(name);
  return value !== null && Number.isInteger(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

function configuredModel(deep = false): ModelConfig {
  const baseModel = process.env.OPENAI_MODEL?.trim() ?? "";
  const deepModel = deep ? process.env.OPENAI_DEEP_MODEL?.trim() : undefined;
  const prefix = deepModel ? "AI_DEEP_" : "AI_";
  const input = envNumber(`${prefix}INPUT_USD_PER_MILLION`);
  const output = envNumber(`${prefix}OUTPUT_USD_PER_MILLION`);
  const search = envNumber("AI_SEARCH_USD_PER_CALL");
  return {
    name: deepModel || baseModel,
    pricing: input !== null && output !== null && search !== null ? { input, output, search } : null,
  };
}

export function researchHealth() {
  const model = configuredModel();
  const deep = configuredModel(true);
  const hasKey = Boolean(process.env.OPENAI_API_KEY?.trim());
  return {
    configured: hasKey && Boolean(model.name) && Boolean(model.pricing),
    model: model.name || undefined,
    deepModel: deep.name || undefined,
    webSearch: hasKey && Boolean(model.name) && Boolean(model.pricing),
    pricingConfigured: Boolean(model.pricing),
  };
}

export function defaultRequestLimit() {
  return envInteger("AI_MAX_CALLS_PER_TICKER", 3, 1, 5);
}

export function researchSignal(signal?: AbortSignal) {
  const deadline = AbortSignal.timeout(95_000);
  return signal ? AbortSignal.any([signal, deadline]) : deadline;
}

export function usageTotals(usages: ResearchUsage[]) {
  return {
    requestCount: usages.length,
    estimatedCost: Number(usages.reduce((sum, item) => sum + item.estimatedCost, 0).toFixed(8)),
  };
}

function computeCost(pricing: Pricing, inputTokens: number, outputTokens: number, searchUsage: number) {
  return Number(((inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000 +
    searchUsage * pricing.search).toFixed(8));
}

function classifyProviderError(error: unknown, signal?: AbortSignal) {
  if (signal?.aborted) {
    const timedOut = signal.reason?.name === "TimeoutError";
    return {
      error: timedOut
        ? new ResearchError("TIMEOUT", "Le délai total de cette recherche est atteint.")
        : new ResearchError("CANCELLED", "Recherche annulée."),
      retry: false,
    };
  }
  const data = typeof error === "object" && error !== null ? error as { status?: number; name?: string } : {};
  if (data.status === 429) return { error: new ResearchError("RATE_LIMIT", "OpenAI limite les requêtes. Réessayez ultérieurement."), retry: true };
  if (data.name === "APIConnectionTimeoutError" || data.name === "TimeoutError" || data.status === 408) {
    return { error: new ResearchError("TIMEOUT", "La recherche OpenAI a dépassé le délai configuré."), retry: true };
  }
  if (data.status === 401 || data.status === 403 || data.status === 404 || data.status === 400) {
    return { error: new ResearchError("CONFIG", "OpenAI a refusé la configuration, le modèle ou la recherche Web."), retry: false };
  }
  return {
    error: new ResearchError("PROVIDER", "Le service de recherche OpenAI est temporairement indisponible."),
    retry: data.name === "APIConnectionError" || (data.status !== undefined && data.status >= 500),
  };
}

export function researchErrorMessage(error: unknown) {
  return error instanceof ResearchError ? error.message : "La recherche n’a pas pu être terminée.";
}

function countSearches(response: Response) {
  // OpenAI's web-search guide identifies search actions as the billable calls.
  // The remaining actions still count against the Responses API max_tool_calls.
  return response.output.filter((item) => item.type === "web_search_call" && item.action.type === "search").length;
}

interface RequestInput<Schema extends ZodType> {
  type: ResearchRequestType;
  instructions: string;
  input: string;
  schema: Schema;
  schemaName: string;
  deep?: boolean;
  web: boolean;
  maxOutputTokens: number;
  maxRequests: number;
  hooks?: BudgetHooks;
  signal?: AbortSignal;
  usages: ResearchUsage[];
}

export async function openAIRequest<Schema extends ZodType>(
  input: RequestInput<Schema>,
): Promise<{ data: output<Schema>; response: Response }> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  const model = configuredModel(input.deep);
  const pricing = model.pricing;
  if (!apiKey || !model.name || !pricing) {
    throw new ResearchError("CONFIG", "Configurez la clé OpenAI, le modèle et les tarifs estimatifs côté serveur.");
  }
  const client = new OpenAI({
    apiKey,
    maxRetries: 0,
    timeout: envInteger("AI_RESEARCH_TIMEOUT_MS", 22_000, 1_000, 55_000),
  });
  const retryMax = envInteger("AI_MAX_RETRIES", 1, 0, 2);
  const maxToolCalls = input.web ? (input.deep ? 4 : 2) : 0;
  // Search context size is advisory. Reserve conservatively and reconcile with actual usage.
  const estimatedWebContextTokens = input.web ? (input.deep ? 20_000 : 10_000) : 0;
  const reservedTokens = Buffer.byteLength(input.instructions + input.input, "utf8") +
    estimatedWebContextTokens * maxToolCalls + 2_000;
  const reservation = {
    model: model.name,
    requestType: input.type,
    estimatedCost: computeCost(pricing, reservedTokens, input.maxOutputTokens, maxToolCalls),
    estimatedSearches: maxToolCalls,
  };
  const format = zodTextFormat(input.schema, input.schemaName);
  let response: Response | undefined;

  for (let retry = 0; retry <= retryMax; retry += 1) {
    if (input.signal?.aborted) throw classifyProviderError(input.signal.reason, input.signal).error;
    if (input.usages.length >= input.maxRequests) {
      throw new ResearchError("BUDGET", "Plafond de requêtes de cette recherche atteint.");
    }
    if (input.hooks?.allowRequest && !await input.hooks.allowRequest(reservation)) {
      throw new ResearchError("BUDGET", "Budget de recherche épuisé pour cette période.");
    }

    let failure: ReturnType<typeof classifyProviderError> | undefined;
    try {
      response = await client.responses.create({
        model: model.name,
        instructions: input.instructions,
        input: input.input,
        store: false,
        max_output_tokens: input.maxOutputTokens,
        text: { format },
        ...(input.web ? {
          tools: [{ type: "web_search", search_context_size: input.deep ? "medium" : "low" }],
          tool_choice: "required" as const,
          include: ["web_search_call.action.sources"],
          max_tool_calls: maxToolCalls,
        } : {}),
      }, { signal: input.signal });
    } catch (error) {
      failure = classifyProviderError(error, input.signal);
    }

    const inputTokens = response?.usage?.input_tokens ?? 0;
    const outputTokens = response?.usage?.output_tokens ?? 0;
    const searchUsage = response ? countSearches(response) : 0;
    const usage: ResearchUsage = {
      model: model.name,
      requestType: input.type,
      inputTokens,
      outputTokens,
      searchUsage,
      estimatedCost: computeCost(pricing, inputTokens, outputTokens, searchUsage),
      createdAt: new Date().toISOString(),
      usageAvailable: Boolean(response?.usage),
    };
    input.usages.push(usage);
    await input.hooks?.recordUsage?.(usage);
    if (!failure) break;
    if (!failure.retry || retry === retryMax || input.usages.length >= input.maxRequests) throw failure.error;
    await new Promise((resolve) => setTimeout(resolve, 200 * 2 ** retry));
  }

  if (!response || response.status !== "completed" || !response.output_text) {
    throw new ResearchError("SCHEMA", "OpenAI n’a pas retourné une analyse structurée complète.");
  }
  if (input.web && !response.output.some((item) =>
    item.type === "web_search_call" && item.action.type === "search" && item.status === "completed",
  )) {
    throw new ResearchError("NO_SOURCES", "La recherche Web n’a retourné aucune source exploitable.");
  }

  let json: unknown;
  try {
    json = JSON.parse(response.output_text);
  } catch {
    throw new ResearchError("SCHEMA", "OpenAI a retourné une réponse illisible.");
  }
  const parsed = input.schema.safeParse(json);
  if (!parsed.success) throw new ResearchError("SCHEMA", "La réponse OpenAI ne respecte pas le format de recherche.");
  return { data: parsed.data, response };
}
