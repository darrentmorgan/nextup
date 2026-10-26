// Worker dispatch lanes (pi and Codex), read from the dispatch folder: <root>/<task>/state.json.
// Read only: nothing here writes a file or reaches the network. The shape of state.json belongs to the
// worker-dispatch skill; the group, phase and phase_at fields are newer and optional, so older lanes still read.

// Run and Lane live in the state contract (types/index.d.ts): the lanes snapshot is kept in state.
import type { Lane, Run } from '../types'
export type { Lane, Run }

export type Port = {
  list: (dir: string) => Promise<{ name: string; kind: string }[]>
  read: (path: string) => Promise<string>
  mtime: (path: string) => Promise<number>
  /** Whether a process is alive; absent where it cannot be asked, and then a running lane is believed. */
  alive?: (pid: number) => Promise<boolean>
}

export const UNGROUPED = 'Ungrouped'
export const RECENT_MS = 24 * 3600 * 1000

const time = (v: unknown) => {
  const t = typeof v === 'string' ? Date.parse(v) : NaN
  return Number.isNaN(t) ? undefined : t
}
const str = (v: unknown) => (typeof v === 'string' ? v : '')

/** One state.json as a lane; null when it is not JSON or not an object with a task. */
export function parseLane(text: string, dir: string, fileTime: number): Lane | null {
  let v: unknown
  try { v = JSON.parse(text) } catch { return null }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null
  const o = v as Record<string, unknown>
  const task = str(o.task) || dir.slice(dir.lastIndexOf('/') + 1)
  const runs: Run[] = (Array.isArray(o.runs) ? o.runs : []).flatMap((r, i): Run[] => {
    if (typeof r !== 'object' || r === null) return []
    const x = r as Record<string, unknown>
    return [{
      n: typeof x.n === 'number' ? x.n : i + 1,
      harness: str(x.harness) || '?',
      status: str(x.status) || 'unknown',
      started: time(x.started),
      ended: time(x.ended),
      wallS: typeof x.wall_s === 'number' ? x.wall_s : undefined,
      exit: typeof x.exit === 'number' ? x.exit : undefined,
      fast: typeof x.fast === 'boolean' ? x.fast : undefined,
      pids: [x.pid, x.launcher_pid].filter((n): n is number => typeof n === 'number' && Number.isInteger(n) && n > 0),
    }]
  })
  const phaseAt = time(o.phase_at)
  const last = runs.at(-1)
  const newest = [last?.ended, phaseAt, time(o.created)].filter((t): t is number => t !== undefined)
  return {
    task, group: str(o.group).trim() || UNGROUPED, unreadable: false, stale: false, repo: str(o.repo), branch: str(o.branch),
    phase: str(o.phase) || undefined, phaseAt, runs, dir,
    touched: newest.length ? Math.max(...newest) : fileTime,
  }
}

export const isRunning = (l: Lane) => !l.unreadable && !l.stale && l.runs.at(-1)?.status === 'running'

/** Every lane under root, as found: one folder each, a malformed state.json kept as an unreadable lane. */
export async function readLanes(port: Port, root: string): Promise<Lane[]> {
  let entries: { name: string; kind: string }[]
  try { entries = await port.list(root) } catch { return [] }
  const out: Lane[] = []
  for (const entry of entries) {
    if (entry.kind !== 'dir') continue
    const dir = `${root}/${entry.name}`
    const file = `${dir}/state.json`
    let text: string
    // An unknown age counts as new: an unreadable lane must still show.
    let fileTime = Number.MAX_SAFE_INTEGER
    const gone = { task: entry.name, group: UNGROUPED, unreadable: true, stale: false, repo: '', branch: '', runs: [] as Run[], dir }
    try { text = await port.read(file) } catch {
      // No state.json, or one that cannot be read: age it by the folder.
      try { fileTime = await port.mtime(dir) } catch { /* the age stays unknown */ }
      out.push({ ...gone, touched: fileTime })
      continue
    }
    try { fileTime = await port.mtime(file) } catch { /* the age stays unknown */ }
    const lane = parseLane(text, dir, fileTime)
    if (!lane) { out.push({ ...gone, touched: fileTime }); continue }
    const last = lane.runs.at(-1)
    if (port.alive && last?.status === 'running' && last.pids.length) {
      const alive = await Promise.all(last.pids.map(pid => port.alive!(pid).catch(() => true)))
      if (!alive.some(Boolean)) { lane.stale = true; lane.touched = fileTime }
    }
    out.push(lane)
  }
  return out
}

