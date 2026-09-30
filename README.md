# Ledge

A small notch on the edge of your screen for GNOME Shell. Hover the pill to unfold it. Each cell is a widget; hover or click one for its card.

Built for **Ubuntu 24.04** and **GNOME Shell 46** on Wayland.

## Widgets

| Widget | Cell | Card |
| --- | --- | --- |
| Claude Code, Cursor, Codex | Usage left in the current window | Every limit window, reset times, live session activity |
| Power | Current power profile | Power Saver, Balanced and Performance; click one to switch |
| Todo | Open todos | Add with the entry and Enter, tick done, delete; done items sink to the bottom |
| Local models | Loaded model count; the ring is GPU memory in use | Ollama and LM Studio models with size and VRAM, and a speed test per Ollama model |
| GitHub | Review requests; turns red when a watched repository's latest CI run failed | Review requests, your open pull requests, latest CI run per watched repository |
| Training | Active run's epoch progress, with its loss as the label | Recent runs with epoch, loss, ETA and state |

Every widget can be switched off in preferences. A switched-off widget does no reads and no polling, and the notch shortens to fit. With all widgets on, a side-edge notch is about 910 px tall; on a smaller screen, switch some off or use the top or bottom edge.

## Requirements

- Ubuntu 24.04 with GNOME Shell 46
- Python 3 and `glib-compile-schemas` (normally on Ubuntu Desktop)
- Node.js for tests only. The running extension does not need it.

## Install

```sh
git clone https://github.com/shiv2077/Ledge.git
cd Ledge
make install
```

Log out and back in, then enable it:

```sh
gnome-extensions enable ledge@shiv2077
gnome-extensions prefs ledge@shiv2077
```

The installer backs up any existing install under `~/.local/share/ledge/backups/`. `make package` builds `dist/ledge@shiv2077.shell-extension.zip`.

## Use

- Hover the narrow pill on the screen edge to expand it.
- Hover or click a cell for its card. **Refresh** requests a new reading. Clicking the todo cell puts the cursor in its entry.
- Hover the curve under the notch for the settings gear.
- **Super+Shift+L** opens and focuses the notch. Tab moves between controls. Escape closes it.
- **Demo readings** in preferences previews the notch without reading any accounts.

Usage rings show quota **left**. A dash means no reading and never stands in for 0%. Dim rings mark stale readings. An inner moving arc means a session is working; amber means it is waiting for you. Codex activity is estimated from recent local writes.

## Appearance

Preferences open with an Appearance section. Pick a theme from the list; each shows a color swatch.

| Theme | Look |
| --- | --- |
| Midnight | Pure black. The default |
| Graphite | Soft dark grey |
| Nord, Catppuccin Mocha, Dracula | The well-known palettes |
| Ocean | Deep navy |
| Snow | Clean light theme |
| Frosted Dark, Frosted Light | Glass: blurs what is behind the notch and cards, with a tint, a bright rim and a soft shadow |
| System | Follows Ubuntu's light or dark style and the Yaru accent color, live |
| Custom | Your own notch, card, text and highlight colors and background opacity |

Frosted themes add sliders for blur strength, tint opacity and backdrop brightness. Custom adds color pickers and an opacity slider. Changes apply immediately, including to an open card.

Every theme keeps text readable: contrast is checked for each theme, and Custom and glass settings are held to the same rule. A translucent custom background is made more opaque when text would otherwise be hard to read. Claude, Cursor, Codex and widget colors stay the same everywhere; on a theme where one would be hard to see, only its lightness changes.

The glass blur follows the notch's exact outline, curls and rounded corners included. It works alongside Blur My Shell.

## Where readings come from

Ledge only talks to the network through the usage reader below, `gh`, and localhost. It keeps no tokens and sends no telemetry.

