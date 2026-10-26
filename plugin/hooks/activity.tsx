import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, RenderElement, RenderInput } from 'claude-code'

import { drawDispatch } from './dispatch'
import { act, view } from './events'
import { desk, surfaceTheme, tone } from './theme'
import type { FileTouch, ShellRun, Spawn, ToolEvent } from '../types'

// What this session has done, recorded from its own tool calls as they happen.
// Kept in session state only: nothing is written to disk or sent anywhere.

export const LOG_CAP = 500
export const FILES_CAP = 200
export const SHELL_CAP = 200
/** Longest command text kept; a heredoc can be pages long. */
export const COMMAND_CHARS = 2000

export const log = atom({ plugin: 'nextup', key: 'log' } as const, [])
export const files = atom({ plugin: 'nextup', key: 'files' } as const, [])
export const shell = atom({ plugin: 'nextup', key: 'shell' } as const, [])
export const turn = atom({ plugin: 'nextup', key: 'turn' } as const, null)
export const spawns = atom({ plugin: 'nextup', key: 'spawns' } as const, [])
const more = atom({ plugin: 'nextup', key: 'more' } as const, [])

export async function pressActivity($: EngineInterface, id: string) {
  if (id.startsWith('file-') || id === 'turn-calls') {
    await update($, more, s => s.includes(id) ? s.filter(x => x !== id) : [...s, id])
  } else if (['gate-waiting', 'gate-allowed', 'gate-asked', 'gate-denied'].includes(id)) {
    const gate = gateStats(await read($, log))
    const count = id === 'gate-waiting' ? (await read($, log)).filter(isWaiting).length : id === 'gate-allowed' ? gate.allowed : id === 'gate-asked' ? gate.asked : gate.denied
    if (count) await update($, more, s => [...s.filter(x => !['gate-waiting', 'gate-allowed', 'gate-asked', 'gate-denied'].includes(x)), ...(s.includes(id) ? [] : [id])])
  }
}

const WRITES = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])

const firstLine = (v: string, n = 120) => {
  const line = v.trim().split('\n')[0] ?? ''
  return line.length > n ? `${line.slice(0, n - 1)}…` : line
}

/** A path under the session's folder is shown relative to it. */
export const relative = (path: string, cwd: string) =>
  cwd && path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path

type Args = Record<string, unknown>
const s = (a: Args, k: string) => (typeof a[k] === 'string' ? (a[k] as string) : '')

/** The path a writing tool changed, or '' for any other tool. */
export function touchedPath(tool: string, a: Args) {
  if (!WRITES.has(tool)) return ''
  return s(a, 'file_path') || s(a, 'notebook_path')
}

/** One line saying what the call did, from its arguments. */
export function summarise(tool: string, a: Args, cwd = '') {
  const path = s(a, 'file_path') || s(a, 'notebook_path') || s(a, 'path')
  if (tool === 'Bash') return firstLine(s(a, 'command'))
  if (path && tool !== 'Grep' && tool !== 'Glob') return relative(path, cwd)
  if (tool === 'Grep' || tool === 'Glob') return firstLine(`${s(a, 'pattern')}${path ? `  in ${relative(path, cwd)}` : ''}`)
  if (tool === 'WebFetch') return firstLine(s(a, 'url'))
  if (tool === 'WebSearch') return firstLine(s(a, 'query'))
  if (tool === 'Agent' || tool === 'Task') return firstLine(s(a, 'description') || s(a, 'subagent_type'))
  if (tool === 'Skill') return firstLine(s(a, 'skill'))
  const mcp = /^mcp__(.+?)__(.+)$/.exec(tool)
  if (mcp) return `${mcp[1]} · ${mcp[2]}`
  return ''
}

/** Short name for the log: an MCP tool by its own name, others as they are. */
export const toolName = (tool: string) => /^mcp__.+?__(.+)$/.exec(tool)?.[1] ?? tool

async function timestamp($: EngineInterface) {
  try { return await $.clock.now() } catch { return Date.now() }
}

const TYPED = ['composer', 'bridge', 'sdk', 'user']
const SESSIONS = ['peer', 'peer-send-message', 'projects-relay', 'coordinator', 'channel', 'slack-ping']

/**
 * A log row for a prompt: who sent it and a short line saying what it is. The person's own, typed
 * or from their phone, is as typed with no sender ("you"). Anything else names its sender (a helper by
 * its agent id, another session, or the main loop) and reads as a short label, never its raw markup:
 * a helper's hand-back is "reported back", a task notification its summary, a session's message who sent it.
 */
