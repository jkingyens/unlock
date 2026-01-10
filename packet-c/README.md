# C Quest Packet

A Quest packet implementation in C that demonstrates WebAssembly Component Model integration.

## Prerequisites

- **wit-bindgen** (for generating C bindings)
- **wasi-sdk** or **clang** with wasm32-wasi target
- **wasm-tools** (for component conversion)
- **Node.js** (for packaging)

## Installation

### Install wit-bindgen:
```bash
cargo install wit-bindgen-cli
```

### Install wasi-sdk:
```bash
# macOS
brew install wasi-sdk

# Or download from: https://github.com/WebAssembly/wasi-sdk/releases
```

## Building

```bash
./build.sh
```

This will:
1. Generate C bindings from packet.wit using wit-bindgen
2. Compile C code to WebAssembly (WASI target)
3. Convert to Component Model using wasm-tools
4. Package as packet.json

## Output

- `dist/packet.wasm` - WebAssembly component
- `dist/packet.json` - Packaged packet ready for import

## Implementation

The C packet implements the same Quest API as JavaScript, Rust, and Python versions:
- Registers "Visit Google" as a content item
- Creates a quest task
- Responds to navigation events
- Updates task status when google.com is visited

## Notes

C has excellent Component Model support through wit-bindgen. The bindings use the canonical ABI for string passing (pointer + length structs).

The implementation is very low-level and efficient, making it ideal for performance-critical packets.
