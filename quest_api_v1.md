# The Quest Engine API (v1)

## Overview
This document proposes a new **Quest Engine API** to replace the generic `run()` interface. It shifts the Agent from a passive script to an active **Dungeon Master** that manages User progress, Objectives, and Achievements.

## The Metaphor
- **The Agent**: The Dungeon Master (Game Logic).
- **The Host**: The Game Engine (UI, Persistence, Event Bus).
- **The User**: The Player.

## Core Concepts
1.  **Objectives**: High-level goals (e.g., "Complete the Onboarding").
2.  **Tasks**: Specific actionable steps (e.g., "Visit the Settings Page").
3.  **Progression**: The state of these tasks (Active -> Completed).
4.  **Events**: Signals from the world (Navigation, Input, Time).
5.  **Rewards**: Achievements or Content Unlocks.

## The Contract (WIT)

```wit
package component:quest-v1;

interface engine-types {
    type quest-id = string;
    type task-id = string;

    enum status {
        locked,
        active,
        completed,
        failed
    }
}

interface host-quest-manager {
    use engine-types.{quest-id, task-id, status};

    // Define the structure of the quest
    register-quest: func(id: quest-id, title: string, description: string);
    register-task: func(qid: quest-id, tid: task-id, description: string);

    // Update state
    update-task: func(qid: quest-id, tid: task-id, s: status);
    
    // Feedback
    unlock-achievement: func(title: string, icon: string);
    notify-player: func(message: string);
    
    // Persistence
    save-state: func(key: string, value: string);
    load-state: func(key: string) -> string;
}

interface host-content {
    // Register the static content available in this Quest
    register-item: func(id: string, url: string, title: string, type: string);
}

interface host-events {
    // Check if player is on a specific URL
    get-current-url: func() -> string;
}

world quest-agent {
    import host-quest-manager;
    import host-content;
    import host-events;

    // Called on boot. Restore state + Register Quests.
    export init: func();

    // Called when the Player navigates
    export on-visit: func(url: string);
    
    // Called when Player provides input (e.g. into a box)
    export on-input: func(id: string, value: string);
}
```

## Stress Test: The JSON Emulator
To prove this API is robust, we can build a **Universal Emulator Agent** that replicates the exact behavior of our legacy `packet.json` system.

**The Emulator Logic (JavaScript):**
```javascript
import { register_item } from 'component:quest-v1/host-content';
import { register_task, update_task, status } from 'component:quest-v1/host-quest-manager';

// This would be the 'packet.json' content
const CONFIG = {
  contents: [{ id: "c1", url: "google.com", title: "Google" }],
  checkpoints: [{ required: ["google.com"] }]
};

export function init() {
    // 1. Replicate 'contents'
    for (const item of CONFIG.contents) {
        register_item(item.id, item.url, item.title, "page");
    }
        
    // 2. Replicate 'checkpoints' as Tasks
    CONFIG.checkpoints.forEach((cp, i) => {
        register_task("main", `cp_${i}`, `Visit ${cp.required[0]}`);
    });
}

export function on_visit(url) {
    // 3. Replicate logic (Simple "includes" check)
    CONFIG.checkpoints.forEach((cp, i) => {
        if (url.includes(cp.required[0])) {
             update_task("main", `cp_${i}`, status.completed);
        }
    });
}
```
If we can build this **Emulator**, then the Quest Engine is strictly more powerful than the legacy system.

### 1. `checkpoints` (JSON) -> `register-task` (Wasm)
Instead of statically defining a list of URLs, your Agent code registers tasks and listens for events.

**Old (JSON):**
```json
"checkpoints": [
    { "requiredItems": ["settings.html"] }
]
```

**New (Python Agent):**
```python
def init():
    host.register_task("q1", "t1", "Go to Settings")

def on_visit(url):
    if "settings.html" in url:
        host.update_task("q1", "t1", status.COMPLETED)
        host.notify_player("Task Complete!")
```

### 2. `moments` (JSON) -> `on-visit` (Wasm)
Instead of static triggers, you implement logic.

**Old (JSON):**
```json
"moments": [
    { "type": "visit", "url": "..." }
]
```

**New (JS Agent):**
```javascript
export function on_visit(url) {
    if (url.includes("secret-level")) {
        host.unlock_achievement("Found the Secret!");
    }
}
```

## Benefits of V1
- **Conditional Logic**: Only unlock Task B if Task A is done.
- **Dynamic Goals**: Create tasks based on user input.
- **State Persistence**: The Host engine tracks the `status` of registered tasks, so the Agent doesn't need to implement complex save/load logic itself.
