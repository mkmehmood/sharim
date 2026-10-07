import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  readFileSync, writeFileSync, copyFileSync,
  mkdirSync, rmSync,
} from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT  = __dirname;
const DIST  = join(ROOT, 'dist');

const IS_WIN = process.platform === 'win32';
const ESBUILD_BIN = join(ROOT, 'node_modules/.bin', IS_WIN ? 'esbuild.cmd' : 'esbuild');

function run(args) {
  const quoted = IS_WIN ? args.map(a => (/[\s&|^<>()]/.test(a) ? `"${a}"` : a)) : args;
  execFileSync(ESBUILD_BIN, quoted, { stdio: ['ignore', 'inherit', 'inherit'], shell: IS_WIN });
}

function contentHash(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex').slice(0, 8);
}

function write(filePath, content) { writeFileSync(filePath, content, 'utf8'); }
function read(filePath) { return readFileSync(filePath, 'utf8'); }

rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });

const metafile = join(DIST, 'meta.json');
run([
  join(ROOT, 'modules/main.js'),
  '--bundle', '--splitting', '--format=esm',
  '--minify', '--platform=browser', '--target=es2018',
  `--outdir=${DIST}`, '--entry-names=[name]-[hash]',
  `--metafile=${metafile}`,
]);

const meta = JSON.parse(read(metafile));
let mainOut = null, factoryOut = null, repOut = null;
const allChunks = [];
for (const [outPath, info] of Object.entries(meta.outputs)) {
  const name = basename(outPath);
  allChunks.push(name);
  if (info.entryPoint === 'modules/main.js') mainOut = name;
  else if (info.entryPoint === 'modules/factory.js') factoryOut = name;
  else if (info.entryPoint === 'modules/rep-sales.js') repOut = name;
}
if (!mainOut || !factoryOut || !repOut) {
  throw new Error(`Could not identify all entry chunks in esbuild metafile. Found: ${allChunks.join(', ')}`);
}
rmSync(metafile);

const coreHash = contentHash(join(DIST, mainOut));

const cssMinTmp = join(DIST, '_app_min.css');
run([join(ROOT, 'app.css'), '--bundle=false', '--minify', `--outfile=${cssMinTmp}`]);
const cssHash = contentHash(cssMinTmp);
const cssOut  = `app.${cssHash}.css`;
copyFileSync(cssMinTmp, join(DIST, cssOut));
rmSync(cssMinTmp);

for (const f of ['manifest.json', '192.png', '512.png', 'sql-wasm.js', 'sql-wasm.wasm', 'sql.js']) {
  copyFileSync(join(ROOT, f), join(DIST, f));
}

let html = read(join(ROOT, 'index.html'));

html = html.replace(
  '<link rel="modulepreload" href="modules/main.js">',
  `<link rel="modulepreload" href="${mainOut}">`,
);
html = html.replace(
  '<link rel="stylesheet" href="app.css">',
  `<link rel="stylesheet" href="${cssOut}">`,
);
html = html.replace(
  '<script type="module" src="modules/main.js"></script>',
  `<script type="module" src="${mainOut}"></script>`,
);

write(join(DIST, 'index.html'), html);

mkdirSync(join(DIST, 'fonts'), { recursive: true });
const FONT_FILES = [['@fontsource-variable/playfair-display', 'playfair-display-latin-wght-normal.woff2'], ['@fontsource-variable/playfair-display', 'playfair-display-latin-wght-italic.woff2'], ['@fontsource-variable/plus-jakarta-sans', 'plus-jakarta-sans-latin-wght-normal.woff2'], ['@fontsource-variable/manrope', 'manrope-latin-wght-normal.woff2'], ['@fontsource-variable/jetbrains-mono', 'jetbrains-mono-latin-wght-normal.woff2'], ['@fontsource-variable/cinzel', 'cinzel-latin-wght-normal.woff2'], ['@fontsource/noto-nastaliq-urdu', 'noto-nastaliq-urdu-arabic-400-normal.woff2'], ['@fontsource/noto-nastaliq-urdu', 'noto-nastaliq-urdu-arabic-700-normal.woff2']];
for (const [pkg, file] of FONT_FILES) copyFileSync(join(ROOT, 'node_modules', pkg, 'files', file), join(DIST, 'fonts', file));

mkdirSync(join(DIST, 'vendor'), { recursive: true });
copyFileSync(join(ROOT, 'node_modules/jspdf/dist/jspdf.umd.min.js'), join(DIST, 'vendor/jspdf.umd.min.js'));
copyFileSync(join(ROOT, 'node_modules/jspdf-autotable/dist/jspdf.plugin.autotable.min.js'), join(DIST, 'vendor/jspdf.plugin.autotable.min.js'));

const ASSETS_TO_CACHE_BLOCK =
`const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './${cssOut}',
  ${allChunks.map(c => `'./${c}',`).join('\n  ')}
  './manifest.json',
  './192.png',
  './512.png',

  './sql-wasm.js',
  './sql-wasm.wasm',
  './sql.js',
  './vendor/jspdf.umd.min.js',
  './vendor/jspdf.plugin.autotable.min.js',
  ${FONT_FILES.map(f => `'./fonts/${f[1]}'`).join(',\n  ')}
];`;

let sw = read(join(ROOT, 'sw.js'));
sw = sw.replace(/const BUILD_HASH = '[^']+';/, `const BUILD_HASH = 'sarim-${coreHash}-${new Date().toISOString().slice(0,10).replace(/-/g,'')}';`);
sw = sw.replace(/const ASSETS_TO_CACHE = \[[\s\S]*?\];/, ASSETS_TO_CACHE_BLOCK);
write(join(DIST, 'sw.js'), sw);

const kb = f => (readFileSync(join(DIST, f)).length / 1024).toFixed(1);
console.log('\nBuild complete:\n');
for (const c of allChunks) {
  const tag = c === mainOut ? '(entry + core)' : c === factoryOut ? '(lazy — factory tab)' : c === repOut ? '(lazy — rep tab)' : '(shared chunk)';
  console.log(`  ${c.padEnd(30)} ${kb(c)} KB  ${tag}`);
}
console.log(`  ${cssOut.padEnd(30)} ${kb(cssOut)} KB  (styles)`);
console.log(`\n  SW cache key: sarim-${coreHash}`);
console.log(`  Output:       dist/\n`);
