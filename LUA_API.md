# HvH Lua scripting (CS:GO mode)

Scripts run in a sandboxed Lua 5.3 (Fengari, MIT). Open **Lua** tab > "Open Lua script manager". Example scripts are in `scripts/` (listed in `scripts/index.json`). The "Custom script" slot lets you paste your own; it is saved in your browser.

Each script gets its own Lua state with only base (no load/dofile/require), string, table, math, utf8, coroutine. There is no file, network, OS or DOM access. A callback that runs longer than 12 ms is aborted; 5 errors in a row switch the script off. One script failing does not affect the game or other scripts.

Metadata comments at the top: `--@name`, `--@version`, `--@author`, `--@desc`, `--@requires 3.4`.

## Events: `hvh.on(name, fn)`
`round_start`, `round_end`, `spawn`, `death`, `hit` (`{head, name, kill}`), `weapon` (`{name}`), `tick` (dt), `draw` (w, h), `key`.

## hvh
`hvh.log(...)`, `hvh.notify(title, text, "#color")`, `hvh.sound(name, volume)`, `hvh.get(key)`, `hvh.set(key, value)` (whitelisted settings only), `hvh.bots()`, `hvh.player()`, `hvh.score()`, `hvh.set_bot(index, "aa"|"prof", value)`, `hvh.time()`, `hvh.version()`, `hvh.key("F8", fn)`.

Settable keys: `baa_on baa_prof baa_pitch baa_head baa_lean baa_spd diff botacc bs_crouch bs_jig bs_rep hs_on hs_head hs_body hs_master hs_hvol hs_bvol dbg_perf dbg_hb dbg_ins vig`.

## ui (script settings, saved per script)
`ui.checkbox(id, label, default)`, `ui.slider(id, label, min, max, default)`, `ui.combo(id, label, {options}, default)`, `ui.get(id)`.

## draw (only inside a `draw` event)
`draw.text(x, y, text, color, size, align)`, `draw.rect(x, y, w, h, color, filled)`, `draw.line(x1, y1, x2, y2, color, width)`, `draw.circle(x, y, r, color, width)`, `draw.size()`.
