#!/bin/bash
set -e

ACTION=${1:-build}

if [ "$ACTION" == "clean" ]; then
    echo "🧹 Cleaning project..."
    
    # Root
    echo "  - Root..."
    rm -rf node_modules dist
    
    # agent-runtime
    echo "  - agent-runtime..."
    rm -rf agent-runtime/node_modules 
    # agent-runtime outputs to ../agents (so cleaning agents/ works)

    # agent-packet-js
    echo "  - agent-packet-js..."
    rm -rf agent-packet-js/node_modules 
    rm -rf agent-packet-js/dist 
    rm -f agent-packet-js/component.wasm 

    # Agents output
    rm -f agents/agent.js
    rm -f agents/jco.js
    rm -rf agents/shims

    # agent-sample
    echo "  - agent-sample..."
    rm -rf agent-sample/node_modules 
    rm -f agent-sample/component.wasm
    rm -f agent-sample/remote-payload.js

    # agent-packet-py
    echo "  - agent-packet-py..."
    rm -rf agent-packet-py/venv
    rm -f agent-packet-py/component.wasm
    # agent-packet-py/dist might exist depending on componentize-py, cleaning it just in case
    rm -rf agent-packet-py/dist 

    echo "✅ Clean complete."

elif [ "$ACTION" == "build" ]; then
    echo "🏗️  Building project..."
    
    echo "1️⃣  Building agent-runtime (Loader)..."
    (cd agent-runtime && npm install && npm run build)

    echo "2️⃣  Building agent-packet-js..."
    (cd agent-packet-js && npm install && npm run build)

    echo "3️⃣  Building agent-packet-py..."
    (cd agent-packet-py && bash build.sh)

    echo "4️⃣  Building agent-sample..."
    (cd agent-sample && npm install && node build.js)

    echo "5️⃣  Building root extension..."
    npm install
    npm run build
    
    echo "✅ Build complete."
else
    echo "Usage: $0 [build|clean]"
    exit 1
fi
