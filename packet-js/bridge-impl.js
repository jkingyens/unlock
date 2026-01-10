const bridge = globalThis.JCO_BRIDGE;

export const ask = async (prompt) => {
  if (!bridge) throw new Error("Global JCO_BRIDGE not found");
  return await bridge.ask(prompt);
};

export const log = (msg) => {
  if (bridge) bridge.log(msg);
};

// Quest API exports
export const registerTask = (id, title, desc) => {
  if (bridge && bridge.quest) return bridge.quest.registerTask(id, title, desc);
};

export const updateTask = (id, taskId, status) => {
  if (bridge && bridge.quest) return bridge.quest.updateTask(id, taskId, status);
};

export const notifyPlayer = (message) => {
  if (bridge && bridge.quest) return bridge.quest.notifyPlayer(message);
};

export const getCurrentUrl = () => {
  if (bridge && bridge.quest) return bridge.quest.getCurrentUrl();
};

export const registerItem = (id, url, title, type) => {
  if (bridge && bridge.quest) return bridge.quest.registerItem(id, url, title, type);
};