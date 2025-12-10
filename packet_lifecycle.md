# Packet Lifecycle & Contract

This document outlines the architecture of "Active Packets"—portable WebAssembly environments that can execute arbitrary logic within the Chrome Extension.

## The Contract

The agreement between the **Extension** (the Host) and the **Packet** (the Guest) consists of two layers:

### 1. The Metadata Layer (`packet.json`)
Defines *how* to load the code and declares compatibility.
*   **Format**: `wasm` (indicates a Wasm Component).
*   **Origin**: `internal` (stored in IndexedDB) or `external` (fetched from URL).
*   **Version**: `worldVersion` (e.g., `"v1"`).

### 2. The Interface Layer (WIT World)
Defines the strict binary API (ABI) that the Wasm must implement. The current world (`agent-v1`) requires exactly one export for execution:

```wit
// The "Plug" must match this "Socket"
export run-code: func(code: string) -> string;
```

Any Wasm binary—whether written in Rust, C, or a compiled JS interpreter—that implements this signature can be executed by the runtime.

---

## Lifecycle Phases

### Phase 1: Development (Image Creation)
The "build time" phase where the Wasm binary is created and packaged.

1.  **Source Code**: A Wasm Component is built (e.g., `logic.wasm`). This binary often contains a **JavaScript Engine** (like QuickJS) exposed via the WIT interface.
2.  **Packaging**: The `package-packet.mjs` script runs.
3.  **Encoding**: The Wasm binary is read and encoded into a **Base64 String**.
4.  **Manifest Generation**: A `packet.json` is created, embedding the Base64 Wasm as the `sourceContent`.
    *   *Result*: A self-contained "Packet Image" (JSON).

### Phase 2: Distribution (Import)
The phase where the packet enters the user's system.

1.  **Import**: User drags `packet.json` into the Extension.
2.  **Storage**: The Extension parses the JSON.
    *   It detects `origin: "internal"`.
    *   It extracts the heavy Wasm B64 and saves it to **IndexedDB** (preventing memory bloat).
3.  **Registration**: A `PacketRuntime` instance is initialized in memory with the Packet ID.

### Phase 3: Runtime (Boot)
The initialization phase when the user clicks **"Start"**.

1.  **Retrieval**: `packet-runtime.js` retrieves the Wasm B64 from IndexedDB.
2.  **Transpilation (JCO)**:
    *   Since browsers don't support Wasm Components natively yet, the B64 is sent to `offscreen.js`.
    *   The **JCO Compiler** converts the Component into **Core Wasm** + **JavaScript Glue Code**.
    *   **Output**: Blob URLs for the shim (`blob:.../shim.js`) and the binary (`blob:.../core.wasm`).
3.  **Sandbox Injection**:
    *   `sandbox.html` (an iframe) is created.
    *   The JCO Glue Code is injected.
    *   **Dynamic Adapters** are generated on-the-fly to mock WASI interfaces (Filesystem, Console, etc.) using Blob URLs.

### Phase 4: Execution (Run)
The active execution phase.

1.  **Linking**: The Browser links the Core Wasm imports to the Sandbox's shim blobs.
2.  **Instantiation**: `WebAssembly.instantiateStreaming` boots the Wasm "Computer".
3.  **The Call**:
    *   `packet-runtime.js` sends a payload: `{ code: "..." }`.
    *   `sandbox.html` receives it and calls the Wasm export: `instance.exports.runCode("...")`.
4.  **Evaluation**:
    *   Inside Wasm, the interpreter (e.g., QuickJS) parses the string.
    *   It executes the logic safely within the Wasm sandbox.
5.  **Completion**: The result (or error) is returned to the Sandbox, then relayed to `packet-runtime.js`.
