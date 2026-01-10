import { componentize } from '@bytecodealliance/componentize-js';
import { readFile, writeFile } from 'fs/promises';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

async function build() {
  console.log('1. Componentizing JS...');

  const jsSource = await readFile('packet.js', 'utf8');

  const { component } = await componentize(jsSource, {
    witPath: '../packet.wit',
    worldName: 'packet',
    disableFeatures: []
  });

  await writeFile('dist/packet.core.wasm', component);

  console.log('2. Transpiling to JS (ESM + JSPI)...');

  // Use JCO to transpile the component to JS with JSPI support
  try {
    await execAsync('npx jco transpile dist/packet.core.wasm -o dist --name packet --map component:quest-v1/host-console=../bridge-impl.js --map component:quest-v1/host-quest-manager=../bridge-impl.js --map component:quest-v1/host-events=../bridge-impl.js --map component:quest-v1/host-content=../bridge-impl.js --valid-lifting-optimization --tla-compat');
    console.log('3. Transpile Complete.');
  } catch (error) {
    console.error('Transpile failed:', error);
    process.exit(1);
  }
}
build().catch(console.error);