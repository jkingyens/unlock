import { defineConfig } from 'vite'
import { crx } from '@crxjs/vite-plugin'
import manifest from './manifest.json'
import { resolve } from 'path'

export default defineConfig({
  build: {
    // Output to a 'dist' folder in the same directory
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        // These pages are loaded dynamically (not in manifest), so we include them explicitly.
        // Since we are in the root, we just look for the filename.
        offscreen: resolve(__dirname, 'offscreen.html'),
        llm_help: resolve(__dirname, 'llm_help.html'),
        s3_help: resolve(__dirname, 's3_help.html')
      }
    }
  },
  plugins: [
    crx({ manifest })
  ]
})