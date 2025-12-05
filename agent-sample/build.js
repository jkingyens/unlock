import { componentize } from '@bytecodealliance/componentize-js';
import { transpile } from '@bytecodealliance/jco';
import fs from 'fs/promises';
import { rollup } from 'rollup';
import nodeResolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';

// --- PLUGIN: Universal Mock ---
// Mocks Node.js built-ins but LETS @bytecodealliance packages resolve naturally.
function universalMockPlugin() {
    return {
        name: 'universal-mock',
        resolveId(source) {
            // Only mock "node:" imports and bare "wasi:" imports (if any remain)
            if (source.startsWith('node:') || source.startsWith('wasi:')) {
                return source;
            }
            return null;
        },
        load(id) {
            if (id.startsWith('node:') || id.startsWith('wasi:')) {
                return `
                    const proxy = new Proxy(() => 0, { 
                        get: () => proxy, 
                        apply: () => 0 
                    });
                    export default proxy;
                    // Export common named exports to satisfy destructuring
                    export const { 
                        readFile, writeFile, stderr, stdout, stdin, env,
                        argv, exit, hrtime, platform
                    } = new Proxy({}, { get: () => proxy });
                `;
            }
            return null;
        }
    };
}

async function build() {
    try {
        console.log("1. Reading Source File...");
        const jsSourceCode = await fs.readFile('logic.js', 'utf8');

        console.log("2. Componentizing JS -> WASM...");
        const { component } = await componentize(jsSourceCode, {
            witPath: 'calculator.wit',
            worldName: 'calculator',
        });

        console.log("3. Transpiling Component -> Browser Artifacts...");
        // ENABLE WASI SHIM (The fix for the hang)
        // We let JCO bundle the correct OS logic.
        const { files } = await transpile(component, {
            name: 'calculator',
            wasiShim: true
        });

        console.log("   Build Output Files:", Object.keys(files));

        // --- ASSETS ---
        const wasmAssets = {};
        let jsEntryContent = null;

        for (const [filename, content] of Object.entries(files)) {
            if (filename.endsWith('.wasm')) {
                console.log(`   Processing WASM: ${filename}`);
                wasmAssets[filename] = Buffer.from(content).toString('base64');
            } else if (filename.endsWith('.js')) {
                jsEntryContent = new TextDecoder('utf-8').decode(content);
            }
        }

        if (!jsEntryContent) throw new Error("No JS entry point found!");

        console.log("4. Bundling Dependencies (Rollup)...");
        await fs.writeFile('temp_shim.js', jsEntryContent);

        const bundle = await rollup({
            input: 'temp_shim.js',
            plugins: [
                universalMockPlugin(),
                nodeResolve({ browser: true, preferBuiltins: false }),
                commonjs()
            ]
        });

        const { output } = await bundle.generate({ format: 'es' });
        let bundledJsSource = output[0].code;

        await fs.unlink('temp_shim.js');

        console.log("5. Patching & Inlining Assets...");

        // --- PATCH: Intelligent URL Replacement ---
        bundledJsSource = bundledJsSource.replace(
            /new\s+URL\s*\(\s*['"]\.\/([^'"]+\.wasm)['"]\s*,\s*import\.meta\.url\s*\)/g,
            (match, filename) => `"${filename}"`
        );

        const assetsJSON = JSON.stringify(wasmAssets);

        const finalPayload = `
      // --- INLINED ASSETS ---
      const wasmAssets = ${assetsJSON};
      
      // HELPER: Returns FRESH bytes (Fixes "Buffer Source" error)
      function getFreshBytes(filename) {
          let base64 = wasmAssets[filename];
          // Fallback logic
          if (!base64) base64 = Object.values(wasmAssets)[0];
          
          const binaryString = atob(base64);
          const bytes = new Uint8Array(binaryString.length);
          for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i);
          }
          return bytes;
      }

      // --- OMNI-INTERCEPTORS ---
      const originalCompile = WebAssembly.compile;
      const originalInstantiate = WebAssembly.instantiate;

      delete WebAssembly.instantiateStreaming;
      delete WebAssembly.compileStreaming;

      globalThis.fetch = async function(url) {
          console.log("[Sandbox] Fetch:", url);
          const filename = url.split('/').pop();
          return new Response(getFreshBytes(filename), { 
              headers: { 'Content-Type': 'application/wasm' } 
          });
      };

      WebAssembly.compile = function(arg) {
          console.log("[Sandbox] Compile");
          // Always use fresh bytes if a filename string is passed
          if (typeof arg === 'string') return originalCompile(getFreshBytes(arg));
          return originalCompile(arg);
      };

      WebAssembly.instantiate = async function(mod, imports) {
          console.log("[Sandbox] Instantiate");
          
          // Allow the Shim to provide its own imports (don't force deepPatch if not needed)
          imports = imports || {};

          let rawResult;
          if (mod instanceof WebAssembly.Module) {
              rawResult = await originalInstantiate(mod, imports);
          } else if (typeof mod === 'string') {
              // Passing filename -> load fresh bytes
              rawResult = await originalInstantiate(getFreshBytes(mod), imports);
          } else if (mod instanceof Response) {
              // Passing Response -> extract bytes
              const bytes = await mod.arrayBuffer();
              rawResult = await originalInstantiate(bytes, imports);
          } else {
              // Passing bytes directly -> pass through
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

      // --- JCO SHIM CODE ---
      ${bundledJsSource}
    `;

        await fs.writeFile('remote-payload.js', finalPayload);
        console.log("✅ Success! 'remote-payload.js' is ready.");

    } catch (e) {
        console.error("Build Failed:", e);
    }
}

build();