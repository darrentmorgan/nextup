---
status: accepted
---

# The marks file is a public format, defined only by the Marks ledger

`mod-marks.json` in the data folder holds every Mark, and people and their own scripts read and write it beside the mod. So it is a public format, and the Marks ledger in the mod is its only definition. Everything else that touches the file follows the ledger. The rules:

- One entry per item id: `{ done?, dropped?, parkUntil?, keep?, at }`, where `at` is milliseconds since the epoch.
- The newest `at` for an item wins. A writer that merges marks from elsewhere keeps the entry with the larger `at` and never mixes the fields of two entries.
- Undo writes an entry with only `at` (and `keep`, if set). The cleared entry keeps its time, so an older mark from elsewhere cannot win back.
- Keep survives every later mark on the item. No action removes it.
- Drop is written as `dropped` alone. A reader treats `dropped`, with or without `done`, as off the board and never counted as done.
- Park hides the item until `parkUntil`. After that time the entry means nothing.
- A file that exists but does not parse is never overwritten. The mod reports it and waits for a Retry.

## Considered options

- **Each writer keeps its own rules.** This is how it was before: the pane's TypeScript and personal Python scripts each had a copy, and the copies drifted (Drop written two ways, Keep lost on export, merge versus replace). Rejected.
- **A shared fixture file of rule cases that writers in any language test against.** Deferred, not rejected. Today the only other writers are personal scripts outside this repo. Add the fixtures when a second writer needs them, and the personal pipeline is the first planned user.

## Consequences

The mod cannot write the file atomically, because the engine's file API has no rename. The ledger checks the file's modified time before it reads and again before it writes, and merges again if another writer changed it between the two.
