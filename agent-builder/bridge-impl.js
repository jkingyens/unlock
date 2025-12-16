const bridge = globalThis.JCO_BRIDGE;

export const ask = async (prompt) => {
  if (!bridge) throw new Error("Global JCO_BRIDGE not found");
  return await bridge.ask(prompt);
};

export const log = (msg) => {
  if (bridge) bridge.log(msg);
};