import { ask } from 'component:agent/host-capabilities';
import { log } from 'component:agent/host-console';

export async function runCode(code) {
  log(`[Agent] Evaluating code length: ${code.length}`);
  try {
    // 1. Basic Eval
    // In a real scenario, we might want to wrap this in a function to isolate scope slightly,
    // but the Wasm boundary already provides strong isolation.
    const result = await eval(`(async () => { ${code} })()`);

    return String(result);
  } catch (e) {
    log(`[Agent] Error: ${e.message}`);
    return `Error: ${e.message}`;
  }
}