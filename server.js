/**
 * MarginPilot server — static web app + optional API (auth, snapshot sync).
 * Static-only when DATABASE_URL is unset. Production: set DATABASE_URL and run migrations.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from './server/db.mjs';
import { handleApi } from './server/api.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, 'apps', 'web');
const PORT = Number(process.env.PORT) || 3000;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function safeJoin(root, reqPath) {
  const decoded = decodeURIComponent((reqPath || '/').split('?')[0]);
  const cleaned = path.normalize(decoded).replace(/^(\.\.[/\\])+/, '');
  const full = path.join(root, cleaned);
  if (!full.startsWith(root)) return null;
  return full;
}

function serveStatic(req, res) {
  let filePath = safeJoin(ROOT, req.url === '/' ? '/index.html' : req.url);
  if (!filePath) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) filePath = path.join(ROOT, 'index.html');
    fs.readFile(filePath, (readErr, data) => {
      if (readErr) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, {
        'Content-Type': TYPES[ext] || 'application/octet-stream',
        'Cache-Control':
          ext === '.html' || filePath.endsWith('sw.js') || ext === '.webmanifest'
            ? 'no-cache'
            : 'public, max-age=3600',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        'X-Frame-Options': 'DENY',
      });
      res.end(data);
    });
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const host = req.headers.host || 'localhost';
    const url = new URL(req.url || '/', `http://${host}`);
    if (url.pathname.startsWith('/api/')) {
      const handled = await handleApi(req, res, url);
      if (handled) return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405);
      res.end('Method not allowed');
      return;
    }
    serveStatic(req, res);
  } catch (e) {
    console.error(e);
    res.writeHead(500);
    res.end('Server error');
  }
});

await db.init();
server.listen(PORT, '0.0.0.0', () => {
  console.log(`MarginPilot listening on http://0.0.0.0:${PORT}`);
  console.log(`  API health: http://0.0.0.0:${PORT}/api/health`);
  console.log(`  Database: ${db.enabled ? 'connected' : 'off (local browser mode)'}`);
});
