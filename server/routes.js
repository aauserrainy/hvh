/* HvH platform - API routes. Zero dependencies. */
'use strict';
const U = require('./util');
const { tx } = require('./db');

const SESSION_DAYS = 14;
const MODES = { '1v1': 2, '2v2': 4, '3v3': 6, '4v4': 8, '5v5': 10 };
const now = () => Date.now();

/* in-memory signalling mailboxes, keyed by match id. Not persisted: they are
   WebRTC offers/answers that are worthless a few seconds later. */
const signals = new Map();
setInterval(() => {
  const cut = now() - 120e3;
  for (const [k, box] of signals) {
    box.msgs = box.msgs.filter(m => m.at > cut);
    if (!box.msgs.length && box.touched < cut) signals.delete(k);
  }
}, 30e3).unref?.();

function build(ctx) {
  const { db, limiter, cfg } = ctx;
  const q = {
    userByName: db.prepare('SELECT * FROM users WHERE uname_lc = ?'),
    userByUid: db.prepare('SELECT * FROM users WHERE uid = ?'),
    insUser: db.prepare('INSERT INTO users(username, uname_lc, pw, created) VALUES(?,?,?,?)'),
    insSession: db.prepare('INSERT INTO sessions(token, uid, created, expires, last_ip, ua) VALUES(?,?,?,?,?,?)'),
    session: db.prepare('SELECT * FROM sessions WHERE token = ?'),
    delSession: db.prepare('DELETE FROM sessions WHERE token = ?'),
    delUserSessions: db.prepare('DELETE FROM sessions WHERE uid = ?'),
    touchSession: db.prepare('UPDATE sessions SET last_ip = ? WHERE token = ?'),
    seen: db.prepare('UPDATE users SET last_seen = ? WHERE uid = ?'),
    insConn: db.prepare('INSERT INTO conn_log(uid, ip, at) VALUES(?,?,?)'),
    meta: db.prepare('SELECT v FROM meta WHERE k = ?'),
    setMeta: db.prepare('INSERT INTO meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v = excluded.v'),
    audit: db.prepare('INSERT INTO audit(at, actor_uid, action, target, detail, ok) VALUES(?,?,?,?,?,?)'),
    ipBans: db.prepare('SELECT * FROM ip_bans WHERE active = 1'),
    kick: db.prepare('SELECT * FROM kicks WHERE uid = ?'),
    delKick: db.prepare('DELETE FROM kicks WHERE uid = ?')
  };

  const audit = (actor, action, target, detail, ok = true) =>
    q.audit.run(now(), actor ?? null, action, target == null ? null : String(target), detail == null ? null : String(detail).slice(0, 500), ok ? 1 : 0);

  function ownerUid() {
    const row = q.meta.get('owner_uid');
    return row ? +row.v : null;
  }
  /* The first account created becomes the owner, recorded once. Deleting or banning
     UID 1 later never promotes anyone else - the recorded value is what counts. */
  function bootstrapOwner(uid) { if (!q.meta.get('owner_uid')) q.setMeta.run('owner_uid', String(uid)); }

  function ipBanned(ip) {
    if (!ip) return null;
    for (const b of q.ipBans.all()) if (U.ipInCidr(ip, b.cidr)) return b;
    return null;
  }

  function auth(req) {
    const t = req.bearer;
    if (!t) return null;
    const s = q.session.get(t);
    if (!s) return null;
    if (s.expires < now()) { q.delSession.run(t); return null; }
    const u = q.userByUid.get(s.uid);
    if (!u) { q.delSession.run(t); return null; }
    if (s.last_ip !== req.ip) { q.touchSession.run(req.ip, t); q.insConn.run(u.uid, req.ip, now()); }
    q.seen.run(now(), u.uid);
    return { session: s, user: u, owner: u.uid === ownerUid() };
  }
  const pub = u => ({ uid: u.uid, username: u.username, owner: u.uid === ownerUid() });

  /* ---------- helpers for route results ---------- */
  const ok = (body = {}) => ({ status: 200, body: { ok: true, ...body } });
  const err = (status, message, extra) => ({ status, body: { ok: false, error: message, ...extra } });
  const needAuth = req => { const a = auth(req); return a ? a : null; };

  const R = {};  /* 'METHOD /path' -> handler(req, params) */

  /* Checked by the dispatcher before every authenticated route: a banned account
     gets one clear answer explaining the ban, and its sessions are revoked. */
  const OPEN_PATHS = new Set(['/api/login', '/api/register', '/api/logout', '/api/health']);
  function banGate(req) {
    if (OPEN_PATHS.has(req.path) || !req.bearer) return null;
    const s = q.session.get(req.bearer);
    if (!s) return null;
    const u = q.userByUid.get(s.uid);
    if (!u || !u.banned) return null;
    q.delUserSessions.run(u.uid);
    return err(403, 'This account is banned.' + (u.ban_reason ? ' Reason: ' + u.ban_reason : ''));
  }

  /* ============ ACCOUNTS ============ */

  R['POST /api/register'] = (req) => {
    const wait = limiter.take('reg:' + req.ip, 5, 60 * 60e3);
    if (wait) return err(429, 'Too many accounts created from this network. Try again in ' + Math.ceil(wait / 60) + ' minutes.');
    const banned = ipBanned(req.ip);
    if (banned) return err(403, 'This network is banned.' + (banned.reason ? ' Reason: ' + banned.reason : ''));

    const username = U.clampStr(req.body.username, 40);
    const password = typeof req.body.password === 'string' ? req.body.password : '';
    const confirm = typeof req.body.confirm === 'string' ? req.body.confirm : password;
    let bad = U.checkUsername(username); if (bad) return err(400, bad, { field: 'username' });
    bad = U.checkPassword(password); if (bad) return err(400, bad, { field: 'password' });
    if (password !== confirm) return err(400, 'Passwords do not match', { field: 'confirm' });

    const pw = U.hashPassword(password);
    let user;
    try {
      user = tx(db, () => {
        /* uname_lc is UNIQUE: that constraint, not this check, is what makes two
           simultaneous registrations safe. uid is AUTOINCREMENT, so it is allocated
           by the database, never reused, and the first row is always uid 1. */
        const info = q.insUser.run(username, username.toLowerCase(), pw, now());
        const u = q.userByUid.get(Number(info.lastInsertRowid));
        bootstrapOwner(u.uid);
        return u;
      });
    } catch (e) {
      if (/UNIQUE/i.test(e.message)) return err(409, 'That username is already taken', { field: 'username' });
      throw e;
    }
    const tok = U.token();
    q.insSession.run(tok, user.uid, now(), now() + SESSION_DAYS * 864e5, req.ip, U.clampStr(req.headers['user-agent'], 200));
    q.insConn.run(user.uid, req.ip, now());
    audit(user.uid, 'register', user.uid, 'username=' + user.username);
    return ok({ token: tok, user: pub(user) });
  };

  R['POST /api/login'] = (req) => {
    const name = U.clampStr(req.body.username, 40).toLowerCase();
    const wait = limiter.take('login:' + req.ip, 20, 15 * 60e3) || limiter.take('login:u:' + name, 10, 15 * 60e3);
    if (wait) return err(429, 'Too many attempts. Try again in ' + Math.ceil(wait / 60) + ' minutes.');
    const banned = ipBanned(req.ip);
    if (banned) return err(403, 'This network is banned.' + (banned.reason ? ' Reason: ' + banned.reason : ''));

    const u = q.userByName.get(name);
    const okPw = u ? U.verifyPassword(String(req.body.password || ''), u.pw) : U.verifyPassword('x', U.hashPassword('y'));
    if (!u || !okPw) { audit(u ? u.uid : null, 'login_fail', name, 'ip=' + U.maskIp(req.ip), false); return err(401, 'Wrong username or password'); }
    if (u.banned) return err(403, 'This account is banned.' + (u.ban_reason ? ' Reason: ' + u.ban_reason : ''));

    const tok = U.token();
    q.insSession.run(tok, u.uid, now(), now() + SESSION_DAYS * 864e5, req.ip, U.clampStr(req.headers['user-agent'], 200));
    q.insConn.run(u.uid, req.ip, now());
    limiter.clear('login:u:' + name);
    audit(u.uid, 'login', u.uid, null);
    return ok({ token: tok, user: pub(u) });
  };

  R['POST /api/logout'] = (req) => { if (req.bearer) q.delSession.run(req.bearer); return ok(); };

  R['GET /api/me'] = (req) => {
    const a = needAuth(req); if (!a) return err(401, 'Not signed in');
    if (a.user.banned) { q.delUserSessions.run(a.user.uid); return err(403, 'This account is banned.' + (a.user.ban_reason ? ' Reason: ' + a.user.ban_reason : '')); }
    const k = q.kick.get(a.user.uid);
    if (k) q.delKick.run(a.user.uid);
    const unread = db.prepare(
      `SELECT COUNT(*) n FROM messages m WHERE (m.to_uid = ? OR m.to_uid IS NULL)
         AND NOT EXISTS(SELECT 1 FROM message_reads r WHERE r.msg_id = m.id AND r.uid = ?)`).get(a.user.uid, a.user.uid).n;
    const mine = db.prepare(
      `SELECT m.* FROM matches m JOIN match_players p ON p.match_id = m.id
        WHERE p.uid = ? AND m.status IN ('open','live') ORDER BY m.created DESC LIMIT 1`).get(a.user.uid);
    return ok({ user: pub(a.user), unread, kicked: k ? { reason: k.reason, at: k.at } : null, match: mine ? matchView(mine, a.user.uid) : null, version: cfg.version });
  };

  R['POST /api/account/password'] = (req) => {
    const a = needAuth(req); if (!a) return err(401, 'Not signed in');
    if (!U.verifyPassword(String(req.body.current || ''), a.user.pw)) return err(401, 'Current password is wrong');
    const bad = U.checkPassword(req.body.password); if (bad) return err(400, bad);
    db.prepare('UPDATE users SET pw = ? WHERE uid = ?').run(U.hashPassword(req.body.password), a.user.uid);
    db.prepare('DELETE FROM sessions WHERE uid = ? AND token <> ?').run(a.user.uid, req.bearer);
    audit(a.user.uid, 'password_change', a.user.uid, null);
    return ok();
  };

  /* ============ MATCHES ============ */

  function matchView(m, viewerUid) {
    const players = db.prepare(
      `SELECT p.uid, p.slot, p.team, u.username FROM match_players p JOIN users u ON u.uid = p.uid
        WHERE p.match_id = ? ORDER BY p.slot`).all(m.id);
    return {
      id: m.id, mode: m.mode, status: m.status, cap: m.cap,
      code: (viewerUid && players.some(p => p.uid === viewerUid)) ? m.code : undefined,
      host: m.host_uid, players, created: m.created,
      win_rounds: m.win_rounds, bracket_id: m.bracket_id
    };
  }
  const touchMatch = id => db.prepare('UPDATE matches SET touched = ? WHERE id = ?').run(now(), id);

  /* Drop lobbies nobody has touched for 3 minutes, and matches live for over 3 hours. */
  function sweep() {
    const t = now();
    db.prepare(`UPDATE matches SET status='abandoned', ended=? WHERE status='open' AND touched < ?`).run(t, t - 180e3);
    db.prepare(`UPDATE matches SET status='ended', ended=? WHERE status='live' AND touched < ?`).run(t, t - 3 * 3600e3);
  }

  function leaveAll(uid) {
    const rows = db.prepare(
      `SELECT m.id, m.host_uid, m.status FROM matches m JOIN match_players p ON p.match_id = m.id
        WHERE p.uid = ? AND m.status IN ('open','live')`).all(uid);
    for (const m of rows) {
      db.prepare('DELETE FROM match_players WHERE match_id = ? AND uid = ?').run(m.id, uid);
      const left = db.prepare('SELECT COUNT(*) n FROM match_players WHERE match_id = ?').get(m.id).n;
      if (!left || m.host_uid === uid) db.prepare(`UPDATE matches SET status='abandoned', ended=? WHERE id=?`).run(now(), m.id);
    }
  }

  R['POST /api/match/host'] = (req) => {
    const a = needAuth(req); if (!a) return err(401, 'Not signed in');
    if (a.user.banned) return err(403, 'This account is banned.');
    const wait = limiter.take('host:' + a.user.uid, 20, 10 * 60e3);
    if (wait) return err(429, 'Slow down a moment, then try again.');
    sweep();
    const mode = MODES[req.body.mode] ? req.body.mode : '1v1';
    const visible = req.body.visible === false ? 0 : 1;
    const m = tx(db, () => {
      leaveAll(a.user.uid);
      const id = U.matchId();
      let code = U.joinCode();
      for (let i = 0; i < 5 && db.prepare('SELECT 1 FROM matches WHERE code = ? AND status = \'open\'').get(code); i++) code = U.joinCode();
      db.prepare(`INSERT INTO matches(id, code, host_uid, mode, status, cap, visible, created, touched)
                  VALUES(?,?,?,?,'open',?,?,?,?)`).run(id, code, a.user.uid, mode, MODES[mode], visible, now(), now());
      db.prepare('INSERT INTO match_players(match_id, uid, slot, joined) VALUES(?,?,0,?)').run(id, a.user.uid, now());
      return db.prepare('SELECT * FROM matches WHERE id = ?').get(id);
    });
    audit(a.user.uid, 'match_host', m.id, 'mode=' + mode);
    return ok({ match: matchView(m, a.user.uid) });
  };

  function joinMatch(user, m) {
    return tx(db, () => {
      const fresh = db.prepare('SELECT * FROM matches WHERE id = ?').get(m.id);
      if (!fresh || fresh.status !== 'open') return { e: 'That match is no longer open' };
      const n = db.prepare('SELECT COUNT(*) n FROM match_players WHERE match_id = ?').get(fresh.id).n;
      if (db.prepare('SELECT 1 FROM match_players WHERE match_id = ? AND uid = ?').get(fresh.id, user.uid))
        return { m: fresh };
      if (n >= fresh.cap) return { e: 'That match is full' };
      leaveAll(user.uid);
      db.prepare('INSERT INTO match_players(match_id, uid, slot, joined) VALUES(?,?,?,?)').run(fresh.id, user.uid, n, now());
      const total = db.prepare('SELECT COUNT(*) n FROM match_players WHERE match_id = ?').get(fresh.id).n;
      if (total >= fresh.cap) db.prepare(`UPDATE matches SET status='live', started=?, touched=? WHERE id=?`).run(now(), now(), fresh.id);
      else touchMatch(fresh.id);
      return { m: db.prepare('SELECT * FROM matches WHERE id = ?').get(fresh.id) };
    });
  }

  R['POST /api/match/join'] = (req) => {
    const a = needAuth(req); if (!a) return err(401, 'Not signed in');
    if (a.user.banned) return err(403, 'This account is banned.');
    sweep();
    const code = U.clampStr(req.body.code, 12).toUpperCase();
    if (!code) return err(400, 'Enter a match code');
    const m = db.prepare('SELECT * FROM matches WHERE code = ? ORDER BY created DESC').get(code);
    if (!m) return err(404, 'No match with that code');
    if (m.status === 'live') {
      if (db.prepare('SELECT 1 FROM match_players WHERE match_id = ? AND uid = ?').get(m.id, a.user.uid))
        return ok({ match: matchView(m, a.user.uid) });
      return err(409, 'That match is already full');
    }
    if (m.status !== 'open') return err(409, 'That match has finished');
    const r = joinMatch(a.user, m);
    if (r.e) return err(409, r.e);
    audit(a.user.uid, 'match_join', r.m.id, 'code');
    return ok({ match: matchView(r.m, a.user.uid) });
  };

  R['POST /api/match/quick'] = (req) => {
    const a = needAuth(req); if (!a) return err(401, 'Not signed in');
    if (a.user.banned) return err(403, 'This account is banned.');
    sweep();
    const mode = MODES[req.body.mode] ? req.body.mode : '1v1';
    const cands = db.prepare(
      `SELECT m.*, (SELECT COUNT(*) FROM match_players p WHERE p.match_id = m.id) n
         FROM matches m WHERE m.status='open' AND m.visible=1 AND m.mode=? AND m.host_uid <> ?
        ORDER BY n DESC, m.created ASC LIMIT 10`).all(mode, a.user.uid);
    for (const c of cands) {
      if (c.n >= c.cap) continue;
      const r = joinMatch(a.user, c);
      if (r.m) { audit(a.user.uid, 'match_quick', r.m.id, 'mode=' + mode); return ok({ match: matchView(r.m, a.user.uid) }); }
    }
    return ok({ match: null, message: 'No open matches right now' });
  };

  R['GET /api/match/open'] = (req) => {
    const a = needAuth(req); if (!a) return err(401, 'Not signed in');
    sweep();
    const rows = db.prepare(
      `SELECT m.id, m.mode, m.cap, m.created, u.username host,
              (SELECT COUNT(*) FROM match_players p WHERE p.match_id = m.id) n
         FROM matches m JOIN users u ON u.uid = m.host_uid
        WHERE m.status='open' AND m.visible=1 ORDER BY m.created DESC LIMIT 40`).all();
    return ok({ matches: rows });
  };

  R['GET /api/match/state'] = (req) => {
    const a = needAuth(req); if (!a) return err(401, 'Not signed in');
    const id = U.clampStr(req.query.id, 64);
    const m = db.prepare('SELECT * FROM matches WHERE id = ?').get(id);
    if (!m) return err(404, 'Match not found');
    const mine = db.prepare('SELECT 1 FROM match_players WHERE match_id = ? AND uid = ?').get(id, a.user.uid);
    if (mine) touchMatch(id);
    return ok({ match: matchView(m, a.user.uid) });
  };

  R['POST /api/match/leave'] = (req) => {
    const a = needAuth(req); if (!a) return err(401, 'Not signed in');
    tx(db, () => leaveAll(a.user.uid));
    return ok();
  };

  /* --- match signalling: the backend carries the WebRTC handshake, so players
         never see broker names or connection strings. --- */
  R['POST /api/match/signal'] = (req) => {
    const a = needAuth(req); if (!a) return err(401, 'Not signed in');
    const id = U.clampStr(req.body.match, 64);
    if (!db.prepare('SELECT 1 FROM match_players WHERE match_id = ? AND uid = ?').get(id, a.user.uid))
      return err(403, 'You are not in that match');
    const box = signals.get(id) || { msgs: [], seq: 0, touched: now() };
    box.touched = now();
    const payload = U.clampStr(JSON.stringify(req.body.data ?? null), 20000);
    box.msgs.push({ seq: ++box.seq, from: a.user.uid, data: payload, at: now() });
    if (box.msgs.length > 60) box.msgs.shift();
    signals.set(id, box);
    touchMatch(id);
    return ok({ seq: box.seq });
  };

  R['GET /api/match/signal'] = (req) => {
    const a = needAuth(req); if (!a) return err(401, 'Not signed in');
    const id = U.clampStr(req.query.match, 64);
    if (!db.prepare('SELECT 1 FROM match_players WHERE match_id = ? AND uid = ?').get(id, a.user.uid))
      return err(403, 'You are not in that match');
    const since = U.toInt(req.query.since, 0);
    const box = signals.get(id);
    touchMatch(id);
    const msgs = box ? box.msgs.filter(m => m.seq > since && m.from !== a.user.uid) : [];
    return ok({ seq: box ? box.seq : 0, msgs: msgs.map(m => ({ seq: m.seq, from: m.from, data: JSON.parse(m.data) })) });
  };

  R['POST /api/report'] = (req) => {
    const a = needAuth(req); if (!a) return err(401, 'Not signed in');
    if (limiter.take('rep:' + a.user.uid, 30, 10 * 60e3)) return ok();  /* silently drop spam */
    db.prepare('INSERT INTO reports(at, match_id, by_uid, about_uid, kind, detail) VALUES(?,?,?,?,?,?)')
      .run(now(), U.clampStr(req.body.match, 64) || null, a.user.uid, U.toInt(req.body.about, 0) || null,
           U.clampStr(req.body.kind, 40) || 'other', U.clampStr(req.body.detail, 300));
    return ok();
  };

  /* ============ LOBBY CHAT ============ */

  const CHAT_KEEP = 300;        /* rows retained */
  const ONLINE_WINDOW = 75e3;   /* counted as present if seen this recently */

  function onlineUsers() {
    return db.prepare(
      `SELECT uid, username, last_seen FROM users WHERE last_seen > ? AND banned = 0
        ORDER BY username COLLATE NOCASE LIMIT 100`).all(now() - ONLINE_WINDOW)
      .map(u => ({ uid: u.uid, username: u.username, owner: u.uid === ownerUid() }));
  }

  R['GET /api/chat'] = (req) => {
    const a = needAuth(req); if (!a) return err(401, 'Not signed in');
    const since = U.toInt(req.query.since, 0);
    const rows = db.prepare(
      `SELECT c.id, c.uid, c.body, c.created, u.username
         FROM chat c JOIN users u ON u.uid = c.uid
        WHERE c.id > ? AND c.hidden = 0
        ORDER BY c.id DESC LIMIT 60`).all(since).reverse();
    const own = ownerUid();
    return ok({ messages: rows.map(m => ({ ...m, owner: m.uid === own })), online: onlineUsers() });
  };

  R['POST /api/chat/send'] = (req) => {
    const a = needAuth(req); if (!a) return err(401, 'Not signed in');
    if (a.user.banned) return err(403, 'This account is banned.');
    const body = U.clampStr(req.body.body, 300);
    if (!body) return err(400, 'Say something first');
    const wait = limiter.take('chat:' + a.user.uid, 12, 20e3);
    if (wait) return err(429, 'You are sending messages too quickly');
    const info = db.prepare('INSERT INTO chat(uid, body, created) VALUES(?,?,?)').run(a.user.uid, body, now());
    /* keep the table small - this is a live chat, not an archive */
    db.prepare('DELETE FROM chat WHERE id <= (SELECT MAX(id) FROM chat) - ?').run(CHAT_KEEP);
    return ok({ id: Number(info.lastInsertRowid) });
  };

  R['POST /api/admin/chat/hide'] = (req) => {
    const g = needOwner(req); if (g.e) return g.e;
    const id = U.toInt(req.body.id, 0);
    db.prepare('UPDATE chat SET hidden = 1 WHERE id = ?').run(id);
    audit(g.a.user.uid, 'chat_hide', id, null);
    return ok();
  };

  R['POST /api/admin/chat/clear'] = (req) => {
    const g = needOwner(req); if (g.e) return g.e;
    db.prepare('UPDATE chat SET hidden = 1 WHERE hidden = 0').run();
    audit(g.a.user.uid, 'chat_clear', null, null);
    return ok();
  };

  /* ============ INBOX ============ */

  R['GET /api/inbox'] = (req) => {
    const a = needAuth(req); if (!a) return err(401, 'Not signed in');
    const rows = db.prepare(
      `SELECT m.id, m.kind, m.subject, m.body, m.created, m.from_uid, m.to_uid IS NULL AS broadcast,
              EXISTS(SELECT 1 FROM message_reads r WHERE r.msg_id = m.id AND r.uid = ?) AS read
         FROM messages m WHERE m.to_uid = ? OR m.to_uid IS NULL
        ORDER BY m.created DESC LIMIT 60`).all(a.user.uid, a.user.uid);
    return ok({ messages: rows });
  };

  R['POST /api/inbox/read'] = (req) => {
    const a = needAuth(req); if (!a) return err(401, 'Not signed in');
    const ids = Array.isArray(req.body.ids) ? req.body.ids.slice(0, 100).map(x => U.toInt(x, 0)) : [];
    const st = db.prepare('INSERT OR IGNORE INTO message_reads(msg_id, uid, at) VALUES(?,?,?)');
    tx(db, () => ids.forEach(id => { if (id) st.run(id, a.user.uid, now()); }));
    return ok();
  };

  /* ============ TOURNAMENTS ============ */

  const T_STATUS = ['draft', 'open', 'closed', 'bracket', 'live', 'completed', 'cancelled'];

  function tournamentView(t, viewerUid) {
    const teams = db.prepare(
      `SELECT tm.id, tm.name, tm.captain_uid, tm.seed,
              (SELECT GROUP_CONCAT(u.username, ', ') FROM team_members mm JOIN users u ON u.uid = mm.uid WHERE mm.team_id = tm.id) members,
              (SELECT COUNT(*) FROM team_members mm WHERE mm.team_id = tm.id) size
         FROM teams tm WHERE tm.tournament_id = ? ORDER BY tm.seed, tm.id`).all(t.id);
    const bracket = db.prepare('SELECT * FROM bracket WHERE tournament_id = ? ORDER BY round, slot').all(t.id);
    const mine = viewerUid ? db.prepare(
      `SELECT tm.id FROM teams tm JOIN team_members mm ON mm.team_id = tm.id
        WHERE tm.tournament_id = ? AND mm.uid = ?`).get(t.id, viewerUid) : null;
    return { ...t, teams, bracket, myTeam: mine ? mine.id : null };
  }

  R['GET /api/tournaments'] = (req) => {
    const a = auth(req);
    const isOwner = a && a.owner;
    const rows = db.prepare(
      `SELECT t.*, (SELECT COUNT(*) FROM teams tm WHERE tm.tournament_id = t.id) team_count
         FROM tournaments t ${isOwner ? '' : `WHERE t.visibility='public' AND t.status <> 'draft'`}
        ORDER BY t.created DESC LIMIT 50`).all();
    return ok({ tournaments: rows });
  };

  R['GET /api/tournament'] = (req) => {
    const a = auth(req);
    const t = db.prepare('SELECT * FROM tournaments WHERE id = ?').get(U.toInt(req.query.id, 0));
    if (!t) return err(404, 'Tournament not found');
    if (t.visibility !== 'public' && !(a && a.owner)) return err(404, 'Tournament not found');
    return ok({ tournament: tournamentView(t, a ? a.user.uid : null) });
  };

  R['POST /api/tournament/register'] = (req) => {
    const a = needAuth(req); if (!a) return err(401, 'Not signed in');
    if (a.user.banned) return err(403, 'This account is banned.');
    const t = db.prepare('SELECT * FROM tournaments WHERE id = ?').get(U.toInt(req.body.id, 0));
    if (!t) return err(404, 'Tournament not found');
    if (t.status !== 'open') return err(409, 'Registration is not open');
    if (t.reg_close_at && now() > t.reg_close_at) return err(409, 'Registration has closed');
    if (t.reg_open_at && now() < t.reg_open_at) return err(409, 'Registration has not opened yet');
    const name = U.clampStr(req.body.team, 32) || a.user.username + "'s team";
    try {
      const team = tx(db, () => {
        if (db.prepare(`SELECT 1 FROM teams tm JOIN team_members mm ON mm.team_id = tm.id WHERE tm.tournament_id=? AND mm.uid=?`).get(t.id, a.user.uid))
          throw new Error('ALREADY');
        const count = db.prepare('SELECT COUNT(*) n FROM teams WHERE tournament_id = ?').get(t.id).n;
        if (count >= t.max_teams) throw new Error('FULL');
        const info = db.prepare('INSERT INTO teams(tournament_id, name, name_lc, captain_uid, created) VALUES(?,?,?,?,?)')
          .run(t.id, name, name.toLowerCase(), a.user.uid, now());
        const id = Number(info.lastInsertRowid);
        db.prepare('INSERT INTO team_members(team_id, uid, joined) VALUES(?,?,?)').run(id, a.user.uid, now());
        return id;
      });
      audit(a.user.uid, 'tournament_register', t.id, 'team=' + name);
      return ok({ team });
    } catch (e) {
      if (e.message === 'ALREADY') return err(409, 'You are already registered in this tournament');
      if (e.message === 'FULL') return err(409, 'This tournament is full');
      if (/UNIQUE/i.test(e.message)) return err(409, 'That team name is taken');
      throw e;
    }
  };

  R['POST /api/tournament/join-team'] = (req) => {
    const a = needAuth(req); if (!a) return err(401, 'Not signed in');
    const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(U.toInt(req.body.team, 0));
    if (!team) return err(404, 'Team not found');
    const t = db.prepare('SELECT * FROM tournaments WHERE id = ?').get(team.tournament_id);
    if (t.status !== 'open') return err(409, 'Registration is not open');
    try {
      tx(db, () => {
        if (db.prepare(`SELECT 1 FROM teams tm JOIN team_members mm ON mm.team_id = tm.id WHERE tm.tournament_id=? AND mm.uid=?`).get(t.id, a.user.uid))
          throw new Error('ALREADY');
        const n = db.prepare('SELECT COUNT(*) n FROM team_members WHERE team_id = ?').get(team.id).n;
        if (n >= t.team_size) throw new Error('FULL');
        db.prepare('INSERT INTO team_members(team_id, uid, joined) VALUES(?,?,?)').run(team.id, a.user.uid, now());
      });
    } catch (e) {
      if (e.message === 'ALREADY') return err(409, 'You are already in a team for this tournament');
      if (e.message === 'FULL') return err(409, 'That team is full');
      throw e;
    }
    return ok();
  };

  R['POST /api/tournament/leave'] = (req) => {
    const a = needAuth(req); if (!a) return err(401, 'Not signed in');
    const t = db.prepare('SELECT * FROM tournaments WHERE id = ?').get(U.toInt(req.body.id, 0));
    if (!t) return err(404, 'Tournament not found');
    if (!['open', 'draft'].includes(t.status)) return err(409, 'You cannot leave once the bracket exists');
    tx(db, () => {
      const row = db.prepare(`SELECT tm.id, tm.captain_uid FROM teams tm JOIN team_members mm ON mm.team_id = tm.id
                               WHERE tm.tournament_id=? AND mm.uid=?`).get(t.id, a.user.uid);
      if (!row) return;
      db.prepare('DELETE FROM team_members WHERE team_id = ? AND uid = ?').run(row.id, a.user.uid);
      const left = db.prepare('SELECT COUNT(*) n FROM team_members WHERE team_id = ?').get(row.id).n;
      if (!left || row.captain_uid === a.user.uid) {
        db.prepare('DELETE FROM team_members WHERE team_id = ?').run(row.id);
        db.prepare('DELETE FROM teams WHERE id = ?').run(row.id);
      }
    });
    return ok();
  };

  /* Single elimination with byes. Teams are seeded in registration order unless
     the owner has set seeds. With n teams the bracket is the next power of two;
     the top (size - n) seeds get a first-round bye. */
  function generateBracket(t) {
    const teams = db.prepare('SELECT id FROM teams WHERE tournament_id = ? ORDER BY COALESCE(seed, 999999), id').all(t.id).map(r => r.id);
    const n = teams.length;
    if (n < 2) throw new Error('NEEDS_2');
    let size = 1; while (size < n) size *= 2;
    const byes = size - n;
    /* slot order so that seed 1 and seed 2 can only meet in the final */
    const order = [0];
    for (let r = 1; r < size; r *= 2) {
      const next = [];
      for (const s of order) { next.push(s); next.push(r * 2 - 1 - s); }
      order.length = 0; order.push(...next);
    }
    const seeded = new Array(size).fill(null);
    order.forEach((pos, i) => { seeded[pos] = i < n ? teams[i] : null; });
    /* give the byes to the strongest seeds: they already pair against the null slots */
    db.prepare('DELETE FROM bracket WHERE tournament_id = ?').run(t.id);
    const ins = db.prepare(`INSERT INTO bracket(tournament_id, round, slot, team_a, team_b, status, map)
                            VALUES(?,?,?,?,?,?,?)`);
    const maps = (t.maps || '').split(',').map(s => s.trim()).filter(Boolean);
    const rounds = Math.log2(size);
    for (let slot = 0; slot < size / 2; slot++) {
      const a = seeded[slot * 2], b = seeded[slot * 2 + 1];
      ins.run(t.id, 1, slot, a, b, a && b ? 'pending' : 'bye', maps[slot % (maps.length || 1)] || null);
    }
    for (let r = 2; r <= rounds; r++)
      for (let slot = 0; slot < size / Math.pow(2, r); slot++) ins.run(t.id, r, slot, null, null, 'pending', null);
    /* resolve byes immediately */
    for (const m of db.prepare(`SELECT * FROM bracket WHERE tournament_id=? AND status='bye'`).all(t.id)) {
      const w = m.team_a || m.team_b;
      db.prepare('UPDATE bracket SET winner=?, status=? WHERE id=?').run(w, w ? 'done' : 'empty', m.id);
      if (w) advance(t.id, m.round, m.slot, w);
    }
    db.prepare(`UPDATE tournaments SET status='bracket' WHERE id=?`).run(t.id);
    return { size, byes, rounds };
  }
  function advance(tid, round, slot, winner) {
    const parent = db.prepare('SELECT * FROM bracket WHERE tournament_id=? AND round=? AND slot=?').get(tid, round + 1, Math.floor(slot / 2));
    if (!parent) return;
    const col = slot % 2 === 0 ? 'team_a' : 'team_b';
    db.prepare(`UPDATE bracket SET ${col}=? WHERE id=?`).run(winner, parent.id);
    const fresh = db.prepare('SELECT * FROM bracket WHERE id=?').get(parent.id);
    /* if the other side is a resolved empty slot, this team walks on */
    if (fresh.team_a && !fresh.team_b) {
      const sib = db.prepare('SELECT * FROM bracket WHERE tournament_id=? AND round=? AND slot=?').get(tid, round, Math.floor(slot / 2) * 2 + (slot % 2 === 0 ? 1 : 0));
      if (sib && sib.status === 'empty') {
        db.prepare(`UPDATE bracket SET winner=?, status='done' WHERE id=?`).run(fresh.team_a, fresh.id);
        advance(tid, fresh.round, fresh.slot, fresh.team_a);
      }
    }
  }

  /* ============ OWNER ADMIN ============ */

  function needOwner(req) {
    const a = auth(req);
    if (!a) return { e: err(401, 'Not signed in') };
    if (!a.owner) { audit(a.user.uid, 'admin_denied', null, 'path=' + req.path, false); return { e: err(403, 'Not allowed') }; }
    return { a };
  }

  R['GET /api/admin/overview'] = (req) => {
    const g = needOwner(req); if (g.e) return g.e;
    sweep();
    const one = (sql, ...p) => db.prepare(sql).get(...p);
    const online = one(`SELECT COUNT(DISTINCT uid) n FROM sessions WHERE expires > ? AND uid IN (SELECT uid FROM users WHERE last_seen > ?)`, now(), now() - 120e3).n;
    return ok({
      accounts: one('SELECT COUNT(*) n FROM users').n,
      online,
      live: one(`SELECT COUNT(*) n FROM matches WHERE status='live'`).n,
      lobbies: one(`SELECT COUNT(*) n FROM matches WHERE status='open'`).n,
      tournaments: one(`SELECT COUNT(*) n FROM tournaments WHERE status IN ('open','bracket','live')`).n,
      banned: one('SELECT COUNT(*) n FROM users WHERE banned=1').n,
      ipBans: one('SELECT COUNT(*) n FROM ip_bans WHERE active=1').n,
      reports: one('SELECT COUNT(*) n FROM reports').n,
      recentUsers: db.prepare('SELECT uid, username, created, banned FROM users ORDER BY created DESC LIMIT 8').all(),
      recentAudit: db.prepare('SELECT * FROM audit ORDER BY at DESC LIMIT 12').all(),
      health: { uptime: Math.round(process.uptime()), rss: process.memoryUsage().rss, version: cfg.version, node: process.version }
    });
  };

  R['GET /api/admin/users'] = (req) => {
    const g = needOwner(req); if (g.e) return g.e;
    const term = U.clampStr(req.query.q, 40);
    const rows = term
      ? db.prepare(`SELECT uid, username, created, last_seen, banned, ban_reason FROM users
                     WHERE uname_lc LIKE ? OR uid = ? ORDER BY uid LIMIT 100`).all('%' + term.toLowerCase() + '%', U.toInt(term, -1))
      : db.prepare('SELECT uid, username, created, last_seen, banned, ban_reason FROM users ORDER BY uid LIMIT 100').all();
    return ok({ users: rows, ownerUid: ownerUid() });
  };

  R['GET /api/admin/user'] = (req) => {
    const g = needOwner(req); if (g.e) return g.e;
    const uid = U.toInt(req.query.uid, 0);
    const u = db.prepare('SELECT uid, username, created, last_seen, banned, ban_reason, ban_at, ban_by FROM users WHERE uid = ?').get(uid);
    if (!u) return err(404, 'No such account');
    const ips = db.prepare(`SELECT ip, COUNT(*) hits, MAX(at) last FROM conn_log WHERE uid = ? GROUP BY ip ORDER BY last DESC LIMIT 20`).all(uid);
    /* Shared-address investigation. A shared IP is a signal, not proof: households,
       schools, phone networks and VPNs all put unrelated people on one address. */
    const alts = ips.length ? db.prepare(
      `SELECT c.uid, u.username, MAX(c.at) last, u.banned, COUNT(DISTINCT c.ip) shared
         FROM conn_log c JOIN users u ON u.uid = c.uid
        WHERE c.ip IN (${ips.map(() => '?').join(',')}) AND c.uid <> ?
        GROUP BY c.uid ORDER BY last DESC LIMIT 30`).all(...ips.map(i => i.ip), uid) : [];
    const matches = db.prepare(
      `SELECT m.id, m.mode, m.status, m.created FROM matches m JOIN match_players p ON p.match_id = m.id
        WHERE p.uid = ? ORDER BY m.created DESC LIMIT 10`).all(uid);
    const sessions = db.prepare('SELECT created, expires, last_ip, ua FROM sessions WHERE uid = ? ORDER BY created DESC LIMIT 10').all(uid);
    const reports = db.prepare('SELECT * FROM reports WHERE about_uid = ? ORDER BY at DESC LIMIT 20').all(uid);
    audit(g.a.user.uid, 'admin_view_user', uid, null);
    return ok({ user: u, ips, alts, matches, sessions, reports, owner: uid === ownerUid() });
  };

  R['POST /api/admin/kick'] = (req) => {
    const g = needOwner(req); if (g.e) return g.e;
    const uid = U.toInt(req.body.uid, 0), reason = U.clampStr(req.body.reason, 200) || 'Kicked by an administrator';
    if (!db.prepare('SELECT 1 FROM users WHERE uid = ?').get(uid)) return err(404, 'No such account');
    tx(db, () => {
      db.prepare('INSERT INTO kicks(uid, at, reason) VALUES(?,?,?) ON CONFLICT(uid) DO UPDATE SET at=excluded.at, reason=excluded.reason').run(uid, now(), reason);
      leaveAll(uid);
    });
    audit(g.a.user.uid, 'kick', uid, reason);
    return ok();
  };

  R['POST /api/admin/ban'] = (req) => {
    const g = needOwner(req); if (g.e) return g.e;
    const uid = U.toInt(req.body.uid, 0), reason = U.clampStr(req.body.reason, 200);
    if (uid === ownerUid()) return err(400, 'The owner account cannot be banned');
    if (!db.prepare('SELECT 1 FROM users WHERE uid = ?').get(uid)) return err(404, 'No such account');
    tx(db, () => {
      db.prepare('UPDATE users SET banned=1, ban_reason=?, ban_at=?, ban_by=? WHERE uid=?').run(reason, now(), g.a.user.uid, uid);
      leaveAll(uid);
    });
    audit(g.a.user.uid, 'ban', uid, reason);
    return ok();
  };

  R['POST /api/admin/unban'] = (req) => {
    const g = needOwner(req); if (g.e) return g.e;
    const uid = U.toInt(req.body.uid, 0);
    db.prepare('UPDATE users SET banned=0, ban_reason=NULL WHERE uid=?').run(uid);
    audit(g.a.user.uid, 'unban', uid, U.clampStr(req.body.reason, 200));
    return ok();
  };

  R['GET /api/admin/ipbans'] = (req) => {
    const g = needOwner(req); if (g.e) return g.e;
    return ok({ bans: db.prepare('SELECT * FROM ip_bans ORDER BY created DESC LIMIT 200').all() });
  };

  R['POST /api/admin/ipban'] = (req) => {
    const g = needOwner(req); if (g.e) return g.e;
    const parsed = U.parseCidr(req.body.cidr);
    if (!parsed) return err(400, 'That is not a valid IP address or range');
    const mine = db.prepare('SELECT last_ip FROM sessions WHERE token = ?').get(req.bearer);
    if (mine && U.ipInCidr(mine.last_ip, parsed)) return err(400, 'That range covers your own address - you would lock yourself out');
    try {
      db.prepare('INSERT INTO ip_bans(cidr, reason, note, created, by_uid, active) VALUES(?,?,?,?,?,1)')
        .run(parsed.text, U.clampStr(req.body.reason, 200), U.clampStr(req.body.note, 500), now(), g.a.user.uid);
    } catch (e) {
      if (/UNIQUE/i.test(e.message)) { db.prepare('UPDATE ip_bans SET active=1, reason=?, created=? WHERE cidr=?').run(U.clampStr(req.body.reason, 200), now(), parsed.text); }
      else throw e;
    }
    audit(g.a.user.uid, 'ip_ban', parsed.text, U.clampStr(req.body.reason, 200));
    return ok({ cidr: parsed.text });
  };

  R['POST /api/admin/unipban'] = (req) => {
    const g = needOwner(req); if (g.e) return g.e;
    const id = U.toInt(req.body.id, 0);
    const row = db.prepare('SELECT * FROM ip_bans WHERE id = ?').get(id);
    if (!row) return err(404, 'No such ban');
    db.prepare('UPDATE ip_bans SET active=0 WHERE id=?').run(id);
    audit(g.a.user.uid, 'ip_unban', row.cidr, null);
    return ok();
  };

  R['GET /api/admin/ip'] = (req) => {
    const g = needOwner(req); if (g.e) return g.e;
    const ip = U.normIp(U.clampStr(req.query.ip, 60));
    const rows = db.prepare(
      `SELECT c.uid, u.username, MAX(c.at) last, COUNT(*) hits, u.banned
         FROM conn_log c JOIN users u ON u.uid = c.uid WHERE c.ip = ? GROUP BY c.uid ORDER BY last DESC`).all(ip);
    audit(g.a.user.uid, 'admin_lookup_ip', U.maskIp(ip), null);
    return ok({ ip, accounts: rows, banned: !!ipBanned(ip) });
  };

  R['GET /api/admin/audit'] = (req) => {
    const g = needOwner(req); if (g.e) return g.e;
    return ok({ entries: db.prepare('SELECT * FROM audit ORDER BY at DESC LIMIT 200').all() });
  };

  R['GET /api/admin/matches'] = (req) => {
    const g = needOwner(req); if (g.e) return g.e;
    sweep();
    const rows = db.prepare(
      `SELECT m.*, (SELECT COUNT(*) FROM match_players p WHERE p.match_id=m.id) n,
              (SELECT GROUP_CONCAT(u.username, ', ') FROM match_players p JOIN users u ON u.uid=p.uid WHERE p.match_id=m.id) players
         FROM matches m WHERE m.status IN ('open','live') ORDER BY m.created DESC LIMIT 60`).all();
    return ok({ matches: rows });
  };

  R['POST /api/admin/match/end'] = (req) => {
    const g = needOwner(req); if (g.e) return g.e;
    const id = U.clampStr(req.body.id, 64);
    db.prepare(`UPDATE matches SET status='ended', ended=? WHERE id=?`).run(now(), id);
    audit(g.a.user.uid, 'match_end', id, U.clampStr(req.body.reason, 200));
    return ok();
  };

  R['POST /api/admin/message'] = (req) => {
    const g = needOwner(req); if (g.e) return g.e;
    const subject = U.clampStr(req.body.subject, 120), body = U.clampStr(req.body.body, 4000);
    if (!subject || !body) return err(400, 'Subject and message are both required');
    if (limiter.take('msg:' + g.a.user.uid, 60, 10 * 60e3)) return err(429, 'Too many messages, slow down');
    const broadcast = !!req.body.broadcast;
    const to = broadcast ? null : U.toInt(req.body.uid, 0);
    if (!broadcast && !db.prepare('SELECT 1 FROM users WHERE uid = ?').get(to)) return err(404, 'No such account');
    const info = db.prepare('INSERT INTO messages(to_uid, from_uid, kind, subject, body, created) VALUES(?,?,?,?,?,?)')
      .run(to, g.a.user.uid, broadcast ? 'announcement' : 'dm', subject, body, now());
    audit(g.a.user.uid, broadcast ? 'announce' : 'dm', to, subject);
    /* stored and visible to the recipient on their next inbox fetch - no push delivery */
    return ok({ id: Number(info.lastInsertRowid), delivery: 'stored' });
  };

  R['GET /api/admin/announcements'] = (req) => {
    const g = needOwner(req); if (g.e) return g.e;
    return ok({ messages: db.prepare('SELECT * FROM messages ORDER BY created DESC LIMIT 100').all() });
  };

  R['GET /api/admin/reports'] = (req) => {
    const g = needOwner(req); if (g.e) return g.e;
    return ok({ reports: db.prepare(
      `SELECT r.*, a.username by_name, b.username about_name FROM reports r
         LEFT JOIN users a ON a.uid=r.by_uid LEFT JOIN users b ON b.uid=r.about_uid
        ORDER BY r.at DESC LIMIT 100`).all() });
  };

  /* --- tournament administration --- */
  R['POST /api/admin/tournament'] = (req) => {
    const g = needOwner(req); if (g.e) return g.e;
    const b = req.body;
    const size = U.toInt(b.team_size, 1);
    if (![1, 2, 3, 4, 5].includes(size)) return err(400, 'Team size must be 1 to 5');
    const maxTeams = U.toInt(b.max_teams, 8);
    if (maxTeams < 2 || maxTeams > 128) return err(400, 'Max teams must be between 2 and 128');
    const name = U.clampStr(b.name, 80); if (!name) return err(400, 'Name is required');
    const bo = [1, 3, 5].includes(U.toInt(b.best_of, 1)) ? U.toInt(b.best_of, 1) : 1;
    const info = db.prepare(
      `INSERT INTO tournaments(name, descr, team_size, max_teams, best_of, maps, rules, visibility, status,
                               reg_open_at, reg_close_at, start_at, created, by_uid)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      name, U.clampStr(b.descr, 2000), size, maxTeams, bo, U.clampStr(b.maps, 300), U.clampStr(b.rules, 2000),
      b.visibility === 'private' ? 'private' : 'public', 'draft',
      U.toInt(b.reg_open_at, 0) || null, U.toInt(b.reg_close_at, 0) || null, U.toInt(b.start_at, 0) || null,
      now(), g.a.user.uid);
    audit(g.a.user.uid, 'tournament_create', Number(info.lastInsertRowid), name);
    return ok({ id: Number(info.lastInsertRowid) });
  };

  R['POST /api/admin/tournament/status'] = (req) => {
    const g = needOwner(req); if (g.e) return g.e;
    const id = U.toInt(req.body.id, 0), status = U.clampStr(req.body.status, 20);
    if (!T_STATUS.includes(status)) return err(400, 'Unknown status');
    const t = db.prepare('SELECT * FROM tournaments WHERE id = ?').get(id);
    if (!t) return err(404, 'Tournament not found');
    if (status === 'bracket' && !db.prepare('SELECT 1 FROM bracket WHERE tournament_id = ?').get(id))
      return err(409, 'Generate the bracket first');
    db.prepare('UPDATE tournaments SET status=? WHERE id=?').run(status, id);
    audit(g.a.user.uid, 'tournament_status', id, status);
    return ok();
  };

  R['POST /api/admin/tournament/bracket'] = (req) => {
    const g = needOwner(req); if (g.e) return g.e;
    const t = db.prepare('SELECT * FROM tournaments WHERE id = ?').get(U.toInt(req.body.id, 0));
    if (!t) return err(404, 'Tournament not found');
    if (['live', 'completed'].includes(t.status) && !req.body.force)
      return err(409, 'The tournament has already started. Pass force to regenerate.');
    try {
      const info = tx(db, () => generateBracket(t));
      audit(g.a.user.uid, 'bracket_generate', t.id, 'size=' + info.size + ' byes=' + info.byes);
      return ok(info);
    } catch (e) {
      if (e.message === 'NEEDS_2') return err(409, 'At least two teams are needed');
      throw e;
    }
  };

  R['POST /api/admin/tournament/result'] = (req) => {
    const g = needOwner(req); if (g.e) return g.e;
    const m = db.prepare('SELECT * FROM bracket WHERE id = ?').get(U.toInt(req.body.match, 0));
    if (!m) return err(404, 'Bracket match not found');
    const winner = U.toInt(req.body.winner, 0);
    if (winner !== m.team_a && winner !== m.team_b) return err(400, 'The winner must be one of the two teams in that match');
    tx(db, () => {
      db.prepare('UPDATE bracket SET winner=?, score_a=?, score_b=?, status=? WHERE id=?')
        .run(winner, U.toInt(req.body.score_a, 0), U.toInt(req.body.score_b, 0), 'done', m.id);
      advance(m.tournament_id, m.round, m.slot, winner);
      const left = db.prepare(`SELECT COUNT(*) n FROM bracket WHERE tournament_id=? AND status='pending' AND team_a IS NOT NULL AND team_b IS NOT NULL`).get(m.tournament_id).n;
      const finalRound = db.prepare('SELECT MAX(round) r FROM bracket WHERE tournament_id=?').get(m.tournament_id).r;
      const fin = db.prepare('SELECT * FROM bracket WHERE tournament_id=? AND round=?').get(m.tournament_id, finalRound);
      if (!left && fin && fin.winner) db.prepare(`UPDATE tournaments SET status='completed' WHERE id=?`).run(m.tournament_id);
      else db.prepare(`UPDATE tournaments SET status='live' WHERE id=? AND status='bracket'`).run(m.tournament_id);
    });
    audit(g.a.user.uid, 'bracket_result', m.id, 'winner=' + winner);
    return ok();
  };

  /* ============ TOURNAMENT MATCH LOBBY ============
     A bracket match is only a record until the players actually turn up. These
     two routes turn it into a real lobby: the first player on either side to
     press Join creates the match and links it to the bracket row, everyone else
     joins the same one, and the match goes live by itself the moment both teams
     are complete. Membership is checked server side against team_members, so a
     client cannot put itself into a match it was never drawn into. */

  function bracketLobby(b, viewerUid) {
    const t = db.prepare('SELECT * FROM tournaments WHERE id = ?').get(b.tournament_id);
    const side = (teamId) => db.prepare(
      `SELECT u.uid, u.username,
              (SELECT COUNT(*) FROM match_players p WHERE p.match_id = ? AND p.uid = mm.uid) joined
         FROM team_members mm JOIN users u ON u.uid = mm.uid
        WHERE mm.team_id = ? ORDER BY u.uid`).all(b.match_id || '', teamId);
    const a = side(b.team_a), c = side(b.team_b);
    const m = b.match_id ? db.prepare('SELECT * FROM matches WHERE id = ?').get(b.match_id) : null;
    const nameOf = id => (db.prepare('SELECT name FROM teams WHERE id = ?').get(id) || {}).name || null;
    return {
      bracket: b.id, round: b.round, slot: b.slot, status: b.status,
      team_size: t ? t.team_size : 1,
      win_rounds: m ? m.win_rounds : 12,
      teams: { a: { id: b.team_a, name: nameOf(b.team_a), players: a },
               c: { id: b.team_b, name: nameOf(b.team_b), players: c } },
      ready: a.filter(p => p.joined).length + c.filter(p => p.joined).length,
      need: (t ? t.team_size : 1) * 2,
      match: m ? matchView(m, viewerUid) : null
    };
  }

  /* Which of the two drawn teams this player belongs to, or null. */
  function sideOf(b, uid) {
    const row = db.prepare(
      `SELECT mm.team_id FROM team_members mm WHERE mm.uid = ? AND mm.team_id IN (?, ?)`).get(uid, b.team_a, b.team_b);
    return row ? row.team_id : null;
  }

  R['GET /api/tournament/match'] = (req) => {
    const a = auth(req);
    const b = db.prepare('SELECT * FROM bracket WHERE id = ?').get(U.toInt(req.query.match, 0));
    if (!b) return err(404, 'Bracket match not found');
    return ok({ lobby: bracketLobby(b, a ? a.user.uid : null) });
  };

  R['POST /api/tournament/match/join'] = (req) => {
    const a = needAuth(req); if (!a) return err(401, 'Not signed in');
    if (a.user.banned) return err(403, 'This account is banned.');
    sweep();
    const b = db.prepare('SELECT * FROM bracket WHERE id = ?').get(U.toInt(req.body.match, 0));
    if (!b) return err(404, 'Bracket match not found');
    if (!b.team_a || !b.team_b) return err(409, 'This match is still waiting on an opponent');
    if (b.status === 'done') return err(409, 'This match has already been played');

    const t = db.prepare('SELECT * FROM tournaments WHERE id = ?').get(b.tournament_id);
    if (!t) return err(404, 'Tournament not found');
    if (!['bracket', 'live'].includes(t.status))
      return err(409, 'The tournament is not ready to be played yet');

    const myTeam = sideOf(b, a.user.uid);
    if (!myTeam) return err(403, 'You are not on either team in this match');

    const r = tx(db, () => {
      const fresh = db.prepare('SELECT * FROM bracket WHERE id = ?').get(b.id);
      let m = fresh.match_id ? db.prepare('SELECT * FROM matches WHERE id = ?').get(fresh.match_id) : null;
      /* A finished or swept match must not trap the bracket row forever. */
      if (m && m.status === 'done') m = null;
      if (!m) {
        const size = t.team_size, mode = size + 'v' + size;
        const id = U.matchId();
        let code = U.joinCode();
        for (let i = 0; i < 5 && db.prepare(`SELECT 1 FROM matches WHERE code = ? AND status = 'open'`).get(code); i++) code = U.joinCode();
        db.prepare(`INSERT INTO matches(id, code, host_uid, mode, status, cap, visible, created, touched, bracket_id, win_rounds)
                    VALUES(?,?,?,?,'open',?,0,?,?,?,?)`)
          .run(id, code, a.user.uid, mode, (MODES[mode] || size * 2), now(), now(), fresh.id, 12);
        db.prepare('UPDATE bracket SET match_id = ? WHERE id = ?').run(id, fresh.id);
        m = db.prepare('SELECT * FROM matches WHERE id = ?').get(id);
      }
      if (db.prepare('SELECT 1 FROM match_players WHERE match_id = ? AND uid = ?').get(m.id, a.user.uid))
        return { m: db.prepare('SELECT * FROM matches WHERE id = ?').get(m.id) };
      if (m.status !== 'open') return { e: 'That match has already started' };
      const n = db.prepare('SELECT COUNT(*) n FROM match_players WHERE match_id = ?').get(m.id).n;
      if (n >= m.cap) return { e: 'That match is full' };
      leaveAll(a.user.uid);
      db.prepare('INSERT INTO match_players(match_id, uid, slot, joined, team) VALUES(?,?,?,?,?)')
        .run(m.id, a.user.uid, n, now(), myTeam === fresh.team_a ? 'T' : 'CT');
      const total = db.prepare('SELECT COUNT(*) n FROM match_players WHERE match_id = ?').get(m.id).n;
      if (total >= m.cap) db.prepare(`UPDATE matches SET status='live', started=?, touched=? WHERE id=?`).run(now(), now(), m.id);
      else touchMatch(m.id);
      return { m: db.prepare('SELECT * FROM matches WHERE id = ?').get(m.id) };
    });
    if (r.e) return err(409, r.e);
    audit(a.user.uid, 'cup_match_join', r.m.id, 'bracket=' + b.id);
    const fresh = db.prepare('SELECT * FROM bracket WHERE id = ?').get(b.id);
    return ok({ lobby: bracketLobby(fresh, a.user.uid) });
  };

  R['POST /api/admin/tournament/schedule'] = (req) => {
    const g = needOwner(req); if (g.e) return g.e;
    const m = db.prepare('SELECT * FROM bracket WHERE id = ?').get(U.toInt(req.body.match, 0));
    if (!m) return err(404, 'Bracket match not found');
    db.prepare('UPDATE bracket SET scheduled=?, map=? WHERE id=?')
      .run(U.toInt(req.body.scheduled, 0) || null, U.clampStr(req.body.map, 40) || m.map, m.id);
    audit(g.a.user.uid, 'bracket_schedule', m.id, null);
    return ok();
  };

  R['POST /api/admin/tournament/remove-team'] = (req) => {
    const g = needOwner(req); if (g.e) return g.e;
    const id = U.toInt(req.body.team, 0);
    const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(id);
    if (!team) return err(404, 'Team not found');
    tx(db, () => {
      db.prepare('DELETE FROM team_members WHERE team_id = ?').run(id);
      db.prepare('DELETE FROM teams WHERE id = ?').run(id);
    });
    audit(g.a.user.uid, 'tournament_remove_team', id, team.name);
    return ok();
  };

  return { routes: R, auth, ownerUid, ipBanned, sweep, banGate, _generateBracket: generateBracket };
}

module.exports = { build, MODES };
