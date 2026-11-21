import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const argumentsForNext = process.argv.slice(2).flatMap((argument) =>
  argument === '--strictPort' ? [] : [argument === '--host' ? '--hostname' : argument]);
const child = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'dev', ...argumentsForNext], {
  stdio: 'inherit',
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('exit', (code) => { process.exitCode = code ?? 0; });
