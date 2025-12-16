#!/bin/bash
set -e

echo "1. Creating Virtual Environment..."
python3 -m venv venv
source venv/bin/activate

echo "2. Installing componentize-py..."
pip install componentize-py

echo "3. Building Component..."
componentize-py -d . -w calculator componentize logic -o component.wasm

echo "✅ Success! 'component.wasm' is ready."