export function describePrompt(text: string, origin: { kind: string } | string | undefined, helpers: Spawn[]): { from?: string; summary: string } {
  const kind = typeof origin === 'string' ? origin : origin?.kind
  const tag = /^\s*<([\w-]+)([^>]*)>/.exec(text)
  if (!kind || TYPED.includes(kind) || (kind === 'unclassified' && !tag)) return { summary: firstLine(text) }
  const attr = (name: string) => tag ? new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(tag[2]!)?.[1] : undefined
  const helper = (id?: string) => (id && helpers.find(x => x.id === id.trim())?.name) || undefined
  const by = SESSIONS.includes(kind) ? 'session' : 'main'
  switch (tag?.[1]) {
    case 'agent-message': return { from: helper(attr('from')) ?? 'helper', summary: 'reported back' }
    case 'task-notification': {
      const field = (name: string) => new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(text)?.[1]?.trim()
      const status = field('status')
      return { from: helper(field('task-id')) ?? 'main', summary: firstLine(field('summary') || (status ? `task ${status}` : 'task finished')) }
    }
    case 'cross-session-message': {
      const name = attr('name')
      return { from: 'session', summary: firstLine(name ? `message from ${name}` : 'message from another session') }
    }
    case undefined: return { from: by, summary: firstLine(text) }
    default: return { from: by, summary: tag![1]!.replace(/-/g, ' ') }
  }
}

const cap = <T,>(list: T[], n: number) => (list.length > n ? list.slice(list.length - n) : list)

/** Records every tool call; the call itself runs exactly as it would without this hook. */
export function recordActivity(on: On) {
  let seq = 0
  // Classic permission requests have no call id; correlate with the still-running
  // call's tool, arguments and loop instead of inferring prompts from outcomes.
  const pending = new Map<string, { tool: string; args: Args; agent?: string }>()
  on('classic.PermissionRequest', async ($, e, next) => {
    try {
      const entry = [...pending].find(([, x]) => x.tool === e.tool_name && x.agent === e.agent_id &&
        Object.entries((e.tool_input ?? {}) as Args).every(([k, v]) => JSON.stringify(x.args[k]) === JSON.stringify(v)))
      if (entry) await update($, log, l => l.map(x => x.id === entry[0] ? { ...x, asked: true } : x))
    } catch { /* observational only */ }
    return next(e)
  })
  on('prompt.submit', async ($, e, next) => {
    if (!(e as unknown as Args).agentId) {
      try {
        const at = await timestamp($)
        await update($, turn, () => ({ at }))
        const { from, summary } = describePrompt(e.text, e.origin, await read($, spawns))
        await update($, log, l => cap([...l, { id: `prompt-${at}-${++seq}`, at, tool: '', summary, status: 'ok', prompt: true, ...(from ? { from } : {}) }], LOG_CAP))
      } catch { /* observational only */ }
    }
    return next(e)
  })
  on('agent.spawn', async ($, e, next) => {
    const at = await timestamp($)
    const out = await next(e)
    if (out.agentId) {
      const id = out.agentId
      try { await update($, spawns, l => cap([...l, { id, name: firstLine(e.description || e.subagentType || 'Helper'), at, call: e.tool_use_id }], LOG_CAP)) } catch { /* observational only */ }
    }
    return out
  })
  on('turn.complete', async ($, e, next) => {
    try {
      const end = await timestamp($)
      if (e.agentId) await update($, spawns, l => l.map(x => x.id === e.agentId && x.end === undefined ? { ...x, end } : x))
      else await update($, turn, t => t ? { ...t, end } : t)
    } catch { /* observational only */ }
    return next(e)
  })
  on('tool.call', async ($, e, next) => {
    const id = e.tool_use_id ?? `call-${Date.now()}-${++seq}`
    const args = e as unknown as Args
    const started = await timestamp($)
    pending.set(id, { tool: e.tool, args, agent: e.agentId })
    let cwd = ''
    try {
      cwd = await $.session.cwd()
      const event: ToolEvent = { id, at: started, tool: e.tool, summary: summarise(e.tool, args, cwd), status: 'running' }
      if (typeof e.agentId === 'string' && e.agentId) event.agent = e.agentId
      await update($, log, l => cap([...l, event], LOG_CAP))
      if (e.tool === 'Bash') {
        const run: ShellRun = { id, command: s(args, 'command').trim().slice(0, COMMAND_CHARS), at: started, status: 'running' }
        await update($, shell, l => cap([...l, run], SHELL_CAP))
      }
    } catch {
      // Recording never stands in the way of the call.
    }
    let out
    try { out = await next(e) } finally { pending.delete(id) }
    try {
      const status: ToolEvent['status'] = out.deny !== undefined ? 'denied' : out.isError ? 'failed' : 'ok'
      const finished = await timestamp($)
      const ms = finished - started
      await update($, log, l => l.map(x => (x.id === id ? { ...x, status, ms } : x)))
      if (e.tool === 'Bash') await update($, shell, l => l.map(x => (x.id === id ? { ...x, status, ms } : x)))
      const path = status === 'ok' ? touchedPath(e.tool, args) : ''
      if (path) {
        const shown = relative(path, cwd)
        await update($, files, l => {
          const was = l.find(f => f.path === shown)
          const rest = l.filter(f => f.path !== shown)
          const touch: FileTouch = { path: shown, count: (was?.count ?? 0) + 1, at: finished, tool: e.tool,
            edits: cap([...(was?.edits ?? []), { at: finished, tool: e.tool, ...(e.agentId ? { agent: e.agentId } : {}) }], 20) }
          return cap([...rest, touch], FILES_CAP)
        })
      }
    } catch {
      // As above: the result goes back untouched.
    }
    return out
  })
}


