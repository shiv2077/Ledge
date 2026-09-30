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
7. Sizes and spacing come from `design.js`, colors from theme tokens in `themes.js`. Never hardcode a UI color. Do not change `SCALE` or the `.ledge-percent` font size.
8. Ledge is an original product. Do not name any predecessor project anywhere except `THIRD_PARTY_LICENSES`, which is never edited. This includes commit messages: never say "rebrand", "rename from", "port" or refer to earlier code.
9. No dependencies beyond GNOME Shell 46 and Python 3.

## Layout

| File | Role |
| --- | --- |
| `extension.js` | Notch host: placement, unfold motion, cells, cards, keyboard focus. `MODULES` sets cell order |
| `lib/module.js` | `Module` base class, the interface every widget implements |
| `lib/subprocess.js` | `run(argv, {timeout, signal, cancellable, stderr})`: async, killed on timeout or cancel, never rejects |
| `lib/http.js` | `getJson` / `postJson` via Soup 3: localhost only, no redirects, no proxy, per-call timeout, never rejects |
| `lib/files.js` | `readText`, atomic `writeText`, `ensureDir`, `dataDir()`: async, never reject |
| `modules/usage.js` | Claude, Cursor, Codex modules sharing one `UsageSource` reader process |
| `modules/power.js` | power-profiles-daemon over system D-Bus proxy, UPower name first |
| `modules/todo.js` | `~/.local/share/ledge/todos.json`, serialised uncancellable saves, bad-file backup |
| `modules/models.js` | Ollama `/api/ps`, LM Studio `/api/v1/models` then `/api/v0/models`, `nvidia-smi` once, speed test |
| `modules/github.js` | `gh` search and run list with `--json`; exit 4 means logged out |
| `modules/training.js` | `Gio.FileMonitor` on `runs/`, stall timer, notifications on the shell system source |
| `tools/ledge_status.py` | Dependency-free writer for training status files |
| `themes.js` | Theme tokens, built-in themes, system and custom resolution, contrast math, generated stylesheet. Pure, Node-tested |
| `lib/appearance.js` | Runtime theme: watches appearance keys and `org.gnome.desktop.interface`, loads the generated stylesheet |
| `lib/glass.js` | `setGlass(actor, shape, params)`: shape-clipped `Shell.BlurEffect` |
| `model.js` | Pure helpers, tested with Node |
| `design.js` | Layout tokens, accents, spring motion, notch and rounded-rect clip rectangles |
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
    start() { this.every(60, () => this._poll()); }   // begin polling or monitoring
    stop() { /* disconnect own signals */ super.stop(); }  // base cancels this.cancellable, removes every() timers
    cell() {                   // what the notch draws
        return {...super.cell(), fraction: null /* 0..1 ring fill */, label: '—', stale: false, accent: '#rrggbb',
            icon: 'symbolic-icon-name' /* or glyph: glyphs.js key */, animating: false, accessibleName: 'Example'};
    }
    heading() {}               // card title, defaults to static title
    card(body, ui) { return [['Label', callback]]; }  // fill body, return extra footer actions
}
// this.changed() pushes an update; the host coalesces updates into one redraw.
```

The host object passed to the constructor is `{settings, path, changed(module), openPreferences()}`; `this.settings` is set by the base class. The host constructs a module only while its key is on, calls `start()`, and calls `stop()` when the key turns off and in `disable()`. A module checks `settings.get_boolean(id)` in `stop()` to tell "switched off" from "extension disabled". Card `ui` factories: `label(text, style)`, `splitRow(leading, trailing, style)`, `bar(leading, trailing, fraction, stale, color, caption)`, `box(style)`, `hairline()`, `button(label, cb, style)`, `iconButton(icon, accessibleName, cb)`, `row(title, {icon, detail, active, dim, onClick, leading, trailing})`, `entry(hint, onActivate)`, `autofocus(actor)`. Section headings use `label(text, 'ledge-section')`. The footer always ends with Settings. Tab walks every focusable actor in the card; a rebuilt card keeps focus at the same position, and focus inside the card holds the notch open.

Module accents live in `MODULE_COLORS` in `design.js`. Notifications go on `MessageTray.getSystemSource()` as non-transient notifications, so nothing needs cleanup. State that must survive the lock screen (extensions are disabled while locked) lives at module scope, as in `modules/training.js`.

Fixed cell order: claude, cursor, codex, power, todo, models, github, training. Modules use `lib/subprocess.js` and `lib/http.js` rather than their own process or HTTP code. In GJS, `Gio.Cancellable.connect(fn)` is `g_cancellable_connect`, not the GObject signal connect.

## Theme system

Tokens (`themes.js`): `notch`, `card`, `control`, `textPrimary`, `textSecondary`, `border`, `highlight`, `shadow`, `ringTrack`, `barTrack`, `ample`, `watch`, `critical`, `warning`; derived `controlHover`, `controlFocus`, `selection`, `textDim`. Colors are `#rrggbb` or `#rrggbbaa`.

