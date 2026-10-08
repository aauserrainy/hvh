# HvH Sandbox - Online 1v1 (CS:GO + Rust)

Static site. Everything runs in the browser, so it hosts for free on GitHub Pages.
Online play is peer-to-peer (WebRTC via PeerJS), so no game server is needed.

## Files
- `index.html`   launcher
- `csgo.html`    CS:GO HvH sandbox (offline + online 1v1)
- `rust.html`    Rust HvH sandbox (offline + online 1v1)
- `mirage.html`  Mirage map viewer
- `net.js`       lobby + networking (host / join / sync)
- `peerjs.min.js` PeerJS 1.5.4 (included so there is no extra CDN)
- `.nojekyll`    tells GitHub Pages to serve files as-is

## Put it online (GitHub Pages)
1. Make a free account at github.com and click **New repository**. Name it `hvh` (any name works), set it to **Public**, and click **Create repository**.
2. On the new repo page click **uploading an existing file**.
3. Unzip this folder first. Drag **all the files inside it** (not the folder itself) into the page: `index.html, csgo.html, rust.html, mirage.html, net.js, peerjs.min.js` and `.nojekyll`. Click **Commit changes**.
   (If `.nojekyll` is hidden on your computer you can skip it, the site still works.)
4. Go to **Settings -> Pages**. Under **Build and deployment** set **Source: Deploy from a branch**, **Branch: main**, **Folder: / (root)**, then **Save**.
5. Wait 1-2 minutes and refresh. The page shows your link: `https://YOURNAME.github.io/hvh/`.

## Play a friend
1. You: open `.../csgo.html` (or `rust.html`), click **ONLINE 1v1**, then **HOST A MATCH**.
2. Send your friend the 5-letter code or press **COPY LINK** and send that link.
3. Friend: open the link (joins automatically) or type the code and press **JOIN**.
4. Both see "Connected". Click the game to capture the mouse. `Esc` frees it.

Both players must use the **same page** (both CS:GO, or both Rust).

## What is synced
- CS:GO: positions, view angle, crouch, anti-aim state (desync side), shots/tracers, kills. Hits are decided by the shooter's ragebot against your real, offset hitbox, so resolver misses are real. Deathmatch rules: instant respawn, free guns (keys 1-9 and 0).
- Rust: positions, view angle, held weapon, arrows and tracers, damage, built pieces and doors. Bots are turned off during a match. Your normal base save is paused while online.

## If you cannot connect
- Use Chrome, Edge or Firefox, turn off VPNs and tracker blockers for the site, and have the host click HOST again for a fresh code.
- Some networks (school, work, some mobile data) block direct connections. Fix: add a TURN relay in `net.js` (the `iceServers` list near the top), for example a free tier from a TURN provider:
  `{urls:'turn:YOUR.TURN.HOST:3478',username:'USER',credential:'PASS'}`
- The free PeerJS cloud broker can be busy occasionally. You can run your own with `npx peerjs --port 9000` and open the page with `?peerhost=YOURHOST&peerport=9000&secure=1`.

## Test locally
Run `python3 -m http.server 8000` in this folder and open `http://localhost:8000`. Open two tabs to test both sides.
