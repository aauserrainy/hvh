/* HvH platform server. Zero dependencies - `node server/server.js` is all it takes.
   Serves the API and, optionally, the game files themselves. */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { open } = require('./db');
const { build } = require('./routes');
const U = require('./util');

const cfg = {
  port: +(process.env.PORT || 8080),
  host: process.env.HOST || '0.0.0.0',
  dbFile: process.env.DB_FILE || path.join(__dirname, 'data', 'hvh.db'),
  /* Set TRUST_PROXY=1 when the server sits behind a proxy that sets
     X-Forwarded-For (Railway, Render, Fly, nginx). Leave it off otherwise:
     with it on and no proxy, a client can put any address in that header. */
  trustProxy: process.env.TRUST_PROXY === '1',
  /* Comma separated origins allowed to call the API from a browser, or * for any.
     Set this to your site (https://comefly.xyz) once you are live. */
  origins: (process.env.ORIGINS || '*').split(',').map(s => s.trim()).filter(Boolean),
  staticDir: process.env.STATIC_DIR || path.join(__dirname, '..'),
  serveStatic: process.env.SERVE_STATIC !== '0',
  version: process.env.APP_VERSION || '4.0'
};

const db = open(cfg.dbFile);
const limiter = U.makeLimiter();
const api = build({ db, limiter, cfg });

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.lua': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2', '.mp3': 'audio/mpeg', '.webp': 'image/webp' };

function cors(req, res) {
  const origin = req.headers.origin;
  if (!origin) return;
  const allow = cfg.origins.includes('*') ? origin : (cfg.origins.includes(origin) ? origin : null);
  if (!allow) return;
  res.setHeader('Access-Control-Allow-Origin', allow);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Headers', 'content-type, authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Max-Age', '600');
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', c => { n += c.length; if (n > limit) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { const v = JSON.parse(raw); resolve(v && typeof v === 'object' ? v : {}); }
      catch (e) { reject(new Error('bad json')); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, body) {
  const s = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(s),
    'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(s);
}

function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath.split('?')[0]);
  if (rel === '/' || rel === '') rel = '/index.html';
  const full = path.join(cfg.staticDir, rel);
  const root = path.resolve(cfg.staticDir);
  if (!path.resolve(full).startsWith(root + path.sep) && path.resolve(full) !== root) { res.writeHead(403); return res.end('forbidden'); }
  /* never serve the server's own folder, its database or git internals */
  const blocked = ['server' + path.sep, '.git' + path.sep];
  const relResolved = path.resolve(full).slice(root.length + 1);
  if (blocked.some(b => relResolved.startsWith(b))) { res.writeHead(404); return res.end('not found'); }
  fs.stat(full, (e, st) => {
    if (e || !st.isFile()) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('not found'); }
    res.writeHead(200, { 'content-type': TYPES[path.extname(full).toLowerCase()] || 'application/octet-stream',
      'content-length': st.size, 'cache-control': 'no-cache' });
    fs.createReadStream(full).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  const t0 = Date.now();
  cors(req, res);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  const u = new URL(req.url, 'http://x');
  const pathName = u.pathname;

  if (!pathName.startsWith('/api/')) {
    if (!cfg.serveStatic) { res.writeHead(404); return res.end('not found'); }
    return serveStatic(req, res, req.url);
  }

  if (pathName === '/api/health') return sendJson(res, 200, { ok: true, version: cfg.version, uptime: Math.round(process.uptime()) });

  const ip = U.clientIp(req, cfg.trustProxy);
  const banned = api.ipBanned(ip);
  /* IP bans are checked at the front door, so a banned network cannot even log in */
  if (banned && !pathName.startsWith('/api/health'))
    return sendJson(res, 403, { ok: false, error: 'This network is banned.' + (banned.reason ? ' Reason: ' + banned.reason : '') });

  let body = {};
  if (req.method === 'POST') {
    try { body = await readBody(req); }
    catch (e) { return sendJson(res, 400, { ok: false, error: e.message === 'too large' ? 'Request too large' : 'Malformed request' }); }
  }

  const authz = req.headers.authorization || '';
  const ctx = {
    method: req.method, path: pathName, ip, body, headers: req.headers,
    query: Object.fromEntries(u.searchParams), bearer: authz.startsWith('Bearer ') ? authz.slice(7) : ''
  };

  const key = req.method + ' ' + pathName;
  const handler = api.routes[key];
  if (!handler) return sendJson(res, 404, { ok: false, error: 'Unknown endpoint' });

  const gated = api.banGate(ctx);
  if (gated) return sendJson(res, gated.status, gated.body);

  const general = limiter.take('any:' + ip, 600, 60e3);
  if (general) return sendJson(res, 429, { ok: false, error: 'Too many requests, slow down' });

  try {
    const out = handler(ctx) || { status: 204, body: {} };
    sendJson(res, out.status, out.body);
  } catch (e) {
    /* log with a masked address and no request body, so secrets never reach the log */
    console.error('[error]', key, 'ip=' + U.maskIp(ip), e.message);
    sendJson(res, 500, { ok: false, error: 'Something went wrong on the server' });
  }
  if (Date.now() - t0 > 1000) console.warn('[slow]', key, Date.now() - t0 + 'ms');
});

if (require.main === module) {
  server.listen(cfg.port, cfg.host, () => {
    const o = api.ownerUid();
    console.log(`HvH platform v${cfg.version} listening on http://${cfg.host}:${cfg.port}`);
    console.log(`  database   ${cfg.dbFile}`);
    console.log(`  static     ${cfg.serveStatic ? cfg.staticDir : 'disabled'}`);
    console.log(`  trustProxy ${cfg.trustProxy}   origins ${cfg.origins.join(', ')}`);
    console.log(o ? `  owner      UID ${o}` : '  owner      not set yet - the first account to register becomes the owner');
    if (!cfg.trustProxy) console.log('  note: set TRUST_PROXY=1 if you deploy behind a proxy, or every player looks like one IP');
  });
  const bye = () => { try { db.close(); } catch (e) {} process.exit(0); };
  process.on('SIGINT', bye); process.on('SIGTERM', bye);
}

module.exports = { server, db, api, cfg };
