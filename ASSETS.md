# Asset manifest

**No third-party assets are bundled.** Every model, texture, and sound is generated in code at runtime.

| Item | Source | License | File | Status |
|---|---|---|---|---|
| three.js r128 | cdnjs (CDN, not bundled) | MIT | loaded from CDN by `csgo.html` / `rust.html` | in use |
| Characters, first-person arms, weapons (CS:GO) | procedural three.js geometry, original | project's own | `csgo.html` | in use |
| Textures (sand, brick, wood, sky) | procedural canvas textures, original | project's own | `csgo.html` | in use |
| Muzzle flash, impact particles | procedural sprites, original | project's own | `csgo.html` | in use |
| Hit sounds (Skeet-style, Bell, Metallic, Pop, Double tick, Rust headshot, Helmet clank, Flesh, Thud, Tink, Hitmarker...) | WebAudio synthesis, original | project's own | `audio.js` | in use |
| Rust mode visuals | existing procedural art plus vignette, graphics option | project's own | `rust.html` | audio and settings done; model overhaul NOT done |

## Not used, and why
Sketchfab "CS:GO terrorist characters" models and CS wiki weapon references: these are ripped or derived from Valve's copyrighted game assets. They need a login to download and are not licensed for redistribution in a public repo. They were not downloaded or included. If you hold models you have the right to use (glTF/GLB), they can be added later through a loader.

## Settings (each game keeps its own, never shared)
Hit sounds on/off, headshot sound, body sound, master volume, headshot volume, body volume, graphics quality (Quality / Performance), vignette.
