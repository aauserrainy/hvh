# HvH Sandbox - Online 1v1 (net v3.1)

Upload ALL files in this folder (including the hidden .nojekyll) to the ROOT of your GitHub Pages repo, replacing the old ones.
DELETE the old peerjs.min.js - it is no longer used. Then hard-refresh (Ctrl+Shift+R). The lobby footer must say "net v3.1"; if it
says anything else you are looking at a cached/old copy.

## Playing
1. Open the site, pick a game, click ONLINE 1v1. HOST A MATCH, send the code/link. Friend opens the link (or types the code, JOIN).
2. Host keeps the lobby open until the friend connects. Once connected click the game to capture the mouse.

## What changed vs the old version
- No more PeerJS cloud broker (the single point of failure). Matchmaking now runs over 4 public MQTT brokers + ntfy.sh at once;
  if any one is reachable it works.
- MANUAL CONNECT: swap two copy/paste codes over Discord. Needs no matchmaking server at all.
- Position updates go on an unreliable/unordered channel (less lag spikes), shots/damage on a reliable one.
- Real diagnostics: it tells you why it failed, and whether you ended up direct or via relay.

## VPN players
Most VPNs work as-is. If one doesn't (direct connection FAILED), you need a TURN relay:
1. Free account at https://www.metered.ca -> create an app -> note the app name and API key (20 GB/month free).
2. Either: in the lobby open RELAY SETTINGS, paste `appname,apikey`, SAVE (do this on both PCs), or
   bake it in for everyone: in net.js set `const METERED={app:'yourapp',key:'yourkey'};` and re-upload (friends then need nothing).
3. If still failing on a VPN, tick "Relay only".
If your VPN also blocks WebSockets/ntfy (TEST MY NETWORK shows 0 channels), use MANUAL CONNECT.

Test locally: python3 -m http.server 8000 in this folder, open two tabs.
