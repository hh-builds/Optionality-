// Build an OFFLINE, CDN-free, no-runtime-Babel web bundle for Capacitor.
// Source of truth stays ../src (via the root-built ../index.html). This script:
//   1. reads the built ../index.html,
//   2. precompiles the text/babel JSX block to plain JS (esbuild, classic runtime),
//   3. swaps the CDN <script>s for local vendored UMDs and drops babel-standalone,
//   4. strips the PWA manifest link + service-worker registration (native shell
//      doesn't use them),
//   5. writes www/index.html + www/app.js.
// engine.js is already inline in the built index.html, so it is carried through as-is.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import esbuild from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
let html = readFileSync(join(root, 'index.html'), 'utf8');

// 1) extract the JSX block
const m = html.match(/<script type="text\/babel"[^>]*>([\s\S]*?)<\/script>/);
if (!m) throw new Error('text/babel block not found in index.html');
const jsx = m[1];

// 2) precompile JSX -> classic React.createElement (no bundling: React/Recharts/Engine stay globals)
const { code } = esbuild.transformSync(jsx, { loader: 'jsx', jsx: 'transform', target: 'es2018' });

// 3) swap CDN scripts for local vendor UMDs; drop babel-standalone
html = html
  .replace(/<script src="https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/react\/[^"]+"><\/script>/,
           '<script src="vendor/react.production.min.js"></script>')
  .replace(/<script src="https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/react-dom\/[^"]+"><\/script>/,
           '<script src="vendor/react-dom.production.min.js"></script>')
  .replace(/<script src="https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/prop-types\/[^"]+"><\/script>/,
           '<script src="vendor/prop-types.min.js"></script>')
  .replace(/<script src="https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/recharts\/[^"]+"><\/script>/,
           '<script src="vendor/Recharts.js"></script>')
  .replace(/<script src="https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/babel-standalone\/[^"]+"><\/script>\s*/,
           '');

// 4) strip PWA manifest link, icon <link>s, and the SW-registration inline script
//    (native shell provides its own icons; these files aren't shipped in www/)
html = html
  .replace(/<link rel="manifest"[^>]*>\s*/,'')
  .replace(/<link rel="apple-touch-icon"[^>]*>\s*/,'')
  .replace(/<link rel="icon"[^>]*>\s*/,'')
  .replace(/<script>\s*if \('serviceWorker' in navigator\)[\s\S]*?<\/script>\s*/,'');

// 5) replace the babel block with a local compiled app.js
html = html.replace(/<script type="text\/babel"[^>]*>[\s\S]*?<\/script>/,
                    '<script src="app.js"></script>');

writeFileSync(join(here, 'www', 'app.js'), code);
writeFileSync(join(here, 'www', 'index.html'), html);
console.log('www built: index.html', html.length, 'bytes; app.js', code.length, 'bytes');
