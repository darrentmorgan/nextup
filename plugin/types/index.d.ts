export type Thread = {
  id: string
  title: string
  project: string
  finish: string
  minutes: number | null
  progress: number
  link: string
  link_label: string
  resume: string
  source: string
  status: string
  value: number | null
  last: string
  rated?: boolean
  blocked?: boolean
  /** 'verified': still needed, checked against the world; 'ask': nothing settled it. */
  check?: string
  /** The session's context, from scan_threads.py: its first ask, latest ask and last words. */
  goal?: string
  last_ask?: string
  left_off?: string
  branch?: string | null
  dirty?: number
  /** A /goal line for a side task, written by the refresh; built from the step when absent. */
  prompt?: string
}

export type Note = {
  id: string
  text: string
  title: string
  project: string
  ticked: boolean
  minutes: number | null
  prompt?: string
}

export type Board = { threads: Thread[]; notes: Note[]; generated: string }

/** One person's action on an item; the newest `at` wins across sessions and the artifact. */
/** keep: you said the step is still needed (Left Off's Later or still open), so it counts as to do though unchecked. */
export type Mark = { done?: boolean; dropped?: boolean; parkUntil?: number; keep?: boolean; at: number }
export type Marks = Record<string, Mark>

/** One of your open PRs; checks is the head commit's rollup state from GitHub, 'NONE' when it has none. */
export type PR = { title: string; url: string; number: number; repo: string; draft: boolean; updated: string; checks: string }

/** Today's calendar as the 8am refresh writes it; start is "HH:MM" or "all day". */
export type CalEvent = { start: string; end: string; title: string; where: string; link: string }
export type Calendar = { date: string; events: CalEvent[] }
/** Gmail drafts waiting to send, read by the refresh; nothing here sends. */
export type Draft = { id: string; to: string; subject: string; link: string }
export type Drafts = { at: string; drafts: Draft[] }

/** The day's plan: ids picked with "+ Today", in order; a day starts at 4am. */
export type Plan = { date: string; ids: string[] }

/** A session that waits on you: idle, its last reply asks you something. */
export type Need = {
  id: string
  title: string
  /** 'hq' for an HQ, 'child' for a session another started, '' for neither. */
  kind: 'hq' | 'child' | ''
  /** The session this one nests under, when that session is also listed. */
  parent?: string
  /** What it asks, one line. */
  ask: string
  /** lastActivityAt, in milliseconds. */
  since: number
  link: string
}

export type Turn = { at: number; end?: number }
export type Spawn = { id: string; name: string; at: number; end?: number; call?: string }

/** One tool call of this session, as the log shows it. */
export type ToolEvent = {
  id: string
  at: number
  tool: string
  summary: string
  /** Running until the tool answers; denied when a hook or the person refused it. */
  status: 'running' | 'ok' | 'failed' | 'denied'
  ms?: number
  /** Set when a subagent made the call. */
  agent?: string
  asked?: boolean
  prompt?: boolean
  /** Who sent a prompt that the person did not type: a helper's name, or 'session' or 'main'. */
  from?: string
}

/** A file this session edited or wrote, with how many times and when last. */
export type FileTouch = { path: string; count: number; at: number; tool: string; edits: { at: number; tool: string; agent?: string }[] }

/** A shell command this session ran. */
export type ShellRun = { id: string; command: string; at: number; status: ToolEvent['status']; ms?: number }

/** A worker dispatch lane and its runs, as hooks/lanes.ts reads them from <root>/<task>/state.json. */
export type Run = { n: number; harness: string; status: string; started?: number; ended?: number; wallS?: number; exit?: number; fast?: boolean; pids: number[] }

export type Lane = {
  task: string
  /** The Workflow run this lane belongs to; 'Ungrouped' when state.json has none. */
  group: string
  /** True when state.json is missing or could not be read as a lane. */
  unreadable: boolean
  /** True when the last run says running but none of its processes is alive. */
  stale: boolean
  repo: string
  branch: string
  phase?: string
  phaseAt?: number
  runs: Run[]
  /** The lane's own folder, where brief.md and runs/<n>-<harness>/ live. */
  dir: string
  /** When the lane last moved, ms: the newest of the last run's end, phase_at and created, else the file's age (a stale lane: the file's age). */
  touched: number
}

