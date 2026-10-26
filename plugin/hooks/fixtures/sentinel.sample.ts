// A sample of the sentinel.json that sentinel.py writes (board pipeline): the contract this mod reads.
export default {
  "schema": 1,
  "generated": "2026-10-26T11:30:00+10:30",
  "status": "attention",
  "cards": [
    {
      "id": "sentinel-3f9a1c20",
      "fp": "3f9a1c20b7d4",
      "invariant": "SN-01",
      "severity": "P0",
      "title": "Phone ticks missing from the board (3 of 5 since 24 Oct)",
      "summary": "Ticks made on the phone never reached the Mac marks file.",
      "evidence": [
        "board-events: 5 done marks, mod-marks: 2 (refresh.log.jsonl 2026-10-26T09:27)",
        "board-marks doc last written 11:37 by Mac"
      ],
      "firstSeen": "2026-10-24T09:27:00+10:30",
      "lastSeen": "2026-10-26T11:30:00+10:30",
      "count": 14,
      "recurrence": 1,
      "state": "open",
      "route": "hard-bug",
      "routeWhy": "came back after PR 59",
      "prompt": "/darren-core:hard-bug\nNext up Sentinel found: Phone ticks missing from the board (invariant SN-01, P0, seen 14x since 2026-10-24, recurrence 1)\nPromise broken: a tick made on the phone shows on the Mac.\nEvidence: board-events holds 5 done marks, mod-marks holds 2.\nDone means: the check passes on live data and a regression test replays this evidence.",
      "fixHint": ""
    },
    {
      "id": "sentinel-81be07d4",
      "fp": "81be07d4a2c9",
      "invariant": "SN-05",
      "severity": "P1",
      "title": "Failed to read task file for xfer-triage-to-mini (63 times)",
      "summary": "An orphan scheduled task fails on every start.",
      "evidence": [
        "main.log: Failed to read task file for xfer-triage-to-mini x63 since 09:12"
      ],
      "firstSeen": "2026-10-26T09:12:00+10:30",
      "lastSeen": "2026-10-26T11:29:00+10:30",
      "count": 63,
      "recurrence": 0,
      "state": "open",
      "route": "quick-fix",
      "routeWhy": "known fix",
      "prompt": "Remove the task from scheduled tasks or restore ~/.claude/scheduled-tasks/xfer-triage-to-mini/SKILL.md.",
      "fixHint": "Remove the scheduled task xfer-triage-to-mini"
    }
  ]
}
