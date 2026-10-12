/* HvH platform - database layer.
   Zero dependencies: uses node:sqlite (Node 22.5+). One file on disk, WAL mode.
   Every schema change is a numbered migration so an existing database upgrades in place. */
'use strict';
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const MIGRATIONS = [
  // 1 - accounts, sessions, connection metadata, moderation
  `CREATE TABLE users(
     uid       INTEGER PRIMARY KEY AUTOINCREMENT,
     username  TEXT    NOT NULL,
     uname_lc  TEXT    NOT NULL UNIQUE,
     pw        TEXT    NOT NULL,
     created   INTEGER NOT NULL,
     last_seen INTEGER,
     banned    INTEGER NOT NULL DEFAULT 0,
     ban_reason TEXT,
     ban_at    INTEGER,
     ban_by    INTEGER
   );
   CREATE TABLE sessions(
     token   TEXT PRIMARY KEY,
     uid     INTEGER NOT NULL,
     created INTEGER NOT NULL,
     expires INTEGER NOT NULL,
     last_ip TEXT,
     ua      TEXT
   );
   CREATE INDEX idx_sessions_uid ON sessions(uid);
   CREATE TABLE conn_log(
     id  INTEGER PRIMARY KEY AUTOINCREMENT,
     uid INTEGER NOT NULL,
     ip  TEXT NOT NULL,
     at  INTEGER NOT NULL
   );
   CREATE INDEX idx_conn_ip  ON conn_log(ip);
   CREATE INDEX idx_conn_uid ON conn_log(uid);
   CREATE TABLE ip_bans(
     id      INTEGER PRIMARY KEY AUTOINCREMENT,
     cidr    TEXT NOT NULL UNIQUE,
     reason  TEXT,
     note    TEXT,
     created INTEGER NOT NULL,
     by_uid  INTEGER,
     active  INTEGER NOT NULL DEFAULT 1
   );
   CREATE TABLE kicks(
     uid    INTEGER PRIMARY KEY,
     at     INTEGER NOT NULL,
     reason TEXT
   );
   CREATE TABLE audit(
     id        INTEGER PRIMARY KEY AUTOINCREMENT,
     at        INTEGER NOT NULL,
     actor_uid INTEGER,
     action    TEXT NOT NULL,
     target    TEXT,
     detail    TEXT,
     ok        INTEGER NOT NULL DEFAULT 1
   );
   CREATE INDEX idx_audit_at ON audit(at);
   CREATE TABLE meta(k TEXT PRIMARY KEY, v TEXT NOT NULL);`,

  // 2 - matches and lobbies
  `CREATE TABLE matches(
     id        TEXT PRIMARY KEY,
     code      TEXT UNIQUE,
     host_uid  INTEGER NOT NULL,
     mode      TEXT NOT NULL,
     status    TEXT NOT NULL,
     cap       INTEGER NOT NULL,
     visible   INTEGER NOT NULL DEFAULT 1,
     created   INTEGER NOT NULL,
     touched   INTEGER NOT NULL,
     started   INTEGER,
     ended     INTEGER,
     bracket_id INTEGER
   );
   CREATE INDEX idx_match_status ON matches(status);
   CREATE TABLE match_players(
     match_id TEXT NOT NULL,
     uid      INTEGER NOT NULL,
     slot     INTEGER NOT NULL,
     joined   INTEGER NOT NULL,
     PRIMARY KEY(match_id, uid)
   );
   CREATE INDEX idx_mp_uid ON match_players(uid);`,

  // 3 - tournaments
  `CREATE TABLE tournaments(
     id           INTEGER PRIMARY KEY AUTOINCREMENT,
     name         TEXT NOT NULL,
     descr        TEXT,
     team_size    INTEGER NOT NULL,
     max_teams    INTEGER NOT NULL,
     best_of      INTEGER NOT NULL DEFAULT 1,
     maps         TEXT,
     rules        TEXT,
     visibility   TEXT NOT NULL DEFAULT 'public',
     status       TEXT NOT NULL DEFAULT 'draft',
     reg_open_at  INTEGER,
     reg_close_at INTEGER,
     start_at     INTEGER,
     created      INTEGER NOT NULL,
     by_uid       INTEGER NOT NULL
   );
   CREATE TABLE teams(
     id            INTEGER PRIMARY KEY AUTOINCREMENT,
     tournament_id INTEGER NOT NULL,
     name          TEXT NOT NULL,
     name_lc       TEXT NOT NULL,
     captain_uid   INTEGER NOT NULL,
     created       INTEGER NOT NULL,
     seed          INTEGER,
     UNIQUE(tournament_id, name_lc)
   );
   CREATE TABLE team_members(
     team_id INTEGER NOT NULL,
     uid     INTEGER NOT NULL,
     joined  INTEGER NOT NULL,
     PRIMARY KEY(team_id, uid)
   );
   CREATE INDEX idx_tm_uid ON team_members(uid);
   CREATE TABLE bracket(
     id            INTEGER PRIMARY KEY AUTOINCREMENT,
     tournament_id INTEGER NOT NULL,
     round         INTEGER NOT NULL,
     slot          INTEGER NOT NULL,
     team_a        INTEGER,
     team_b        INTEGER,
     winner        INTEGER,
     score_a       INTEGER NOT NULL DEFAULT 0,
     score_b       INTEGER NOT NULL DEFAULT 0,
     status        TEXT NOT NULL DEFAULT 'pending',
     map           TEXT,
     scheduled     INTEGER,
     match_id      TEXT,
     UNIQUE(tournament_id, round, slot)
   );
   CREATE INDEX idx_bracket_t ON bracket(tournament_id);`,

  // 4 - messaging
  `CREATE TABLE messages(
     id       INTEGER PRIMARY KEY AUTOINCREMENT,
     to_uid   INTEGER,
     from_uid INTEGER,
     kind     TEXT NOT NULL DEFAULT 'dm',
     subject  TEXT NOT NULL,
     body     TEXT NOT NULL,
     created  INTEGER NOT NULL
   );
   CREATE INDEX idx_msg_to ON messages(to_uid, created);
   CREATE TABLE message_reads(
     msg_id INTEGER NOT NULL,
     uid    INTEGER NOT NULL,
     at     INTEGER NOT NULL,
     PRIMARY KEY(msg_id, uid)
   );`,

  // 5 - anti-cheat reports raised by peers during a match
  `CREATE TABLE reports(
     id       INTEGER PRIMARY KEY AUTOINCREMENT,
     at       INTEGER NOT NULL,
     match_id TEXT,
     by_uid   INTEGER NOT NULL,
     about_uid INTEGER,
     kind     TEXT NOT NULL,
     detail   TEXT
   );
   CREATE INDEX idx_rep_about ON reports(about_uid);`
];

function open(file) {
  const dir = path.dirname(file);
  if (dir && dir !== '.' && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('CREATE TABLE IF NOT EXISTS schema_version(v INTEGER NOT NULL)');
  let row = db.prepare('SELECT v FROM schema_version').get();
  if (!row) { db.prepare('INSERT INTO schema_version(v) VALUES(0)').run(); row = { v: 0 }; }
  for (let i = row.v; i < MIGRATIONS.length; i++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[i]);
      db.prepare('UPDATE schema_version SET v = ?').run(i + 1);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw new Error('migration ' + (i + 1) + ' failed: ' + e.message); }
  }
  return db;
}

/* Run fn inside a transaction; rolls back and rethrows on error. */
function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { try { db.exec('ROLLBACK'); } catch (_) {} throw e; }
}

module.exports = { open, tx, MIGRATIONS };
