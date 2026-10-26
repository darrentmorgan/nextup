# Synthetic board

`dataDir/` is a complete, fictional board containing one thread, one note, one calendar event and one draft summary. It contains no real board titles, people, machine paths, repository links or session commands. Blank links deliberately make it safe to explore without opening external destinations.

From the repository root:

```sh
mkdir -p "$HOME/nextup-demo"
cp examples/dataDir/*.json "$HOME/nextup-demo/"
```

Configure `dataDir` as `~/nextup-demo` in the plugin options shown in the [README](../README.md). Use a writable copy, not this checked-in fixture: board actions save local state alongside the inputs.

The fixed timestamps are illustrative. Set `calendar.json`'s `date` to today's local `YYYY-MM-DD` for the event to appear; adjust `generated` in `threads.json` to try freshness indicators. The draft is display-only and has no send action. No `build.py`, account, worker dispatch skill or external board generator is needed.

See [docs/SCHEMA.md](../docs/SCHEMA.md) before replacing the example with your own producer output. Keep ids stable and distinct, and keep real data outside the repository.
