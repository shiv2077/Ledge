# Decisions

Short records of choices that are not obvious from the code.

## Look

1. **Chamfers, meters and lights.** Corners facing away from the screen edge or bar are cut at 45 degrees (4 px on chips and badges, 10 px on the rail and deck). Fractions are segmented meters, and state is a 6 px light. St CSS cannot draw chamfers, so the rail, deck, chip and badge fills are drawn with Cairo (`draw.js`); CSS keeps text and control styles.
2. **Monogram badges for every module.** CL, CU, CX, PW, TD, LM, GH, CP, TR. Symbolic icons varied too much between icon themes, and some were missing on Ubuntu 26.04. An extra account's badge is the provider's first letter and the account's first letter (CW for `claude:work`).
3. **Rail chips are 96 x 36 px; top bar chips 80 px wide and the bar's height**, with 4 px gaps and 1 px hairlines between them.
4. **Deck header.** A sentence-case title, then a caption context (`Claude Code · 1 session`); only the context may shorten.
5. **Deck shadow.** One CSS `box-shadow: 0 8px 24px` on the deck actor. It showed no banding, and the 10 px chamfer is too small for the rectangular shadow corner to show.
6. **Meterless readouts are centred** on the badge; readouts above a meter share one baseline.
7. **Rows have no side padding** so their text lines up with the deck's body column.
8. **Contrast floors for unlit marks.** Unlit meter segments need 1.3:1 and an off light 2.5:1 against the deck. Midnight's `meterOff` (`#232A33`) is 1.34:1 and set the first floor.
9. **Copy.** Labels inside decks are lower case (`resets in 2h 14m`, `refresh`, `settings`); titles are sentence case.

## Placement

10. **Top bar is the default placement.** The strip sits right after the clock in the centre box. An empty twin of the strip sits before the clock so the clock stays centred, which halves the space the strip can use before it compacts.
11. **The panel deck lives in a `PopupMenu`** so the shell's menu manager handles grabs, Escape and outside clicks. The menu's background, padding, border, shadow and arrow are removed and it opens with no animation, so only the deck's own motion runs. While the menu holds its grab, `captured-event` enter events switch the deck between chips.
12. **The edge deck lives in a plain `Clutter.Actor` layer** on `Main.uiGroup` and is tracked as chrome only while open. Parenting it directly produced St criticals when the extension was disabled in the same frame a deck opened.
13. **Pin is edge only.** In the top bar the menu holds a modal grab, so a deck that stayed open would block the desktop. Pins are not kept across restarts.

## Alerts and usage

14. **Session alerts fire on transitions only.** The first reading, vanished sessions and derived sessions raise nothing. Busy to idle is "finished"; any state to waiting is "needs you".
15. **Limit alerts at 80 % and 100 %** of the headline window, once each, re-armed when `resetsAt` moves forward. Their state is at module scope so unlocking the screen does not repeat them.
16. **Raising a Codex session's window** scans `/proc` for this user's `codex` processes and matches their working folder to the session's, then walks parent pids to a window. Only the command's first words and the working folder are read.
17. **Extra accounts** are folders beside the default (`~/.claude-<slug>`, `~/.claude_<slug>`, `~/.codex-<slug>`) that hold the provider's sign-in file. The hyphen spelling wins when both exist. Extra Codex accounts are read from their local rollouts only; the app server runs for the default sign-in.
18. **Sessions belong to the default account's chip.** The activity reader does not yet tell accounts apart.
19. **Pace** is used percent minus elapsed percent of the window. Within 5 points reads "on pace".
20. **Spend estimates.** Claude cache reads and writes are billed apart from input; for OpenAI models cached input is part of input and reasoning part of output. Codex token events repeat, so the change in `total_token_usage` is counted, with `last_token_usage` only when no total exists. The five Codex rollouts on the development machine carried no token counts, so the two methods could not be compared on real data; fixtures cover repeated events. Prices are a dated table in `reader/costs.py`, shown as `estimate at API list prices, <date>`. Unknown models are counted as unpriced tokens.

## Sources

21. **LM Studio is read from its server logs**, not a socket protocol, because no LM Studio install was available to test against. Only timestamps and request paths are matched; embeddings are not counted.
22. **llama.cpp** is read from `/health`, `/slots` and `/metrics` on `llamacpp-port`. Slots and metrics need `--slots` and `--metrics`; without them the deck says so.
23. **Copilot** reads `gh api /copilot_internal/user`. A 403 or 404, or a response without quota snapshots, means no Copilot plan. Only quota fields are parsed.

## Testing and support

24. **Supported shell versions.** `metadata.json` lists only GNOME Shell 50, the version the smoke test runs on. The code avoids APIs newer than 46 where it can (for example `orientation` instead of `vertical` on `St.BoxLayout`), but 46 to 49 are untested.
25. **Screenshots are full-stage captures cropped afterwards**, because area captures paint offscreen and the glass blur samples nothing there.
26. **Smoke teardown stops gnome-shell before the rest of the session**, which removed calendar criticals from the shell's own code.
27. **Diagrams are SVG written by `scripts/diagrams.py`** with an Excalidraw scene beside each, so no converter or Node package is needed.
