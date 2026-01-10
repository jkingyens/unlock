#!/bin/bash
set -e

echo "1. Building Zig Wasm Library..."

# Build the Zig library to Wasm
zig build -Doptimize=ReleaseSmall

echo "2. Converting to Component..."

# Use wasm-tools to convert the core module to a component
wasm-tools component new zig-out/lib/packet.wasm \
    --adapt wasi_snapshot_preview1.reactor.wasm \
    -o dist/packet.wasm

echo "3. Packaging Packet..."
mkdir -p dist
node package-packet.mjs

echo "✅ Success! Packet created in 'dist/packet.json'."