// ---------- Gate and helpers, worked out from the log ----------

export type Gate = { total: number; allowed: number; denied: number; asked?: number; running: number }

/** Finished calls split into allowed and denied; a call still running is counted apart. */
export function gateStats(events: ToolEvent[]): Gate {
  const g: Gate = { total: 0, allowed: 0, denied: 0, running: 0 }
  for (const x of events) {
    if (x.prompt) continue
    if (x.asked) g.asked = (g.asked ?? 0) + 1
    if (x.status === 'running') {
      g.running += 1
      continue
    }
    g.total += 1
    if (x.status === 'denied') g.denied += 1
    else if (!x.asked) g.allowed += 1
  }
  return g
}

const isWaiting = (x: ToolEvent) => !x.prompt && x.asked === true && x.status === 'running'

/** Keep live and recent lanes; age a finish from completion, not launch. */
export function sessionLanes(records: Spawn[], now: number) {
  const visible = records.filter(x => x.end === undefined || now - x.end <= 2 * 60 * 60_000)
  return { visible, finished: records.length - visible.length }
}

/** Helpers show an activity label, not tool arguments. Full details remain in the log. */
export function helperLabel(event: ToolEvent) {
  const labels: Record<string, string> = {
    Bash: 'Running command', Read: 'Reading files', Edit: 'Editing files',
    MultiEdit: 'Editing files', Write: 'Writing files', NotebookEdit: 'Editing notebook',
    Grep: 'Searching files', Glob: 'Finding files', WebFetch: 'Fetching page',
    WebSearch: 'Searching web', Agent: 'Delegating work', Task: 'Delegating work',
    Skill: 'Using skill',
  }
  return labels[event.tool] ?? 'Using tool'
}

export type Tick = { id: string; at: number; bad: boolean }
export type Helper = { id: string; name: string; status: ToolEvent['status']; at: number; ms?: number; start: number; len: number; calls: number; last?: ToolEvent; ticks: Tick[] }

/**
 * The helpers' shared time axis: from the earliest start to now while any runs, else to the last finish,
 * so finished lanes keep their length however long the card stays open.
 */
export function helperAxis(records: Spawn[], now: number) {
  const live = records.some(x => x.end === undefined)
  const first = Math.min(now, ...records.map(x => x.at))
  const last = live || !records.length ? now : Math.max(first, ...records.map(x => x.end!))
  return { first, last, live }
}

/** How long after a batch's last helper ends (or last called a tool, while it runs) a new start still joins it. */
export const BATCH_GAP = 120_000
/** How long after its start a running helper counts as busy even before its first call. */
export const BUSY = 600_000

/**
 * The latest batch of helpers, oldest first: walking by start time, a helper that starts more than
 * BATCH_GAP after every helper so far has ended begins a new batch. A running helper reaches as far as
 * its last call, and at least BUSY past its start (it may be thinking), so one left idle cannot hold a
 * batch open for hours. Without `events`
 * a running helper reaches now.
 */
