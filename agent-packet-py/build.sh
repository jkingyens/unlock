#!/bin/bash
set -e

echo "1. Creating Virtual Environment..."
python3 -m venv venv
source venv/bin/activate

echo "2. Installing componentize-py..."
pip install componentize-py



echo "3. Building Component..."
mkdir -p wit
cp ../agent.wit wit/
componentize-py -d wit -w agent-v1 componentize agent -o component.wasm

echo "4. Packaging Packet..."
rm -rf dist
node package-packet.mjs

echo "✅ Success! Packet created in 'dist/packet.json'."
