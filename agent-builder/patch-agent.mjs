import fs from 'fs/promises';
import path from 'path';

async function patchAgent() {
    const agentPath = path.join('dist', 'agent.js');
    let code = await fs.readFile(agentPath, 'utf8');

    console.log("Patching JCO shim for JSPI...");

    console.log("Patching JCO shim for JSPI...");

    // Regex to find the trampoline function that calls ask(result0)
    // We capture the function name and the arguments
    const trampolineRegex = /function\s+(trampoline\d+)\(([^)]+)\)\s*\{[^}]*ask\(result0\)[^}]*\}/s;
    const match = code.match(trampolineRegex);

    if (match) {
        const funcName = match[1];
        const args = match[2];
        console.log(`  - Found trampoline function: ${funcName}`);

        // 1. Make the trampoline async
        code = code.replace(
            `function ${funcName}(${args}) {`,
            `async function ${funcName}(${args}) {`
        );
        console.log(`  - Made ${funcName} async`);

        // 2. Await the ask() call
        code = code.replace(
            'const ret = ask(result0);',
            'const ret = await ask(result0);'
        );
        console.log("  - Added await to ask()");

        // 3. Wrap the trampoline in WebAssembly.Suspending when importing it
        // Look for "'0': trampolineXX," or similar mapping
        // The mapping index might vary, so we look for the usage of the funcName in the imports object
        // It usually looks like: '0': trampoline61,
        // We'll use a regex to find where it's assigned
        const importRegex = new RegExp(`'\\d+':\\s*${funcName},`, 'g');
        code = code.replace(importRegex, (m) => {
            return m.replace(funcName, `new WebAssembly.Suspending(${funcName})`);
        });
        console.log(`  - Wrapped ${funcName} in Suspending`);
    } else {
        console.warn("  ! Trampoline function for 'ask' not found.");
    }

    // 4. Wrap the internal Wasm export in WebAssembly.promising and update the wrapper
    // Pattern: "exports1Run = exports1.run;"
    if (code.includes('exports1Run = exports1.run;')) {
        code = code.replace(
            'exports1Run = exports1.run;',
            'exports1Run = WebAssembly.promising(exports1.run);'
        );
        console.log("  - Wrapped internal export 'exports1.run' in WebAssembly.promising");
    } else {
        console.warn("  ! Internal export assignment not found.");
    }

    // 5. Make the wrapper function async
    // Pattern: "function run() {"
    if (code.includes('function run() {')) {
        code = code.replace(
            'function run() {',
            'async function run() {'
        );
        console.log("  - Made wrapper function 'run' async");
    } else {
        console.warn("  ! Wrapper function 'run' not found.");
    }

    // 6. Await the internal call
    // Pattern: "const ret = exports1Run();"
    if (code.includes('const ret = exports1Run();')) {
        code = code.replace(
            'const ret = exports1Run();',
            'const ret = await exports1Run();'
        );
        console.log("  - Added await to internal 'exports1Run' call");
    } else {
        console.warn("  ! Internal call 'exports1Run()' not found.");
    }

    await fs.writeFile(agentPath, code);
    console.log("Patch complete.");
}

patchAgent().catch(console.error);