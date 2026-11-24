const directoryOrigin = "https://www.nasdaqtrader.com";
const directoryPath = "/dynamic/SymDir/";
const directoryFiles = [
  { file: "nasdaqlisted.txt", primary: "SYMBOL", aliases: [] },
  { file: "otherlisted.txt", primary: "ACT SYMBOL", aliases: ["CQS SYMBOL", "NASDAQ SYMBOL"] },
] as const;
const snapshotLifetimeMs = 30 * 60_000;
const failureCooldownMs = 30_000;
const requestTimeoutMs = 8_000;
const fileByteLimit = 2 * 1024 * 1024;

type DirectoryFile = typeof directoryFiles[number];
type Snapshot = { symbols: ReadonlySet<string>; expiresAt: number };

let snapshot: Snapshot | undefined;
let unavailable: { error: MarketDirectoryError; expiresAt: number } | undefined;
let pending: Promise<Snapshot> | undefined;

export class MarketDirectoryError extends Error {
  constructor(options?: ErrorOptions) {
    super("Le répertoire des titres cotés est temporairement indisponible.", options);
    this.name = "MarketDirectoryError";
  }
}

function normalizeSymbol(value: string) {
  const symbol = value.trim().toUpperCase();
  return symbol.length <= 14 && /^[A-Z][A-Z0-9]*(?:[.-][A-Z0-9]+)*$/u.test(symbol) ? symbol : null;
}

async function readText(response: Response) {
  const length = response.headers.get("content-length");
  if (!response.body || (length !== null && (!/^\d+$/u.test(length) || Number(length) > fileByteLimit))) {
    throw new Error("Invalid symbol directory content length");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let output = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) return output + decoder.decode();
      bytes += chunk.value.byteLength;
      if (bytes > fileByteLimit) throw new Error("Symbol directory exceeds the byte limit");
      output += decoder.decode(chunk.value, { stream: true });
    }
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

function parseDirectory(text: string, file: DirectoryFile) {
  const [rawHeader, ...rows] = text.trimEnd().split(/\r?\n/u);
  const headers = rawHeader.split("|").map((field) => field.trim().toUpperCase());
  const testColumn = headers.indexOf("TEST ISSUE");
  const symbolColumn = headers.indexOf(file.primary);
  if (testColumn < 0 || symbolColumn < 0 || new Set(headers).size !== headers.length) {
    throw new Error("Invalid symbol directory header");
  }
  const footer = rows.pop() ?? "";
  if (!/^File Creation Time:\s*\d{10}:?\d{2}\|*$/u.test(footer)) {
    throw new Error("Missing symbol directory footer");
  }

  // Nasdaq's directory explicitly binds these aliases. Do not synthesize
  // dot/dash forms, since a dash can identify a preferred issue.
  const indexes = [symbolColumn, ...file.aliases.map((field) => headers.indexOf(field)).filter((index) => index >= 0)];
  const symbols = new Set<string>();
  for (const row of rows) {
    const cells = row.split("|");
    const test = cells[testColumn]?.trim();
    if (cells.length !== headers.length || (test !== "N" && test !== "Y")) {
      throw new Error("Invalid symbol directory record");
    }
    if (test === "Y") continue;
    for (const index of indexes) {
      const symbol = normalizeSymbol(cells[index]);
      if (symbol) symbols.add(symbol);
    }
  }
  if (!symbols.size) throw new Error("Empty symbol directory");
  return symbols;
}

async function fetchDirectory(file: DirectoryFile, signal: AbortSignal) {
  const url = directoryOrigin + directoryPath + file.file;
  const response = await fetch(url, {
    headers: { Accept: "text/plain" },
    cache: "no-store",
    redirect: "error",
    signal,
  });
  const mediaType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (!response.ok || response.redirected || (response.url && response.url !== url) || mediaType !== "text/plain") {
    void response.body?.cancel().catch(() => {});
    throw new Error("Untrusted symbol directory response");
  }
  return parseDirectory(await readText(response), file);
}

async function refreshDirectory(): Promise<Snapshot> {
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(requestTimeoutMs)]);
  try {
    const lists = await Promise.all(directoryFiles.map((file) => fetchDirectory(file, signal)));
    const symbols = new Set(lists.flatMap((list) => [...list]));
    snapshot = { symbols, expiresAt: Date.now() + snapshotLifetimeMs };
    unavailable = undefined;
    return snapshot;
  } catch (cause) {
    const error = new MarketDirectoryError({ cause });
    unavailable = { error, expiresAt: Date.now() + failureCooldownMs };
    throw error;
  } finally {
    controller.abort();
  }
}

function currentDirectory() {
  const now = Date.now();
  if (snapshot && snapshot.expiresAt > now) return Promise.resolve(snapshot);
  if (unavailable && unavailable.expiresAt > now) return Promise.reject(unavailable.error);
  pending ??= refreshDirectory().finally(() => { pending = undefined; });
  return pending;
}

function waitForSnapshot(task: Promise<Snapshot>, signal?: AbortSignal) {
  if (!signal) return task;
  return new Promise<Snapshot>((resolve, reject) => {
    const cancel = () => reject(signal.reason);
    signal.addEventListener("abort", cancel, { once: true });
    task.then(
      (value) => { signal.removeEventListener("abort", cancel); resolve(value); },
      (error: unknown) => { signal.removeEventListener("abort", cancel); reject(error); },
    );
    if (signal.aborted) cancel();
  });
}

export async function isExchangeListed(symbol: string, signal?: AbortSignal): Promise<boolean> {
  signal?.throwIfAborted();
  const normalized = normalizeSymbol(symbol);
  if (!normalized) return false;
  const { symbols } = await waitForSnapshot(currentDirectory(), signal);
  return symbols.has(normalized);
}
