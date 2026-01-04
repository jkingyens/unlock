import { componentize } from '@bytecodealliance/componentize-js';
import { transpile } from '@bytecodealliance/jco';
import fs from 'fs/promises';

async function build() {
    try {
        console.log("1. Reading Source File...");
        const jsSourceCode = await fs.readFile('logic.js', 'utf8');

        console.log("2. Componentizing JS -> WASM...");
        const { component } = await componentize(jsSourceCode, {
            witPath: 'calculator.wit',
            worldName: 'calculator',
        });

        console.log("3. Writing Raw Component...");
        await fs.writeFile('component.wasm', component);

        console.log("4. Transpiling to JS...");
        const transpileResult = await transpile(component, {
            name: 'agent',
            noNodejsCompat: true,
            noWasiShim: true,
            map: {
                'wasi:cli/initial-environment': 'window',
                'wasi:cli/environment': 'window',
                'wasi:cli/exit': 'window',
                'wasi:io/error': 'window',
                'wasi:io/streams': 'window',
                'wasi:cli/stdin': 'window',
                'wasi:cli/stdout': 'window',
                'wasi:cli/stderr': 'window',
                'wasi:clocks/wall-clock': 'window',
                'wasi:filesystem/types': 'window',
                'wasi:filesystem/preopens': 'window',
                'wasi:random/random': 'window',
                'wasi:random/insecure': 'window',
                'wasi:random/insecure-seed': 'window',
                'wasi:sockets/instance-network': 'window',
                'wasi:sockets/ip-name-lookup': 'window',
                'wasi:sockets/network': 'window',
                'wasi:sockets/tcp-create-socket': 'window',
                'wasi:sockets/tcp': 'window',
                'wasi:sockets/udp-create-socket': 'window',
                'wasi:sockets/udp': 'window',
            }
        });

        // CRITICAL FIX: Decode the buffer to a string
        let jsContent = new TextDecoder('utf-8').decode(transpileResult.files['agent.js']);
        const wasmBase64 = Buffer.from(transpileResult.files['agent.core.wasm']).toString('base64');
        const dataUri = `data:application/wasm;base64,${wasmBase64}`;

        // Simple inlining
        jsContent = jsContent.replace("new URL('agent.core.wasm', import.meta.url)", `'${dataUri}'`);
        jsContent = jsContent.replace("new URL('./agent.core.wasm', import.meta.url)", `'${dataUri}'`);
        jsContent = jsContent.replace("new URL('agent.core.wasm', location.href).toString()", `'${dataUri}'`);
        jsContent = jsContent.replace("new URL('./agent.core.wasm', location.href).toString()", `'${dataUri}'`);

        await fs.writeFile('remote-payload.js', jsContent);

        console.log("✅ Success! 'component.wasm' and 'remote-payload.js' are ready.");

    } catch (e) {
        console.error("Build Failed:", e);
    }
}

build();