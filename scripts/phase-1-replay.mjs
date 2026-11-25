import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const repo = new URL('..', import.meta.url).href;

// The app's TypeScript uses extensionless imports. This CLI reuses the same
// financial code under Node without changing the app's bundler configuration.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.startsWith(repo) && specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) {
      const source = new URL(`${specifier}.ts`, context.parentURL).href;
      try {
        return nextResolve(source, context);
      } catch (error) {
        if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
      }
    }
    return nextResolve(specifier, context);
  },
});

function csv(rows) {
  const headers = Object.keys(rows[0]);
  const value = (item) => {
    if (item === null || item === undefined) return '';
    const string = String(item);
    return /[,"\r\n]/.test(string) ? `"${string.replaceAll('"', '""')}"` : string;
  };
  return `${headers.join(',')}\n${rows.map((row) => headers.map((key) => value(row[key])).join(',')).join('\n')}\n`;
}

async function writePrivateFile(path, contents) {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, contents, { mode: 0o600, flag: 'wx' });
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true });
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      cache: { type: 'string' },
      candles: { type: 'string' },
      baseline: { type: 'string' },
      'entry-dir': { type: 'string' },
      out: { type: 'string', default: 'work/phase-1' },
      plan: { type: 'string' },
      'baseline-only': { type: 'boolean' },
      'candidate-audit': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help || !values.cache || !values.candles) {
    console.log('Usage: node scripts/phase-1-replay.mjs --cache DIR --candles FILE [--baseline FILE] [--entry-dir DIR] [--out DIR] [--plan FILE] [--baseline-only] [--candidate-audit]');
    return values.help ? 0 : 2;
  }
  const { loadPhase1Inputs } = await import('./phase-1/inputs.ts');
  const { missingEntryPlan, replayPhase1 } = await import('./phase-1/replay.ts');
  const inputs = await loadPhase1Inputs({
    cacheDirectory: values.cache, candlesPath: values.candles,
    baselinePath: values.baseline, entryDirectory: values['entry-dir'],
  });
  const runs = replayPhase1(inputs, values['baseline-only']);
  const out = resolve(values.out);
  await mkdir(out, { recursive: true, mode: 0o700 });
  await writePrivateFile(resolve(out, 'phase_1_trades.csv'), csv(runs.A.trades));
  await writePrivateFile(resolve(out, 'phase_1_comparison.csv'), csv(runs.comparison));
  if (values.plan) {
    const plan = missingEntryPlan([runs.B, runs.C, ...runs.D].filter(Boolean));
    await writePrivateFile(values.plan, `${JSON.stringify(plan, null, 2)}\n`);
  }
  if (values['candidate-audit']) {
    const { runCandidateDiagnostics } = await import('./phase-1/candidate-audit.ts');
    await writePrivateFile(resolve(out, 'phase_1_candidate_diagnostics.json'), `${JSON.stringify(runCandidateDiagnostics(inputs), null, 2)}\n`);
  }
  console.table(runs.comparison.map((row) => ({
    config: row.config, status: row.status, statistic: row.statistic, selected: row.selected_signals,
    executed: row.executed_trades, netPnlUsd: row.net_pnl_usd, missingEntry: row.signals_missing_entry,
  })));
  console.log(`CSV output in ${out}`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Historical replay failed');
    process.exitCode = 1;
  }
}
