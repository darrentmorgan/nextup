# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Darren Morgan is the primary user. He runs several Claude Code sessions at once in the Claude desktop app and glances at the pane between turns to pick the next thread to work on and to see what the current session has done. The repo is private now and public later, so other Claude Code users who keep a similar board are a confirmed second audience.

## Product Purpose

Next up is a Claude Code mod: one pane beside the chat that shows what to do next and what this session has done. It replaces two earlier mods (Left Off and Flightdeck) with one surface. Success means one glance answers "what next?" and "what did this session touch?" without leaving the chat.

## Positioning

It joins a personal work board (open threads, Today plan, PRs, calendar, drafts) with a live log of the current session's own tool calls in the same pane, and it keeps all of it on the user's machine.

## Operating Context

- Opened with `/nextup`; `/nextup-refresh` rescans the board.
- Tabs: Next (open threads with Go to session and Start side task, Today plan, ticks, notes, Copy prompt, PRs and CI, calendar, drafts, wins) and This session (session log, files touched, shell commands).
- The board is read from a user-set `dataDir` (`threads.json`, `notes.json`, optional `calendar.json`, `drafts.json`, `build.py`). The pipeline that builds the board lives in a separate, private repo; this repo is the mod only.
- Rendered by the Claude Code mod engine in both the desktop app and the terminal.

## Capabilities and Constraints

- Template mode: with no `dataDir`, the mod reads and writes no files, hides the board tabs and shows only the This session tab.
- Session log, files touched and shell commands live in session memory only, capped at 500 events, 200 files and 200 commands.
- The PR list calls GitHub through the user's own `gh` CLI every ten minutes, only when `dataDir` is set.
- Questions (Blocker Ledger): a worker asks through an MCP form elicitation; an `Elicitation` command hook writes `asks.json` and waits for `answers.json`, a saved rule or a timeout. The mod only draws the card and writes files; it cannot answer a worker itself. Desktop and interactive-session delivery are unverified. Not MCP Tasks.
- Non-goals: model, effort, context meter, tokens per hour, permission mode, gate colours, last turn. No hosted service and no telemetry.
- No Flightdeck code may be copied (it is Stephen Casella's MIT code).
- `scripts/check.sh` (tsc, `claude plugin validate`, `claude plugin test`) and `scripts/privacy-scan.sh` must pass.

## Brand Commitments

- Name: "Next up" (pane title "Next up", plugin `nextup`).
- The mod has its own visual identity inside Claude rather than copying the host's look (confirmed by Darren, 23 Oct 2026). The identity is set (D1, 26 Oct 2026): Darren's 22 Oct pick of concept B (panels) with C's Next | Session split, a modern app look rather than a terminal look. The original concept artifacts could not be re-read, so this section is the working spec.

## Visual Identity

Darren's pick on 22 Oct: "I like the styles of B and C", B being Panels and C the Next | Session tabs. Source design: `modern.html` in the mvp scratch evidence (`evidence/d1/spec/`).

- B, Panels: a bordered card per area (12px radius, 1px line), empty areas hidden. The Now card has an accent border and a halo ring. Pills for tags, 6px progress bars.
- C, Next | Session: two segmented tabs in a track, Next first (`mainTabs` in `plugin/hooks/register.tsx`).
- Spec tokens. Light: bg #f5f3ee, panel #fff, text #1f1e1b, muted #6f6a60, line #e4dfd3, accent terracotta #c4623b (tint #f6e4da), good #2f7d4f, bad #b4372f, warn #9a6a00, track #ece8dd. Dark: bg #171614, panel #211f1c, text #ece8df, accent #e08a63, good #5fd08c, bad #ff8077, warn #e3b341. Type Inter/system 15px, Now title 18px, eyebrow 11px.
- Host mapping: a plugin gets theme keys (follow light/dark) or raw strings (do not), and cannot read the theme. Text and accents therefore use keys (`claude` is the terracotta accent, `success`/`error`/`warning`), and fills are neutral or tinted alphas in `plugin/hooks/theme.ts` (`desk`). Surfaces must not hardcode colours.
- Known gaps: card fill is a neutral alpha, not the spec's white or #211f1c panel; the active tab is a filled accent Button, not a white segment; no uppercase eyebrow or true 3px ring (halo is a tinted outline).
- Scores are agent scores, not Darren's. Darren can veto on the fixture screenshots in the PR.

## Evidence on Hand

- Drawing-evidence trees for desktop and terminal in `docs/evidence/drawings/`.
- Task record and design history in `docs/goal.md`: earlier design reviews scored light 6 / dark 6.5 against an 8/10 bar; an Impeccable audit scored 17/20 with no P0/P1 issues.
- No public users, testimonials or usage data exist yet; do not invent any.

## Product Principles

1. One glance answers "what next?" and "what did this session do?".
2. Nothing leaves the machine; template mode must work with no data at all.
3. Board actions (Go to session, Start side task) beat display: anything shown should lead somewhere useful.
4. Built for Darren first, but never hardcode his data, so it can go public.
