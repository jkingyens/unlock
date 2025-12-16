import fs from 'fs/promises';
import path from 'path';

async function patchShim() {
  const filePath = path.join('dist', 'agent.js');
  let code = await fs.readFile(filePath, 'utf8');
  
  console.log('Patching JCO shim for JSPI...');

  // 1. Make the trampoline async so it can await the bridge
  // Matches: function trampoline0(arg0, arg1, arg2) {
  code = code.replace(
    /function (trampoline\d+)\(([^)]+)\) \{/g,
    'async function $1($2) {'
  );

  // 2. Await the bridge call inside the trampoline
  // Matches: const ret = ask(result0);
  code = code.replace(
    /const ret = (\w+)\(([^)]+)\);/g,
    'const ret = await $1($2);'
  );

  // 3. Wrap the trampoline in Suspending when passed to Wasm
  // Matches: '0': trampoline0,
  code = code.replace(
    /'(\d+)': (trampoline\d+),/g,
    "'$1': new WebAssembly.Suspending($2),"
  );

  await fs.writeFile(filePath, code);
  console.log('Patch applied successfully.');
}

patchShim().catch(console.error);