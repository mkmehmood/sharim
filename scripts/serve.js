import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, extname, resolve, dirname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const baseDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const hasDist = existsSync(resolve(baseDir, 'dist/index.html'));
const defaultDir = (process.env.NODE_ENV === 'production' && hasDist) ? 'dist' : '.';
const root = resolve(baseDir, process.argv[2] || defaultDir);
const port = Number(process.argv[3] || process.env.PORT || 3000);
const host = process.env.HOST && process.env.HOST !== 'localhost' ? process.env.HOST : '0.0.0.0';
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png',
  '.wasm': 'application/wasm', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf',
  '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json',
};

createServer(async (req, res) => {
  try {
    let p = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname));
    let file = join(root, p);
    if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
    const s = await stat(file).catch(() => null);
    if (s?.isDirectory()) file = join(file, 'index.html');
    else if (!s && !extname(file)) file = join(root, 'index.html');
    const data = await readFile(file);
    res.writeHead(200, {
      'Content-Type': TYPES[extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(data);
  } catch { res.writeHead(404).end('Not found'); }
}).listen(port, host, () => console.log(`Serving ${root} at http://${host}:${port}`));