export function latestBatch(records: Spawn[], now: number, events?: ToolEvent[]): Spawn[] {
  const reach = (x: Spawn) => x.end ?? (events ? Math.max(Math.min(now, x.at + BUSY), ...events.filter(e => e.agent === x.id).map(e => e.at)) : now)
  let batch: Spawn[] = []
  let until = -Infinity
  for (const x of [...records].sort((p, q) => p.at - q.at)) {
    if (x.at > until + BATCH_GAP) batch = []
    batch.push(x)
    until = Math.max(until, reach(x))
  }
  return batch
}

/** A helper's own hand-back to the main loop: plumbing, never what it is doing, counted or ticked. */
const INTERNAL = /^(SubagentHandback|StructuredOutput)$/

/**
 * Spawn lifetimes on one shared axis (helperAxis), each with its own calls (matched by agent id)
 * as ticks. Never use Agent launch latency. `events` are oldest first.
 */
export function helperRuns(events: ToolEvent[], now: number, records: Spawn[] = []): Helper[] {
  const { first, last } = helperAxis(records, now)
  const width = Math.max(1, last - first)
  const pos = (at: number) => Math.min(1, Math.max(0, (at - first) / width))
  return records.map(x => {
    const ms = x.end === undefined ? undefined : x.end - x.at
    const own = events.filter(e => e.agent === x.id && !INTERNAL.test(e.tool))
    const start = pos(x.at)
    return {
      id: x.id, name: x.name, status: x.end === undefined ? 'running' : 'ok', at: x.at, ms,
      start, len: pos(x.end ?? now) - start, calls: own.length, last: own.at(-1),
      ticks: own.map(e => ({ id: e.id, at: pos(e.at), bad: e.status === 'failed' || e.status === 'denied' })),
    }
  })
}

// ---------- Drawing ----------

const MARK: Record<ToolEvent['status'], [string, string]> = {
  running: ['◌', tone.brand],
  ok: ['✓', tone.done],
  failed: ['✗', tone.fail],
  denied: ['⊘', tone.warn],
}

