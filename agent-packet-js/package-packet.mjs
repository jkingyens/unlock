import fs from 'fs/promises';
import path from 'path';

async function packagePacket() {
    console.log('Packaging Wasm Component into Packet...');

    // 1. Read the Wasm Binary
    const wasmPath = 'component.wasm';
    try {
        await fs.access(wasmPath);
    } catch {
        console.error("Error: 'component.wasm' not found. Run 'npm run build' first.");
        process.exit(1);
    }

    const buffer = await fs.readFile(wasmPath);
    const base64Wasm = buffer.toString('base64');

    // 2. Define Packet Metadata (Template)
    // In a real CLI, these might come from args or a separate config file
    const packet = {
        id: `pkg_${Date.now()}_wasm`,
        title: "Packaged Wasm Agent",
        created: new Date().toISOString(),
        sourceContent: [
            {
                origin: "internal",
                format: "wasm",
                lrl: "logic.wasm", // Virtual filename
                worldVersion: "v1", // Explicitly state conformance to 'agent-v1' world
                title: "Agent Logic",
                contentB64: base64Wasm // The embedded binary
            }
        ],
        checkpoints: [],
        moments: []
    };

    // 3. Write Output
    const distDir = 'dist';
    await fs.mkdir(distDir, { recursive: true });

    const outputPath = path.join(distDir, 'packet.json');
    await fs.writeFile(outputPath, JSON.stringify(packet, null, 2));

    console.log(`\nSuccess! Packet created at: ${outputPath}`);
    console.log(`Size: ${(base64Wasm.length / 1024 / 1024).toFixed(2)} MB (Base64)`);
}

packagePacket().catch(console.error);
