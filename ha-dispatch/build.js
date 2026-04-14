import { build } from 'esbuild'
import { copyFileSync, mkdirSync } from 'fs'

await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  outfile: 'dist/index.js',
  banner: {
    js: [
      `import { createRequire as __cr } from 'module';`,
      `import { fileURLToPath as __fu } from 'url';`,
      `import { dirname as __dn } from 'path';`,
      `const require = __cr(import.meta.url);`,
      `const __filename = __fu(import.meta.url);`,
      `const __dirname = __dn(__filename);`,
    ].join(' '),
  },
})

// sql.js needs its WASM file next to the bundle
mkdirSync('dist', { recursive: true })
copyFileSync('node_modules/sql.js/dist/sql-wasm.wasm', 'dist/sql-wasm.wasm')

console.log('Build complete: dist/index.js + sql-wasm.wasm')
