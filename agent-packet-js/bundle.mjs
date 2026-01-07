// agent-builder/bundle.mjs
import * as esbuild from 'esbuild';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const jcoBridgePlugin = {
  name: 'jco-bridge',
  setup(build) {
    // [FIX] Externalize the new WIT package name 'component:quest-v1'
    build.onResolve({ filter: /^component:quest-v1\// }, args => {
      return { external: true };
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