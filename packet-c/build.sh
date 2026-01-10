#!/bin/bash
set -e

echo "1. Generating C bindings from WIT..."

# Generate C bindings using wit-bindgen
wit-bindgen c --out-dir src ../packet.wit

echo "2. Compiling C to Wasm..."

# Compile C to WebAssembly using clang/wasi-sdk
clang --target=wasm32-wasi \
    -O2 \
    -I src \
    -Wl,--export-all \
    -Wl,--no-entry \
    -o dist/packet-core.wasm \
    src/packet.c \
    src/packet_component_type.o

echo "3. Converting to Component..."

# Use wasm-tools to convert the core module to a component
wasm-tools component new dist/packet-core.wasm \
    --adapt wasi_snapshot_preview1.reactor.wasm \
    -o dist/packet.wasm

echo "4. Packaging Packet..."
mkdir -p dist
node package-packet.mjs

echo "✅ Success! Packet created in 'dist/packet.json'."
