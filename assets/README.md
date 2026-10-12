# assets/

Optional. The game ships with no model files and does not need any: every
character, weapon and texture is generated in code at load. This directory is
the hook for replacing those with real meshes.

## How it works

`csgo.html` fetches `assets/manifest.json` once at startup.

- **No manifest, or a manifest that fails to parse** - the game uses its
  built-in procedural models. This is the default and is not an error; the
  GitHub Pages build runs this way.
- **Manifest present** - each listed model is loaded with `GLTFLoader` and
  swapped in. Anything that fails to load individually falls back on its own,
  so one bad entry cannot take the game down.

Loading never blocks the match starting. Models appear when they arrive.

## Formats

glTF 2.0 (`.glb` or `.gltf`) only, because that is what three.js loads without
a build step. FBX, DAE, OBJ and .blend must be converted first - Blender's
glTF 2.0 exporter is the usual route, and `.blend` files open directly.

`"scale": "auto"` measures the model and fits it to the game's 1.8-unit player
height, which saves hand-tuning units. A number overrides it.

## Licensing

Anything committed here is published: the repo is public and GitHub Pages
serves it. Only assets that may be redistributed belong here - CC0, CC-BY (with
attribution recorded in `ASSETS.md`), or your own work.

Assets extracted from another game are not redistributable, whatever the file
format. To use those privately, put them in this directory and leave them
untracked - `.gitignore` already excludes model and texture files here for
exactly that reason, so a local manifest works without ever being committed.
