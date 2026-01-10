# Zig Quest Packet

A Quest packet implementation in Zig that demonstrates WebAssembly Component Model integration.

## Prerequisites

- Zig 0.11.0 or later
- wasm-tools
- Node.js (for packaging)

## Installation

Install Zig:
```bash
brew install zig
```

Or download from: https://ziglang.org/download/

## Building

```bash
./build.sh
```

This will:
1. Compile Zig code to WebAssembly (WASI target)
2. Convert to Component Model using wasm-tools
3. Package as packet.json

## Output

- `dist/packet.wasm` - WebAssembly component
- `dist/packet.json` - Packaged packet ready for import

## Implementation

The Zig packet implements the same Quest API as JavaScript and Rust versions:
- Registers "Visit Google" as a content item
- Creates a quest task
- Responds to navigation events
- Updates task status when google.com is visited

## Notes

This implementation uses manual Component Model bindings since wit-bindgen for Zig is still in development. The bindings follow the Component Model canonical ABI for string passing (pointer + length).
