#!/bin/bash
set -e

echo "1. Creating Virtual Environment..."
python3 -m venv venv
source venv/bin/activate

echo "2. Installing componentize-py..."
pip install componentize-py



echo "3. Building Component..."
mkdir -p wit dist
cp ../packet.wit wit/
componentize-py -d ../packet.wit -w packet componentize app -o dist/packet.wasm

echo "4. Packaging Packet..."
node package-packet.mjs

echo "✅ Success! Packet created in 'dist/packet.json'."