- **Power:** power-profiles-daemon over the system D-Bus (`org.freedesktop.UPower.PowerProfiles`, or the older `net.hadess.PowerProfiles`). Changes made in Quick Settings show up immediately.
- **Todo:** `~/.local/share/ledge/todos.json`, replaced atomically on every change. An unreadable file is kept as `todos.json.bad-<time>` and the list starts empty.
- **Local models:** `http://127.0.0.1:11434/api/ps` (Ollama) and `http://127.0.0.1:1234/api/v1/models`, falling back to `/api/v0/models` (LM Studio), every 15 seconds. Total GPU memory is read once from `nvidia-smi`. **Measure speed** sends one short non-streaming prompt to Ollama and reports `eval_count / eval_duration`.
- **GitHub:** the `gh` CLI with its own sign-in, every 5 minutes: `gh search prs` for review requests and your pull requests, and `gh run list` for each watched repository (set in preferences as `owner/name`). A CI run that is queued or in progress counts as running; only a completed run with a failing conclusion turns the cell red.
- **Training:** JSON files in `~/.local/share/ledge/runs/`, watched with a file monitor. A running job with no update for 10 minutes is marked stalled. A notification is sent when a run finishes, crashes or stalls.

### Reporting training progress

Copy `tools/ledge_status.py` next to your training script (it needs only the Python standard library):

```python
from ledge_status import RunStatus

with RunStatus("resnet-cifar", total_epochs=10) as status:
    for epoch in range(1, 11):
        for step, batch in enumerate(loader):
            loss = train_step(batch)
            status.update(epoch=epoch, step=step, loss=loss, eta_seconds=eta)
```

The file is rewritten atomically every 10 updates (`every=` changes that). Leaving the block marks the run done; an exception marks it crashed. Outside a `with` block, call `status.done()` or `status.crashed()` yourself.

### Coding usage

| Provider | Source |
| --- | --- |
| Claude Code | `~/.claude/.credentials.json` (or `CLAUDE_CONFIG_DIR`), then Claude's OAuth usage endpoint |
| Cursor | `$XDG_CONFIG_HOME/Cursor/User/globalStorage/state.vscdb`, opened read-only, then Cursor's usage-summary endpoint |
| Codex | Local `codex app-server` rate-limit request, with rollout fallback under `CODEX_HOME` (default `~/.codex`) |

The reader never signs in, refreshes credentials, or writes to another tool's files. Requests go only to the owning vendor and do not follow redirects. A sanitized cache and rate-limit backoff live in `~/.cache/ledge` with private permissions. Tokens are never cached, logged or printed.

GNOME inherits your login environment, which may differ from a terminal. If Codex lives outside `PATH`, `~/.local/bin` or `~/.nvm`, set `LEDGE_CODEX_BIN` in your login environment and log in again.

## Development

```sh
make test      # unit tests, schema compile, syntax checks; no account reads
make smoke     # headless GNOME Shell with demo data; screenshots in .smoke/
make reload    # link this checkout into the extensions folder and re-enable
make nested    # run a nested GNOME Shell window with this checkout
```

GJS caches ES modules for the life of the shell, so JavaScript edits need `make nested` or a fresh login. Settings and schema changes apply with `make reload`.

Watch errors with:

```sh
journalctl --user -f -o cat /usr/bin/gnome-shell
```

## Troubleshooting

```sh
python3 reader/usage_reader.py --providers codex,claude,cursor --demo
gnome-extensions info ledge@shiv2077
```

For an expired credential, open the owning tool, use it once, then press Refresh. Network failures keep the last good reading, marked stale. Refresh does not bypass rate-limit backoff.

To remove: `gnome-extensions disable ledge@shiv2077`, then delete `~/.local/share/gnome-shell/extensions/ledge@shiv2077`, `~/.cache/ledge` and `~/.local/share/ledge`. Reset settings with `dconf reset -f /org/gnome/shell/extensions/ledge/`.

## License

MIT. See [LICENSE](LICENSE) and [THIRD_PARTY_LICENSES](THIRD_PARTY_LICENSES).
