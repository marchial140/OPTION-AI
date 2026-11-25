import { parseArgs } from 'node:util';
import './phase-1-replay.mjs';

try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    private: { type: 'string', default: 'work/phase-3' },
    approval: { type: 'string', default: 'approval.json' },
    'licensed-index': { type: 'string', default: 'licensed-index.json' },
  } });
  if (positionals.length !== 1) throw new Error('Use manifest, cost, fingerprints, acquire-candles, prepare-chains, acquire-chains, or validate.');
  const { runPhase3 } = await import('./phase-3/command.ts');
  const result = await runPhase3(positionals[0], {
    privateDirectory: values.private, approvalFile: values.approval, licensedIndex: values['licensed-index'],
    token: process.env.MARKETDATA_API_TOKEN,
  });
  console.log(JSON.stringify(result, null, 2));
  if (result.status === 'blocked') process.exitCode = 2;
} catch (error) {
  console.error(error?.retryAt ? `${error.message} Resume after ${error.retryAt}.` : error instanceof Error ? error.message : 'Phase 3 command failed.');
  process.exitCode = 1;
}
