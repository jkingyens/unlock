#!/bin/bash
set -e

echo "1. Building Rust Wasm Component..."

# Build the Rust library to Wasm
cargo build --target wasm32-wasip1 --release

echo "2. Converting to Component..."

# Use wasm-tools to convert the core module to a component
wasm-tools component new \
    target/wasm32-wasip1/release/packet_rust.wasm \
    -o dist/packet.wasm

echo "3. Packaging Packet..."
mkdir -p dist
node package-packet.mjs

echo "✅ Success! Packet created in 'dist/packet.json'."
