import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import type { Response } from "openai/resources/responses/responses";
import { z, type ZodType, type output } from "zod";

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
  unreconciledCost?: number;
  unreconciledSearches?: number;
}

export interface BudgetHooks {
  allowRequest?: (reservation: UsageReservation) => Promise<boolean>;
  recordUsage?: (usage: ResearchUsage) => Promise<void>;
}

type ResearchErrorCode = "CONFIG" | "BUDGET" | "TIMEOUT" | "RATE_LIMIT" | "QUOTA" |
  "PROVIDER" | "SCHEMA" | "NO_SOURCES" | "CANCELLED" | "REFUSAL";

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
      uncertain: true,
    };
  }
  const data = typeof error === "object" && error !== null
    ? error as { status?: number; name?: string; code?: string; param?: string; headers?: Headers }
    : {};
  if (data.status === 429) {
    if (data.code === "insufficient_quota") {
      return { error: new ResearchError("QUOTA", "Le compte OpenAI a atteint son quota de facturation."), retry: false, uncertain: false };
    }
    const retryAfter = data.headers?.get?.("retry-after");
    const waitSeconds = retryAfter && /^\d+(?:\.\d+)?$/.test(retryAfter) ? Number(retryAfter) :
      retryAfter ? Math.max(0, (Date.parse(retryAfter) - Date.now()) / 1000) : 0;
    return {
      error: new ResearchError("RATE_LIMIT", "OpenAI limite les requêtes. Réessayez ultérieurement."),
      retry: waitSeconds <= 2,
      waitMs: Number.isFinite(waitSeconds) ? waitSeconds * 1000 : 0,
      uncertain: false,
    };
  }
  if (data.name === "APIConnectionTimeoutError" || data.name === "TimeoutError" || data.status === 408) {
    return { error: new ResearchError("TIMEOUT", "La recherche OpenAI a dépassé le délai configuré."), retry: true, uncertain: true };
  }
  const configFailures: Record<number, string> = {
    400: "OpenAI a refusé le modèle ou les paramètres de cette recherche.",
    401: "La clé API OpenAI a été refusée.",
    403: "Le projet OpenAI ne dispose pas de l’accès requis.",
    404: "Le modèle OpenAI configuré est introuvable ou inaccessible.",
    422: "OpenAI a refusé les paramètres de cette recherche.",
  };
  const configMessage = data.status === undefined ? undefined : configFailures[data.status];
  if (configMessage) {
    const safeCodes = ["model_not_found", "unsupported_parameter", "unsupported_value", "invalid_value", "invalid_request_error"];
    const safeParameters = ["model", "tools", "tools[0].type", "tools[0].filters", "tools[0].search_context_size",
      "tool_choice", "max_tool_calls", "max_output_tokens", "text.format", "text.format.schema", "include"];
    const details = [
      data.code && safeCodes.includes(data.code) ? data.code : undefined,
      data.param && safeParameters.includes(data.param) ? data.param : undefined,
    ].filter(Boolean);
    const diagnostic = data.status === 400 && details.length ? " (" + details.join(" · ") + ")" : "";
    return { error: new ResearchError("CONFIG", configMessage + diagnostic), retry: false, uncertain: false };
  }
  const serverError = data.status !== undefined && data.status >= 500;
  return {
    error: new ResearchError("PROVIDER", "Le service de recherche OpenAI est temporairement indisponible."),
    retry: data.name === "APIConnectionError" || serverError,
    uncertain: data.status === undefined || serverError,
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

function observedTokenCount(value: number | undefined) {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function completedText(response: Response) {
  if (response.status === "incomplete") {
    const limit = response.incomplete_details?.reason;
    const message = limit === "max_output_tokens"
      ? "L’analyse OpenAI a atteint le plafond de sortie configuré."
      : "OpenAI a interrompu l’analyse avant la fin.";
    throw new ResearchError("SCHEMA", message);
  }
  if (response.status !== "completed") throw new ResearchError("PROVIDER", "OpenAI n’a pas terminé l’analyse.");
  const messages = response.output.filter((item) => item.type === "message")
    .filter((item) => item.status === "completed");
  const final = messages.filter((item) => item.phase === "final_answer").at(-1) ??
    messages.filter((item) => !item.phase).at(-1);
  if (final?.content.some((block) => block.type === "refusal")) {
    throw new ResearchError("REFUSAL", "OpenAI a refusé de produire une analyse pour cette demande.");
  }
  const text = final?.content.flatMap((block) => block.type === "output_text" ? [block.text] : []).join("");
  if (!text) throw new ResearchError("SCHEMA", "OpenAI n’a pas retourné une analyse structurée complète.");
  return text;
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
  maxWebCalls?: number;
  minimalWebProbe?: boolean;
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
    baseURL: "https://api.openai.com/v1",
    maxRetries: 0,
    timeout: envInteger("AI_RESEARCH_TIMEOUT_MS", 22_000, 1_000, 55_000),
  });
  const retryMax = envInteger("AI_MAX_RETRIES", 1, 0, 2);
  const maxToolCalls = input.web ? (input.maxWebCalls ?? (input.deep ? 4 : 2)) : 0;
  const format = input.minimalWebProbe ? undefined : zodTextFormat(input.schema, input.schemaName);
  // Some models reject hosted search combined with a strict response format.
  const instructions = input.web && !input.minimalWebProbe
    ? input.instructions + "\nReturn only one JSON object matching this schema. Use null for unavailable nullable fields and [] for empty lists. Put source URLs in their designated fields. Do not add Markdown or citation markers to JSON syntax. Schema: " + JSON.stringify(format?.schema)
    : input.instructions;
  // Reserve conservatively for search context and reconcile with actual usage.
  const estimatedWebContextTokens = input.web ? (input.deep ? 20_000 : 10_000) : 0;
  const reservedTokens = Buffer.byteLength(instructions + input.input, "utf8") +
    estimatedWebContextTokens * maxToolCalls + 2_000;
  const reservation = {
    model: model.name,
    requestType: input.type,
    estimatedCost: computeCost(pricing, reservedTokens, input.maxOutputTokens, maxToolCalls),
    estimatedSearches: maxToolCalls,
  };
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
        ...(input.minimalWebProbe ? {} : { instructions }),
        input: input.input,
        store: false,
        max_output_tokens: input.maxOutputTokens,
        ...(!input.web && format ? { text: { format } } : {}),
        ...(input.web ? {
          tools: [{ type: "web_search" }],
          tool_choice: "required" as const,
          max_tool_calls: maxToolCalls,
        } : {}),
      }, { signal: input.signal });
    } catch (error) {
      failure = classifyProviderError(error, input.signal);
    }

    const observedInput = observedTokenCount(response?.usage?.input_tokens);
    const observedOutput = observedTokenCount(response?.usage?.output_tokens);
    const inputTokens = observedInput ?? 0;
    const outputTokens = observedOutput ?? 0;
    const hasOutput = Boolean(response && Array.isArray(response.output));
    const searchUsage = response && hasOutput ? countSearches(response) : 0;
    const usageAvailable = observedInput !== null && observedOutput !== null && hasOutput;
    const estimatedCost = computeCost(pricing, inputTokens, outputTokens, searchUsage);
    const uncertain = Boolean(response ? !usageAvailable : failure?.uncertain);
    const usage: ResearchUsage = {
      model: model.name,
      requestType: input.type,
      inputTokens,
      outputTokens,
      searchUsage,
      estimatedCost,
      createdAt: new Date().toISOString(),
      usageAvailable,
      ...(uncertain ? {
        unreconciledCost: Number(Math.max(reservation.estimatedCost - estimatedCost, 0).toFixed(8)),
        unreconciledSearches: hasOutput ? 0 : Math.max(maxToolCalls - searchUsage, 0),
      } : {}),
    };
    input.usages.push(usage);
    await input.hooks?.recordUsage?.(usage);
    if (!failure) break;
    if (!failure.retry || retry === retryMax || input.usages.length >= input.maxRequests) throw failure.error;
    const waitMs = Math.max(200 * 2 ** retry, failure.waitMs ?? 0);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }

  if (!response || !Array.isArray(response.output)) throw new ResearchError("SCHEMA", "OpenAI a retourné une réponse incomplète.");
  const text = completedText(response);
  if (input.web && !response.output.some((item) =>
    item.type === "web_search_call" && item.action.type === "search" && item.status === "completed",
  )) {
    throw new ResearchError("NO_SOURCES", "La recherche Web n’a retourné aucune source exploitable.");
  }

  if (input.minimalWebProbe) return { data: input.schema.parse(text), response };

  let json: unknown;
  try {
    const fenced = input.web ? /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/i.exec(text.trim()) : null;
    json = JSON.parse(fenced?.[1] ?? text);
  } catch {
    throw new ResearchError("SCHEMA", "OpenAI a retourné une réponse illisible.");
  }
  const parsed = input.schema.safeParse(json);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.flatMap(({ path }) =>
      typeof path[0] === "string" ? [path[0]] : [],
    ))].slice(0, 4);
    const detail = fields.length ? ` Champs à vérifier : ${fields.join(", ")}.` : "";
    throw new ResearchError("SCHEMA", "La réponse OpenAI ne respecte pas le format de recherche." + detail);
  }
  return { data: parsed.data, response };
}


export async function testOpenAIConnection(hooks: BudgetHooks, signal?: AbortSignal) {
  const usages: ResearchUsage[] = [];
  const schema = z.string().trim().min(1);
  let error: ResearchError | undefined;
  try {
    await openAIRequest({
      type:"screen", instructions:"", input:"Find the title of the official OpenAI API documentation.",
      schema, schemaName:"connection_test", web:true, minimalWebProbe:true,
      maxWebCalls:1, maxOutputTokens:256, maxRequests:1, usages, hooks, signal,
    });
  } catch (failure) {
    if (!(failure instanceof ResearchError)) throw failure;
    error = failure;
  }
  const usage = usages[0];
  return {
    ok:!error, message:error?.message ?? "Connexion OpenAI et recherche Web vérifiées.",
    estimatedCost:usage?.usageAvailable ? usage.estimatedCost : null,
    unreconciledCost:usage?.unreconciledCost ?? null,
  };
}
