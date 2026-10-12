# HvH — project notes for Claude

A browser CS:GO-style HvH game plus a small multiplayer platform around it.
Owner: aauserrainy. Repo: https://github.com/aauserrainy/hvh

## Shape of the thing

Two halves, deployed separately:

- **Client** — static files at the repo root. Served from GitHub Pages at
  `comefly.xyz/hvh`, and also by the backend.
- **Backend** — `server/`. Node, **zero dependencies**. Runs on Railway at
  `hvh-production-bc71.up.railway.app`.

GitHub Pages cannot run the backend. That is why `app.js` has a `DEFAULT_API`
constant pointing at the Railway deployment.

| File | What it is |
|---|---|
| `index.html` | the client: login/register, main menu, lobbies, tournaments, inbox |
| `admin.html` | owner-only dashboard (UID 1) |
| `app.js` | shared API client; holds `DEFAULT_API` |
| `csgo.html` | the whole game — renderer, bots, cheat menu, netcode glue |
| `net.js` | WebRTC peer connection + signalling transports |
| `audio.js` | synthesised hit sounds (no audio files) |
| `lua.js`, `lib/fengari-web.js`, `scripts/` | sandboxed Lua scripting |
| `server/` | the backend (see `server/README.md`) |
| `DEPLOY.md` | how to run and deploy |
| `LUA_API.md` | the scripting API |
| `ASSETS.md` | asset manifest and licences |

## Running it

```bash
node server/server.js     # serves API + game on :8080
node server/test.js         # 95 backend tests
node server/e2e.js          # 30 browser tests, full platform (needs Playwright)
node server/chat-e2e.js     # 24 browser tests, menu + chat
node server/respawn-e2e.js  #  9 browser tests, 1v1 netcode
node server/assets-e2e.js   # 15 browser tests, external model pipeline
```

Node **22.5+** is required — the backend uses the built-in `node:sqlite`.

## Things that will bite you

- **No npm dependencies, deliberately.** The backend uses only `node:sqlite`,
  `node:crypto` and `node:http`. Keep it that way: it is what makes deployment
  a single command with nothing to install. Do not add a package unless there
  is no alternative, and say so clearly if you do.
- **The game is peer to peer.** There is no server in the match. So the server
  *cannot* validate movement or hit registration, and the IP in the dashboard is
  the address used to reach the backend, not the game traffic. Each client
  polices its opponent's movement instead and reports impossible speed. Do not
  describe this as server-authoritative anti-cheat.
- **Never rewrite the opponent's position.** Each client owns where it is.
  `validateRemote` detects and reports, and deliberately does not clamp: an
  earlier version did, which dragged a respawning opponent back to the spot
  where they died — parking them on top of whoever had just killed them, who
  could then kill them repeatedly while they stood somewhere else entirely.
  A respawn, a death, spawn protection and a packet gap all re-baseline the
  check rather than counting as a teleport.
- **Deaths are acknowledged, not assumed.** `dmg()` refuses a kill against a
  remote player who is spawn protected (`b.inv`, carried in the state packet)
  or who already has an unacknowledged kill in flight (`b.ko`).
- **`csgo.html` is one enormous script.** Declaration order matters: `SPEC` and
  `show('Rage')` run at the top level, so anything they touch (`ONLINE_MATCH`,
  `blocked()`, `RANKED_OFF`) must be declared above them or you get a temporal
  dead zone error at load.
- **Online restrictions are enforced where values are used**, not in the menu —
  `canManip()`, `canMagic()`, `moveSpeed()`. Hiding a control is not enough; a
  config import or a Lua script would walk straight past it.
- **Models are generated in code; `assets/` is optional.** `assets/manifest.json`
  is fetched once at startup and, if present, its glTF models replace the
  generated ones. No manifest means the built-in models are used - that is the
  default and what Pages serves, not an error. `assets/manifest.json`,
  `assets/models/` and `assets/textures/` are gitignored, because the repo is
  public and Pages serves it: only redistributable assets may be committed
  there. Game-ripped assets are not redistributable whatever the file format.
- **`dt` is clamped at both ends.** `now` in `tick()` is the rAF timestamp, the
  time the frame started, while `t0` is seeded from `performance.now()` after
  it - so a slow load can make the first frame's elapsed time negative. Every
  accumulator that decays by `dt` then grows: that is what parked the viewmodel
  five units behind the camera and made the weapon vanish. Do not remove the
  lower bound.
- **Bump the `?v=` query** on `app.js` / `net.js` / `csgo.html` when you change
  them, or Pages and browsers serve the stale file.
- **UID 1 is the owner**, recorded once in the `meta` table at bootstrap. Deleting
  or banning UID 1 does not promote anyone else.
- **`TRUST_PROXY`** must be `1` on Railway. Off, every player looks like one
  address and an IP ban hits everybody. On without a real proxy in front, a
  client can spoof `X-Forwarded-For` and dodge bans.

## Conventions

- Both test suites should pass before anything is pushed.
- Work on a branch and open a PR; `main` is what Pages serves.
- Test visual and gameplay changes by actually rendering them (Playwright with a
  local three.js r128 build), not by reading the code and assuming.
