#!/bin/bash
set -e

ACTION=${1:-build}

if [ "$ACTION" == "clean" ]; then
    echo "🧹 Cleaning project..."
    
    # Root
    echo "  - Root..."
    rm -rf node_modules dist
    
    # packet-runtime
    echo "  - packet-runtime..."
    rm -rf packet-runtime/node_modules 
    
    # packet-js
    echo "  - packet-js..."
    rm -rf packet-js/node_modules 
    rm -rf packet-js/dist 
    rm -f packet-js/component.wasm 

    # Packets output
    rm -f packets/packet.js
    rm -f packets/jco.js
    rm -rf packets/shims

    # packet-sample
    echo "  - packet-sample..."
    rm -rf packet-sample/node_modules 
    rm -f packet-sample/component.wasm
    rm -f packet-sample/remote-payload.js

    # packet-py
    echo "  - packet-py..."
    rm -rf packet-py/venv
    rm -f packet-py/component.wasm
    # packet-py/dist might exist depending on componentize-py, cleaning it just in case
    rm -rf packet-py/dist 

    echo "✅ Clean complete."

elif [ "$ACTION" == "build" ]; then
    echo "🏗️  Building project..."
    
    echo "1️⃣  Building packet-runtime (Loader)..."
    (cd packet-runtime && npm install && npm run build)

    echo "2️⃣  Building packet-js..."
    (cd packet-js && npm install && npm run build)

    echo "3️⃣  Building packet-py..."
    (cd packet-py && bash build.sh)

    echo "4️⃣  Building packet-sample..."
    (cd packet-sample && npm install && node build.js)

    echo "5️⃣  Building root extension..."
    npm install
    npm run build
    
    echo "✅ Build complete."
else
    echo "Usage: $0 [build|clean]"
    exit 1
fi
