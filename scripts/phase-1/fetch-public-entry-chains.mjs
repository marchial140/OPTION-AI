import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { promisify } from 'node:util';
import { phase1Protocol } from './config.ts';

const curl = promisify(execFile);
const dayMs = 86_400_000;
const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const isoDate = (ms) => new Date(ms).toISOString().slice(0, 10);

function publicEntryRequests(candles, signalChains) {
  if (candles.s !== 'ok' || candles.t?.length !== phase1Protocol.expectedSessions) {
    throw new Error('Supply the original unadjusted AAPL candles.');
  }
  const dates = candles.t.map((epoch) => isoDate(epoch * 1000));
  const requests = [];
  for (let anchor = Date.parse(phase1Protocol.start); anchor <= Date.parse(phase1Protocol.horizon); anchor += phase1Protocol.scanEveryCalendarDays * dayMs) {
    const index = dates.findIndex((date) => date >= isoDate(anchor));
    const entryDate = dates[index + 1];
    if (index < 0 || !entryDate) break;
    const chain = signalChains.get(dates[index]);
    if (chain?.s !== 'ok') throw new Error(`Missing original signal chain on ${dates[index]}.`);
    const expiries = [...new Set(chain.expiration)].map((epoch) => isoDate(epoch * 1000)).sort();
    const strikes = [...new Set(chain.strike)].sort((a, b) => a - b).join(',');
    const url = `https://api.marketdata.app/v1/options/chain/AAPL/?date=${entryDate}&from=${expiries[0]}&to=${expiries.at(-1)}&strike=${strikes}&nonstandard=false&dateformat=unix`;
    requests.push({ entryDate, url });
  }
  if (requests.length !== phase1Protocol.expectedSignals) throw new Error('Unexpected entry schedule.');
  return requests;
}

async function readIfPresent(path) {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return null;
  }
}

async function collect() {
  const [signalCache, candlesPath, outputDirectory] = process.argv.slice(2);
  if (!signalCache || !candlesPath || !outputDirectory) {
    throw new Error('Usage: node scripts/phase-1/fetch-public-entry-chains.mjs SIGNAL_CACHE CANDLES PRIVATE_OUTPUT_DIR');
  }
  const candles = JSON.parse(await readFile(candlesPath, 'utf8'));
  const signalChains = new Map();
  for (const epoch of candles.t) {
    const date = isoDate(epoch * 1000);
    const url = `https://api.marketdata.app/v1/options/chain/AAPL/?date=${date}&nonstandard=false&dateformat=unix&dte=7-30&strikeLimit=12&limit=256`;
    const prior = await readIfPresent(join(signalCache, `${sha256(url).slice(0, 20)}.json`));
    if (prior) signalChains.set(date, JSON.parse(prior));
  }

  const requests = publicEntryRequests(candles, signalChains);
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  const usage = [];
  for (const { entryDate, url } of requests) {
    const dataPath = join(outputDirectory, `${entryDate}.json`);
    const headerPath = join(outputDirectory, `${entryDate}.headers`);
    let snapshot = await readIfPresent(dataPath);
    let headers = await readIfPresent(headerPath);
    const reused = Boolean(snapshot && headers);
    if (!reused) {
      // -q disables ~/.curlrc, so this public demo request cannot pick up a token from it.
      await curl('curl', ['-q', '--proto', '=https', '--max-time', '45', '--silent', '--show-error',
        '--dump-header', headerPath, '--output', dataPath, url]);
      [snapshot, headers] = await Promise.all([readFile(dataPath, 'utf8'), readFile(headerPath, 'utf8')]);
    }
    const status = Number([...headers.matchAll(/^HTTP\/\S+ (\d+)/gm)].at(-1)?.[1]);
    const consumed = headers.match(/^x-api-ratelimit-consumed:\s*(\d+)\s*$/im)?.[1];
    const chain = JSON.parse(snapshot);
    if (!Number.isInteger(status) || status < 200 || status >= 300 || consumed !== '0' || chain.s !== 'ok' || !chain.optionSymbol?.length) {
      throw new Error(`Public demo did not return a confirmed zero-credit chain on ${entryDate} (HTTP ${status}).`);
    }
    usage.push({ entryDate, url, status, consumed: Number(consumed), rows: chain.optionSymbol.length, sha256: sha256(snapshot), reused });
    await writeFile(join(outputDirectory, 'usage.json'), JSON.stringify(usage, null, 2) + '\n', { mode: 0o600 });
    console.log(`${entryDate}: ${chain.optionSymbol.length} rows, HTTP ${status}, ${consumed} credits${reused ? ' (reused)' : ''}`);
    if (!reused) await setTimeout(1500);
  }
}

await collect();