const clock = (at: number) => new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })
/** A length of time for the axis scale: 45s, 1m 20s, 2m, 1h 5m. */
export const span = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return s % 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s / 60}m`
  const m = Math.floor(s / 60)
  return m % 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m / 60}h`
}
export const took = (ms?: number) => ms === undefined ? '' : `${Math.floor(ms / 60_000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`
export const age = (at: number, now: number) => {
  const m = Math.max(0, Math.floor((now - at) / 60_000))
  return m < 1 ? 'now' : m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h` : `${Math.floor(m / 1440)}d`
}

// A phone-style switch, drawn: green track with the knob right when on, grey with it left when off.
const fastPill = (on: boolean) => `<svg xmlns="http://www.w3.org/2000/svg" width="50" height="24" viewBox="0 0 50 24">` +
  `<rect width="50" height="24" rx="12" fill="${on ? '#22c55e' : '#8e8e93'}" fill-opacity="${on ? 1 : 0.45}"/>` +
  `<text x="${on ? 15 : 35}" y="15.5" text-anchor="middle" font-family="-apple-system, system-ui, sans-serif" font-size="9" font-weight="700" fill="#ffffff">${on ? 'ON' : 'OFF'}</text>` +
  `<circle cx="${on ? 38 : 12}" cy="12" r="10" fill="#ffffff"/></svg>`

/** How many rows each section shows before Show more. */
export const SHOWN = { log: 7, files: 8, turn: 8 } as const

/** The Session tab: what this session has done, newest first. */
export async function drawActivity($: EngineInterface, e: RenderInput<'Pane'>, fast?: { on: boolean; toggle: () => unknown }): Promise<RenderElement> {
  const els = $.ui.resolve(e)
  const { Box, Text, Button } = els
  const events = [...(await read($, log))].reverse()
  // A hand-back or structured-output call is how a helper reports back; its "reported back" row already says so.
  const logged = events.filter(x => x.prompt || !INTERNAL.test(x.tool))
  const touched = [...(await read($, files))].reverse()
  const current = await read($, turn)
  const records = await read($, spawns)
  const open = await read($, more)
  const terminal = e.surface === 'terminal'
  const skin = surfaceTheme(e.surface)
  const now = await timestamp($)
  const cut = <T,>(id: string, items: T[], n: number) => (open.includes(`act-${id}`) ? items : items.slice(0, n))
  const moreRow = (id: string, total: number, n: number) =>
    total > n ? (
      <Box key={`am-${id}`} paddingX={1} hover={{ backgroundColor: skin.hover }}>
        <Button
          key={`amore-${id}`}
          plain
          dimColor
          label={open.includes(`act-${id}`) ? 'Show less' : `Show ${total - n} more`}
          onPress={view($, () => update($, more, s => (s.includes(`act-${id}`) ? s.filter(x => x !== `act-${id}`) : [...s, `act-${id}`])))}
        />
      </Box>
    ) : null
  const empty = (id: string, text: string) => (
    <Box key={`ae-${id}`} paddingX={1}>
      <Text size="caption" dimColor>{text}</Text>
    </Box>
  )
  const card = (key: string, title: string, side: string, children: (RenderElement | null)[], glyph?: RenderElement, control?: RenderElement) => (
    <Box key={`pc-${key}`} width="100%" flexShrink={1} minWidth={0} flexDirection="column" gap="xs" paddingX="sm" paddingY="xs" borderStyle="round" {...skin.card()}>
      <Box width="100%" flexShrink={1} minWidth={0} justifyContent="space-between" alignItems="center" gap={1}>
        <Box gap={1} flexShrink={0} alignItems="center">{glyph}<Text size={skin.title} weight="bold">{title}</Text>{control}</Box>
        <Box flexShrink={1} minWidth={0}><Text size="caption" dimColor tabular wrap="truncate-end">{side}</Text></Box>
      </Box>
      {children}
    </Box>
  )
  const gate = gateStats(events)
  const waiting = events.filter(isWaiting).length
  const counts = [waiting, gate.asked ?? 0, gate.denied]
  const colors = [tone.warn, tone.accent, tone.warn]
  const kinds = ['waiting', 'asked', 'denied'] as const
  const who = (agent?: string) => agent ? records.find(a => a.id === agent)?.name || 'Helper' : 'main'
  const row = (key: string, at: number, identity: string, detail: string, color: string) => (
    <Box key={key} {...skin.rows} width="100%" flexShrink={1} minWidth={0} gap={1} flexWrap="nowrap" alignItems="center" hover={{ backgroundColor: skin.hover }}>
      <Box width={5} flexShrink={0}><Text size="caption" dimColor tabular wrap="truncate-end">{clock(at)}</Text></Box>
      <Box width={1} flexShrink={0}><Text size="caption" dimColor wrap="truncate-end">·</Text></Box>
      <Box width={12} flexShrink={0}><Text size="caption" color={color} wrap="truncate-end">{firstLine(identity, 12)}</Text></Box>
      <Box width={1} flexShrink={0}><Text size="caption" dimColor wrap="truncate-end">·</Text></Box>
      <Box flexShrink={1} flexGrow={1} minWidth={0}><Text size="caption" wrap="truncate-end">{detail}</Text></Box>
    </Box>
  )
  const callRow = (x: ToolEvent, prefix: string) => row(`${prefix}-${x.id}`, x.at, x.prompt ? x.from ?? 'you' : who(x.agent),
    x.prompt ? x.summary : [toolName(x.tool), x.summary].filter(Boolean).join(' · '), x.agent || x.from ? tone.brand : x.prompt ? tone.quiet : tone.warn)
  const gateCalls = (kind: typeof kinds[number] | 'allowed') => events.filter(x => !x.prompt && (kind === 'waiting' ? isWaiting(x) : kind === 'asked' ? x.asked : kind === 'denied' ? x.status === 'denied' : x.status !== 'running' && x.status !== 'denied' && !x.asked))
  // Fast mode is the build workers' setting (Codex and pi), never this Claude session's own.
  const pressFast = act($, 'worker-fast', async () => { if (fast) await fast.toggle() }, { label: 'change worker fast mode' })
  const fastSwitch = fast ? terminal ?
    <Button key="helper-fast" plain label={`⚡ Fast ${fast.on ? '●' : '○'}`} onPress={pressFast} /> :
    <Box key="helper-fast-group" gap="xs" alignItems="center">
      <Text color={fast.on ? tone.warn : tone.quiet}>⚡</Text>
      {'Svg' in els ? <els.Svg source={fastPill(fast.on)} alt={`Fast mode ${fast.on ? 'on' : 'off'}`} width={50} height={24} /> :
        <Text color={fast.on ? tone.done : tone.quiet}>{fast.on ? '●' : '○'}</Text>}
      <Button key="helper-fast" plain label="Fast" onPress={pressFast} />
      <Text size="caption" dimColor wrap="truncate-end">Codex and pi only</Text>
    </Box> : undefined
  const thisTurn = events.filter(x => !x.prompt && current && x.at >= current.at)
  const failed = thisTurn.filter(x => x.status === 'failed').length
  const edits = thisTurn.filter(x => WRITES.has(x.tool) && x.status === 'ok').length
  // Collapse stale finishes before applying the row limit so they cannot hide live work.
  const { visible, finished } = sessionLanes(records, now)
  const shown = [...visible].sort((x, y) => y.at - x.at).slice(0, 6)
  const helpers = helperRuns([...events].reverse(), now, shown)
  // The lanes and their axis cover the latest batch only (latestBatch), at most six, oldest on top.
  const batch = latestBatch(visible, now, events).slice(-6)
  const lanes = helperRuns([...events].reverse(), now, batch)
  const axis = helperAxis(batch, now)
  const doing = (run: Helper) => {
    const [glyph, color] = MARK[run.status]
    return (
      <Box key={`hn-${run.id}`} width="100%" flexShrink={1} minWidth={0} gap={1} flexWrap="nowrap" alignItems="center" hover={{ backgroundColor: skin.hover }}>
        <Box width={1} flexShrink={0}><Text color={color}>{glyph}</Text></Box>
        <Box width={12} flexShrink={0}><Text size="caption" wrap="truncate-end">{run.name}</Text></Box>
        <Box flexShrink={1} flexGrow={1} minWidth={0}><Text size="caption" dimColor={!run.last} wrap="truncate-end">{run.last ? helperLabel(run.last) : run.status === 'running' ? 'starting' : 'done'}</Text></Box>
        <Box flexShrink={0}><Text size="caption" dimColor tabular>{`${took(run.ms ?? now - run.at)} · ${run.calls} call${run.calls === 1 ? '' : 's'}`}</Text></Box>
      </Box>
    )
  }
  // Terminal: a fixed run of cells, ─ for the helper's span and │ for each call.
  const cells = Math.max(10, Math.min(100, ((e.props as { bodyColumns?: number }).bodyColumns ?? 60) - 22))
  const glyphLine = (run: Helper) => {
    const cell = (at: number) => Math.min(cells - 1, Math.round(at * (cells - 1)))
    const a = cell(run.start)
    const b = Math.max(a, cell(run.start + run.len))
    const chars = Array.from({ length: cells }, (_, i) => i < a || i > b ? [' ', tone.quiet] : ['─', tone.quiet])
    for (const t of run.ticks) chars[cell(t.at)] = ['│', t.bad ? tone.fail : tone.brand]
    const runs: [string, string][] = []
    for (const [c, k] of chars) runs.at(-1)?.[1] === k ? (runs.at(-1)![0] += c) : runs.push([c!, k!])
    return <Text size="caption">{runs.map(([c, k], i) => <Text key={`hg-${run.id}-${i}`} color={k}>{c}</Text>)}</Text>
  }
  // Desktop: flex segments across the full axis, a thin line for the span (a quarter cell) and a tall mark per call.
  const boxLine = (run: Helper) => {
    const seg = (key: string, grow: number, on: boolean) =>
      <Box key={key} flexGrow={Math.max(0, grow)} width={0} height={0.25} {...(on ? { backgroundColor: run.status === 'running' ? tone.brand : desk.raised } : {})} />
    const parts = [seg(`hs-${run.id}-pre`, run.start, false)]
    let at = run.start
    run.ticks.forEach((t, i) => {
      const x = Math.max(at, t.at)
      parts.push(seg(`hs-${run.id}-${i}`, x - at, true))
      parts.push(<Box key={`tick-${run.id}-${i}`} flexShrink={0} width={0.25} height={1} backgroundColor={t.bad ? tone.fail : tone.brand} />)
      at = x
    })
    parts.push(seg(`hs-${run.id}-end`, run.start + run.len - at, true), seg(`hs-${run.id}-post`, 1 - run.start - run.len, false))
    return <Box key={`tl-${run.id}`} flexGrow={1} minWidth={0} height={1} alignItems="center">{parts}</Box>
  }
  const nameCol = (key: string, label: string) => <Box key={key} width={12} flexShrink={0}><Text size="caption" dimColor wrap="truncate-end">{label}</Text></Box>
  const timeline = lanes.length ? <Box key="help-lines" width="100%" flexShrink={1} minWidth={0} flexDirection="column">
    {lanes.map(run => <Box key={`hl-${run.id}`} width="100%" flexShrink={1} minWidth={0} gap={1} flexWrap="nowrap" alignItems="center">
      {nameCol(`hln-${run.id}`, run.name)}
      {terminal ? glyphLine(run) : boxLine(run)}
    </Box>)}
    <Box key="help-axis" width="100%" flexShrink={1} minWidth={0} gap={1} flexWrap="nowrap">
      {nameCol('help-axis-pad', '')}
      <Box flexShrink={terminal ? 0 : 1} minWidth={0} {...(terminal ? { width: cells } : { flexGrow: 1 })} justifyContent="space-between">
        <Text size="caption" dimColor tabular>{clock(axis.first)}</Text>
        <Text size="caption" dimColor tabular>{`+${span((axis.last - axis.first) / 2)}`}</Text>
        <Text size="caption" dimColor tabular>{`${span(axis.last - axis.first)} · ${axis.live ? 'now' : clock(axis.last)}`}</Text>
      </Box>
    </Box>
  </Box> : null
  const lanesCard = await drawDispatch($, e)
  const panels = [
        card('sum', 'This turn', current ? `${clock(current.at)} · ${edits} edits · ${failed} errors` : 'No turn yet',
          current && open.includes('turn-calls') ? [<Box key="turn-calls-list" flexDirection="column">
            {thisTurn.length ? cut('turn', thisTurn, SHOWN.turn).map(x => callRow(x, 'at')) : [empty('turn', 'No tool calls this turn yet.')]}
            {moreRow('turn', thisTurn.length, SHOWN.turn)}
          </Box>] : [],
          current ? <Text color={current.end === undefined ? tone.warn : tone.done}>{current.end === undefined ? '◐' : '✓'}</Text> : undefined,
          current ? <Button key="turn-calls" plain dimColor label={`${thisTurn.length} call${thisTurn.length === 1 ? '' : 's'} ${open.includes('turn-calls') ? '▾' : '▸'}`} onPress={view($, () => pressActivity($, 'turn-calls'))} /> : undefined),
        card('gate', 'Permissions', `${waiting} waiting · ${gate.denied} denied`, [
          <Box key={`gate-history-${gate.allowed}`}>
            <Button key="gate-allowed" plain dimColor label={`${gate.allowed} allowed`} onPress={view($, () => pressActivity($, 'gate-allowed'))} />
          </Box>,
          open.includes('gate-allowed') ? <Box key="gate-calls-allowed" flexDirection="column">
            {cut('gate-allowed', gateCalls('allowed'), 8).map(x => callRow(x, 'ag-allowed'))}
            {moreRow('gate-allowed', gateCalls('allowed').length, 8)}
          </Box> : null,
          // The counts are in the key: a desktop native Button may keep the label it first drew, so a new count
          // draws new Buttons rather than relabelling the old ones (tiles stuck at 0 in 0.4.31).
          <Box key={`gate-tiles-${counts.join('-')}`} width="100%" gap="sm">{kinds.map((kind, i) => {
            const id = `gate-${kind}`
            const active = open.includes(id)
            const n = counts[i]!
            const label = kind === 'asked' ? 'asked you' : kind
            const fill = active ? desk.raised : desk.track
            // Desktop: the tile is a column that stretches its one child, the native Button, so the whole tile takes the press.
            return <Box key={`gate-tile-${kind}`} {...(!terminal ? { flexGrow: 1, width: 0, flexDirection: 'column' as const, alignItems: 'stretch' as const, backgroundColor: fill, borderStyle: 'round' as const, borderColor: fill, hover: { backgroundColor: desk.raised } } : {})}>
              {terminal ? <Button key={id} plain label={`${n} ${label}`} dimColor={!n} onPress={view($, () => pressActivity($, id))}>
                <Text tabular weight={active ? 'bold' : 'regular'} dimColor={!n}>{`${n} ${label}`}</Text>
              </Button> : <Button key={id} plain label={`${n} ${label}`} dimColor={!n} onPress={view($, () => pressActivity($, id))}>
                <Text size="caption" color={colors[i]} dimColor={!n}>●</Text>
                {' '}
                <Text weight="bold" tabular dimColor={!n}>{String(n)}</Text>
                {` ${label}`}
              </Button>}
            </Box>
          })}</Box>,
          ...kinds.map(kind => open.includes(`gate-${kind}`) ? <Box key={`gate-calls-${kind}`} flexDirection="column">
            {cut(`gate-${kind}`, gateCalls(kind), 8).map(x => callRow(x, `ag-${kind}`))}
            {moreRow(`gate-${kind}`, gateCalls(kind).length, 8)}
          </Box> : null),
        ]),
        records.length || fast ? card('help', 'Helpers', `${records.filter(x => x.end === undefined).length} running · ${records.length} total`, [
          ...helpers.map(doing), timeline,
          finished ? empty('help-finished', `${finished} finished`) : null,
          !records.length ? empty('help', 'No helpers yet.') : null,
        ], undefined, fastSwitch) : null,
        lanesCard,
      ].filter(Boolean)

  return (
    <Box width="100%" flexShrink={1} minWidth={0} flexDirection="column" gap="md">
      {panels}
      {card('files', 'Files touched', `${touched.length} edited`, touched.length ? [
        ...cut('files', touched, SHOWN.files).map(f => {
          const path = f.path
          const slash = path.lastIndexOf('/')
          const parent = slash < 0 ? '' : path.slice(0, slash).split('/').filter(Boolean).at(-1)
          const hint = terminal ? (slash < 0 ? './' : path.slice(0, slash + 1)) : path.startsWith('/') ? `~/…/${parent ? `${parent}/` : ''}` : parent ? `${parent}/` : './'
          const id = `file-${path}`
          const expanded = open.includes(id)
          return <Box key={`file-wrap-${path}`} flexDirection="column" width="100%" flexShrink={1} minWidth={0}>
              {/* Desktop: one native Button holds the name and its hint, stretched across the row, so the whole row takes the press. */}
              {terminal ? <Box key={`af-${f.path}`} {...skin.rows} width="100%" flexShrink={1} minWidth={0} gap={1} justifyContent="space-between" alignItems="center">
                <Box flexShrink={1} flexGrow={1} minWidth={0}><Button key={id} plain label={`${expanded ? '▾' : '▸'} ${path.slice(slash + 1)}`} onPress={view($, () => pressActivity($, id))}><Text size="caption" wrap="truncate-end">{expanded ? '▾ ' : '▸ '}{path.slice(slash + 1)}</Text></Button></Box>
                <Box flexShrink={1} minWidth={0}><Text size="caption" dimColor wrap="truncate-end">{`${hint} · ×${f.count} · ${age(f.at, now)}`}</Text></Box>
              </Box> : <Box key={`af-${f.path}`} {...skin.rows} width="100%" flexShrink={1} minWidth={0} flexDirection="column" alignItems="stretch" hover={{ backgroundColor: skin.hover }}>
                <Button key={id} plain label={`${expanded ? '▾' : '▸'} ${path.slice(slash + 1)}`} onPress={view($, () => pressActivity($, id))}>
                  <Text size="caption" wrap="truncate-end">{expanded ? '▾ ' : '▸ '}{path.slice(slash + 1)}</Text>
                  {'  '}
                  <Text size="caption" dimColor wrap="truncate-end">{`${hint} · ×${f.count} · ${age(f.at, now)}`}</Text>
                </Button>
              </Box>}
            {expanded ? <Box key={`file-edits-${path}`} flexDirection="column">
              {[...(f.edits ?? [])].reverse().map((x, i) => row(`fe-${path}-${i}`, x.at, x.tool, who(x.agent), tone.quiet))}
            </Box> : null}
          </Box>
        }), moreRow('files', touched.length, SHOWN.files),
      ] : [empty('files', 'No files edited or written yet.')])}
      {card('log', 'Session log', 'newest first', logged.length ? [
        ...cut('log', logged, SHOWN.log).map(x => callRow(x, 'al')), moreRow('log', logged.length, SHOWN.log),
      ] : [empty('log', 'No tool calls yet. Each one shows here as it runs.')])}
      {events.length ? <Text size="caption" dimColor>This log is for this session only and is not saved.</Text> : null}
    </Box>
  )
}
