import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const base = resolve(root, process.argv[2] || '.');
const missing = [];
let checked = 0;

function check(ref, from) {
  checked++;
  if (!existsSync(join(base, ref))) missing.push(`${ref}  (from ${from})`);
}

const html = readFileSync(join(base, 'index.html'), 'utf8');
for (const m of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
  const ref = m[1];
  if (/^(https?:|data:|#|\/\/)/.test(ref) || ref === '') continue;
  if (ref.startsWith('fonts/') && !existsSync(join(base, 'fonts'))) continue;
  check(ref.split('?')[0], 'index.html');
}

const sw = readFileSync(join(base, 'sw.js'), 'utf8');
const block = sw.match(/ASSETS_TO_CACHE = \[([\s\S]*?)\];/);
if (!block) missing.push('ASSETS_TO_CACHE block not found in sw.js');
else for (const m of block[1].matchAll(/'\.\/([^']+)'/g)) check(m[1], 'sw.js');

for (const f of ['manifest.json', 'sw.js']) check(f, 'required root file');

if (missing.length) {
  console.error(`\n✗ ${missing.length} missing reference(s) in ${base}:\n`);
  missing.forEach(m => console.error('  - ' + m));
  process.exit(1);
}
console.log(`✓ ${checked} references OK in ${base}`);
