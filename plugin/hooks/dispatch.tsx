import { atom, read, update } from 'claude-code'
import type { EngineInterface, RenderElement, RenderInput } from 'claude-code'

import { groupLanes, isRunning, readLanes, rowOf } from './lanes'
import type { Lane, Port, Row } from './lanes'
import { view } from './events'
import { surfaceTheme, tone } from './theme'

// The worker dispatch panel on the Session tab: one group per Workflow run, one row per lane.
// Read only. The dispatch folder is the one the Fast switch uses (the dispatchDir option, else DISPATCH_ROOT).

const expanded = atom({ plugin: 'nextup', key: 'dispatchOpen' } as const, [])
// The lanes as last read: written by the live loop (register.tsx), read by the drawing, so a reread redraws on its own.
const snapshot = atom({ plugin: 'nextup', key: 'lanes' } as const, null)

/** The folder to read; '' until register resolves it, and when there is none. */
let root = ''
export const REFRESH_MS = 5000
/** Lanes drawn before Show more. */
const SHOWN = 8

function portOf($: EngineInterface): Port {
  return {
    list: async dir => (await $.fs.list(dir)).map(x => ({ name: x.name, kind: x.kind })),
    read: path => $.fs.read(path) as Promise<string>,
    mtime: async path => (await $.fs.stat(path)).mtimeMs,
    // kill -0 sends nothing; exit 0 means the process is there. A host that cannot run it believes the lane.
    alive: async pid => {
      try { return (await $.process.run(['kill', '-0', String(pid)])).exitCode === 0 } catch { return true }
    },
  }
}

async function stamp($: EngineInterface) {
  try { return await $.clock.now() } catch { return Date.now() }
}

export function setDispatchRoot(dir: string) {
  root = dir
}

/** What the card shows, as one string: the rows and the header counts. Equal strings draw equal cards. */
export function cardSignature(groups: ReturnType<typeof groupLanes>, now: number) {
  return JSON.stringify(groups.map(g => [g.name, g.lanes.map(l => { const r = rowOf(l, now); return [r.task, r.kind, r.state, r.harness, r.elapsed, r.step] })]))
}

// When the folder was last read, written or not: equal data skips the write, so the atom alone cannot say how old it is.
let readAt = 0

/** Reread the folder; write the lanes only when the card would draw differently, so equal data redraws nothing. */
export async function refreshDispatch($: EngineInterface) {
  if (!root) return
  const dir = root
  const now = await stamp($)
  const lanes = await readLanes(portOf($), dir)
  const signature = cardSignature(groupLanes(lanes, now), now)
  readAt = now
  const last = await read($, snapshot)
  if (last?.root === dir && last.signature === signature) return
  await update($, snapshot, () => ({ root: dir, lanes, signature }))
}

// A drawing cannot write state, so a first draw (a mod installed mid-session, before any reread) reads the folder
// itself and hands the write to the clock; one write at a time.
let seeding = false
function seedDispatch($: EngineInterface) {
  if (seeding) return
  seeding = true
  $.clock.after(0, async () => {
    try { await refreshDispatch($) } catch { /* The next tick tries again. */ } finally { seeding = false }
  })
}

/** The name cut to `max` cells with an ellipsis, so a row stays on one line. */
export const fit = (text: string, max: number) => (text.length <= max ? text : max <= 1 ? '…'.slice(0, Math.max(0, max)) : `${text.slice(0, max - 1)}…`)

const toneOf = (r: Row) => r.kind === 'unreadable' || r.kind === 'failed' ? tone.fail : r.kind === 'running' ? tone.warn : r.kind === 'done' ? tone.done : tone.quiet
const glyphOf = (r: Row) => ({ running: '◐', done: '✓', failed: '✕', unreadable: '!', stale: '·', other: '·' })[r.kind]

