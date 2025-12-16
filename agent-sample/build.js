import { componentize } from '@bytecodealliance/componentize-js';
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
        console.log("✅ Success! 'component.wasm' is ready.");

    } catch (e) {
        console.error("Build Failed:", e);
    }
}

build();