# Testing

## Commands

| Command | What it runs |
| --- | --- |
| `make test` | Node tests (`tests/*.test.js`), Python unittest (`tests/test_*.py`), the GJS helper test, a strict schema compile and `node --check` on every JS file |
| `make smoke` | A real headless GNOME Shell 50 with demo data. Screenshots and the shell log land in `.smoke/` |
| `make links` | Relative links in the README and docs point at files that exist |
| `make diagrams` | Regenerates `docs/diagrams` from the code |
| `make demo-assets` | Runs smoke, then builds the README images with ffmpeg |

`make smoke` and the GJS helper test run in a clean environment (`CLEAN_ENV` in the Makefile) because the VS Code snap injects libraries and an old schema path. Run any ad hoc `gjs` or `gnome-shell` the same way.

A smoke run passes only when `.smoke/result.json` says `"ok": true` and `.smoke/shell.log` has no `JS ERROR` and no criticals.

## What smoke covers

- **Edge rail:** the tick on all four edges, hover intent, the unfold, every deck on every edge, focus and Escape, Overview and workspace dismissal, reduced motion, and no repaints while idle.
- **Top bar:** the strip after the clock with the clock centred, the menu painting nothing of its own, click to open, hover to switch, compact and summary modes, and switching placement five times with leak checks.
- **Alerts:** sounds, the rail peek, Do Not Disturb, sound preview, and limit notifications at 80 and 100 % with muting and re-arming.
- **Usage depth:** an extra account's chip, the three chip orders, pace captions, the clock reset format, the spend section, pin, and hidden accounts.
- **Sources:** the models deck with llama.cpp and LM Studio counts, the Copilot deck, and GitHub demo data.
- **Themes, glass and preferences:** every theme over a striped backdrop, with glass present exactly for frosted themes; the preferences window; then disable and re-enable.

## Fixture-only sources

These were built against documented formats and fixtures, with no live server on the development machine:

| Source | Fixtures and tests |
| --- | --- |
| LM Studio server logs | `tests/fixtures/lmstudio.log`, `tests/test_lmstudio.py` |
| LM Studio, Ollama HTTP | `tests/widgets.test.js`, `tests/sources.test.js` |
| llama.cpp `/slots`, `/metrics` | `tests/sources.test.js` |
| Copilot "no plan" response | Handled as a 403 or 404 from `gh`, or a response without quota snapshots |
| Codex token counts | `tests/fixtures/codex-rollout.jsonl`; local rollouts had no token events |

To check llama.cpp live, start `llama-server --port 8080 --slots --metrics` and open the models deck.

## Measured numbers

On the development machine (ASUS ROG G14), Ubuntu 26.04, GNOME Shell 50.1:

| Measurement | Result |
| --- | --- |
| `make test` | 3 s |
| `make smoke` | about 110 s |
| Cost index, cold, 232 MB of Claude transcripts | 0.75 s (stops at 200 000 lines per run and continues on the next) |
| Cost index, warm | 0.07 s |
| Repaints on Ledge's own actors over 2 s while folded and idle | 0 |

## Trying a change by hand

GJS caches modules for the life of the shell, so JavaScript changes need a fresh shell:

1. `sudo apt install mutter-dev-bin`, then `make nested` for a shell in a window; or log out and back in.
2. `make reload` applies schema and settings changes to the running shell.
3. Watch `journalctl --user -f -o cat /usr/bin/gnome-shell` for `JS ERROR`, `St-CRITICAL` or `Ledge`.
