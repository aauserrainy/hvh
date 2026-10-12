# Asset manifest

**No third-party art assets are bundled.** Every model, texture, and sound is generated in
code at runtime. The only vendored third-party files are JavaScript libraries, all MIT,
listed below with their licence text alongside them.

The graphics overhaul deliberately kept this property. Production asset libraries were
reviewed - Quaternius, Kenney, Poly Haven, ambientCG, OpenGameArt - and all would have
worked licence-wise (CC0 or CC-BY). They were not used because the game has no model or
texture loading pipeline at all: it is a single static HTML file with no build step and no
npm dependencies, served from GitHub Pages. Adding GLTFLoader plus binary meshes and
texture sets would mean shipping megabytes of assets, a loading screen, and an async asset
pipeline, against a backend whose whole design rule is that it installs nothing. The
improvement was made instead in the geometry, materials and lighting that are generated in
code - see the commits for measured before/after.

Valve's own CS:GO character, weapon and de_mirage assets are not used and are not
redistributable. The map is original geometry laid out to echo Mirage's routes and
architectural character, not a conversion of Valve's map.

| Item | Source | License | File | Status |
|---|---|---|---|---|
| three.js r128 | cdnjs (CDN, not bundled) | MIT | loaded from CDN by `csgo.html` | in use |
| Fengari (Lua 5.3 in JavaScript) | github.com/fengari-lua/fengari-web v0.1.4 | MIT | `lib/fengari-web.js`, `lib/FENGARI-LICENSE.txt` | in use (Lua scripting, CS:GO) |
| three.js r128 post-processing addons (EffectComposer, RenderPass, ShaderPass, MaskPass, Pass, CopyShader, SAOPass, SAOShader, DepthLimitedBlurShader, UnpackDepthRGBAShader, SMAAPass, SMAAShader) | three.js r128 `examples/js`, github.com/mrdoob/three.js | MIT | `lib/three-addons/`, `lib/three-addons/THREE-LICENSE.txt` | in use (ambient occlusion, anti-aliasing) |
| Characters, first-person arms, weapons (CS:GO) | procedural three.js geometry, original | project's own | `csgo.html` | in use |
| Textures (sand, brick, wood, sky) | procedural canvas textures, original | project's own | `csgo.html` | in use |
| Muzzle flash, impact particles | procedural sprites, original | project's own | `csgo.html` | in use |
| Hit sounds (Skeet-style, Bell, Metallic, Pop, Double tick, Impact, Helmet clank, Flesh, Thud, Tink, Hitmarker...) | WebAudio synthesis, original | project's own | `audio.js` | in use |

## Not used, and why
Sketchfab "CS:GO terrorist characters" models and CS wiki weapon references: these are ripped or derived from Valve's copyrighted game assets. They need a login to download and are not licensed for redistribution in a public repo. They were not downloaded or included. If you hold models you have the right to use (glTF/GLB), they can be added later through a loader.

## Settings
Hit sounds on/off, headshot sound, body sound, master volume, headshot volume, body volume, graphics quality (Quality / Performance), vignette.

## Backend
The `server/` backend has **no third-party dependencies**: it uses Node's built-in `node:sqlite`, `node:crypto` and `node:http` only. Nothing to install, nothing to license.
