# Build Instructions

This project consists of multiple components that need to be built in a specific order.

## Prerequisites

- Node.js (v18+ recommended)
- Python 3 (for `agent-python`)
- `npm`

## Project Structure

- `agent-builder/`: Builds the core agent runtime (`agents/agent.js`).
- `agent-sample/`: A sample WebAssembly agent.
- `agent-python/`: A Python WebAssembly agent.
- `agents/`: Directory where compiled agent runtimes are placed.
- `root`: The main Chrome Extension (built with Vite).

## Automated Build

A `build.sh` script is provided to automate the build and clean processes.

### Build Everything
```bash
./build.sh
```
Or explicitly:
```bash
./build.sh build
```

### Clean Everything
```bash
./build.sh clean
```

## Manual Build Steps

If you prefer to build manually, follow this order:

1.  **Build Agent Builder**
    ```bash
    cd agent-builder
    npm install
    npm run build
    cd ..
    # This creates ../agents/agent.js
    ```

2.  **Build Sample Agent**
    ```bash
    cd agent-sample
    npm install
    node build.js
    cd ..
    # This creates agent-sample/component.wasm
    ```

3.  **Build Python Agent**
    ```bash
    cd agent-python
    bash build.sh
    cd ..
    # This creates agent-python/component.wasm
    ```

4.  **Build Extension**
    ```bash
    npm install
    npm run build
    # This creates the dist/ directory
    ```
