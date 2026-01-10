import fs from 'fs/promises';
import path from 'path';

async function inlineWasm() {
    const distDir = 'dist';
    const jsFile = path.join(distDir, 'packet.bundled.js');

    console.log('Inlining WASM into dist/packet.bundled.js...');
    let code = await fs.readFile('dist/packet.bundled.js', 'utf8');

    const files = await fs.readdir(distDir);
    const wasmFiles = files.filter(f => f.endsWith('.wasm'));

    for (const wasmFile of wasmFiles) {
        console.log(`  Embedding ${wasmFile}...`);
        const wasmPath = path.join(distDir, wasmFile);
        const buffer = await fs.readFile(wasmPath);
        const base64 = buffer.toString('base64');
        const dataUri = `data:application/wasm;base64,${base64}`;

        // Replace all variations of the filename with the Data URI
        code = code.split(`'./${wasmFile}'`).join(`'${dataUri}'`);
        code = code.split(`"./${wasmFile}"`).join(`"${dataUri}"`);
        code = code.split(`'${wasmFile}'`).join(`'${dataUri}'`);
        code = code.split(`"${wasmFile}"`).join(`"${dataUri}"`);
    }

    // Inject WebAssembly Overrides
    const overrides = `
      const originalCompile = WebAssembly.compile;
      const originalInstantiate = WebAssembly.instantiate;

      delete WebAssembly.instantiateStreaming;
      delete WebAssembly.compileStreaming;

      WebAssembly.compile = function(arg) {
          console.log("[Sandbox] Compile");
          return originalCompile(arg);
      };

      WebAssembly.instantiate = async function(mod, imports) {
          console.log("[Sandbox] Instantiate");
          imports = imports || {};
          let rawResult;
          if (mod instanceof WebAssembly.Module) {
              rawResult = await originalInstantiate(mod, imports);
          } else if (mod instanceof Response) {
              const bytes = await mod.arrayBuffer();
              rawResult = await originalInstantiate(bytes, imports);
          } else {
              rawResult = await originalInstantiate(mod, imports);
          }
          
          const actualInstance = rawResult.instance || rawResult;
          const actualModule = rawResult.module || mod; 
          
          const hybrid = {
              module: actualModule,
              instance: actualInstance,
              exports: actualInstance.exports 
          };
          if (actualInstance) {
             Object.setPrototypeOf(hybrid, Object.getPrototypeOf(actualInstance));
          }
          return hybrid;
      };
  `;

    code = overrides + code;

    await fs.writeFile(jsFile, code);

    console.log("Inlining complete.");
}
inlineWasm().catch(console.error);