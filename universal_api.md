# Universal Agent API

The **Universal Agent API** defines a standard contract that allows standard "Agents" to run securely inside the Extension capabilities. Regardless of the programming language used (JavaScript, Python, etc.), all agents must adhere to this shared interface.

## Core Concept
The system follows a **Host-Guest** model:
- **The Host (Runtime)**: The extension environment. It provides tools, manages execution, and ensures security.
- **The Guest (Agent)**: Your code. It runs inside a secure sandbox and performs specific logic.

## The Contract
The API is defined using **WIT** (WebAssembly Interface Type), which is language-agnostic. It consists of two parts: what the Agent *must provides* (Exports) and what the Host *provides to* the Agent (Imports).

### 1. Agent Exports (Your Responsibility)
Every agent must expose a single primary function entry point.

#### `run`
This is the main entry point called by the Host to start your agent.

- **Signature**: `run(code: string) -> string`
- **Input**: A string payload (often user instructions, code code, or configuration).
- **Output**: A string result indicating success, failure, or a computed value.
- **Behavior**: When the extension executes your agent, it invokes this function. Your agent should perform its task and return the result.

### 2. Host Imports (Available Tools)
The Host provides a set of capabilities that your agent can import and use to interact with the outside world (since the sandbox is otherwise isolated).

#### `host-capabilities`
- **`ask(prompt: string) -> string`**
    - **Purpose**: Request input or decision-making from the user (or an LLM acting as the user).
    - **Usage**: Use this to ask questions, confirm actions, or get missing information.
    - **This function is blocking/synchronous** from the agent's perspective (even if handled asynchronously by the host).

#### `host-console`
- **`log(message: string)`**
    - **Purpose**: Emit debug logs or status updates to the extension's debug console.
    - **Usage**: Use this for standard logging instead of `print` or `console.log` to ensure it is captured correctly by the Runtime.

## Implementation Examples

### JavaScript / TypeScript
```javascript
import { ask } from 'component:agent/host-capabilities';
import { log } from 'component:agent/host-console';

export async function run(input) {
  log(`Received input: ${input}`);
  
  const name = await ask("What is your name?");
  return `Hello, ${name}! You sent: ${input}`;
}
```

### Python
```python
import wit_world

class Agent(wit_world.WitWorld):
    def run(self, code: str) -> str:
        wit_world.host_console.log(f"Received: {code}")
        
        user_response = wit_world.host_capabilities.ask("Confirm execution?")
        return f"Executed with confirmation: {user_response}"
```
