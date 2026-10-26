# Board data contract

Set `dataDir` to a writable directory containing UTF-8 JSON. The plugin consumes these files; it does not require a particular board producer. Supply `threads.json` and `notes.json`. `calendar.json` and `drafts.json` are optional. A static board works without `build.py`.

The shapes below describe the producer contract in `plugin/types/index.d.ts`. Thread/note fields are not comprehensively validated at runtime: provide the complete required shape rather than relying on missing-field defaults. Use stable, unique string ids across threads and notes, since marks and plans refer to these ids. Use `null` for unknown numeric estimates, not a numeric string. Extra producer metadata is not part of this contract.

## `threads.json`

Object with `threads` (array of Thread) and `generated` (ISO 8601 timestamp string, used for scan freshness).

| Thread field | Type | Meaning |
| --- | --- | --- |
| `id` | string | Stable item identity. |
| `title`, `project` | string | Display title and project label. |
| `finish` | string | Concrete next step / completion condition. |
| `minutes` | number or null | Estimated effort in minutes. |
| `progress` | number | Completion percentage, 0–100. |
| `value` | number or null | Producer's value estimate, used in ranking. |
| `link`, `link_label` | string | Destination and display label; empty when absent. |
| `resume` | string | Session resume command; empty when absent. Remote commands may be copied rather than opened. |
| `source`, `status` | string | Producer's source and status descriptions. |
| `last` | string | Last activity timestamp; use ISO 8601, or empty if unknown. |
| `rated`, `blocked` | optional boolean | Whether rated / blocked. |
| `check` | optional string | `verified`: still needed, checked against the world; `ask`: unresolved. |
| `goal`, `last_ask`, `left_off` | optional string | Session context: first ask, latest ask and last words. |
| `branch` | optional string or null | Branch used when matching PR context. |
| `dirty` | optional number | Dirty-file count. |
| `prompt` | optional string | Producer-supplied side-task goal; otherwise built from the step. |

A producer should not renumber ids on each refresh. Otherwise previously completed work can reappear as a new item.

## `notes.json`

Object with `items` (array of Note).

| Note field | Type | Meaning |
| --- | --- | --- |
| `id` | string | Stable identity, distinct from thread ids. |
| `text`, `title`, `project` | string | Note body, display title and project label. |
| `ticked` | boolean | Already completed notes are filtered from the active board. |
| `minutes` | number or null | Effort estimate, if known. |
| `prompt` | optional string | Side-task instruction. |

An empty notes file is `{"items":[]}`, not an empty file or a bare array.

## `calendar.json` (optional)

Object with `date` (local `YYYY-MM-DD`) and `events` (array). Each event has string fields:

- `start`: local `HH:MM` or exactly `all day`.
- `end`: local `HH:MM`; empty for an event without an end.
- `title`: nonempty event label.
- `where`: location label, or empty.
- `link`: destination, or empty; use an HTTPS URL for external links.

Only today's local date is displayed. Remaining timed events are sorted by start, followed by all-day events. An end before the start is treated as crossing midnight and remaining until the end of the calendar date. Missing/non-string optional text becomes empty; entries without a title or recognizable start are filtered. Single-digit hours such as `9:00` are normalized, but producers should write valid zero-padded 24-hour times.

## `drafts.json` (optional)

Object with `at` (ISO 8601 refresh timestamp string) and `drafts` (array). Each draft has string fields `id`, `to`, `subject`, `link`. Use stable ids and HTTPS links; empty text is allowed. This is a display list, not a send queue: Next up does not send mail.

The reader substitutes positional ids (`draft-<index>`) for missing or repeated ids and coerces non-string text to empty. Producers should still supply the full shape, including unique ids.

## Errors and ownership

Missing or invalid required thread data produces a board problem rather than a clear-board success. Missing optional calendar/draft files show no corresponding summary; malformed optional input is handled defensively. Do not depend on defensive coercion as validation.

Keep generated inputs separate from plugin-owned state. In particular, do not overwrite `mod-marks.json` during refresh: it is an id-keyed object of `{done?, dropped?, parkUntil?, keep?, at}` records. `at` and `parkUntil` are epoch milliseconds; newest `at` wins. See [ADR-0001](adr/0001-marks-format.md) for merge rules.

Other state includes `today.json` (date and ordered ids; the planning day rolls over at 04:00), launch ledgers, event logs, ratings and elicitation files. These are not required inputs for a new board and should not be copied into public examples.

## Example

[../examples/dataDir/](../examples/dataDir/) contains complete synthetic files for all four inputs. Their dates are fixed for reproducibility; update the calendar date to today for a live demonstration. No private board export is needed.
