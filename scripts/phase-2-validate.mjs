// Reuse the offline TypeScript resolver without starting the Phase 1 CLI.
import './phase-1-replay.mjs';

const { runNumericalValidation, runStressValidation } = await import('./phase-2/validation.ts');
const output = { ...runNumericalValidation(), stress: runStressValidation() };
console.log(JSON.stringify(output, null, 2));