export type Group = { name: string; lanes: Lane[] }

/**
 * The lanes worth showing, in groups: running first, then those that moved in the last 24 hours.
 * Groups with a running lane come first, then the most recently moved; Ungrouped is last.
 */
export function groupLanes(lanes: Lane[], now: number): Group[] {
  const shown = lanes.filter(l => isRunning(l) || now - l.touched < RECENT_MS)
  const groups = new Map<string, Lane[]>()
  for (const l of shown) groups.set(l.group, [...(groups.get(l.group) ?? []), l])
  const order = (a: Lane, b: Lane) => Number(isRunning(b)) - Number(isRunning(a)) || b.touched - a.touched || a.task.localeCompare(b.task)
  const rank = (g: Group) => (g.name === UNGROUPED ? 2 : g.lanes.some(isRunning) ? 0 : 1)
  return [...groups].map(([name, ls]) => ({ name, lanes: ls.sort(order) }))
    .sort((a, b) => rank(a) - rank(b) || Math.max(...b.lanes.map(l => l.touched)) - Math.max(...a.lanes.map(l => l.touched)) || a.name.localeCompare(b.name))
}

/** m:ss under an hour, h:mm after. */
export function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}h` : `${m}:${r}`
}

export type Row = {
  task: string
  /** What the glyph shows: done is exit 0 only; stale is running with no live process. */
  kind: 'running' | 'done' | 'failed' | 'stale' | 'unreadable' | 'other'
  harness: string
  /** The phase when the lane has one, else the last run's status. */
  state: string
  /** Live for a running lane (now - started), else the run's own wall time. Empty when unknown. */
  elapsed: string
  /** The phase and when it was set, or the last run's status and exit. */
  step: string
  running: boolean
  unreadable: boolean
  brief: string
  report: string
}

const ago = (ms: number) => {
  const m = Math.floor(ms / 60_000)
  return m < 1 ? 'just now' : m < 60 ? `${m}m ago` : `${Math.floor(m / 60)}h ago`
}

export function rowOf(l: Lane, now: number): Row {
  const run = l.runs.at(-1)
  const kind: Row['kind'] = l.unreadable ? 'unreadable' : l.stale ? 'stale' : isRunning(l) ? 'running'
    : run?.status === 'failed' ? 'failed' : run?.status === 'done' && run.exit === 0 ? 'done' : 'other'
  const base = { task: l.task, kind, brief: `${l.dir}/brief.md`, report: run ? `${l.dir}/runs/${run.n}-${run.harness}/` : '', running: isRunning(l), unreadable: l.unreadable }
  if (l.unreadable) return { ...base, harness: '', state: 'unreadable', elapsed: '', step: 'unreadable · state.json could not be read', report: '' }
  const status = l.stale ? 'stale' : run?.status ?? 'brief'
  const stoppedAt = l.touched < Number.MAX_SAFE_INTEGER ? l.touched : undefined
  const length = !run ? '' : l.stale ? (run.started !== undefined && stoppedAt !== undefined ? elapsed(stoppedAt - run.started) : '')
    : run.status === 'running' && run.started !== undefined ? elapsed(now - run.started)
    : run.wallS !== undefined ? elapsed(run.wallS * 1000) : run.started !== undefined && run.ended !== undefined ? elapsed(run.ended - run.started) : ''
  const step = l.stale ? `stale · process gone${stoppedAt !== undefined ? ` · ${ago(now - stoppedAt)}` : ''}` : l.phase ? `${l.phase}${l.phaseAt !== undefined ? ` · ${ago(now - l.phaseAt)}` : ''}`
    : run ? `${run.status}${run.exit !== undefined ? ` · exit ${run.exit}` : ''}` : 'brief'
  return { ...base, harness: run?.harness ?? '', state: l.stale ? 'stale' : l.phase ?? status, elapsed: length, step }
}
