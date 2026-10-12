# Running the HvH platform

The game is static files. **Accounts, matchmaking, tournaments, bans and the owner
dashboard need a server that can run Node and keep a database**, which GitHub Pages
cannot do. So there are two pieces:

| Piece | What it is | Where it goes |
|---|---|---|
| The client | `index.html`, `csgo.html`, `admin.html`, `app.js`, `net.js`, `audio.js`, `lua.js`, `lib/`, `scripts/` | anywhere static — GitHub Pages is fine |
| The backend | `server/` | a host that runs Node 22.5 or newer |

You can also serve both from the backend and skip the static host entirely.

## Requirements

Node **22.5 or newer** (it uses the built-in `node:sqlite`). Check with `node -v`.
There are **no dependencies** — nothing to `npm install`. The repo pins the version
three ways (`package.json` engines, `.nvmrc`, and the documented
`NIXPACKS_NODE_VERSION`), and the server exits with a plain-English message if the
host still runs something older.

## Run it locally

```bash
node server/server.js
# open http://localhost:8080
```

The first account you create becomes **UID 1, the owner**. Make it immediately,
before anyone else can reach the server.

## Configuration

Every setting is an environment variable. Nothing is hard-coded, so you never
have to edit source to deploy.

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `8080` | Port to listen on. Most hosts set this for you. |
| `HOST` | `0.0.0.0` | Interface to bind. |
| `DB_FILE` | `server/data/hvh.db` | SQLite file. **Put this on a persistent disk.** |
| `TRUST_PROXY` | off | Set to `1` **only** behind a proxy that sets `X-Forwarded-For` (Railway, Render, Fly, nginx). Off, every player looks like one address. On without a real proxy, a player can fake their address and dodge an IP ban. |
| `ORIGINS` | `*` | Comma-separated origins allowed to call the API from a browser. Set it to your site once you are live, e.g. `https://comefly.xyz`. |
| `SERVE_STATIC` | on | `0` to serve only the API. |
| `STATIC_DIR` | repo root | Folder of game files to serve. |
| `APP_VERSION` | `4.0` | Shown in the client footer and health check. |

The `server/` folder and `.git` are never served, so the database and the source
are not reachable over HTTP even with static serving on.

## Deploy on Railway (step by step)

1. **New project** → *Deploy from GitHub repo* → pick `aauserrainy/hvh`.
2. **Settings → Source**: set the branch to the one holding this code (`platform`
   until you merge it into `main`).
3. **Add a volume** (right-click the service → *Add Volume*, or Settings → Volumes).
   Mount path: `/data`. Without a volume the database is wiped on every redeploy.
4. **Variables** → add:
   - `DB_FILE` = `/data/hvh.db`
   - `TRUST_PROXY` = `1`  (Railway is a proxy; without this every player looks
     like one address and IP bans hit everyone)
   - `ORIGINS` = `https://comefly.xyz`  (add `,http://localhost:8080` while testing)
   - `NIXPACKS_NODE_VERSION` = `22`  (belt and braces — `.nvmrc` and
     `engines.node` already ask for 22, but this one always wins)
   Leave `PORT` alone; Railway sets it.
5. **Deploy.** The start command comes from `railway.json`. The build installs
   nothing, because there are no dependencies.
6. **Settings → Networking → Generate Domain.** You get something like
   `hvh-production.up.railway.app`.
7. Open `https://<your-domain>/api/health`. You want `{"ok":true,...}`.
8. Open `https://<your-domain>/` and **register immediately** — the first account
   becomes UID 1, the owner.

If the deploy crashes with a message about Node 22.5, set
`NIXPACKS_NODE_VERSION=22` and redeploy.

## Deploy the backend elsewhere

Any host that runs Node works. The start command is always `node server/server.js`.

**Render**: point it at this repo, start command `node server/server.js`, add a
persistent disk, and set `DB_FILE` to a path on it. Set `TRUST_PROXY=1` and
`ORIGINS=https://your-site`.

**Fly.io**: same, with a volume mounted at `/data`.

**Your own VPS**: put it behind nginx or Caddy with TLS, set `TRUST_PROXY=1`, and
run it under systemd so it restarts.

Always serve it over **HTTPS**. Browsers block a page on `https://` from calling an
API on `http://`, so a plain-HTTP backend will not work with a site on GitHub Pages.

## Point the game at the backend

If the backend serves the files too, nothing to do.

Otherwise the client already defaults to the deployed backend
(`https://hvh-production-bc71.up.railway.app`, set as `DEFAULT_API` in `app.js`), so
there is nothing for a player to configure. If you move the backend, change that one
constant.

To override it for a single browser, put the address in the **Game server** box on the
sign-in card. You can also link straight to it:

```
https://comefly.xyz/hvh/?api=https://your-backend.example.com
```

## Health, backups, restore

- Health check: `GET /api/health` returns `{ok, version, uptime}`.
- Backup: stop the server and copy `hvh.db`, or while running use
  `sqlite3 hvh.db ".backup backup.db"`. WAL mode means `hvh.db-wal` matters too —
  copy the whole set, or use `.backup`.
- Restore: stop the server, put the file back at `DB_FILE`, start it.
- Upgrades: migrations run automatically at startup. **Back up first.**

## Owner account

The first account registered becomes the owner, and that is recorded permanently.
If UID 1 is later deleted or banned, nobody is promoted automatically.

To move ownership (for example if you lose the password), stop the server and run:

```bash
node -e "const{open}=require('./server/db');const d=open(process.env.DB_FILE||'./server/data/hvh.db');
d.prepare(\"INSERT INTO meta(k,v) VALUES('owner_uid',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v\").run('5');
console.log('owner is now UID 5')"
```

That needs shell access to the server, which is the point: no request from a client
can change it.

## Tests

```bash
node server/test.js    # 82 backend checks: concurrency, auth, bans, brackets
node server/e2e.js     # 28 browser checks (needs Playwright + a local three.js)
```

## Security notes

- Passwords use scrypt (N=2^16, r=8, p=2) from Node's standard library. Argon2id
  would need a native module; this is the strongest option with zero dependencies.
- Sessions are random 256-bit bearer tokens, valid 14 days, revoked on ban and on
  password change.
- Registration, login, hosting and messaging are rate limited per address.
- IP addresses are visible to the owner only, are never sent to other players, and
  are masked in server logs.
- The audit log records every administrative action, including refused attempts,
  and never stores passwords or tokens.
- Keep `ORIGINS` set to your real site in production rather than `*`.
