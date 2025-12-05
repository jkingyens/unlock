// agent-builder/bundle.mjs
import * as esbuild from 'esbuild';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const jcoBridgePlugin = {
  name: 'jco-bridge',
  setup(build) {
    // [FIX] Match the new WIT package name 'component:agent'
    build.onResolve({ filter: /^component:agent\// }, args => {
      return { path: path.resolve(__dirname, 'bridge-impl.js') };
    });

    // Stub Node.js built-ins
    build.onResolve({ filter: /^node:/ }, args => {
      return { path: args.path, namespace: 'node-stub' };
    });
    
    build.onLoad({ filter: /.*/, namespace: 'node-stub' }, args => {
      return { contents: 'export default {};', loader: 'js' };
    });
  },
};

await esbuild.build({
  entryPoints: ['dist/agent.js'],
  bundle: true,
  format: 'esm',
  outfile: 'dist/agent.bundled.js',
  plugins: [jcoBridgePlugin],
  external: ['*.wasm'], 
});

console.log("Bundling complete.");