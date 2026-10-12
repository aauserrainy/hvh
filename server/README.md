# server/

Zero-dependency Node backend for the HvH platform. See `../DEPLOY.md` for running
and deploying it.

| File | Purpose |
|---|---|
| `server.js` | HTTP server, static files, CORS, IP-ban gate, entry point |
| `routes.js` | every API endpoint |
| `db.js` | schema and numbered migrations (`node:sqlite`) |
| `util.js` | password hashing, tokens, validation, rate limiting, CIDR matching |
| `test.js` | 82 backend tests |
| `e2e.js` | 28 browser tests (needs Playwright) |

Run: `node server/server.js` · Test: `node server/test.js`