/** The Worker lanes card, or null when there is no dispatch folder or nothing to show. */
export async function drawDispatch($: EngineInterface, e: RenderInput<'Pane'>): Promise<RenderElement | null> {
  const { Box, Text, Button } = $.ui.resolve(e)
  if (!root) return null
  const now = await stamp($)
  const snap = await read($, snapshot)
  // A pane hidden or undrawn gets no reread, so a snapshot that missed a tick is redrawn from the folder itself.
  const fresh = snap?.root === root && now - readAt <= 2 * REFRESH_MS
  if (!fresh) seedDispatch($)
  const groups = groupLanes(fresh ? snap.lanes : await readLanes(portOf($), root), now)
  if (!groups.length) return null
  const open = await read($, expanded)
  const skin = surfaceTheme(e.surface)
  const terminal = e.surface === 'terminal'
  const all = groups.flatMap(g => g.lanes)
  // Running lanes are always drawn; the cap hides only finished ones.
  const showAll = open.includes('dp-all')
  const live = all.filter(isRunning)
  const shown = new Set(showAll ? all : [...live, ...all.filter(l => !isRunning(l))].slice(0, Math.max(SHOWN, live.length)))
  const running = all.filter(isRunning).length
  const unreadable = all.filter(l => l.unreadable).length
  // A narrow pane says live, so the unreadable count is not cut off.
  const counts = `${running} ${unreadable && (e.props.bodyColumns ?? 60) < 50 ? 'live' : 'running'} · ${all.length} lane${all.length === 1 ? '' : 's'}${unreadable ? ` · ${unreadable} unreadable` : ''}`
  const pathLine = (key: string, label: string, path: string) => path ? <Box key={key} width="100%" flexShrink={1} minWidth={0} gap={1}>
    <Box width={7} flexShrink={0}><Text size="caption" dimColor>{label}</Text></Box>
    <Box flexShrink={1} flexGrow={1} minWidth={0}><Text size="caption" wrap="truncate-start">{path}</Text></Box>
  </Box> : null
  const laneRow = (l: Lane) => {
    const r = rowOf(l, now)
    const id = `dp-${l.dir}`
    const isOpen = open.includes(id)
    const press = view($, () => update($, expanded, s => (s.includes(id) ? s.filter(x => x !== id) : [...s, id])))
    // One line: the pane's padding and the card's frame take 8 columns; the glyph, the toggle, two gaps and the
    // elapsed time (always shown whole) take the rest. The name gives way, never the time.
    const room = Math.max(8, (e.props.bodyColumns ?? 60) - 8 - 1 - 2 - 2 - Math.max(5, r.elapsed.length) - 1)
    const head = `${isOpen ? '▾' : '▸'} ${fit(r.task, room)}`
    const detail = [r.harness, r.step].filter(Boolean).join(' · ')
    return <Box key={`dp-lane-${l.dir}`} width="100%" flexShrink={1} minWidth={0} flexDirection="column" {...skin.rows} hover={{ backgroundColor: skin.hover }}>
      <Box width="100%" flexShrink={1} minWidth={0} gap={1} flexWrap="nowrap" alignItems="center">
        <Box width={1} flexShrink={0}><Text size="caption" color={toneOf(r)}>{glyphOf(r)}</Text></Box>
        <Box flexShrink={1} flexGrow={1} minWidth={0}>
          <Button key={`dp-open-${l.dir}`} plain label={head} onPress={press} />
        </Box>
        <Box flexShrink={0}><Text size="caption" color={toneOf(r)} tabular>{r.elapsed}</Text></Box>
      </Box>
      <Box width="100%" flexShrink={1} minWidth={0} paddingLeft={2}><Text size="caption" dimColor wrap="truncate-end">{detail}</Text></Box>
      {isOpen ? <Box key={`dp-detail-${l.dir}`} width="100%" flexShrink={1} minWidth={0} flexDirection="column" paddingLeft={2}>
        {pathLine(`dp-brief-${l.dir}`, 'brief', r.brief)}
        {pathLine(`dp-report-${l.dir}`, 'report', r.report)}
      </Box> : null}
    </Box>
  }
  return <Box key="pc-dispatch" width="100%" flexShrink={1} minWidth={0} flexDirection="column" gap="xs" paddingX="sm" paddingY="xs" borderStyle="round" {...skin.card()}>
    <Box width="100%" flexShrink={1} minWidth={0} flexDirection="column">
      <Box key="dp-title" flexShrink={0}><Text size={skin.title} weight="bold">Worker lanes</Text></Box>
      <Box key="dp-count" width="100%" flexShrink={1} minWidth={0}><Text size="caption" dimColor tabular wrap="truncate-end">{counts}</Text></Box>
    </Box>
    {groups.filter(g => g.lanes.some(l => shown.has(l))).map(g => <Box key={`dp-group-${g.name}`} width="100%" flexShrink={1} minWidth={0} flexDirection="column">
      <Box width="100%" flexShrink={1} minWidth={0}><Text size="caption" weight="bold" dimColor wrap="truncate-end">{g.name}</Text></Box>
      {g.lanes.filter(l => shown.has(l)).map(laneRow)}
    </Box>)}
    {all.length > shown.size || showAll && all.length > SHOWN ? <Box key="dp-more" paddingX={1} hover={{ backgroundColor: skin.hover }}>
      <Button key="dp-more-button" plain dimColor label={showAll ? 'Show less' : `Show ${all.length - shown.size} more`}
        onPress={view($, () => update($, expanded, s => (s.includes('dp-all') ? s.filter(x => x !== 'dp-all') : [...s, 'dp-all'])))} />
    </Box> : null}
  </Box>
}
