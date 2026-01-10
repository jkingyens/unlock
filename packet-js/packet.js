import { log } from 'component:quest-v1/host-console';
import { registerTask, updateTask, notifyPlayer } from 'component:quest-v1/host-quest-manager';
import { registerItem } from 'component:quest-v1/host-content';

export function init() {
  // Register the google.com page as a visitable item
  registerItem("google-item", "https://google.com", "Visit Google", "webpage");

  // Register the "Visit Google" task
  registerTask("quest-1", "task-1", "Visit https://google.com");
  notifyPlayer("Quest Started: Visit Google!");
}

export function onVisit(url) {
  if (url.includes("google.com")) {
    updateTask("quest-1", "task-1", "completed");
    notifyPlayer("Task Complete: You visited Google!");
  }
}

export async function run(code) {
  // The 'init' command is now handled by the exported 'init' function.
  // This 'run' function is for evaluating arbitrary code.
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