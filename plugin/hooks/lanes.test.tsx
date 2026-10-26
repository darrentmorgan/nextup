import { expect, test } from 'claude-code/testing'

import { elapsed, groupLanes, isRunning, readLanes, rowOf } from './lanes'
import type { Port } from './lanes'

// The worker lanes reader at its own seam: a dispatch folder held in memory and a fixed time.
const ROOT = '/H/developer/_scratch/dispatch'
const NOW = Date.parse('2026-10-24T10:00:00Z')
const iso = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString()

const run = (o: Record<string, unknown>) => ({ n: 1, harness: 'pi', status: 'done', pid: 1, fast: false, exit: 0, ...o })
const FILES: Record<string, string> = {
  // Old schema: no group, no phase.
  'old-done': JSON.stringify({ task: 'old-done', repo: '/r', branch: 'worker/old-done', created: iso(100), runs: [run({ started: iso(90), ended: iso(80), wall_s: 600, harness: 'codex', exit: 0 })] }),
  // New schema, running.
  'live-a': JSON.stringify({ task: 'live-a', group: 'Panel build', phase: 'running', phase_at: iso(3), created: iso(20), runs: [run({ status: 'running', started: iso(5), exit: undefined })] }),
  // New schema, finished and committed, same group.
  'done-b': JSON.stringify({ task: 'done-b', group: 'Panel build', phase: 'committed', phase_at: iso(30), created: iso(120), runs: [run({ started: iso(100), ended: iso(60), wall_s: 2400 })] }),
  // Failed run, other group.
  'bad-c': JSON.stringify({ task: 'bad-c', group: 'Retro', created: iso(200), runs: [run({ status: 'failed', exit: 1, started: iso(150), ended: iso(140), wall_s: 600 })] }),
  // Finished more than 24 h ago: hidden.
  'ancient': JSON.stringify({ task: 'ancient', group: 'Retro', created: iso(3000), runs: [run({ started: iso(2990), ended: iso(2980), wall_s: 600 })] }),
  // Running but old: running lanes are always shown.
  'stuck': JSON.stringify({ task: 'stuck', created: iso(3000), runs: [run({ status: 'running', started: iso(2990), exit: undefined })] }),
  'broken': '{ not json',
}

const port = (files: Record<string, string>, mtime = NOW, alive?: Port['alive']): Port => ({
  alive,
  list: async dir => dir === ROOT ? [...Object.keys(files).map(name => ({ name, kind: 'dir' })), { name: 'fast', kind: 'file' }, { name: 'empty', kind: 'dir' }] : [],
  read: async path => {
    const task = path.slice(ROOT.length + 1).replace('/state.json', '')
    if (!(task in files)) throw new Error('ENOENT')
    return files[task]!
  },
  mtime: async () => mtime,
})

test('lanes group by run, running first, with the 24 hour cutoff', async () => {
  const lanes = await readLanes(port(FILES), ROOT)
  // The fast file is not a lane; a folder with no state.json is an unreadable one.
  expect(lanes.map(l => l.task).sort()).toEqual(['ancient', 'bad-c', 'broken', 'done-b', 'empty', 'live-a', 'old-done', 'stuck'])
  const groups = groupLanes(lanes, NOW)
  expect(groups.map(g => [g.name, g.lanes.map(l => l.task)])).toEqual([
    ['Panel build', ['live-a', 'done-b']],
    ['Retro', ['bad-c']],
    ['Ungrouped', ['stuck', 'broken', 'empty', 'old-done']],
  ])
})

test('old schema lanes read as Ungrouped with their last run', async () => {
  const [lane] = (await readLanes(port({ 'old-done': FILES['old-done']! }), ROOT))
  expect(lane).toMatchObject({ group: 'Ungrouped', unreadable: false, phase: undefined })
  expect(rowOf(lane!, NOW)).toMatchObject({ task: 'old-done', harness: 'codex', state: 'done', elapsed: '10:00', step: 'done · exit 0', running: false })
})

test('a running lane shows live elapsed and its phase step', async () => {
  const lanes = await readLanes(port({ 'live-a': FILES['live-a']! }), ROOT)
  const row = rowOf(lanes[0]!, NOW)
  expect(row).toMatchObject({ harness: 'pi', state: 'running', elapsed: '5:00', step: 'running · 3m ago', running: true })
  // The clock moves on its own.
  expect(rowOf(lanes[0]!, NOW + 65_000).elapsed).toBe('6:05')
  expect(row.brief).toBe(`${ROOT}/live-a/brief.md`)
  expect(row.report).toBe(`${ROOT}/live-a/runs/1-pi/`)
})

test('a failed run shows its exit', async () => {
  const [lane] = await readLanes(port({ 'bad-c': FILES['bad-c']! }), ROOT)
  expect(rowOf(lane!, NOW)).toMatchObject({ state: 'failed', step: 'failed · exit 1', elapsed: '10:00' })
})

test('a malformed state.json is one unreadable lane and breaks nothing', async () => {
  const lanes = await readLanes(port({ broken: FILES.broken!, 'live-a': FILES['live-a']! }), ROOT)
  const row = rowOf(lanes.find(l => l.task === 'broken')!, NOW)
  expect(row).toMatchObject({ state: 'unreadable', unreadable: true, running: false })
  // An unreadable lane older than a day is hidden like any other.
  expect(groupLanes(await readLanes(port({ broken: FILES.broken! }, NOW - 2 * 86_400_000), ROOT), NOW)).toEqual([])
  // JSON that is not a lane object is unreadable too.
  expect((await readLanes(port({ x: '[1,2]' }), ROOT))[0]!.unreadable).toBe(true)
})

