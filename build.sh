#!/bin/bash
set -e

ACTION=${1:-build}

if [ "$ACTION" == "clean" ]; then
    echo "🧹 Cleaning project..."
    
    # Root
    echo "  - Root..."
    rm -rf node_modules dist
    
    # agent-builder
    echo "  - agent-builder..."
    rm -rf agent-builder/node_modules 
    rm -rf agent-builder/dist 
    rm -f agent-builder/component.wasm 

    # Agents output
    rm -f agents/agent.js

    # agent-sample
    echo "  - agent-sample..."
    rm -rf agent-sample/node_modules 
    rm -f agent-sample/component.wasm

    # agent-python
    echo "  - agent-python..."
    rm -rf agent-python/venv
    rm -f agent-python/component.wasm
    # agent-python/dist might exist depending on componentize-py, cleaning it just in case
    rm -rf agent-python/dist 

    echo "✅ Clean complete."

elif [ "$ACTION" == "build" ]; then
    echo "🏗️  Building project..."
    
    echo "1️⃣  Building agent-builder..."
    (cd agent-builder && npm install && npm run build)

    echo "2️⃣  Building agent-sample..."
    (cd agent-sample && npm install && node build.js)

    echo "3️⃣  Building agent-python..."
    (cd agent-python && bash build.sh)

    echo "4️⃣  Building root extension..."
    npm install
    npm run build
    
    echo "✅ Build complete."
else
    echo "Usage: $0 [build|clean]"
    exit 1
fi
