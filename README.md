# Ledge

A small notch on the edge of your screen for GNOME Shell. Hover the pill to unfold it. Each cell is a widget; hover or click one for its card.

Built for **Ubuntu 24.04** and **GNOME Shell 46** on Wayland.

## Widgets

| Widget | Shows |
| --- | --- |
| Claude Code, Cursor, Codex | Usage left in each limit window, reset times, and live session activity |

Every widget can be switched off in preferences. A switched-off widget does no reads at all, and the notch shortens to fit.

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
- Hover or click a cell for its card. **Refresh** requests a new reading.
- Hover the curve under the notch for the settings gear.
- **Super+Shift+L** opens and focuses the notch. Tab moves between controls. Escape closes it.
- **Demo readings** in preferences previews the notch without reading any accounts.

Usage rings show quota **left**. A dash means no reading and never stands in for 0%. Dim rings mark stale readings. An inner moving arc means a session is working; amber means it is waiting for you. Codex activity is estimated from recent local writes.

## Where usage readings come from

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
