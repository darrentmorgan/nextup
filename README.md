# Next up

A Claude Code plugin with a pane beside the chat: what to do next, and what this session has done. MIT licensed.

## Quick start

In Claude Code:

```text
/plugin marketplace add darrentmorgan/nextup
/plugin install nextup@nextup
```

The pane opens when a session starts. Use `/nextup` to reopen it. No board, GitHub account, external pipeline or worker skill is required for the Session tab.

To try a board, copy the synthetic [example data folder](examples/dataDir/) to a writable folder you own:

```sh
mkdir -p "$HOME/nextup-demo"
cp examples/dataDir/*.json "$HOME/nextup-demo/"
```

Set the plugin option in `~/.claude/settings.json`, then start a new session:

```json
{
  "pluginConfigs": {
    "nextup@nextup": {
      "options": { "dataDir": "~/nextup-demo" }
    }
  }
}
```

The example calendar has a fixed date; change it to today's local date to see its events. See [examples/README.md](examples/README.md) and [the schema](docs/SCHEMA.md) to supply your own data.

## Core versus optional integrations

### Core

- **Session:** edits, errors, permission decisions, helper lifetimes, files touched, prompts and tool calls. Session activity stays in memory.
- **Board (with `dataDir`):** Next, work, notes, planning, marks and wins. Next puts the next step first, followed by Needs you and Later today. The Band offers a compact next step and visible action feedback.
- **Local state:** Done, Drop, Park and Keep are saved by item id; the newest timestamp wins. Producers must preserve stable ids and follow the [marks format](docs/adr/0001-marks-format.md).

With no `dataDir`, template mode shows Session only and reads or writes no board files. The board's source files are `threads.json` and `notes.json`; calendar and drafts are optional. This plugin consumes a board, rather than collecting your projects or generating the board itself.

### Optional

| Integration | Enable with | Behavior / limitation |
| --- | --- | --- |
| Board refresh | Your own `build.py` in `dataDir` | `/nextup-refresh` can rebuild the board; a static example needs no producer. |
| GitHub PRs | Authenticated `gh` CLI and `dataDir` | Reads your open PRs every ten minutes; never runs in template mode. |
| Desktop sessions | Claude desktop session service | Needs you and Open session links depend on this service; unavailable surfaces hide them. |
| Worker dispatch | `dispatchDir` or `DISPATCH_ROOT` | Session shows worker lanes and a Fast switch. The switch writes a `fast` file for compatible Codex/pi workers, not the Claude session. |
| Skill launches | Matching thread/PR context and available skills | Launches wait ten seconds with Undo, with a shared five-per-local-day cap. The optional `darren-core:worker-dispatch` skill is used when installed; otherwise Delegate copies a plain instruction. |
| Calendar and drafts | `calendar.json`, `drafts.json` | Read-only summaries; the plugin does not send drafts. |
| Attention | `interruptions.json` | Local interruption summaries and ratings; hidden when absent. |
| Sentinel | External checker producing `sentinel.json` and `sentinel-state.json` | Evidence and action prompts; absence and stale checks are shown explicitly. The checker is not required. |
| Reload helper | `reloadHelper` script path | Runs `python3 <path> --plugin nextup@nextup --json`, expecting `plugins` and `needs_restart`. Without it, updates plugins and asks you to run `/reload-plugins`. |
| Worker questions | MCP form elicitation hook and `dataDir` | Local question/answer ledger; see below. Plain-chat questions are not covered. |

## Options

`openOnStart` defaults to `true`; set it to `false` for manual opening. `dataDir` accepts a leading `~`. `dispatchDir` and `reloadHelper` are optional paths; neither is needed for core use.

## Worker questions

An MCP form elicitation can appear as a One question card with Send answer and Skip. The hook writes `asks.json`, polls `answers.json`, and cancels unsupported or secret-shaped asks. URL-mode asks are declined. Safe saved boolean/enum rules can answer automatically; sensitive actions never match a rule. The default timeout is twenty minutes (`NEXTUP_ASK_TIMEOUT` in seconds). Only a safe ask may use its schema default on timeout; otherwise it cancels. Errors cancel. `NEXTUP_ASK_OFF=1` restores Claude's normal prompt route.

The hook requires Node 22.18+ or 23.6+ to load TypeScript directly. With no board it steps aside. Fallbacks: `/nextup ask`, `/nextup answer <id> <choice>`, or `scripts/nextup-answer <id> <value>`. See [the worker snippet](docs/worker-ask-snippet.md) and `plugin/hooks/elicit/demo/`.

**Verification limits:** question cards and Sentinel have harness coverage, not a verified desktop tap walkthrough. Elicitation was exercised through `claude -p`; interactive/desktop hook delivery and Select/Input taps remain unproven.

## Privacy and local writes

The session activity log is held in memory, not persisted or uploaded by Next up. Board actions do persist in your configured folder: marks, the daily plan, notes, launch reservations/history, press outcomes, interruption ratings, and the question/answer/rule ledger. Launch history retains up to 500 launches and evaluates their 48-hour outcomes. Press outcomes append to `mod-events.jsonl`, rotated past 1 MB. Optional integrations can run local commands, query GitHub or open sessions; enabling them is not an offline guarantee.

Keep real boards and credentials outside this repository. All supplied examples are synthetic. [docs/PUBLIC-FILES.txt](docs/PUBLIC-FILES.txt) is the publication allowlist, not an automatic export tool.

## Develop

```sh
NEXTUP_TYPES=/path/to/generated/types scripts/check.sh
```

The engine generates the types after hot-loading the plugin. Alternatively put them in `~/.cache/nextup/types`. The check type-checks, validates and tests the plugin, including press-handler linting and privacy scanning. `scripts/privacy-scan.sh` also checks board titles when `NEXTUP_DATA` points to a board.

See [CHANGELOG.md](CHANGELOG.md) for merged-PR history and [docs/SCHEMA.md](docs/SCHEMA.md) for the data contract.

## License

MIT; see `LICENSE`.
