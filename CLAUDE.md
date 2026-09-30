# Ledge

**This file overrides `~/dev/CLAUDE.md` and any other parent CLAUDE.md for this repository.** Those files describe a different project; none of their rules (branches, commit bans, Python tooling, GPU rules) apply here.

Ledge is a GNOME Shell extension: a notch on a screen edge whose cells are widgets with hover/click cards.

## Environment

- Ubuntu 24.04, GNOME Shell 46, Wayland. ASUS ROG G14 with an NVIDIA GPU (6 GB).
- GJS with ESM imports, GNOME 46 APIs only. Soup 3 for HTTP.
- UUID `ledge@shiv2077`. GSettings schema `org.gnome.shell.extensions.ledge` at `/org/gnome/shell/extensions/ledge/`.
- Cache `~/.cache/ledge`, data `~/.local/share/ledge`.
- Default shortcut Super+Shift+L (`toggle-notch`).
- Tools available to the extension: `gh` (logged in), Ollama on 11434, LM Studio on 1234, `nvidia-smi`, power-profiles-daemon on the system bus.

## Hard rules

1. Never block the shell main loop. All IO, subprocesses and HTTP are async with timeouts.
2. Network: localhost only (Ollama, LM Studio), GitHub only through the `gh` CLI, plus the existing Claude, Cursor and Codex usage endpoints in `reader/usage_reader.py`. No other hosts, no telemetry.
3. Never store, log or print tokens or credentials. Ledge holds no GitHub token; `gh` handles auth.
4. Every module has an enable switch. A disabled module does no reads and no polling.
5. Every data source fails gracefully into a visible idle or error state, never a crash.
6. `disable()` cleans up everything: timers, file monitors, subprocesses, signals, D-Bus proxies. Repeated enable/disable must not leak.
7. Visual style comes from `design.js`. Do not change `SCALE` or the `.ledge-percent` font size.
8. Ledge is an original product. Do not name any predecessor project anywhere except `THIRD_PARTY_LICENSES`, which is never edited. This includes commit messages: never say "rebrand", "rename from", "port" or refer to earlier code.
9. No dependencies beyond GNOME Shell 46 and Python 3.

## Layout

| File | Role |
| --- | --- |
| `extension.js` | Notch host: placement, unfold motion, cells, cards, keyboard focus. `MODULES` sets cell order |
| `lib/module.js` | `Module` base class, the interface every widget implements |
| `lib/subprocess.js` | `run(argv, {timeout, signal, cancellable, stderr})`: async, killed on timeout or cancel, never rejects |
| `lib/http.js` | `getJson` / `postJson` via Soup 3: localhost only, no redirects, no proxy, per-call timeout, never rejects |
| `modules/usage.js` | Claude, Cursor, Codex modules sharing one `UsageSource` reader process |
| `model.js` | Pure helpers, tested with Node |
| `design.js` | Palette, layout tokens, spring motion |
| `draw.js` | Cairo drawing for notch, rings, bars, tail, settings orb |
| `glyphs.js` | Provider glyph outlines |
| `prefs.js` | Adwaita preferences |
| `reader/usage_reader.py`, `reader/activity.py` | Usage and session activity readers, run as subprocesses |

## Module interface

Each widget lives in `modules/<id>.js` and extends `Module` from `lib/module.js`:

```js
class Example extends Module {
    static id = 'example';     // also the GSettings bool key that enables it
    static title = 'Example';
    start() {}                 // begin polling or monitoring
    stop() {}                  // must leave no timers, processes, monitors, signals or proxies
    cell() {                   // what the notch draws
        return {fraction: null /* 0..1 ring fill */, label: '—', stale: false, accent: '#rrggbb',
            glyph: null /* glyphs.js key */, sessions: [], animating: false, accessibleName: 'Example'};
    }
    heading() {}               // card title, defaults to static title
    card(body, ui) { return [['Label', callback]]; }  // fill body, return extra footer actions
}
// this.changed() pushes an update; the host coalesces updates into one redraw.
```

The host object passed to the constructor is `{settings, path, changed(module), openPreferences()}`. The host constructs a module only while its key is on, calls `start()`, and calls `stop()` when the key turns off and in `disable()`. A module checks `settings.get_boolean(id)` in `stop()` to tell "switched off" from "extension disabled". Card `ui` factories: `label(text, style)`, `splitRow(leading, trailing, style)`, `bar(leading, trailing, fraction, stale, color, caption)`, `box(style)`, `hairline()`. The footer always ends with Settings. Tab walks every focusable actor in the card.

Fixed cell order: claude, cursor, codex, power, todo, models, github, training. Modules use `lib/subprocess.js` and `lib/http.js` rather than their own process or HTTP code. In GJS, `Gio.Cancellable.connect(fn)` is `g_cancellable_connect`, not the GObject signal connect.

## Testing workflow

- `make test` must pass: Node tests, Python unittest, strict schema compile, `node --check` on every JS file.
- `make smoke` runs a real headless GNOME Shell with demo data and must pass. It and the GJS helper test run under `CLEAN_ENV` because the VS Code snap injects libraries and an old `GSETTINGS_SCHEMA_DIR`; run any ad hoc `gjs` or `gnome-shell` the same way.
- `tests/helpers.gjs.js` covers `lib/subprocess.js` and `lib/http.js` (timeouts, cancel, leaks, localhost refusal, redirects).
- The owner tests with `make reload` (schema and settings) or `make nested` / a fresh login (JS changes, since GJS caches modules), and watches `journalctl --user -f -o cat /usr/bin/gnome-shell`.
- Work one phase at a time. Stop after each phase with exact test steps and wait for confirmation.
- Commit only after the owner confirms a phase works. Conventional, clear messages. No co-author trailers or AI attribution anywhere.
- When the owner pastes journalctl output, fix the root cause.
- Update this file whenever the architecture changes.
