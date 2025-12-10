import { build } from 'esbuild';
import fs from 'fs/promises';
import path from 'path';

console.log('Building JCO for Extension...');

// 1. Create Entry Point that exports 'transpile'
const entryContent = `
import { transpile } from '@bytecodealliance/jco';
export { transpile };
`;
await fs.writeFile('jco-entry.js', entryContent);

// 2. Build the Bundle
await build({
    entryPoints: ['jco-entry.js'],
    bundle: true,
    format: 'esm',
    outfile: '../agents/jco.js',
    platform: 'browser',
    external: ['node:*', 'fs', 'path', 'url', 'crypto'],
    define: { 'process.env.NODE_DEBUG': 'false' }
});

console.log('Wrapped JCO bundled to ../agents/jco.js');

// 3. Copy Wasm Assets
const jcoDir = 'node_modules/@bytecodealliance/jco/obj';
const destDir = '../agents';

const wasmFiles = [
    'js-component-bindgen-component.core.wasm',
    'js-component-bindgen-component.core2.wasm',
    'wasm-tools.core.wasm',
    'wasm-tools.core2.wasm'
];

for (const file of wasmFiles) {
    try {
        await fs.copyFile(path.join(jcoDir, file), path.join(destDir, file));
        console.log(`Copied ${file}`);
    } catch (e) {
        console.warn(`Warning: Could not copy ${file}: ${e.message}`);
    }
}

// 4. Copy Preview2 Shims
const shimDir = 'node_modules/@bytecodealliance/preview2-shim/lib/browser';
const shimDestDir = '../agents/shims';

try {
    await fs.mkdir(shimDestDir, { recursive: true });
    const shimFiles = await fs.readdir(shimDir);
    for (const file of shimFiles) {
        if (file.endsWith('.js')) {
            await fs.copyFile(path.join(shimDir, file), path.join(shimDestDir, file));
            console.log(`Copied shim: ${file}`);
        }
    }
} catch (e) {
    console.error(`Error copying shims: ${e.message}`);
}

console.log('JCO Build Complete.');
