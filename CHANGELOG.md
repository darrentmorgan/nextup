# Changelog

Changes through 0.6.1, from merged-PR commit subjects in the local Git history.
`gh pr list --state merged` could not run without authentication; the public API
also returned 404. This is a local-history fallback, not a verified API export.
Versions below are retained only where recorded in those subjects.
Historical migration work is recorded here, but is excluded from the public allowlist.

## 0.6.1 (2026-10-26)

- Cut dry run passes clean ([#80](https://github.com/darrentmorgan/nextup/pull/80)).
- Apply the B+C visual identity ([#79](https://github.com/darrentmorgan/nextup/pull/79)).
- Blocker Ledger headless demo check ([#78](https://github.com/darrentmorgan/nextup/pull/78)).
- Release 0.6.0 ([#77](https://github.com/darrentmorgan/nextup/pull/77)).

## 0.6.0 (2026-10-26)

- Band shows what needs you; Needs you lists permission waits ([#76](https://github.com/darrentmorgan/nextup/pull/76)).
- Clean-install smoke test and Node version guard ([#75](https://github.com/darrentmorgan/nextup/pull/75)).
- Public cut script, dry run only ([#74](https://github.com/darrentmorgan/nextup/pull/74)).
- README, CHANGELOG, schema doc and public-file allowlist ([#73](https://github.com/darrentmorgan/nextup/pull/73)).
- Pane layout: Now first, collapsed bars, one-row tabs, real estimates ([#72](https://github.com/darrentmorgan/nextup/pull/72)).
- Permission wait clears on deny; marks newest-at-wins ([#71](https://github.com/darrentmorgan/nextup/pull/71)).
- Headless fixture capture harness ([#70](https://github.com/darrentmorgan/nextup/pull/70)).
- Light PR CI workflow ([#69](https://github.com/darrentmorgan/nextup/pull/69)).
- Press lint: stricter inline onPress detection ([#68](https://github.com/darrentmorgan/nextup/pull/68)).
- Session signal: activity updates and ten-lane fixture ([#67](https://github.com/darrentmorgan/nextup/pull/67)).
- Data trust: rowtext helper, momentum and stage fixes ([#66](https://github.com/darrentmorgan/nextup/pull/66)).
- Record sessions waiting on a permission prompt ([#65](https://github.com/darrentmorgan/nextup/pull/65)).
- Shared marks merge fixture ([#64](https://github.com/darrentmorgan/nextup/pull/64)).
- MIT licence and provenance note ([#63](https://github.com/darrentmorgan/nextup/pull/63)).

## 2026-10-26

- Sentinel strip, act() on every press, honest reload rows (0.5.6) ([#62](https://github.com/darrentmorgan/nextup/pull/62)).
- Stalled rows get Rescue and show once (0.5.5) ([#61](https://github.com/darrentmorgan/nextup/pull/61)).
- Band: a thread with a live delegated or working session is not a to-do (0.5.4) ([#60](https://github.com/darrentmorgan/nextup/pull/60)).
- Go to session and Rescue give visible feedback; remote sessions copy their ssh command (0.5.3) ([#59](https://github.com/darrentmorgan/nextup/pull/59)).
- fix/reload expire ([#58](https://github.com/darrentmorgan/nextup/pull/58)).
- Reload plugins message: counts and titles, no raw ids (0.5.1) ([#57](https://github.com/darrentmorgan/nextup/pull/57)).
- Blocker Ledger: answer a blocked worker with one tap (0.5.0) ([#56](https://github.com/darrentmorgan/nextup/pull/56)).
## 2026-10-25

- Reload plugins button: count app-reloaded sessions (0.4.39) ([#55](https://github.com/darrentmorgan/nextup/pull/55)).
- Delegated rows: tag the launch prompt per thread and match the session by it (0.4.38) ([#54](https://github.com/darrentmorgan/nextup/pull/54)).
- Unlink own scripts: reloadHelper option, plain launch prompt without darren-core (0.4.37) ([#53](https://github.com/darrentmorgan/nextup/pull/53)).
- Momentum polish: delegated session link from live rows, drop clutter lines, Morning/Midday/Night (0.4.36) ([#52](https://github.com/darrentmorgan/nextup/pull/52)).
- Momentum UI: defect fixes, wins ring, value bars, day parts, Rescue, reload plugins, Delegated marker (0.4.35) ([#51](https://github.com/darrentmorgan/nextup/pull/51)).
- Needs you: status reports with their own next step are not asks (0.4.34) ([#50](https://github.com/darrentmorgan/nextup/pull/50)).
- PRODUCT.md: the board pipeline lives in a private board repo ([#49](https://github.com/darrentmorgan/nextup/pull/49)).
- Desktop live refresh: one live loop, drawn values in atoms (0.4.33) ([#48](https://github.com/darrentmorgan/nextup/pull/48)).
- Desktop clicks: remove layers over buttons, guard against them; permission tiles redraw (0.4.32) ([#47](https://github.com/darrentmorgan/nextup/pull/47)).
- Launch history with 48 h outcomes; idea stage can fire (0.4.31) ([#46](https://github.com/darrentmorgan/nextup/pull/46)).
- Delegate card and stage-based skill launches with 10 s Undo and a 5 a day cap (0.4.30) ([#45](https://github.com/darrentmorgan/nextup/pull/45)).
- Next tab puts the next step first: Momentum hero, Needs you, Later today (0.4.29) ([#44](https://github.com/darrentmorgan/nextup/pull/44)).
## 2026-10-24

- Add Attention card to the Next tab ([#43](https://github.com/darrentmorgan/nextup/pull/43)).
- Band buttons wrap on a narrow screen instead of clipping Hide (0.4.28) ([#42](https://github.com/darrentmorgan/nextup/pull/42)).
- Band stacks above other mods' bands instead of hiding them (0.4.27) ([#41](https://github.com/darrentmorgan/nextup/pull/41)).
- Worker lanes: stale lanes, one-line rows, reread only while drawn, honest glyphs (0.4.26) ([#40](https://github.com/darrentmorgan/nextup/pull/40)).
- Version 0.4.25 and README for the Worker lanes card ([#39](https://github.com/darrentmorgan/nextup/pull/39)).
- Session tab: Worker lanes card for dispatch lanes (0.4.25) ([#38](https://github.com/darrentmorgan/nextup/pull/38)).
## 2026-10-23

- Desktop tabs: framed Buttons, no hit overlay (0.4.24) ([#37](https://github.com/darrentmorgan/nextup/pull/37)).
- Desktop tabs: anchor the hit region to the track, and move Hand off to the header (0.4.23) ([#36](https://github.com/darrentmorgan/nextup/pull/36)).
- Desktop tabs: one hit region over the whole track (0.4.22) ([#35](https://github.com/darrentmorgan/nextup/pull/35)).
- Desktop tab edge clicks and a one-row tab switch (0.4.21) ([#34](https://github.com/darrentmorgan/nextup/pull/34)).
- Needs you: say why when the session server refuses (0.4.20) ([#33](https://github.com/darrentmorgan/nextup/pull/33)).
- Needs you card: sessions waiting on you (0.4.19) ([#32](https://github.com/darrentmorgan/nextup/pull/32)).
- Permission tile counts and terminal tab edge clicks (0.4.18) ([#31](https://github.com/darrentmorgan/nextup/pull/31)).
- Session tab: Hand off and clear button (darren-core) and hidden hand-back log rows (0.4.17) ([#30](https://github.com/darrentmorgan/nextup/pull/30)).
- Session log: hand-backs read as '<helper> · reported back'; idle helpers no longer hold a batch open (0.4.16) ([#29](https://github.com/darrentmorgan/nextup/pull/29)).
- Helpers: lanes for the latest batch, no stray separator, hand-backs uncounted, stretched Lists tabs (0.4.15) ([#28](https://github.com/darrentmorgan/nextup/pull/28)).
- Helpers: thin lanes, fixed axis with a time scale, whole-box tabs and tiles, helper-named log rows (0.4.14) ([#27](https://github.com/darrentmorgan/nextup/pull/27)).
- Helpers: Doing now list and a ticked timeline (0.4.13) ([#26](https://github.com/darrentmorgan/nextup/pull/26)).
- Session tab: 7-row log, compact helpers, This turn drill-down, tabs without hit overlay (0.4.12) ([#25](https://github.com/darrentmorgan/nextup/pull/25)).
- Enable the taste-skill plugin for this repo; ignore its working files ([#24](https://github.com/darrentmorgan/nextup/pull/24)).
- Fast switch: a drawn green pill with a sliding knob and ON/OFF (0.4.11) ([#23](https://github.com/darrentmorgan/nextup/pull/23)).
- Session tab: one-click toggles, one-line permission tiles, full-width helper lanes, ⚡ Fast switch (0.4.10) ([#22](https://github.com/darrentmorgan/nextup/pull/22)).
- Desktop tiles: count and dot outside the Button, ▸ in file labels, Fast beside the Helpers title (0.4.9) ([#21](https://github.com/darrentmorgan/nextup/pull/21)).
- Session tab: permission tiles with drill-down, file edit drill-down, Fast switch (0.4.8) ([#20](https://github.com/darrentmorgan/nextup/pull/20)).
- Retro checks: ADR-0001 rule and privacy scan in check.sh, dispatchDir option (0.4.7) ([#19](https://github.com/darrentmorgan/nextup/pull/19)).
- Run check.sh and claude plugin test outside the sandbox ([#18](https://github.com/darrentmorgan/nextup/pull/18)).
- Marks ledger: one module owns mod-marks.json (0.4.6) ([#17](https://github.com/darrentmorgan/nextup/pull/17)).
- Desktop polish to match Concept C: filled cards, slim bars and pills, filled tab track (0.4.5) ([#16](https://github.com/darrentmorgan/nextup/pull/16)).
- Session tab: worker fast mode toggle (0.4.4) ([#15](https://github.com/darrentmorgan/nextup/pull/15)).
- Load the board from the pane when no session.start ran (0.4.3) ([#14](https://github.com/darrentmorgan/nextup/pull/14)).
- Desktop tabs take a click anywhere on the segment, even gaps in the track, full-width rescan rail; bump to 0.4.2 ([#13](https://github.com/darrentmorgan/nextup/pull/13)).
- Next up 0.4.1: Session cards fit the desktop's wide layout; quieter tab track ([#12](https://github.com/darrentmorgan/nextup/pull/12)).
- Next up 0.4.0: concept C pane, Done keeps the row in place, open on start in the desktop ([#11](https://github.com/darrentmorgan/nextup/pull/11)).
- Bump nextup to 0.3.0 so installs pick up the Left Off migration and desktop fixes ([#10](https://github.com/darrentmorgan/nextup/pull/10)).
- Left Off migration: keep marks, import script; desktop spacing fixes ([#9](https://github.com/darrentmorgan/nextup/pull/9)).
- Enable mattpocock-skills for this repo only (project scope) ([#8](https://github.com/darrentmorgan/nextup/pull/8)).
- Bump nextup to 0.2.0 so installs pick up open on start ([#7](https://github.com/darrentmorgan/nextup/pull/7)).
- Open the Next up pane when a session starts (openOnStart option, on by default) ([#6](https://github.com/darrentmorgan/nextup/pull/6)).
- Add Impeccable PRODUCT.md for the Next up redesign ([#5](https://github.com/darrentmorgan/nextup/pull/5)).
- Drawing-evidence test: pane tabs and band on desktop and terminal, trees saved to docs/evidence; M4, M7, M9 recorded ([#4](https://github.com/darrentmorgan/nextup/pull/4)).
## 2026-10-22

- goal.md: record M5 waiver, M7 install, M8 and M9 merges; M4 and M7 desktop shots blocked ([#3](https://github.com/darrentmorgan/nextup/pull/3)).
- nextup UI redesign: states, tokens, Session tab polish ([#2](https://github.com/darrentmorgan/nextup/pull/2)).
