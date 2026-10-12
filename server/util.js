/* HvH platform - crypto, validation, rate limiting, IP handling. Zero dependencies. */
'use strict';
const crypto = require('crypto');

/* ---------- password hashing ----------
   scrypt from Node's crypto, with parameters above the OWASP minimum
   (N=2^16, r=8, p=2 -> ~64 MB of memory per hash). Format: scrypt$N$r$p$salt$hash
   Argon2id would need a native module; scrypt is the strongest option in the standard library. */
const SCRYPT = { N: 1 << 16, r: 8, p: 2, keylen: 64 };

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(pw, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: 256 * 1024 * 1024 });
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), h.toString('base64')].join('$');
}

function verifyPassword(pw, stored) {
  try {
    const [alg, N, r, p, saltB64, hashB64] = String(stored).split('$');
    if (alg !== 'scrypt') return false;
    const salt = Buffer.from(saltB64, 'base64'), want = Buffer.from(hashB64, 'base64');
    const got = crypto.scryptSync(pw, salt, want.length, { N: +N, r: +r, p: +p, maxmem: 256 * 1024 * 1024 });
    return got.length === want.length && crypto.timingSafeEqual(got, want);
  } catch (e) { return false; }
}

const token = (n = 32) => crypto.randomBytes(n).toString('base64url');
const matchId = () => crypto.randomUUID();
function joinCode() {
  const al = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let s = ''; const b = crypto.randomBytes(6);
  for (let i = 0; i < 6; i++) s += al[b[i] % al.length];
  return s;
}

/* ---------- validation ---------- */
const USERNAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{2,19}$/;
function checkUsername(u) {
  if (typeof u !== 'string') return 'Username is required';
  u = u.trim();
  if (u.length < 3) return 'Username must be at least 3 characters';
  if (u.length > 20) return 'Username must be at most 20 characters';
  if (!USERNAME_RE.test(u)) return 'Use letters, numbers, dot, dash or underscore; must start with a letter or number';
  return null;
}
function checkPassword(p) {
  if (typeof p !== 'string') return 'Password is required';
  if (p.length < 8) return 'Password must be at least 8 characters';
  if (p.length > 200) return 'Password must be at most 200 characters';
  return null;
}
const clampStr = (v, n, d = '') => (typeof v === 'string' ? v.trim().slice(0, n) : d);
const toInt = (v, d = 0) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; };

/* ---------- rate limiting (in-memory sliding window) ---------- */
function makeLimiter() {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [k, arr] of hits) {
      const keep = arr.filter(t => now - t < 3600e3);
      if (keep.length) hits.set(k, keep); else hits.delete(k);
    }
  }, 60e3).unref?.();
  return {
    /* returns null if allowed, or seconds to wait */
    take(key, max, windowMs) {
      const now = Date.now();
      const arr = (hits.get(key) || []).filter(t => now - t < windowMs);
      if (arr.length >= max) { hits.set(key, arr); return Math.ceil((windowMs - (now - arr[0])) / 1000); }
      arr.push(now); hits.set(key, arr); return null;
    },
    clear(key) { hits.delete(key); }
  };
}

/* ---------- IP handling ----------
   Behind a proxy (Railway/Render/Fly all proxy), the socket address is the proxy's.
   TRUST_PROXY must be set explicitly, otherwise a client could spoof X-Forwarded-For. */
function clientIp(req, trustProxy) {
  if (trustProxy) {
    const xff = req.headers['x-forwarded-for'];
    if (xff) {
      const first = String(xff).split(',')[0].trim();
      if (first) return normIp(first);
    }
    const real = req.headers['x-real-ip'];
    if (real) return normIp(String(real).trim());
  }
  return normIp(req.socket?.remoteAddress || '');
}
function normIp(ip) {
  if (!ip) return '';
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);          // IPv4-mapped IPv6
  const pct = ip.indexOf('%'); if (pct > -1) ip = ip.slice(0, pct); // zone id
  return ip;
}
/* Mask for ordinary logs: keep enough to be useful, drop enough to not be an identifier. */
function maskIp(ip) {
  if (!ip) return '';
  if (ip.includes(':')) return ip.split(':').slice(0, 3).join(':') + ':…';
  const p = ip.split('.'); return p.length === 4 ? p[0] + '.' + p[1] + '.x.x' : 'x.x.x.x';
}

/* IPv4 and IPv6 CIDR matching, for IP bans. */
function ipToBytes(ip) {
  if (!ip) return null;
  if (ip.includes('.') && !ip.includes(':')) {
    const p = ip.split('.');
    if (p.length !== 4) return null;
    const b = Buffer.alloc(4);
    for (let i = 0; i < 4; i++) { const n = +p[i]; if (!(n >= 0 && n <= 255) || p[i] === '') return null; b[i] = n; }
    return b;
  }
  if (!ip.includes(':')) return null;
  const halves = ip.split('::');
  if (halves.length > 2) return null;
  const expand = s => (s ? s.split(':').filter(x => x !== '') : []);
  const head = expand(halves[0]), tail = halves.length === 2 ? expand(halves[1]) : [];
  const fill = 8 - head.length - tail.length;
  if (halves.length === 1 ? head.length !== 8 : fill < 0) return null;
  const groups = halves.length === 2 ? [...head, ...Array(fill).fill('0'), ...tail] : head;
  const b = Buffer.alloc(16);
  for (let i = 0; i < 8; i++) {
    const n = parseInt(groups[i], 16);
    if (!Number.isFinite(n) || n < 0 || n > 0xffff) return null;
    b[i * 2] = n >> 8; b[i * 2 + 1] = n & 255;
  }
  return b;
}
function parseCidr(s) {
  s = String(s || '').trim();
  const [ip, maskStr] = s.split('/');
  const bytes = ipToBytes(ip);
  if (!bytes) return null;
  const full = bytes.length * 8;
  const bits = maskStr === undefined ? full : toInt(maskStr, -1);
  if (bits < 0 || bits > full) return null;
  return { bytes, bits, text: maskStr === undefined ? ip : ip + '/' + bits };
}
function ipInCidr(ip, cidr) {
  const a = ipToBytes(ip), c = typeof cidr === 'string' ? parseCidr(cidr) : cidr;
  if (!a || !c || a.length !== c.bytes.length) return false;
  let bits = c.bits, i = 0;
  while (bits >= 8) { if (a[i] !== c.bytes[i]) return false; i++; bits -= 8; }
  if (bits === 0) return true;
  const m = 0xff << (8 - bits) & 0xff;
  return (a[i] & m) === (c.bytes[i] & m);
}

module.exports = {
  hashPassword, verifyPassword, token, matchId, joinCode,
  checkUsername, checkPassword, clampStr, toInt,
  makeLimiter, clientIp, normIp, maskIp, parseCidr, ipInCidr, ipToBytes
};