test('a missing dispatch folder gives no lanes', async () => {
  expect(await readLanes({ ...port({}), list: async () => { throw new Error('ENOENT') } }, ROOT)).toEqual([])
})

test('elapsed reads m:ss, then h:mm', () => {
  expect([elapsed(0), elapsed(59_000), elapsed(61_000), elapsed(3_600_000), elapsed(3_660_000 + 5 * 60_000)]).toEqual(['0:00', '0:59', '1:01', '1:00h', '1:06h'])
})

const pidRun = (o: Record<string, unknown>) => ({ n: 1, harness: 'pi', status: 'running', started: iso(300), pid: 100, launcher_pid: 99, ...o })
const LIVE_PIDS = (set: number[]): Port['alive'] => async pid => set.includes(pid)

test('a running lane whose pids are dead is stale: not running, its clock stopped at the file time, and it ages out', async () => {
  const text = JSON.stringify({ task: 'ghost', created: iso(400), runs: [pidRun({})] })
  const fresh = (await readLanes(port({ ghost: text }, NOW - 60 * 60_000, LIVE_PIDS([])), ROOT))[0]!
  expect(isRunning(fresh)).toBe(false)
  expect(rowOf(fresh, NOW)).toMatchObject({ state: 'stale', running: false, kind: 'stale', elapsed: '4:00h' })
  // The clock does not move on.
  expect(rowOf(fresh, NOW + 3_600_000).elapsed).toBe('4:00h')
  expect(groupLanes([fresh], NOW)).toHaveLength(1)
  // Past 24 hours it is hidden like any finished lane.
  const old = (await readLanes(port({ ghost: text }, NOW - 2 * 86_400_000, LIVE_PIDS([])), ROOT))[0]!
  expect(groupLanes([old], NOW)).toEqual([])
})

test('a running lane stays running while its pid or launcher is alive, or when it records none', async () => {
  const text = (run: Record<string, unknown>) => JSON.stringify({ task: 't', created: iso(400), runs: [run] })
  const running = async (t: string, alive: Port['alive']) => isRunning((await readLanes(port({ t }, NOW, alive), ROOT))[0]!)
  expect(await running(text(pidRun({})), LIVE_PIDS([100]))).toBe(true)
  expect(await running(text(pidRun({})), LIVE_PIDS([99]))).toBe(true)
  expect(await running(text(pidRun({ pid: undefined, launcher_pid: undefined })), LIVE_PIDS([]))).toBe(true)
  // No way to test a pid: the lane is believed.
  expect(await running(text(pidRun({})), undefined)).toBe(true)
  // A finished lane is never probed.
  expect(await running(text(pidRun({ status: 'done' })), LIVE_PIDS([]))).toBe(false)
})

test('a lane moves at the newest of its end, phase and creation', async () => {
  const text = JSON.stringify({ task: 't', created: iso(3000), phase: 'review', phase_at: iso(10), runs: [run({ started: iso(2990), ended: iso(2980) })] })
  const [lane] = await readLanes(port({ t: text }), ROOT)
  expect(lane!.touched).toBe(NOW - 10 * 60_000)
  expect(groupLanes([lane!], NOW)).toHaveLength(1)
})

test('only a done run with exit 0 is a success; failed fails; the rest are neutral', () => {
  const kind = async (o: Record<string, unknown>) => rowOf((await readLanes(port({ t: JSON.stringify({ task: 't', created: iso(5), runs: [run(o)] }) }), ROOT))[0]!, NOW).kind
  return Promise.all([kind({}), kind({ status: 'failed', exit: 1 }), kind({ status: 'cancelled', exit: undefined }), kind({ status: 'weird', exit: undefined }), kind({ status: 'done', exit: undefined })])
    .then(k => expect(k).toEqual(['done', 'failed', 'other', 'other', 'other']))
})

test('a lane with no runs is brief-only and neutral', async () => {
  const [lane] = await readLanes(port({ t: JSON.stringify({ task: 't', created: iso(5) }) }), ROOT)
  expect(rowOf(lane!, NOW)).toMatchObject({ kind: 'other', state: 'brief' })
})

test('a folder with no state.json, or one that cannot be read, is an unreadable lane', async () => {
  const lanes = await readLanes({ ...port({}), list: async () => [{ name: 'nostate', kind: 'dir' }], read: async () => { throw new Error('EACCES') }, mtime: async path => { if (path.endsWith('state.json')) throw new Error('ENOENT'); return NOW - 5 * 60_000 } }, ROOT)
  expect(lanes).toHaveLength(1)
  expect(rowOf(lanes[0]!, NOW)).toMatchObject({ task: 'nostate', unreadable: true, kind: 'unreadable', state: 'unreadable' })
  // It ages by the folder, so it shows now and goes after a day.
  expect(groupLanes(lanes, NOW)).toHaveLength(1)
  expect(groupLanes(lanes, NOW + 2 * 86_400_000)).toEqual([])
})
