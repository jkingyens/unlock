import { ask } from 'component:agent/host-capabilities';
import { log } from 'component:agent/host-console';

export function run() {
  log("JCO Agent: Sending prompt...");
  const answer = ask("Write a haiku about WebAssembly.");
  return "Success: " + answer;
}