- `resolveTheme({theme, custom, glass, desktop})` returns the tokens plus `glass`, `glassParams`, `light` and `accent(color, 'notch' | 'card')`. Text is fitted to 4.5:1 and accents to 3:1 against every background it can land on: over black and white desktops for translucent themes, and over tint-on-black and tint-on-white for glass. Accents only change lightness. `tests/themes.test.js` enforces this for every theme; a new theme must pass it without runtime correction.
- Midnight reproduces the original colors exactly and is the default.
- System: `color-scheme` plus the Yaru variant in `gtk-theme` (for example `Yaru-blue-dark`), or `accent-color` when the schema has it (checked through `Gio.SettingsSchemaSource`, never assumed). The accent drives `highlight` and tints `ringTrack`.
- Custom: four `custom-*` colors and `custom-opacity`. The opacity is raised automatically until text can read over both a black and a white desktop.
- Runtime: `Appearance` resolves on any `theme`, `custom-*` or `glass-*` change, or desktop change in System mode. It calls `_applyTheme` synchronously, which re-applies glass, re-renders cells, repaints the Cairo areas and rebuilds an open card. Then it writes `~/.cache/ledge/theme-<time>.css` and swaps it in. St lets the extension's own `stylesheet.css` win specificity ties, so generated selectors double each class (`.a.a`). `stylesheet.css` keeps sizes and the Midnight colors as a fallback.
- Cairo drawing takes colors from `this._theme`; modules return accents as hex or token names (`'critical'`, `'watch'`) and the host resolves them.

Frosted glass (`lib/glass.js`): three effects on the actor, outermost first: a stencil region clip in the actor's exact shape (`Mtk.Region` of pixel rectangles from `notchRects` / `roundedRectRects`, in framebuffer coordinates of the view being painted), `Shell.BlurEffect` in `BACKGROUND` mode (GNOME 46 properties: `radius`, `brightness`, `mode`), and a clip end that pops the clip so the actor's own tint, rim and shadow paint unclipped. A shader mask would need an offscreen redirect, where a background blur only sees an empty buffer. For the same reason glass cards skip the opacity fade. `Cogl.Framebuffer.push_region_clip` takes an `Mtk.Region`, and `Clutter.StageView.get_layout` takes a caller-allocated `Mtk.Rectangle`.

## Testing workflow

- `make test` must pass: Node tests (including `tests/themes.test.js` contrast checks), Python unittest, strict schema compile, `node --check` on every JS file.
- `make smoke` runs a real headless GNOME Shell with demo data and must pass. It and the GJS helper test run under `CLEAN_ENV` because the VS Code snap injects libraries and an old `GSETTINGS_SCHEMA_DIR`; run any ad hoc `gjs` or `gnome-shell` the same way.
- `tests/helpers.gjs.js` covers `lib/subprocess.js`, `lib/http.js` and `lib/files.js` (timeouts, cancel, leaks, localhost refusal, redirects, atomic writes). `tests/widgets.test.js` covers the pure widget helpers in `model.js`; `tests/test_ledge_status.py` the Python helper.
- The smoke test runs every widget in a real shell: todo typing, training file events, every card, every theme over a striped backdrop (checking the generated stylesheet wins and glass is present exactly for frosted themes), the prefs window, then disable and re-enable. Screenshots land in `.smoke/`. Its shell log (`.smoke/shell.log`) must have no JS errors or Clutter criticals.
- The owner tests with `make reload` (schema and settings) or `make nested` / a fresh login (JS changes, since GJS caches modules), and watches `journalctl --user -f -o cat /usr/bin/gnome-shell`. Try glass changes in `make nested` first.
- Work one phase at a time. Stop after each phase with exact test steps and wait for confirmation.
- Commit only after the owner confirms a phase works. Conventional, clear messages. No co-author trailers or AI attribution anywhere.
- When the owner pastes journalctl output, fix the root cause.
- Update this file whenever the architecture changes.
