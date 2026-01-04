import { componentize } from '@bytecodealliance/componentize-js';
import { transpile } from '@bytecodealliance/jco';
import fs from 'fs/promises';
import path from 'path';

async function build() {
  console.log('1. Componentizing JS...');
  const { component } = await componentize(
    await fs.readFile('agent.js', 'utf8'),
    {
      witPath: '../agent.wit',
      worldName: 'agent-v1',
      disable: ['clocks', 'http', 'random', 'stdio']
    }
  );
  await fs.writeFile('component.wasm', component);

  console.log('2. Transpiling to JS (ESM + JSPI)...');
  const transpileResult = await transpile(component, {
    name: 'agent',
    noNodejsCompat: true,
    noWasiShim: true,
    // CRITICAL: Enable JSPI. JCO will generate the 'new WebAssembly.Suspending()' wrappers.
    asyncMode: 'jspi',
    asyncImports: ['local:agent/host-capabilities'],
    // CRITICAL: Do NOT use instantiation mode. We want top-level imports.
  });

  await fs.mkdir('dist', { recursive: true });
  for (const [filename, source] of Object.entries(transpileResult.files)) {
    const filePath = path.join('dist', filename);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, source);
  }
  console.log('3. Transpile Complete.');
}
build().catch(console.error);