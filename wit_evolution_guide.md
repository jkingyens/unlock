# WIT Evolution Guide

This guide outlines the steps to modify the WIT interface (e.g., changing function signatures) and update the Host (Extension) and Guest (Agents) accordingly.

## Scenario: Adding `version` to `run`
**Goal**: Change `run() -> string` to `run(version: string) -> string`.

## 1. Update the Interface (WIT)
Modify the `.wit` file in your agent projects.

**File**: `ext/agent-sample/calculator.wit` (and `ext/agent-python/calculator.wit`)
```wit
package local:demo;

world calculator {
  // export run: func() -> string;           <-- OLD
  export run: func(version: string) -> string; // <-- NEW
}
```

## 2. Update the Host (Extension)
The Extension "Host" invokes the Agent. It must now provide the implementation for the new argument.

**File**: `ext/sandbox.js`
Locate `executeAgentCode` or `executeAgentFromUrl`.
```javascript
// ...
if (agentModule.run) {
    console.log("[Sandbox] Running Agent...");
    // Pass the argument expected by the new signature
    const currentVersion = "1.0.0"; 
    const result = await agentModule.run(currentVersion); // <-- UPDATED CALL
    window.parent.postMessage({ type: 'AGENT_EXECUTION_COMPLETE', result }, '*');
}
// ...
```

## 3. Update the Guests (Agents)
Update the implementation logic in each language to accept the new argument.

### JavaScript Agent
**File**: `ext/agent-sample/logic.js`
```javascript
export function run(version) { // <-- Accept arg
  console.log(`Executing Agent with Host Version: ${version}`);
  return `Hello from Wasm! (Host: ${version})`;
}
```

### Python Agent
**Refining the bindings**:
When the WIT changes, `componentize-py` (and JCO) will generate different bindings. You may need to regenerate bindings to see the updated type signature, or just match it.

**File**: `ext/agent-python/logic.py`
```python
import wit_world

class WitWorld(wit_world.WitWorld):
    def run(self, version: str) -> str: # <-- Accept arg
        print(f"Executing Agent with Host Version: {version}")
        return f"Hello from Python! (Host: {version})"
```

## 4. Rebuild Components
Regenerate the `component.wasm` binaries to bake in the new Interface types.

**Agent Sample (JS)**:
```bash
cd ext/agent-sample
npm run build 
# (This runs componentize-js with the updated WIT)
```

**Agent Python**:
```bash
cd ext/agent-python
sh build.sh 
# (This runs componentize-py with the updated WIT)
```

## 5. Verify Not Breaking
*   **Backward Compatibility**: If you change the WIT, old Agents (expecting 0 args) might break if the Host sends 1 arg, or vice versa.
*   **Versioning**: Ideally, use WIT `world` versioning or feature negotiation if you need to support mixed populations of agents.
    *   Example: Check `if (agentModule.run.length > 0)` in javascript to detect signature? (Unreliable in Wasm bindings).
    *   Better: Use different export names `run-v2` or rely on packet metadata.