/** The Attention card's interruptions (interruptions.json) and ratings, as hooks/attention.ts reads them. */
export type Counts = { day: string; a: number; b: number; c: number; d: number; total: number; blocked_wait_min: number }
export type Recent = { id: string; project: string; day: string; ts: string; cls: 'a' | 'b' | 'c' | 'd'; summary: string; wait_min: number }
export type Attention = { today: string; totals: Counts[]; projects: { project: string; trial: boolean; counts: Counts }[]; trials: string[]; recent: Recent[] }
export type Ratings = Record<string, { rating: 'worth' | 'not'; at: string }>
export type AttentionRead = { dir: string; at: number; data: Attention | null; ratings: Ratings }

/** One thing the Sentinel found, as sentinel.py writes it into sentinel.json. */
export type SentinelCard = {
  id: string; fp: string; invariant: string; severity: 'P0' | 'P1' | 'P2'; title: string; summary: string
  evidence: string[]; firstSeen: string; lastSeen: string; count: number; recurrence: number
  state: string; route: string; routeWhy: string; prompt: string; fixHint: string
}
/** What sentinel.json and sentinel-state.json said at the last read (see hooks/sentinel.ts). */
export type SentinelRead = {
  installed: boolean
  status: 'ok' | 'attention' | 'blind' | 'failing'
  cards: SentinelCard[]
  /** When the checker last ran (epoch ms), or null when no state says. */
  checkedAt: number | null
  problem: 'report' | 'state' | null
}

/** What the last button press did, drawn under the header: pending, done, nothing changed, or why it failed. */
export type Feedback = { id: string; action: string; kind: 'pending' | 'ok' | 'fail' | 'noop'; text: string; at: number } | null

declare module 'claude-code' {
  interface PluginState {
    nextup: {
      board: Board | null
      marks: Marks
      bandHidden: boolean
      building: boolean
      momentumMinute: number
      pluginReload: { running: boolean; message: string; failed: boolean; at?: number }
      tab: 'focus' | 'work' | 'notes' | 'wins' | 'parked' | 'session'
      open: string | null
      cardNote: { id: string; kind: 'pending' | 'ok' | 'fail'; text: string } | null
      /** The last button press's outcome (see hooks/events.ts). */
      feedback: Feedback
      /** What sentinel.json and sentinel-state.json said at the last read; null before the first read. */
      sentinel: SentinelRead | null
      more: string[]
      /** Worker lanes whose row is expanded, by lane folder. */
      dispatchOpen: string[]
      plan: Plan
      /** Open PRs and when gh was last read. */
      prs: { at: number; items: PR[] } | null
      cal: Calendar | null
      drafts: Drafts | null
      /** Why the board could not be read, or null when it was. */
      problem: string | null
      /** Why the pull requests could not be read, or null. */
      prsProblem: string | null
      /** Worker fast mode (the dispatch skill's saved default), or null when dispatch is not set up. */
      workerFast: boolean | null
      /** True once the first read of the board has finished. */
      loaded: boolean
      /** The id of a bulk action waiting for a second press. */
      confirm: string | null
      /** Ids whose Done was just pressed, to the press time; their rows stay in place a few seconds. */
      settling: Record<string, number>
      /** This session's tool calls, newest last, capped. */
      log: ToolEvent[]
      turn: Turn | null
      spawns: Spawn[]
      files: FileTouch[]
      shell: ShellRun[]
      /** Sessions waiting on you, or null outside the desktop app. */
      needs: Need[] | null
      /** Why the session server refused a read (a permission denial, say), or null. */
      needsProblem: string | null
      /** Sessions stopped on a permission prompt, from the permission-wait hook's files. */
      permWaits: { id: string; title: string; tool: string; since: number }[]
      /** The worker lanes as last read, the folder they came from, and the card they drew as one string; null before the first read. */
      lanes: { root: string; lanes: Lane[]; signature: string } | null
      /** The Attention card's interruptions and ratings as last read, and when; null before the first read. */
      attention: AttentionRead | null
      /** The Attention card's All projects toggle. */
      attentionAll: boolean
      /** Launches waiting out their 10 s Undo, by thread id; waiting when another session holds the lock. */
      launches: Record<string, { skill: string; stage: string; waiting?: boolean }>
      /** Whether darren-core serves /handoff-and-clear; null until looked up. */
      handoff: boolean | null
      /** Blocker Ledger rows read from the data folder (asks, answers, rules, log). */
      'elicit-ledger': { asks: object[]; answers: object[]; rules: object[]; log: object[] }
      /** The card's unsent choices, by ask id. */
      'elicit-drafts': Record<string, { picked: Record<string, unknown>; remember: boolean }>
    }
  }
}
