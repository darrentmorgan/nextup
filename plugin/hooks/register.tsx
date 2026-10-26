import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement, RenderInput, UiPressArgument } from 'claude-code'

import { attentionSparkline, createAttention, drawnAttention, rateAttention, refreshAttention, projectFlag } from './attention'
import { drawActivity, recordActivity } from './activity'
import { polledSessions, rankedNeeds, loadNeeds, NEEDS_EVERY_MS, openSession, resetNeeds, waitFor } from './needs'
import { ElicitCard, initialValues } from './elicit/ElicitCard'
import { latest, sortQueue, sleptStats, stateLine } from './elicit/model'
import { askCommand, readLedger, revokeRule, sendAnswer } from './elicit/store'
import type { Ask, Answer, Rule, LogRow } from './elicit/model'
import { refreshDispatch, REFRESH_MS, setDispatchRoot } from './dispatch'
import { reloadMessage, reloadView, type ReloadState } from './reload'
import { sessionToken, stallKey, workOf } from './work'
import type { SessionRow, Work } from './work'
import { act, view, late, beat, bindEvents, Declined, feedbackView } from './events'
import type { Done } from './events'
import { appliedSince, missingSince } from './applog'
import { ageChip, parseSentinel, stripView } from './sentinel'
import type { Card } from './sentinel'
import { momentumStats, WIN_GOAL, winsRing } from './momentum'
import { delegateThreads, launchLabel, stageHint, stageOf } from './stage'
import type { Stage, StagePR } from './stage'
import { desk, humanize, momentum, surfaceTheme, tone } from './theme'
import { done, drop, park, undo, readMarks, filesOf, MarksUnreadable, isHidden, isParked, isKept, doneBetween } from './marks'
import type { Board, Calendar, Need, CalEvent, Drafts, Marks, Note, Plan, PR, SentinelRead, Thread, Feedback } from '../types'

// Accept M1's presentation fields, including an explicit unknown progress value.
// Older board rows carry the same evidence in minutes/progress.
const rowPresentation = (t: Thread) => {
  const row = t as Thread & { progressValue?: number; estimateText?: string }
  return {
    progressValue: 'progressValue' in row ? row.progressValue :
      typeof t.progress === 'number' && Number.isFinite(t.progress) && t.progress >= 0 && t.progress <= 100 ? t.progress : undefined,
    estimateText: row.estimateText ?? (typeof t.minutes === 'number' && Number.isFinite(t.minutes) && t.minutes >= 0 ? `${t.minutes} min estimated` : 'estimate unknown'),
  }
}

// Next up: what to do next and what this session has done, in one pane.
// The board comes from a data folder (the dataDir option): threads.json and notes.json from
// a pipeline outside this mod, plus mod-marks.json, today.json, calendar.json and drafts.json.
// With no data folder the board is hidden and the pane shows this session's activity alone.

const PANE = 'nextup'
const TITLE = 'Next up'
const BUILD_EVERY_MS = 30 * 60 * 1000
const PRS_EVERY_MS = 10 * 60 * 1000
const SETTLE_MS = 4000
type Settling = Record<string, number>
const settling = atom({ plugin: 'nextup', key: 'settling' } as const, {} as Settling)
const readSettling = async ($: E) => await read($, settling)
const updateSettling = ($: E, fn: (s: Settling) => Settling) => update($, settling, fn)

const board = atom({ plugin: 'nextup', key: 'board' } as const, null)
const marks = atom({ plugin: 'nextup', key: 'marks' } as const, {})
const bandHidden = atom({ plugin: 'nextup', key: 'bandHidden' } as const, false)
const building = atom({ plugin: 'nextup', key: 'building' } as const, false)
const momentumMinute = atom({ plugin: 'nextup', key: 'momentumMinute' } as const, 0)
const pluginReload = atom({ plugin: 'nextup', key: 'pluginReload' } as const, { running: false, message: '', failed: false, at: 0 } as ReloadState)
const tab = atom({ plugin: 'nextup', key: 'tab' } as const, 'focus')
// What sentinel.json and sentinel-state.json said at the last read (sentinel.ts); the result of the last press is the feedback atom (events.ts).
const sentinel = atom({ plugin: 'nextup', key: 'sentinel' } as const, null as SentinelRead | null)
const feedback = atom({ plugin: 'nextup', key: 'feedback' } as const, null as Feedback)
// What the last press on a card did, drawn under its buttons: pending, done, or why it failed.
type CardNote = { id: string; kind: 'pending' | 'ok' | 'fail'; text: string } | null
const cardNote = atom({ plugin: 'nextup', key: 'cardNote' } as const, null as CardNote)
const openRow = atom({ plugin: 'nextup', key: 'open' } as const, null)
// Also declared in activity.tsx: the engine's state scan reads only atoms made in the module that uses them.
const more = atom({ plugin: 'nextup', key: 'more' } as const, [])
// The dev seed below writes the session log and files; activity.tsx owns the same keys.
const logAtom = atom({ plugin: 'nextup', key: 'log' } as const, [])
const filesAtom = atom({ plugin: 'nextup', key: 'files' } as const, [])
const log = atom({ plugin: 'nextup', key: 'log' } as const, [])
const plan = atom({ plugin: 'nextup', key: 'plan' } as const, { date: '', ids: [] } as Plan)
const prs = atom({ plugin: 'nextup', key: 'prs' } as const, null)
const cal = atom({ plugin: 'nextup', key: 'cal' } as const, null)
const drafts = atom({ plugin: 'nextup', key: 'drafts' } as const, null)
const problem = atom({ plugin: 'nextup', key: 'problem' } as const, null)
const prsProblem = atom({ plugin: 'nextup', key: 'prsProblem' } as const, null)
const loaded = atom({ plugin: 'nextup', key: 'loaded' } as const, false)
const workerFast = atom({ plugin: 'nextup', key: 'workerFast' } as const, null)
const confirm = atom({ plugin: 'nextup', key: 'confirm' } as const, null)
const needs = atom({ plugin: 'nextup', key: 'needs' } as const, null)
const needsProblem = atom({ plugin: 'nextup', key: 'needsProblem' } as const, null)
/** Sessions stopped on a permission prompt, from the permission-wait hook's files in the data folder. */
type PermWait = { id: string; title: string; tool: string; since: number }
const permWaits = atom({ plugin: 'nextup', key: 'permWaits' } as const, [] as PermWait[])
const attentionAll = atom({ plugin: 'nextup', key: 'attentionAll' } as const, false)
const launches = atom({ plugin: 'nextup', key: 'launches' } as const, {})
const handoffReady = atom({ plugin: 'nextup', key: 'handoff' } as const, null)
const ledger = atom({ plugin: 'nextup', key: 'elicit-ledger' } as const, { asks: [] as Ask[], answers: [] as Answer[], rules: [] as Rule[], log: [] as LogRow[] })
const askDrafts = atom({ plugin: 'nextup', key: 'elicit-drafts' } as const, {} as Record<string, { picked: Record<string, unknown>; remember: boolean }>)

async function refreshLedger($: E) {
  const next = await readLedger($, await dirOf($))
  // Write only on a change: a write redraws the pane, and a redraw can read the board again.
  if (JSON.stringify(await read($, ledger)) !== JSON.stringify(next)) await update($, ledger, () => next)
}
// Hosts expose command arguments as a string or a word array.
function commandArgs(event: unknown): string {
  const args = (event as { args?: unknown }).args
  return typeof args === 'string' ? args : Array.isArray(args) ? args.join(' ') : ''
}

type E = EngineInterface


/** The helper is scoped to Next up; it must never inject keystrokes into sessions. */
async function reloadPlugins($: E): Promise<Done> {
  let started = false
  const t0 = await boardNow($, await read($, marks))
  await update($, pluginReload, state => {
    started = !reloadView(state, t0).running
    if (!started) return state
    return { running: true, message: 'Reloading plugins...', failed: false, at: t0 }
  })
  if (!started) throw new Declined('A reload is already running.')
  let step = 'marketplace update'
  try {
    const run = async (argv: string[]) => {
      const result = await $.process.run(argv, { timeoutMs: 180_000 })
      if (result.exitCode !== 0) throw new Error((result.stderr || result.stdout || `exit ${result.exitCode}`).slice(0, 240))
      return result.stdout
    }
    await run(['claude', 'plugin', 'marketplace', 'update', 'nextup'])
    step = 'plugin update'
    await run(['claude', 'plugin', 'update', 'nextup@nextup'])
    // Optional in-place reload helper (the reloadHelper option). Without one, or when its file is missing, the
    // two commands above are the whole generic reload and open sessions take /reload-plugins themselves.
    const helper = await homePath($, reloadHelper)
    if (!helper || !(await $.fs.exists(helper))) {
      const message = 'Plugin updated. Type /reload-plugins in your open sessions.'
      const at = await boardNow($, await read($, marks))
      await update($, pluginReload, () => ({ running: false, message, failed: false, at }))
      $.ui.toast(message)
      return message
    }
    step = 'session reload'
    const result = JSON.parse(await run(['python3', helper, '--plugin', 'nextup@nextup', '--json'])) as {
      plugins?: { update_error?: string; before?: string; after?: string }[]; reloaded?: string[]; reloaded_by_app?: string[]; pending_app_reload?: string[]; needs_restart?: string[]; list_error?: string
    }
    if (result.list_error || !Array.isArray(result.plugins) || !result.plugins.length || !Array.isArray(result.needs_restart) || !result.needs_restart.every(id => typeof id === 'string'))
      throw new Error(result.list_error || 'Unrecognized reload report')
    const failed = result.plugins.find(p => p.update_error)?.update_error
    if (failed) throw new Error(failed)
    // The helper says what it sent; only the app's own log says which sessions reloaded (census 3 and 16).
    const log = await readMainLog($)
    const applied = log === null ? null : appliedSince(log, t0)
    const message = reloadMessage({ ...result, version: result.plugins[0]?.after, already_current: !!result.plugins[0]?.before && result.plugins[0]?.before === result.plugins[0]?.after }, (await read($, board))?.threads ?? [], applied)
    const at = await boardNow($, await read($, marks))
    await update($, pluginReload, () => ({ running: false, message, failed: false, at }))
    $.ui.toast(message)
    return applied ? { outcome: 'ok', msg: message, proof: `main.log reload_plugins applied x${applied}` } : { outcome: 'noop', msg: message }
  } catch (error) {
    const message = `Reload failed: ${step}. ${error instanceof Error ? error.message : 'Try again.'}`
    const at = await boardNow($, await read($, marks)).catch(() => Date.now())
    await update($, pluginReload, () => ({ running: false, message, failed: true, at }))
    $.ui.toast(message)
    return { outcome: 'fail', msg: message }
  }
}

/** The tail of the Claude desktop app's main.log, or null when it cannot be read: the app's own record of what it did. */
async function readMainLog($: E): Promise<string | null> {
  try {
    const r = await $.process.run(['/bin/sh', '-c', 'tail -c 200000 "$HOME/Library/Logs/Claude/main.log"'], { timeoutMs: 5_000 })
    return r.exitCode === 0 ? r.stdout : null
  } catch { return null }
}


let attention = createAttention()
let timers: { cancel(): void }[] = []
// One live loop per module: session.start starts it (replacing, never stacking), session.end stops it. Each tick asks
// whether the pane is placed and shown at that moment, not at open time: the desktop app starts the session before
// its view connects, so the open answers not placed and no ui.open comes when the view draws the pane later.
let liveTimer: { cancel(): void } | null = null
// Set by session.end so a late drawing of the pane does not start the loop again for a session that is over.
let ended = false
const stopLive = () => { liveTimer?.cancel(); liveTimer = null }
const startLive = ($: E) => {
  stopLive()
  ended = false
  liveTimer = $.clock.every(REFRESH_MS, () => void (async () => {
    // A pane behind another tab, or undrawn, has nothing to redraw.
    const pane = (await $.ui.panes()).find(x => x.id === PANE)
    const shown = !!(pane?.isPlaced && pane.isShown)
    await beatOnce($, shown)
    if (shown) await refreshLive($)
  })().catch(() => undefined))
}
// The heartbeat tells the Sentinel the live loop is running; once every 30 s is often enough to notice it stop.
let lastBeat = 0
async function beatOnce($: E, shown: boolean) {
  const now = await $.clock.now()
  if (now - lastBeat < 30_000) return
  lastBeat = now
  await beat($, await dirOf($), shown)
}
/** Reread sentinel.json and sentinel-state.json; the pane redraws only when they changed. */
async function readSentinel($: E) {
  const dir = await dirOf($)
  if (!dir) return
  const file = async (name: string) => {
    try { return (await $.fs.exists(`${dir}/${name}`)) ? await $.fs.read(`${dir}/${name}`) as string : null } catch { return null }
  }
  const next = parseSentinel(await file('sentinel.json'), await file('sentinel-state.json'), await $.fs.exists(`${dir}/sentinel.py`))
  if (JSON.stringify(await read($, sentinel)) !== JSON.stringify(next)) await update($, sentinel, () => next)
}
/** Reread what the pane draws live: the worker lanes, the Attention card while the Next tab shows, the hand-off command. */
async function refreshLive($: E) {
  const minute = Math.floor(await $.clock.now() / 60_000)
  if (await read($, momentumMinute) !== minute) await update($, momentumMinute, () => minute)
  await refreshDispatch($).catch(() => undefined)
  await readSentinel($).catch(() => undefined)
  if (dataDir && await read($, tab) === 'focus') await refreshAttention($, attention, await dirOf($)).catch(() => undefined)
  await refreshHandoff($)
  await refreshLedger($).catch(() => undefined)
}
// A mod installed mid-session gets no session.start; its first drawing starts the loop through the clock.
function ensureLive($: E) {
  if (liveTimer || ended) return
  $.clock.after(0, () => { if (!liveTimer && !ended) startLive($) })
}

// Set from the dataDir option each time the module registers; empty means no board.
let dataDir = ''
// Set from the openOnStart option; on unless the person turned it off.
let openOnStart = true
// Set from the dispatchDir option; '' falls back to DISPATCH_ROOT.
let dispatchOpt = ''
// Set from the reloadHelper option: a script that reloads open sessions in place; '' means none.
let reloadHelper = ''
/** A folder option with a leading ~ expanded, or '' when none is set. */
const homePath = async ($: E, p: string) => {
  if (!p.startsWith('~')) return p.replace(/\/+$/, '')
  return `${(await $.env.get('HOME')) ?? ''}${p.slice(1)}`.replace(/\/+$/, '')
}

const dismissReload = ($: E) => update($, pluginReload, () => ({ running: false, message: '', failed: false, at: 0 }))

/** Opens a link with the system, and says so when it would not open (an exit code is the only answer open gives). */
async function openUrl($: E, url: string) {
  const r = await $.process.run(['open', url])
  if (r.exitCode !== 0) throw new Error(r.stderr.trim() || `open exited ${r.exitCode}`)
}

/** Retry: a rescan, or when one ran a moment ago just a fresh read, so a fixed file is picked up at once. */
async function retryBoard($: E): Promise<Done> {
  try { return await rescan($) } catch (error) {
    if (!(error instanceof Declined)) throw error
    await loadBoard($)
    return 'Board read again'
  }
}

/** The board's data folder, or '' when none is set. */
const dirOf = ($: E) => homePath($, dataDir)

/** Empty boards can also draw in hosts that have no clock adapter. */
async function boardNow($: E, m: Marks): Promise<number> {
  try { return await $.clock.now() } catch (error) {
    if (Object.keys(m).length) throw error
    return Date.now()
  }
}

async function readJson<T>($: E, path: string, fallback: T): Promise<T> {
  try {
    if (!(await $.fs.exists(path))) return fallback
    const v = JSON.parse((await $.fs.read(path)) as string) as unknown
    // A file holding null or a bare value reads as missing, so callers can trust the fallback's shape.
    return fallback !== null && (typeof v !== 'object' || v === null) ? fallback : (v as T)
  } catch {
    return fallback
  }
}

/** Why a data file cannot be used, in words for the pane; null when it reads fine. `need` makes a missing file a problem. */
async function fileProblem($: E, path: string, name: string, need: boolean): Promise<string | null> {
  try {
    if (!(await $.fs.exists(path))) return need ? `${name} is not in the data folder.` : null
    JSON.parse((await $.fs.read(path)) as string)
    return null
  } catch {
    return `${name} is unreadable (not valid JSON). Fix or restore it, then Retry.`
  }
}

// A plugin installed or updated mid-session gets no session.start, so the pane starts the first load
// itself. A drawing cannot write state, so it hands the load to the clock, and only when no load is
// running (session.start's own, say). A load that failed leaves `loaded` false, so the next draw retries.
let loading: Promise<void> | null = null
function ensureLoaded($: E) {
  if (loading) return
  $.clock.after(0, async () => {
    if (!loading && !(await read($, loaded))) await loadBoard($).catch(() => undefined)
  })
}

async function loadBoard($: E) {
  const run = readBoard($).finally(() => {
    if (loading === run) loading = null
  })
  loading = run
  return run
}

// Worker fast mode is the dispatch skill's saved default: a file named fast in its folder.
// The folder comes from the dispatchDir option, then DISPATCH_ROOT; with neither, no toggle.
const dispatchDir = async ($: E) => homePath($, dispatchOpt || ((await $.env.get('DISPATCH_ROOT')) ?? ''))

async function readWorkerFast($: E) {
  const dir = await dispatchDir($)
  const v = dir && (await $.fs.exists(dir)) ? await $.fs.exists(`${dir}/fast`) : null
  await update($, workerFast, () => v)
  return v
}

/** Flips what is on disk now, not what the pane last read: another session may have changed it. */
async function toggleWorkerFast($: E) {
  const now = await readWorkerFast($)
  if (now === null) return
  const path = `${await dispatchDir($)}/fast`
  const on = !now
  try {
    if (on) await $.fs.write(path, '')
    else if ((await $.process.run(['/bin/rm', '-f', path])).exitCode !== 0) throw new Error('rm failed')
  } catch {
    $.ui.toast(`Could not turn worker fast mode ${on ? 'on' : 'off'}`)
    return
  }
  await update($, workerFast, () => on)
  $.ui.toast(`Worker fast mode ${on ? 'on: Codex and pi use the priority tier' : 'off'}`)
}

async function readBoard($: E) {
  await refreshLedger($)
  const dir = await dirOf($)
  if (!dir) {
    await update($, board, () => null)
    await update($, workerFast, () => null)
    await update($, problem, () => null)
    await update($, loaded, () => true)
    await setStatus($)
    return
  }
  // Read only with a data folder: with none, nextup touches nothing on disk.
  await readWorkerFast($)
  const bad = (await fileProblem($, `${dir}/threads.json`, 'threads.json', true)) ?? (await fileProblem($, `${dir}/notes.json`, 'notes.json', false))
  await update($, problem, () => bad)
  const t = await readJson<{ threads?: Thread[]; generated?: string }>($, `${dir}/threads.json`, {})
  const n = await readJson<{ items?: Note[] }>($, `${dir}/notes.json`, {})
  const next: Board = {
    threads: t.threads ?? [],
    notes: (n.items ?? []).filter(i => !i.ticked),
    generated: t.generated ?? '',
  }
  await update($, board, () => next)
  await readSentinel($).catch(() => undefined)
  let m: Marks = {}
  try {
    m = await readMarks(filesOf($), dir)
  } catch (error) {
    if (!(error instanceof MarksUnreadable)) throw error
    if (!bad) await update($, problem, () => error.message)
  }
  await update($, marks, () => m)
  await reconcileLaunches($)
  const p = await readJson<Plan>($, `${dir}/today.json`, { date: '', ids: [] })
  await update($, plan, () => (p.date === dayKey() ? p : { date: dayKey(), ids: [] }))
  const c = cleanCalendar(await readJson<unknown>($, `${dir}/calendar.json`, null))
  await update($, cal, () => c)
  const d = cleanDrafts(await readJson<unknown>($, `${dir}/drafts.json`, null))
  await update($, drafts, () => d)
  await update($, loaded, () => true)
  await setStatus($)
}

// Your open PRs with the head commit's check state, one GraphQL call for all of them.
const PR_QUERY =
  '{ search(query:"is:pr is:open author:@me archived:false sort:updated-desc", type:ISSUE, first:20){ nodes{ ... on PullRequest { title url number headRefName isDraft updatedAt repository{nameWithOwner} commits(last:1){nodes{commit{statusCheckRollup{state}}}} } } } }'
type GhPR = {
  title?: string
  url?: string
  number?: number
  headRefName?: string
  isDraft?: boolean
  updatedAt?: string
  repository?: { nameWithOwner?: string }
  commits?: { nodes?: { commit?: { statusCheckRollup?: { state?: string } | null } }[] }
}

/** Reads the open PRs with gh at most every ten minutes (force: the timer); a failed gh keeps what was there. */
async function loadPrs($: E, force = false) {
  const have = await read($, prs)
  if (!force && have && (await $.clock.now()) - have.at < PRS_EVERY_MS) return
  try {
    // gh lives in Homebrew, which a mod's child process may not have on its PATH.
    const r = await $.process.run(['/bin/sh', '-c', 'PATH=/opt/homebrew/bin:/usr/local/bin:$PATH exec gh api graphql -f query="$Q"'], {
      env: { Q: PR_QUERY },
      timeoutMs: 20_000,
    })
    if (r.exitCode !== 0) {
      await update($, prsProblem, () => 'gh could not read your pull requests. Run gh auth status in a terminal.')
      return
    }
    const nodes = (JSON.parse(r.stdout) as { data?: { search?: { nodes?: (GhPR | null)[] } } }).data?.search?.nodes
    // Search can hand back null or empty nodes for items it cannot show; those are skipped, not fatal.
    const items: StagePR[] = (Array.isArray(nodes) ? nodes : [])
      .filter((n): n is GhPR => !!n?.url && !!n.number)
      .map(n => ({
        title: n.title ?? '',
        url: n.url ?? '',
        number: n.number ?? 0,
        repo: n.repository?.nameWithOwner ?? '',
        branch: n.headRefName ?? '',
        draft: !!n.isDraft,
        updated: n.updatedAt ?? '',
        checks: n.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state ?? 'NONE',
      }))
    const at = await $.clock.now()
    await update($, prs, () => ({ at, items }))
    await update($, prsProblem, () => null)
    await reconcileLaunches($)
  } catch {
    // No gh, no network or odd output: the PR section keeps what it had and says so.
    await update($, prsProblem, () => 'gh is not available, so pull requests may be out of date.')
  }
}

const prRank = (p: PR) => (isRed(p) ? 0 : p.checks === 'PENDING' || p.checks === 'EXPECTED' ? 1 : 2)
const isRed = (p: PR) => p.checks === 'FAILURE' || p.checks === 'ERROR'
/** Failing first, then still checking, then the rest; newest first within each. */
const sortPrs = (items: PR[]) => [...items].sort((a, b) => prRank(a) - prRank(b) || b.updated.localeCompare(a.updated))

// calendar.json and drafts.json are written by an agent run, so every field is checked once here
// and the views can trust what they get.
const str = (v: unknown) => (typeof v === 'string' ? v : '')
const hhmm = (v: string) => (/^\d:\d\d$/.test(v) ? `0${v}` : v)
const objects = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object') : [])

function cleanCalendar(raw: unknown): Calendar | null {
  const c = raw as { date?: unknown; events?: unknown } | null
  if (!c || typeof c !== 'object' || typeof c.date !== 'string') return null
  const events = objects(c.events)
    .map(e => ({ start: hhmm(str(e.start)), end: hhmm(str(e.end)), title: str(e.title), where: str(e.where), link: str(e.link) }))
    .filter(e => e.title && (e.start === 'all day' || /^\d\d:\d\d$/.test(e.start)))
  return { date: c.date, events }
}

function cleanDrafts(raw: unknown): Drafts | null {
  const d = raw as { at?: unknown; drafts?: unknown } | null
  if (!d || typeof d !== 'object') return null
  // Ids become element keys, so a missing or repeated one takes its place in the list instead.
  const seen = new Set<string>()
  const list = objects(d.drafts).map((x, i) => {
    const id = str(x.id) && !seen.has(str(x.id)) ? str(x.id) : `draft-${i}`
    seen.add(id)
    return { id, to: str(x.to), subject: str(x.subject), link: str(x.link) }
  })
  return { at: str(d.at), drafts: list }
}

/** What is left of today's calendar: timed events not yet over, then all-day ones; nothing from another day. */
function agenda(c: Calendar | null): { next?: CalEvent; rest: number } {
  const d = new Date()
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  if (!c || c.date !== today || !Array.isArray(c.events)) return { rest: 0 }
  const now = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  const timed = /^\d\d:\d\d$/
  // An end before the start runs past midnight, so it is still on until the day ends.
  const ends = (e: CalEvent) => (!timed.test(e.end) ? e.start : e.end < e.start ? '24:00' : e.end)
  const left = c.events.filter(e => timed.test(e.start) && ends(e) > now)
  const allDay = c.events.filter(e => e.start === 'all day')
  const list = [...left.sort((a, b) => a.start.localeCompare(b.start)), ...allDay]
  return { next: list[0], rest: Math.max(0, list.length - 1) }
}

/** Today's date as the plan keys it: the day turns at 4am, so late nights plan the same day. */
const dayKey = () => {
  const d = new Date(Date.now() - 4 * 3600 * 1000)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** Today's planned items still open and on the board, in plan order; an earlier day's plan is empty. */
function plannedItems(b: Board | null, m: Marks, pl: Plan, now: number, s: Record<string, number> = {}): (Thread | Note)[] {
  if (pl.date !== dayKey()) return []
  const all = [...(b?.threads ?? []), ...(b?.notes ?? [])]
  return (Array.isArray(pl.ids) ? pl.ids : []).map(id => all.find(x => x.id === id)).filter((x): x is Thread | Note => !!x && !(s[x.id] === undefined && isHidden(m, x.id, now)))
}

/**
 * Changes today's plan and writes today.json. Re-reads the file first, so a plan edited in another
 * session is kept, and keeps only items still open, so done and stale ids fall out as it is edited.
 */
async function editPlan($: E, fn: (ids: string[]) => string[]) {
  const now = await $.clock.now()
  const dir = await dirOf($)
  const file = `${dir}/today.json`
  const b = await read($, board)
  // With no board loaded nothing could be told open, and the saved plan would be wiped.
  if (!b) return
  const onDisk = await readJson<Plan>($, file, { date: '', ids: [] })
  const open = plannedItems(b, await read($, marks), onDisk, now).map(x => x.id)
  const ids = fn(open)
  const next = { date: dayKey(), ids: ids.filter((x, i) => ids.indexOf(x) === i) }
  await $.fs.write(file, JSON.stringify(next))
  await update($, plan, () => next)
}
const planAdd = ($: E, id: string) => editPlan($, ids => [...ids, id])
const planDrop = ($: E, id: string) => editPlan($, ids => ids.filter(x => x !== id))
const planUp = ($: E, id: string) =>
  editPlan($, ids => {
    const i = ids.indexOf(id)
    return i > 0 ? [...ids.slice(0, i - 1), id, ids[i - 1]!, ...ids.slice(i + 1)] : ids
  })

/** Every pane action goes through the Marks ledger, with one clock time and one write. */
async function applyMark($: E, verb: 'done' | 'drop' | 'park' | 'undo', ids: string[]): Promise<boolean> {
  // A press that changes nothing says why (S21): it throws Declined, and act() draws the reason.
  if (verb === 'undo') await updateSettling($, s => {
    const next = { ...s }
    for (const id of ids) delete next[id]
    return next
  })
  if (verb !== 'undo') { await noteStalled($, ids); for (const id of ids) await undoLaunch($, id) }
  const dir = await dirOf($)
  if (!dir) throw new Declined('No Next up data folder is set, so nothing was saved.')
  if (!ids.length) throw new Declined('There was nothing to mark.')
  const now = await $.clock.now()
  let next: Marks
  try {
    const f = filesOf($)
    next = verb === 'park' ? await park(f, dir, ids, tomorrow8(now), now)
      : await ({ done, drop, undo }[verb])(f, dir, ids, now)
  } catch (error) {
    if (!(error instanceof MarksUnreadable)) throw error
    await update($, problem, p => p || error.message)
    throw new Declined(error.message)
  }
  await update($, marks, () => next)
  await setStatus($)
  const b = await read($, board)
  for (const id of ids) {
    const item = [...(b?.threads ?? []), ...(b?.notes ?? [])].find(x => x.id === id)
    const name = (item ? item.title || ('text' in item ? item.text : '') : '') || 'item'
    if (verb === 'done') $.ui.toast(`✓ Done: ${name}`)
    else if (verb === 'park') $.ui.toast(`Back tomorrow: ${name}`)
    else if (verb === 'drop') $.ui.toast(`Dropped: ${name}`)
  }
  return true
}

const TABS = ['focus', 'work', 'notes', 'wins', 'parked', 'session'] as const

// Shows a tab and drops any half-made confirmation from the one left.
async function showTab($: E, id: string) {
  const next = TABS.find(t => t === id)
  if (!next) return
  await update($, tab, () => next)
  await update($, confirm, () => null)
}

async function markDone($: E, id: string) {
  const at = await $.clock.now()
  await updateSettling($, s => ({ ...s, [id]: at }))
  try {
    if (!(await applyMark($, 'done', [id]))) {
      await updateSettling($, s => { const next = { ...s }; delete next[id]; return next })
      return
    }
  } catch (error) {
    await updateSettling($, s => { const next = { ...s }; delete next[id]; return next })
    throw error
  }
  $.clock.after(Math.max(0, SETTLE_MS - ((await $.clock.now()) - at)), async () => {
    await updateSettling($, s => {
      if (s[id] !== at) return s
      const next = { ...s }
      delete next[id]
      return next
    })
  })
}

/** Keep native control geometry while settling; Button has no disabled prop.
 * Rebuild inert buttons rather than keeping their original press handles alive.
 */
function settledControls($: E, e: RenderInput, active: boolean, doneKey: string, undoKey: string, id: string, tree: RenderElement): RenderElement {
  if (!active) return tree
  const { Button } = $.ui.resolve(e)
  const visit = (node: RenderElement): RenderElement => {
    if (node.type === 'Button') {
      const isDone = node.props.key === doneKey
      return <Button {...{ ...node.props, key: isDone ? undoKey : node.props.key,
        label: isDone ? node.props.label.replace('Done', 'Undo') : node.props.label,
        dimColor: !isDone }} onPress={isDone ? act($, 'undo', () => applyMark($, 'undo', [id]), { label: 'undo it' }) : view($, () => {})} />
    }
    if (node.type === 'Link') return { ...node, props: { ...node.props, href: '' } }
    if ('children' in node && node.children) return { ...node, children: node.children.map(child => typeof child === 'object' && child !== null ? visit(child) : child) } as RenderElement
    return node
  }
  return visit(tree)
}

/** Done on all finished threads is one ledger write. */
const tickAll = ($: E, wins: Thread[]) => applyMark($, 'done', wins.map(t => t.id))

/** The phone board's rank: money value squared over log of effort; unknown minutes count as 30, unrated value as 2. */
const score = (t: Thread) => (t.value ?? 2) ** 2 / Math.log2((t.minutes ?? 30) + 2)
const rank = (a: Thread, b: Thread) => score(b) - score(a) || b.progress - a.progress || b.last.localeCompare(a.last)

/** Explain the actual money/effort score and its tie breakers, without inventing deadlines. */
export const whyThis = (t: Thread, local = false) => local
  ? 'Waiting here: the open step in this repository'
  : `Money: value ${t.value ?? 2} for ${t.minutes ?? 30} min${t.minutes == null ? ' (estimated)' : ''} · best return on effort`

export const freshness = (generated: string | undefined, now: number) => {
  const at = Date.parse(generated ?? '')
  return Number.isFinite(at) ? `updated ${Math.max(0, Math.floor((now - at) / 60_000))} min ago` : 'scan time unavailable'
}

const cwdOf = (t: Thread) => /cd "([^"]+)"/.exec(t.resume)?.[1] ?? ''
const sameRepo = (a: string, b: string) => !!a && !!b && (a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`))
const repoRoot = (p: string) => p.replace(/\/\.claude\/worktrees\/[^/]+.*$/, '')

const tomorrow8 = (now: number) => {
  const d = new Date(now)
  d.setDate(d.getDate() + 1)
  d.setHours(8, 0, 0, 0)
  return d.getTime()
}

/** A labelled copy keeps the board's own title here, for goals and session matching. */
const plainTitles = new WeakMap<Thread, string>()
const plain = (t: Thread) => plainTitles.get(t) ?? t.title

/** Live session rows, read at most once a minute so every band redraw does not call the app. */
let rowsCache: { at: number; rows: SessionRow[] } | undefined
async function sessionRows($: E, now: number): Promise<SessionRow[]> {
  // The Needs you poll already reads the list every minute; reuse it rather than ask the app twice.
  const polled = polledSessions() as { at: number; rows: SessionRow[] } | undefined
  const fresh = [polled, rowsCache].filter((x): x is { at: number; rows: SessionRow[] } => !!x && now >= x.at && now - x.at < 5 * 60_000).sort((a, b) => b.at - a.at)[0]
  if (fresh && (fresh !== rowsCache || now - fresh.at < 60_000)) return fresh.rows
  let rows: SessionRow[] = []
  try {
    const r = await $.mcp.call('ccd_session_mgmt', 'list_sessions', { limit: 60 })
    const v: unknown = r.isError ? [] : JSON.parse(r.content.filter(c => c.type === 'text').map(c => c.text).join('\n'))
    if (Array.isArray(v)) rows = v.filter((x): x is SessionRow => !!x && typeof x === 'object')
  } catch { /* Outside the desktop app only launch history is known. */ }
  rowsCache = { at: now, rows }
  return rows
}

/** The stall each stalled thread is in now, for noting that Darren has seen it. */
let stallKeys = new Map<string, number>()
const stalledSeen = async ($: E): Promise<Record<string, number>> => {
  try { const v = await $.store.get('stalledSeen'); return v && typeof v === 'object' ? v as Record<string, number> : {} } catch { return {} }
}
async function noteStalled($: E, ids: string[]) {
  const hit = ids.filter(id => stallKeys.has(id))
  if (!hit.length) return
  const seen = await stalledSeen($)
  for (const id of hit) seen[id] = stallKeys.get(id)!
  await $.store.set('stalledSeen', seen)
}
/** Rescue on a stalled row: the same handler and feedback as the Rescue card. */
async function rescueRow($: E, t: Thread) {
  await noteStalled($, [t.id])
  await update($, openRow, () => t.id)
  await say($, t.id, 'ok', `Rescue: ${plain(t)}. First step below.`)
}
const isStalled = (t: Thread) => stallKeys.has(t.id) && plainTitles.has(t) && t.title.startsWith('Stalled:')

/** What each open thread is doing: nothing, being worked on, delegate finished, or stalled (work.ts holds the rules). */
async function workStates($: E, threads: Thread[], now: number): Promise<{ states: Map<string, Work>; keys: Map<string, number> }> {
  const out = new Map<string, Work>()
  const keys = new Map<string, number>()
  if (!threads.length || !dataDir) return { states: out, keys }
  let history: LaunchHistoryEntry[] = []
  try { history = await launchHistory($, `${await dirOf($)}/mod-launch-history.json`) } catch { /* History stays optional. */ }
  const rows = await sessionRows($, now)
  for (const t of threads) {
    const launch = history.filter(x => x.id === t.id && x.at <= now && now - x.at < LAUNCH_WINDOW_MS).sort((a, b) => b.at - a.at)[0]
    const w = workOf(t, launch, rows, now)
    out.set(t.id, w)
    if (w === 'stalled') keys.set(t.id, stallKey(t, launch, rows, now))
  }
  return { states: out, keys }
}

/**
 * The phone board's lanes: to do is checked, still needed and has nobody on it; ask is unchecked; wins are rated
 * finished threads. A thread with a live session goes to working. When its delegate finished it returns as
 * "Delegate finished: review"; when the delegate went quiet it returns as "Stalled: <title>".
 */
async function openWork($: E, m: Marks, now: number, s: Record<string, number> = {}) {
  const b = await read($, board)
  const all = (b?.threads ?? []).filter(t => !(s[t.id] === undefined && isHidden(m, t.id, now)))
  const { states, keys } = await workStates($, all.filter(t => t.progress < 100), now)
  // A stall is shown once: after Darren acts on it, it stays hidden until there is new activity (a new key).
  const seen = await stalledSeen($)
  stallKeys = keys
  const state = (t: Thread) => states.get(t.id) ?? 'free'
  const opened = await read($, openRow) // The row Rescue opened stays up until it is closed.
  const dismissed = (t: Thread) => state(t) === 'stalled' && seen[t.id] === keys.get(t.id) && opened !== t.id
  const cardIds = new Set(((await read($, sentinel))?.cards ?? []).map(c => c.id))
  const open = all.filter(t => t.progress < 100)
  const working = open.filter(t => state(t) === 'working').sort(rank)
  const mark = (t: Thread): Thread => {
    const label = state(t) === 'review' ? 'Delegate finished: review' : state(t) === 'stalled' ? 'Stalled:' : ''
    if (!label) return t
    const copy = { ...t, title: `${label} ${t.title}` }
    plainTitles.set(copy, t.title)
    return copy
  }
  const idle = open.filter(t => state(t) !== 'working' && !dismissed(t))
  const confirmed = (t: Thread) => t.check === 'verified' || isKept(m, t.id)
  return {
    todo: idle.filter(t => !t.blocked && confirmed(t)).sort(rank).map(mark),
    ask: idle.filter(t => !t.blocked && !confirmed(t)).sort(rank).map(mark),
    waiting: open.filter(t => t.blocked && state(t) !== 'working').sort(rank),
    working,
    wins: all.filter(t => t.progress >= 100 && t.rated),
    // A Sentinel card that build.py also wrote as a note shows once, as the card.
    notes: (b?.notes ?? []).filter(n => !cardIds.has(n.id) && !(s[n.id] === undefined && isHidden(m, n.id, now))),
  }
}

/** Longest status text: the host adds "nextup: " in front, and the band must fit 48 columns. */
const STATUS_MAX = 40
const fit = (v: string, n: number) => (v.length > n ? `${v.slice(0, n - 1).trimEnd()}…` : v)

/** Reads the permission-wait files and keeps the ones for sessions that are still listed (or all when no list is known). */
async function loadPermissionWaits($: E) {
  const found: PermWait[] = []
  try {
    const dir = await dirOf($)
    if (dir && (await $.fs.exists(`${dir}/permission-wait`))) {
      const rows = polledSessions()?.rows
      const titles = new Map((rows ?? []).map(r => [typeof r.sessionId === 'string' ? r.sessionId : '', typeof r.title === 'string' ? r.title : ''] as const))
      for (const f of await $.fs.list(`${dir}/permission-wait`)) {
        if (f.kind !== 'file' || !f.name.endsWith('.json') || f.name.startsWith('.')) continue
        try {
          const v = JSON.parse((await $.fs.read(`${dir}/permission-wait/${f.name}`)) as string) as { session_id?: unknown; status?: unknown; at?: unknown; tool?: unknown }
          if (v.status !== 'waiting-on-permission' || typeof v.session_id !== 'string' || typeof v.at !== 'number') continue
          if (rows && !titles.has(v.session_id)) continue
          found.push({ id: v.session_id, title: titles.get(v.session_id) || v.session_id, tool: typeof v.tool === 'string' ? v.tool : '', since: v.at })
        } catch { /* one unreadable file never hides the others */ }
      }
    }
  } catch { /* no folder or no listing: nothing waits */ }
  await update($, permWaits, () => found)
}

/** Things that need Darren now: sessions asking, open questions, and permission prompts, each session once. */
function actionable(sessions: Need[], asks: number, perms: PermWait[]) {
  const ids = new Set(sessions.map(x => x.id))
  return sessions.length + asks + perms.filter(x => !ids.has(x.id)).length
}

async function needsCount($: E) {
  const led = await read($, ledger) as Awaited<ReturnType<typeof readLedger>>
  const answered = new Set(led.answers.map(a => a.id))
  return actionable((await read($, needs)) ?? [], led.asks.filter(a => !answered.has(a.id)).length, (await read($, permWaits)) ?? [])
}

async function refreshNeeds($: E) {
  await loadNeeds($)
  // A timer tick must never reject (the session can end mid-read); the status line is a convenience.
  try {
    await loadPermissionWaits($)
    await setStatus($)
  } catch { /* the next tick tries again */ }
}

async function setStatus($: E) {
  const m = await read($, marks)
  const now = await boardNow($, m)
  const w = await openWork($, m, now)
  const n = await needsCount($)
  const parts = [
    n && `${n} need${n === 1 ? 's' : ''} you`,
    w.todo.length && `${w.todo.length} to do`,
  ].filter(Boolean)
  // The host already prefixes the plugin name, so the text carries no title of its own.
  $.ui.status(parts.length ? fit(parts.join(' · '), STATUS_MAX) : undefined)
}

const MANUAL_RESCAN_MS = 60_000
/**
 * Runs the data folder's own build.py, if it has one; a board with no pipeline is only re-read.
 * A person's rescan waits one minute between runs, and says so when it is asked too soon (S26); the timers keep ten.
 */
async function runBuild($: E, why: string): Promise<boolean | 'failed'> {
  const dir = await dirOf($)
  if (!dir) return false
  if (!(await $.fs.exists(`${dir}/build.py`))) {
    await loadBoard($)
    return true
  }
  const now = await $.clock.now()
  const last = ((await $.store.get('lastBuildAt')) as number | undefined) ?? 0
  const manual = why === 'manual'
  if (now - last < (manual ? MANUAL_RESCAN_MS : 10 * 60 * 1000)) {
    if (!manual) return false
    const ago = Math.max(0, Math.round((now - last) / 1000))
    throw new Declined(`Scanned ${ago} s ago, next in ${Math.max(1, Math.ceil((MANUAL_RESCAN_MS - (now - last)) / 60_000))} min.`)
  }
  await $.store.set('lastBuildAt', now)
  await update($, building, () => true)
  let failed = false
  try {
    const r = await $.process.run(['python3', 'build.py', '7'], { cwd: dir })
    failed = r.exitCode !== 0
    if (failed) $.ui.toast(`${TITLE} rebuild failed (${why})`)
    // The Sentinel checks right after a scan, so a fresh board is judged now and not at its next timer.
    else if (await $.fs.exists(`${dir}/sentinel.py`)) await $.process.run(['python3', 'sentinel.py', '--quick'], { cwd: dir, timeoutMs: 60_000 }).catch(() => undefined)
  } finally {
    await update($, building, () => false)
    await loadBoard($)
    // loadBoard reads the files again; a failed rescan is kept on screen, not only in a toast.
    if (failed) await update($, problem, p => p ?? 'The last rescan failed, so this is the previous board.')
  }
  return failed ? 'failed' : true
}

/** A person's Rescan: the result is a sentence, not a silent redraw. */
async function rescan($: E): Promise<Done> {
  const r = await runBuild($, 'manual')
  if (r === 'failed') throw new Error('the scan failed, so this is the previous board')
  return r ? 'Board rescanned' : false
}

async function resume($: E, t: Thread, surface: Parameters<E['ui']['copy']>[0]['surface']) {
  if (/^https:\/\//.test(t.link)) return // drawn as a Link instead
  if (/^http:\/\/127\.0\.0\.1:47811\//.test(t.link)) {
    // The local helper opens Codex CLI chats in Terminal and app chats in the ChatGPT app.
    const r = await $.process.run(['open', t.link])
    if (r.exitCode !== 0) throw new Error(r.stderr.trim() || `open exited ${r.exitCode}`)
    return
  }
  await $.ui.copy({ text: t.resume, surface })
  $.ui.toast('Resume command copied. Paste it in a terminal.')
}


async function openBoard($: E) {
  return (await $.ui.open({ id: PANE, title: TITLE })).isPlaced
}

// Context lines stay short enough to scan: markdown marks out, cut at a word near 160 characters.
const clip = (v: string, n = 160) => {
  const t = v.replace(/<\/?pasted_content[^>]*>|\*\*|`/g, '').replace(/\s+/g, ' ').trim()
  return t.length <= n ? t : `${t.slice(0, n).replace(/\s+\S*$/, '')}…`
}

// A Claude Code session opens in the desktop app by its id (claude://resume, proven 22 Oct).
const isClaudeSession = (t: Thread) => t.source === 'Claude Code' && /^[\w-]+$/.test(t.id)
type Surface = Parameters<E['ui']['copy']>[0]['surface']
const say = ($: E, id: string, kind: 'pending' | 'ok' | 'fail', text: string) => update($, cardNote, () => ({ id, kind, text }))
// A session opens only where its transcript is: the app logs transcript_missing and shows nothing otherwise.
// A session on the Mac Mini has no transcript here, so no link opens it from this Mac (SN-08).
const onMacMini = (t: Thread) => /^ssh\s/.test(t.resume)
const MAC_MINI = 'On Mac Mini, open it there'
async function copySsh($: E, t: Thread, surface: Surface) {
  await $.ui.copy({ text: t.resume, surface })
  await say($, t.id, 'ok', `${t.title} is on the Mac Mini. Resume command copied: paste it in a terminal.`)
  return 'ssh command copied'
}
/** The card note says what happened where the button is; the returned outcome is for the result line and the event log. */
async function goTo($: E, t: Thread, surface?: Surface): Promise<Done> {
  await say($, t.id, 'pending', `Opening ${t.title}…`)
  try {
    const here = (await $.process.run(['/bin/sh', '-c', `ls "$HOME"/.claude/projects/*/${t.id}.jsonl >/dev/null 2>&1`])).exitCode === 0
    if (!here) {
      if (onMacMini(t)) {
        await $.ui.copy({ text: t.resume, surface: surface ?? 'desktop' })
        await say($, t.id, 'ok', `${t.title} is on the Mac Mini. Resume command copied: paste it in a terminal.`)
        return { outcome: 'ok', msg: '' }
      }
      const text = `Session not found on this Mac: ${t.title}`
      await say($, t.id, 'fail', text)
      return { outcome: 'fail', msg: text }
    }
    const pressed = await $.clock.now()
    const r = await $.process.run(['open', `claude://resume?session=${t.id}`])
    if (r.exitCode !== 0) throw new Error(r.stderr.trim() || `open exited ${r.exitCode}`)
    await say($, t.id, 'ok', `Opened ${t.title}`)
    // open exiting 0 only proves the link was handed over. The app's log says if it found no transcript.
    $.clock.after(3000, () => void (async () => {
      const log = await readMainLog($)
      if (log === null || !missingSince(log, t.id, pressed)) return
      const text = `${t.title} did not open: the app has no transcript for it on this Mac.`
      await say($, t.id, 'fail', text)
      await late($, 'go-to-session', 'fail', text, 'main.log transcript_missing')
    })().catch(() => undefined))
    return { outcome: 'ok', msg: '' }
  } catch (error) {
    const text = `Could not open ${t.title}: ${error instanceof Error ? error.message : 'unknown error'}`
    await say($, t.id, 'fail', text)
    return { outcome: 'fail', msg: text }
  }
}

// A side task is a new desktop session with a one-line /goal: measurable, verified, reviewed.
// Code items open in the repo root, never the parent's worktree, so two agents never share files.
// The app cuts q at 14336 characters; one line well under that keeps the done-when clause whole.
const oneLine = (v: string) => v.replace(/\s+/g, ' ').trim().slice(0, 8000)
function sidePrompt(x: Thread | Note) {
  if (x.prompt) return oneLine(x.prompt)
  const t = 'resume' in x ? x : null
  const what = clip(t ? `${plain(t)}: ${t.finish}` : x.title || (x as Note).text, 400).replace(/[.…]+$/, '')
  return oneLine([
    `/goal ${what}.`,
    t ? `Side task of session ${t.id} (${t.project})${t.left_off ? `, which left off: ${clip(t.left_off, 140)}` : ''}.` : '',
    'Done when the change is shown working in this conversation: tests pass for code, a screenshot for anything visual, a read-back for data;',
    'a fresh subagent has adversarially reviewed it and passed it; and for code the feature branch is pushed with green checks at its head.',
    'Keep work on a branch; ask before sending, money, production or deleting data.',
    'Each turn: do the next step, verify it, print `Milestones: x/N`. Log a gate as BLOCKED with its unlock; stop only when all remaining work is blocked.',
  ]
    .filter(Boolean)
    .join(' '))
}
// The app turns a leading "/" in a deep link's q into "/ " (no link may run a command), so the goal
// goes on the clipboard and the new session opens empty; a pasted /goal arms (checked 22 Oct).
async function startGoal($: E, goal: string, root: string, surface: Surface) {
  await $.ui.copy({ text: goal, surface })
  // S24: the exit code was ignored, so a person could land nowhere and be told it worked.
  const r = await $.process.run(['open', root ? `claude://code/new?folder=${encodeURIComponent(root)}` : 'claude://code/new'])
  if (r.exitCode !== 0) throw new Error(r.stderr.trim() || `open exited ${r.exitCode}`)
  await $.ui.toast('Goal copied: paste it in the new session and press Enter')
}
const startSide = ($: E, x: Thread | Note, surface: Surface, goal = sidePrompt(x)) => startGoal($, goal, 'resume' in x ? repoRoot(cwdOf(x)) : '', surface)

// Launch state is ephemeral; the daily ledger is shared through the data folder.
type LaunchLedger = { date: string; count: number; log: { id: string; skill: string; at: number }[] }
type PendingLaunch = { skill: string; stage: string; waiting?: boolean; cancel(): void }
// The cancel handles stay here; what the card draws (pending, waiting) is mirrored into the launches state.
const pendingLaunches = new Map<string, PendingLaunch>()
const syncLaunch = ($: E, id: string) => update($, launches, s => {
  const p = pendingLaunches.get(id)
  const { [id]: _gone, ...rest } = s
  return p ? { ...rest, [id]: { skill: p.skill, stage: p.stage, ...(p.waiting ? { waiting: true } : {}) } } : rest
})
let launchQueue: Promise<unknown> = Promise.resolve()
const localDate = (at: number) => {
  const d = new Date(at)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
async function launchLedger($: E): Promise<LaunchLedger> {
  const date = localDate(await $.clock.now())
  const empty = { date, count: 0, log: [] }
  const dir = await dirOf($)
  if (!dir || !(await $.fs.exists(`${dir}/mod-launches.json`))) return empty
  const v = JSON.parse(await $.fs.read(`${dir}/mod-launches.json`) as string) as LaunchLedger
  if (typeof v.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v.date) || !Number.isInteger(v.count) || v.count < 0 || !Array.isArray(v.log) || v.count !== v.log.length
    || !v.log.every(x => x && typeof x.id === 'string' && typeof x.skill === 'string' && Number.isFinite(x.at))) throw new Error('Invalid launch ledger')
  return v.date === date ? v : empty
}
type LaunchHistoryEntry = {
  id: string; skill: string; stage: string; at: number; progress: number
  outcome?: 'moved' | 'none' | 'gone'; checkedAt?: number
}
async function launchHistory($: E, path: string): Promise<LaunchHistoryEntry[]> {
  if (!(await $.fs.exists(path))) return []
  const v: unknown = JSON.parse(await $.fs.read(path) as string)
  if (!Array.isArray(v) || !v.every(x => x && typeof x.id === 'string' && typeof x.skill === 'string'
    && typeof x.stage === 'string' && Number.isFinite(x.at) && Number.isFinite(x.progress)
    && (x.outcome === undefined || ['moved', 'none', 'gone'].includes(x.outcome))
    && (x.checkedAt === undefined || Number.isFinite(x.checkedAt)))) throw new Error('Invalid launch history')
  return v
}
const LAUNCH_WINDOW_MS = 48 * 3600_000
async function activeLaunch($: E, id: string): Promise<LaunchHistoryEntry | undefined> {
  try {
    const now = await $.clock.now()
    const history = await launchHistory($, `${await dirOf($)}/mod-launch-history.json`)
    return history.filter(x => x.id === id && x.at <= now && now - x.at < LAUNCH_WINDOW_MS)
      .sort((a, b) => b.at - a.at)[0]
  } catch { return undefined } // History remains optional, as it is for outcome tracking.
}

// A short tag per thread rides in the launched prompt (sessionToken, work.ts), so the new session's title or first prompt names its thread.

/** Only creation time proves that a session belongs to this launch; activity time does not. */
async function delegatedSession($: E, thread: Thread, at: number): Promise<string | undefined> {
  try {
    const result = await $.mcp.call('ccd_session_mgmt', 'list_sessions', { limit: 30 })
    if (result.isError) return
    const rows: unknown = JSON.parse(result.content.filter(c => c.type === 'text').map(c => c.text).join('\n'))
    if (!Array.isArray(rows)) return
    const normalize = (v: unknown) => typeof v === 'string' ? v.replace(/[^\p{L}\p{N}]+/gu, ' ').trim().toLowerCase() : ''
    const title = normalize(plain(thread))
    const token = ` ${normalize(sessionToken(thread.id))} `
    const now = await $.clock.now()
    const matches = rows.filter(row => {
      if (!row || typeof row.sessionId !== 'string' || !/^[\w-]+$/.test(row.sessionId)) return false
      // Live rows carry lastActivityAt but no createdAt: a session last active before the launch cannot be its child.
      const stamp = row.createdAt ?? row.lastActivityAt
      const created = typeof stamp === 'number' ? stamp : Date.parse(stamp)
      return Number.isFinite(created) && created >= at && created <= now
        && [row.title, row.firstPrompt].some(v => { const n = ` ${normalize(v)} `; return n.includes(token) || (!!title && n.includes(` ${title} `)) })
    })
    // An ambiguous title is not enough evidence to send the user to a particular session.
    if (matches.length !== 1) return
    return /^claude:\/\//.test(String(matches[0].link)) ? matches[0].link : `claude://resume?session=${matches[0].sessionId}`
  } catch { return undefined } // Outside the desktop app the marker still works.
}

// Drawing cannot write files. Defer to the clock and serialize with launch reservations,
// rereading under their cross-session lock so an outcome never overwrites a new launch.
let checkingOutcomes = false
function ensureLaunchOutcomes($: E) {
  if (checkingOutcomes) return
  checkingOutcomes = true
  $.clock.after(0, () => {
    const run = async () => {
      let locked = false
      let lock = ''
      try {
        const b = await read($, board)
        if (!b || await read($, problem)) return
        const dir = await dirOf($)
        if (!dir) return
        const path = `${dir}/mod-launch-history.json`
        if (!(await $.fs.exists(path))) return
        lock = `${dir}/.mod-launches.lock`
        locked = (await $.process.run(['/bin/mkdir', lock])).exitCode === 0
        if (!locked) return // The next drawing retries a busy history check.
        const history = await launchHistory($, path)
        const now = await $.clock.now()
        let changed = false
        for (const entry of history) {
          if (entry.outcome !== undefined || now - entry.at < LAUNCH_WINDOW_MS) continue
          const t = b.threads.find(t => t.id === entry.id)
          entry.outcome = !t ? 'gone' : t.progress >= 100 || t.progress > entry.progress ? 'moved' : 'none'
          entry.checkedAt = now
          changed = true
        }
        if (changed) await $.fs.write(path, JSON.stringify(history))
      } catch { /* Optional history never prevents the board from rendering. */ }
      finally {
        try { if (locked) await $.process.run(['/bin/rmdir', lock]) }
        finally { checkingOutcomes = false }
      }
    }
    launchQueue = launchQueue.then(run, run).catch(() => { checkingOutcomes = false })
    return launchQueue
  })
}
async function reconcileLaunches($: E) {
  if (!pendingLaunches.size) return
  const b = await read($, board)
  const m = await read($, marks)
  const now = await $.clock.now()
  const evidence = await read($, prs)
  for (const [id, pending] of pendingLaunches) {
    const t = b?.threads.find(t => t.id === id)
    const stage = t && stageOf(t, (evidence?.items ?? []) as StagePR[], now)
    if (!t || isHidden(m, id, now) || !stage || stage.stage !== pending.stage || stage.skill !== pending.skill
      || (stage.live && (!evidence || now - evidence.at > PRS_EVERY_MS || await read($, prsProblem)))) await undoLaunch($, id)
  }
}
async function undoLaunch($: E, id: string) {
  pendingLaunches.get(id)?.cancel()
  pendingLaunches.delete(id)
  await syncLaunch($, id)
}
async function launchSkill($: E, thread: Thread, stage: Stage, surface: Surface): Promise<boolean | undefined> {
  if (!dataDir || pendingLaunches.has(thread.id) || await activeLaunch($, thread.id)) return false
  try { if ((await launchLedger($)).count >= 5) return false } catch { await $.ui.toast('Could not read mod-launches.json. Restore it before launching.'); return false }
  if (pendingLaunches.has(thread.id)) return false
  const entry: PendingLaunch = { skill: stage.skill, stage: stage.stage, cancel() {} }
  pendingLaunches.set(thread.id, entry)
  const enqueue = () => {
    launchQueue = launchQueue.then(run, run)
    return launchQueue
  }
  const run = async (): Promise<void> => {
    if (pendingLaunches.get(thread.id) !== entry) return
    const dir = await dirOf($)
    const lock = `${dir}/.mod-launches.lock`
    let locked = false
    try {
      // mkdir is atomic across local sessions. A busy reservation defers itself, retaining Undo.
      locked = (await $.process.run(['/bin/mkdir', lock])).exitCode === 0
      if (!locked) {
        if (pendingLaunches.get(thread.id) === entry) {
          entry.waiting = true
          const retry = $.clock.after(1000, enqueue)
          entry.cancel = () => retry.cancel()
        }
        return
      }
      if (pendingLaunches.get(thread.id) !== entry) return
      const now = await $.clock.now()
      const current = (await read($, board))?.threads.find(t => t.id === thread.id)
      const fresh = current && stageOf(current, ((await read($, prs))?.items ?? []) as StagePR[], now)
      const evidence = await read($, prs)
      if (fresh?.live && (!evidence || now - evidence.at > PRS_EVERY_MS || await read($, prsProblem))) {
        await $.ui.toast('PR evidence unavailable; launch cancelled')
        return
      }
      if (!current || isHidden(await read($, marks), thread.id, now) || !fresh || fresh.stage !== stage.stage || fresh.skill !== stage.skill) {
        await $.ui.toast('Thread changed; launch cancelled')
        return
      }
      if (await activeLaunch($, thread.id)) return
      const ledger = await launchLedger($)
      // Undo remains effective through the asynchronous reads; an older attempt never clears a new one.
      if (pendingLaunches.get(thread.id) !== entry) return
      // Once execution starts, budget is reserved before opening the app; failures cannot overspend.
      pendingLaunches.delete(thread.id)
      if (ledger.count >= 5) { await $.ui.toast('5 of 5 launches used today'); return }
      const next = { date: ledger.date, count: ledger.count + 1, log: [...ledger.log, { id: thread.id, skill: fresh.skill, at: now }] }
      await $.fs.write(`${dir}/mod-launches.json`, JSON.stringify(next))
      try {
        const path = `${dir}/mod-launch-history.json`
        const history = await launchHistory($, path)
        history.push({ id: current.id, skill: fresh.skill, stage: fresh.stage, at: now, progress: current.progress })
        await $.fs.write(path, JSON.stringify(history.slice(-500)))
      } catch { /* An unavailable history must not change the daily cap or launch. */ }
      // A darren-core skill only exists where darren-core is installed; elsewhere a plain instruction stands in.
      const skillLine = fresh.skill.startsWith('darren-core:') && !(await hasDarrenCore($))
        ? 'Unblock or finish this thread: take the next concrete step, verify it, and say what is left.'
        : `Start with the ${fresh.skill} skill.`
      const tag = `Name this session with the tag [${sessionToken(current.id)}].`
      await startSide($, current, surface, `${sidePrompt(current)}\n${skillLine} ${tag}`)
    } catch { await $.ui.toast('Launch could not finish. Check mod-launches.json before trying again.') }
    finally {
      if (locked) {
        if (pendingLaunches.get(thread.id) === entry) pendingLaunches.delete(thread.id)
        await $.process.run(['/bin/rmdir', lock])
      }
      await syncLaunch($, thread.id)
    }
  }
  const timer = $.clock.after(10_000, enqueue)
  entry.cancel = () => timer.cancel()
  await syncLaunch($, thread.id)
}
async function launchControl($: E, e: RenderInput, thread: Thread, prefix: string, delegate = false): Promise<RenderElement> {
  const { Box, Text, Button } = $.ui.resolve(e)
  if (!dataDir) return <Box />
  // Subscribe to launch changes even when history replaces the launch button.
  const pending = (await read($, launches))[thread.id]
  const delegated = await activeLaunch($, thread.id)
  if (delegated) {
    const link = await delegatedSession($, thread, delegated.at)
    return <Box key={`${prefix}-delegated-${thread.id}`} gap="xs" flexWrap="wrap" alignItems="center">
      <Text size="caption" dimColor>{`Delegated ${waitFor(await $.clock.now() - delegated.at)}`}</Text>
      {link ? <Button key={`${prefix}-delegated-open-${thread.id}`} plain label="Open session" onPress={act($, 'open-session', () => openUrl($, link), { label: 'open the session' })} /> : null}
    </Box>
  }
  // A reload drops the cancel handles: a launch left in state with none is gone, so the clock clears it.
  if (pending && !pendingLaunches.has(thread.id)) $.clock.after(0, () => syncLaunch($, thread.id))
  if (pending) return <Box gap="xs" flexWrap="wrap" alignItems="center">
    <Text size="caption">{pending.waiting ? `Waiting to launch ${pending.skill} ·` : `Launching ${pending.skill} in 10 s ·`}</Text>
    <Button key={`${prefix}-launch-undo-${thread.id}`} plain label="Undo" onPress={act($, 'undo-launch', () => undoLaunch($, thread.id), { label: 'cancel the launch' })} />
  </Box>
  const evidence = await read($, prs)
  const now = await $.clock.now()
  const stage = stageOf(thread, (evidence?.items ?? []) as StagePR[], now)
  if (!stage) return <Box />
  if (stage.live && (!evidence || now - evidence.at > PRS_EVERY_MS || await read($, prsProblem))) return <Text size="caption" dimColor>PR evidence unavailable; rescan before launching</Text>
  if (!stage.live && !delegate) return <Text key={`${prefix}-stage-hint`} size="caption" dimColor>{stageHint(stage)}</Text>
  if (!repoRoot(cwdOf(thread))) return <Text size="caption" dimColor>Repository folder unavailable; launch disabled</Text>
  let count: number
  try { count = (await launchLedger($)).count } catch { return <Text size="caption" dimColor>Launches unavailable: mod-launches.json is unreadable</Text> }
  if (count >= 5) return <Text size="caption" dimColor>5 of 5 launches used today</Text>
  return <Box flexDirection="column" gap="xs">
    {delegate ? null : <Text size="caption" dimColor>{stage.reason}</Text>}
    <Button key={`${prefix}-launch-${thread.id}`} label={delegate ? 'Delegate' : launchLabel(stage)} onPress={act($, 'launch', (pe: UiPressArgument) => launchSkill($, thread, stage, pe.surface), { label: 'launch the skill', noop: 'It is already launching, or today\'s 5 launches are used.' })} />
  </Box>
}

export const register: Register = (on, options) => {
  pendingLaunches.forEach(p => p.cancel())
  pendingLaunches.clear()
  dataDir = typeof options.dataDir === 'string' ? options.dataDir.trim() : ''
  openOnStart = options.openOnStart !== false
  reloadHelper = typeof options.reloadHelper === 'string' ? options.reloadHelper.trim() : ''
  dispatchOpt = typeof options.dispatchDir === 'string' ? options.dispatchDir.trim() : ''
  attention = createAttention()
  bindEvents(dataDir)
  recordActivity(on)

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'nextup', description: 'Open the Next up pane' })
    await $.command.register({ name: 'nextup-refresh', description: 'Rescan and reload the Next up board' })
    await $.command.register({ name: 'nextup-ask', description: 'List waiting questions with ids and choices' })
    await $.command.register({ name: 'nextup-answer', description: 'Answer a waiting question: <id> <choice>' })
    // darren-core may register /handoff-and-clear after this pane first draws: look again once it has had time.
    for (const ms of [3000, 10_000]) $.clock.after(ms, () => void refreshHandoff($))
    await update($, launches, () => ({}))
    // Open the pane first, without taking the keyboard, so it shows before the board has loaded. Not gated on
    // isInteractive: the desktop app runs on the SDK, which reports no person and no surface yet; the engine
    // holds the open undrawn until a surface attaches, and a -p run never attaches one.
    // Not awaited: an open the engine holds back (a narrow terminal) never holds up the session.
    if (openOnStart) void openBoard($).catch(() => undefined)
    await loadBoard($)
    // Development: a .dev-focus file in the data folder reopens the pane on each reload,
    // on the tab it names, so screenshots need no clicks. Absent in normal use.
    // Both dev files act only with NEXTUP_DEV set, so a leftover file never touches normal use.
    const devMode = !!(await $.env.get('NEXTUP_DEV'))
    const dir = await dirOf($)
    if (devMode && dir && (await $.fs.exists(`${dir}/.dev-focus`))) {
      // Later words pick a tab or open a row: "work <thread id>".
      const TABS = ['focus', 'work', 'notes', 'wins', 'parked', 'session']
      const words = ((await $.fs.read(`${dir}/.dev-focus`)) as string).trim().split(/\s+/)
      for (const w of words) {
        if (TABS.includes(w)) await update($, tab, () => w as never)
        else if (w) await update($, openRow, () => w)
      }
      await update($, more, s => s.filter(x => x.startsWith('act-')))
      await $.ui.open({ id: PANE, title: TITLE, focus: true })
    }
    // Development: .dev-act lines ("done|park|drop|back <id>", "tickall <id prefix>", "tab <name>") run the pane's own mark
    // functions live, once, for checks without clicks; the file is emptied after.
    const devAct = `${dir}/.dev-act`
    if (devMode && dir && (await $.fs.exists(devAct))) {
      const now = await $.clock.now()
      const lines = ((await $.fs.read(devAct)) as string).split('\n').map(l => l.trim().split(/\s+/))
      await $.fs.write(devAct, '')
      for (const [verb, id] of lines) {
        if (!id) continue
        try {
          if (verb === 'done') await applyMark($, 'done', [id])
          else if (verb === 'park') await applyMark($, 'park', [id])
          else if (verb === 'drop') await applyMark($, 'drop', [id])
          else if (verb === 'back') await applyMark($, 'undo', [id])
          else if (verb === 'tab') await update($, tab, () => id as 'focus')
          else if (verb === 'seed') {
            // Sample session activity so the Session view can be checked without a live model.
            const n = Date.now()
            const call = (i: number, tool: string, summary: string, status: 'ok' | 'failed' | 'denied' | 'running', ago: number, ms?: number) => ({
              id: `seed-${i}`, at: n - ago * 1000, tool, summary, status, ...(ms === undefined ? {} : { ms }),
            })
            const list = [
              call(1, 'Read', 'plugin/hooks/register.tsx', 'ok', 2400, 20),
              ...Array.from({ length: 150 }, (_, i) => call(10 + i, i % 5 === 0 ? 'Read' : 'Bash', 'ls', 'ok', 2300 - i * 10, 90)),
              call(2, 'Edit', 'plugin/hooks/register.tsx', 'ok', 2000, 30),
              call(3, 'Bash', 'pnpm test', 'failed', 1800, 4000),
              call(4, 'Bash', 'git push', 'denied', 1700),
              call(5, 'Agent', 'Verify M7 emulation', 'ok', 1500, 57_000),
              call(6, 'Agent', 'Re-verify M7 disputes', 'ok', 1400, 238_000),
              call(7, 'Task', 'Final review of plan', 'ok', 900, 185_000),
              call(8, 'Agent', 'Review stop-dates diff', 'ok', 500, 74_000),
              call(9, 'Agent', 'Re-review close_month', 'running', 60),
            ]
            await update($, logAtom, () => list)
            await update($, filesAtom, () => [
              { path: 'plugin/hooks/register.tsx', count: 6, at: n - 120_000, tool: 'Edit' },
              { path: 'plugin/hooks/activity.tsx', count: 2, at: n - 540_000, tool: 'Edit' },
              { path: 'docs/goal.md', count: 1, at: n - 1_860_000, tool: 'Write' },
            ])
          }
          else if (verb === 'tickall') await tickAll($, (await openWork($, await read($, marks), now)).wins.filter(t => t.id.startsWith(id)))
        } catch {
          // A failed dev action never stops the session from starting.
        }
      }
    }
    // Self-updating: rescan every 30 minutes; runBuild skips if any session built in the last 10.
    // A second session.start in this module (the engine starting it again) replaces the timers, never stacks them.
    // The live loop runs whatever the open answered; each tick redraws only a pane placed and shown then.
    timers.forEach(t => t.cancel())
    timers = []
    setDispatchRoot(await dispatchDir($))
    startLive($)
    // With no data folder the board is hidden, so nothing is rebuilt and gh is never asked.
    if (!dataDir) return next(e)
    timers = [
      ...timers,
      $.clock.every(BUILD_EVERY_MS, () => void runBuild($, 'timer')),
      $.clock.every(PRS_EVERY_MS, () => void loadPrs($, true)),
      $.clock.every(NEEDS_EVERY_MS, () => void refreshNeeds($)),
    ]
    resetNeeds()
    // Not awaited: a slow gh or session server never holds up the session.
    void loadPrs($)
    void refreshNeeds($)
    // The session server connects after the session starts, so the first read may miss it.
    for (const ms of [5000, 15_000]) $.clock.after(ms, () => void refreshNeeds($))
    return next(e)
  })

  on('command.run', { command: 'nextup-ask' }, async $ => askCommand($, await dirOf($)))
  on('command.run', { command: 'nextup-answer' }, async ($, e) => {
    const result = await askCommand($, await dirOf($), commandArgs(e))
    await refreshLedger($)
    return result
  })
  on('command.run', { command: 'nextup' }, async ($, e) => {
    const args = commandArgs(e).trim()
    if (args === 'ask' || args.startsWith('answer ')) {
      const result = await askCommand($, await dirOf($), args === 'ask' ? undefined : args.slice(7))
      await refreshLedger($)
      return result
    }
    await loadBoard($)
    if (await openBoard($)) return { text: `${TITLE} opened.` }
    const m = await read($, marks)
    const now = await boardNow($, m)
    const w = await openWork($, m, now)
    const lines = [
      ...w.todo.slice(0, 5).map((t, i) => `${i + 1}. ${t.title}: ${t.finish}${t.minutes ? ` (${t.minutes} min)` : ''}`),
      ...(w.wins.length ? [`Finished, tick these off: ${w.wins.map(t => t.title).join('; ')}`] : []),
      ...(w.notes.length ? [`Notes: ${w.notes.length} open`] : []),
    ]
    return { text: `Pane not shown here.\n${lines.join('\n') || 'Nothing open.'}` }
  })

  on('command.run', { command: 'nextup-refresh' }, async $ => {
    if (!(await dirOf($))) return { text: `${TITLE} has no data folder set.` }
    try { await rescan($) } catch (error) { return { text: `${TITLE}: ${error instanceof Error ? error.message : 'the rescan failed.'}` } }
    return { text: `${TITLE} board rescanned.` }
  })

  // A view connecting (the desktop app's, after session.start) draws the pane: bring the live values up to date now.
  on('session.attach', async ($, e, next) => {
    const attached = await next(e)
    await refreshLive($).catch(() => undefined)
    return attached
  })

  // Self-updating: a session that ends gets its left-off line on the board now, not at 8am.
  on('session.end', async ($, e, next) => {
    pendingLaunches.forEach(p => p.cancel())
    pendingLaunches.clear()
    await update($, launches, () => ({})).catch(() => undefined)
    stopLive()
    ended = true
    timers.forEach(t => t.cancel())
    timers = []
    const dir = await dirOf($)
    if (!dir || !(await $.fs.exists(`${dir}/build.py`))) return next(e)
    // Detached so the session can exit; skipped if any session rebuilt in the last 2 minutes.
    const last = ((await $.store.get('lastBuildAt')) as number | undefined) ?? 0
    if (Date.now() - last > 2 * 60 * 1000) {
      await $.store.set('lastBuildAt', Date.now())
      await $.process.run(['/bin/sh', '-c', `cd "${dir}" && (python3 build.py 7 >/dev/null 2>&1 &)`])
    }
    return next(e)
  })

  // Nudge: Claude gets the open step for this repo, so it can pick up where you stopped.
  on('prompt.compose', async ($, e, next) => {
    const out = await next(e)
    const here = repoRoot(await $.session.cwd())
    const me = await $.session.id()
    const m = await read($, marks)
    const now = await boardNow($, m)
    const { todo } = await openWork($, m, now)
    const mine = todo.filter(t => t.id !== me && sameRepo(repoRoot(cwdOf(t)), here)).slice(0, 3)
    if (!mine.length) return out
    const text = `The Next up board has open steps in this repo from other sessions:\n${mine
      .map(t => `- ${t.title}: ${t.finish}${t.minutes ? ` (${t.minutes} min)` : ''}`)
      .join('\n')}\nMention one only if it bears on what is asked.`
    return { ...out, sections: [...out.sections, { id: 'nextup:repo', text, scope: 'session' as const }] }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (await read($, bandHidden))) return next(e)
    const here = repoRoot(await $.session.cwd())
    const me = await $.session.id()
    const m = await read($, marks)
    const now = await boardNow($, m)
    const s = await readSettling($)
    const { todo } = await openWork($, m, now, s)
    // This repo's open step first; otherwise the board's top step, so the band works in every session.
    const local = todo.find(x => x.id !== me && sameRepo(repoRoot(cwdOf(x)), here))
    const t = local ?? todo.find(x => x.id !== me)
    // Other mods draw in this band too: stack ours above theirs.
    const below = await next(e)
    if (!t) return below
    const els = $.ui.resolve(e)
    const { Box, Button, Text } = els
    // The same way back into the item as the Focus card; nothing to go to, no button.
    const go = /^https:\/\//.test(t.link) ? (
      <Button key="band-go" variant="primary" label={t.link_label || 'Open'} onPress={act($, 'open-link', () => openUrl($, t.link), { label: 'open the link' })} />
    ) : onMacMini(t) ? (
      <Box key="band-go" gap="xs" alignItems="center"><Text size="caption" dimColor>{MAC_MINI}</Text><Button key="band-ssh" label="Copy ssh command" onPress={act($, 'copy-ssh', (pe: UiPressArgument) => copySsh($, t, pe.surface), { label: 'copy the ssh command' })} /></Box>
    ) : isClaudeSession(t) ? (
      <Button key="band-go" variant="primary" label="Go to session" onPress={act($, 'go-to-session', (pe: UiPressArgument) => goTo($, t, pe.surface), { label: 'open the session' })} />
    ) : t.resume || t.link ? (
      <Button key="band-go" variant="primary" label={t.link_label || 'Resume'} onPress={act($, 'resume', (pe: UiPressArgument) => resume($, t, pe.surface), { label: 'copy the resume command' })} />
    ) : null
    const bandNote = await read($, cardNote)
    const reloadAct = act($, 'reload-plugins', () => reloadPlugins($), { label: 'reload plugins', detach: true })
    const reload = reloadView(await read($, pluginReload), await boardNow($, await read($, marks)))
    const needCount = await needsCount($)
    const mine = (
      <Box gap={1} flexWrap="wrap" alignItems="center">
        <Text size="caption" weight="semibold" color={tone.brand}>
          {`${local ? 'LEFT OFF HERE' : 'NEXT UP'}${t.project && e.props.bodyColumns >= 80 ? ` · ${humanize(t.project, 20)}` : ''}`}
        </Text>
        <Text weight="medium" strikethrough={s[t.id] !== undefined} dimColor={s[t.id] !== undefined}>{s[t.id] !== undefined ? <Text color={tone.done}>✓ </Text> : null}{t.title}</Text>
        <Text dimColor wrap="truncate-end">
          {t.minutes ? `${t.minutes} min` : ''}
        </Text>
        <Text key="band-why" size="caption" dimColor>{`Why this: ${whyThis(t, !!local)}`}</Text>
        {s[t.id] === undefined ? await launchControl($, e, t, 'band') : null}
        {s[t.id] === undefined && isStalled(t) ? <Button key={`band-rescue-${t.id}`} label="Rescue" onPress={act($, 'rescue', () => rescueRow($, t), { label: 'start the rescue' })} /> : null}
        {reload.message ? <Box gap="sm" alignItems="center"><Text size="caption" color={reload.failed ? tone.fail : tone.quiet}>{reload.message}</Text>{!reload.running ? <Button key="band-reload-dismiss" plain dimColor label="Dismiss" onPress={view($, () => dismissReload($))} /> : null}</Box> : null}
        {bandNote?.id === t.id ? <Text key={`card-note-${t.id}`} size="caption" {...(bandNote.kind === 'fail' ? { color: tone.fail } : bandNote.kind === 'ok' ? { color: tone.done } : { dimColor: true })}>{bandNote.text}</Text> : null}
        {needCount > 0 ? <Text size="caption" color={momentum.needs}>{`${needCount} need${needCount === 1 ? 's' : ''} you`}</Text> : null}
        {settledControls($, e, s[t.id] !== undefined, 'band-done', 'band-undo', t.id, <Box gap="sm" flexWrap="wrap" alignItems="center">
          {go}
          <Box paddingLeft="sm"><Button key="band-done" plain dimColor label="Done" onPress={act($, 'done', () => markDone($, t.id), { label: 'mark it done' })} /></Box>
        </Box>)}
        {'Select' in els ? <els.Select key="band-more" value="" options={[
          { label: 'More', value: '' }, { label: 'Reload plugins', value: 'reload' }, { label: 'Not today', value: 'later' }, { label: 'Board', value: 'board' }, { label: 'Hide', value: 'hide' },
        ]} onSelect={view($, (value: string) => {
          if (value === 'reload') return reloadAct()
          if (s[t.id] !== undefined) return
          if (value === 'later') return act($, 'park', () => applyMark($, 'park', [t.id]), { label: 'move it to tomorrow' })()
          if (value === 'board') return act($, 'open-board', async () => { if (!(await openBoard($))) throw new Declined('The pane is not shown in this window.') }, { label: 'open the board' })()
          if (value === 'hide') return update($, bandHidden, () => true)
        })} /> : null}
      </Box>
    )
    if (!below) return mine
    return (
      <Box flexDirection="column" gap={1}>
        {mine}
        {below}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, ($, e) => drawBoard($, e))
}

async function drawBoard($: E, e: RenderInput<'Pane'>): Promise<RenderElement> {
  {
    const skin = surfaceTheme(e.surface)
    const terminal = e.surface === 'terminal'
    const els = $.ui.resolve(e)
    const { Box, Text, Button, Link } = els
    const b = await read($, board)
    const m = await read($, marks)
    const now = await boardNow($, m)
    await read($, momentumMinute) // Subscribe idle panes to the minute tick for stalled-day Rescue.
    const busy = await read($, building)
    const reload = reloadView(await read($, pluginReload), now)
    const expanded = await read($, openRow)
    const note = await read($, cardNote)
    const shown = await read($, more)
    const pl = await read($, plan)
    const pullRequests = sortPrs((await read($, prs))?.items ?? [])
    const { next: event, rest: eventsLeft } = agenda(await read($, cal))
    const waiting = (await read($, drafts))?.drafts ?? []
    const s = await readSettling($)
    const settlingProps = (id: string) => ({ strikethrough: s[id] !== undefined, dimColor: s[id] !== undefined })
    const undo = (id: string) => <Button key={`undo-${id}`} plain label="Undo" onPress={act($, 'undo', () => applyMark($, 'undo', [id]), { label: 'undo it' })} />
    const w = await openWork($, m, now, s)
    const planned = plannedItems(b, m, pl, now, s)
    const inPlan = (id: string) => planned.some(x => x.id === id)
    const togglePlan = (id: string) => act($, 'plan', () => (inPlan(id) ? planDrop($, id) : planAdd($, id)), { label: 'change today\'s plan', noop: 'The board is not loaded.' })
    const parkedItems = [...(b?.threads ?? []), ...(b?.notes ?? [])].filter(x => isParked(m, x.id, now))
    const wanted = await read($, tab)
    // With no board, the session's own activity is all there is to show.
    const current = !b && !dataDir && wanted !== 'session' ? 'session' : wanted === 'parked' && !parkedItems.length ? 'focus' : wanted
    const calls = (await read($, log)).filter(x => !x.prompt).length
    const why = await read($, problem)
    const prsWhy = await read($, prsProblem)
    const ready = await read($, loaded)
    if (current === 'focus' && b && ready && !why) ensureLaunchOutcomes($)
    const fast = await read($, workerFast)
    if (!ready && dataDir) ensureLoaded($)
    ensureLive($)
    const asking = await read($, confirm)

    const midnight = new Date(now).setHours(0, 0, 0, 0)
    const doneToday = doneBetween(m, midnight, now).length
    // The rail spans the pane's body, inside the outer padding, so it lines up with the cards below.
    const W = Math.max(12, e.props.bodyColumns - 2)

    // Keep the terminal glyph gauge; desktop uses a slim filled track.
    const [on, off] = e.surface === 'terminal' ? ['▮', '▯'] : ['●', '○']
    const gauge = (fraction: number, color: string, n = 10) => {
      const value = Math.max(0, Math.min(1, fraction))
      if (!terminal) return <Box width="100%" height={0.75} borderStyle="round" borderColor={desk.track} backgroundColor={desk.track}><Box width={0} flexGrow={value} backgroundColor={color} /><Box width={0} flexGrow={1 - value} /></Box>
      const lit = Math.round(value * n)
      return (
        <Text>
          <Text color={color}>{on.repeat(lit)}</Text>
          <Text color={tone.quiet}>{off.repeat(n - lit)}</Text>
        </Text>
      )
    }

    const progress = (t: Thread, suffix = '', n = 10, barColor: string = tone.done) => {
      const value = rowPresentation(t).progressValue
      if (value === undefined || !Number.isFinite(value)) return null
      return <Box key={`progress-${t.id}`} flexDirection={terminal ? 'row' : 'column'} gap="xs">
        {gauge(value / 100, barColor, n)}
        <Text size="caption" dimColor tabular>{`${value}%${suffix}`}</Text>
      </Box>
    }

    // The one moving thing: runs while a rescan runs, a dim line otherwise. Off the terminal the idle line
    // is a stray rule a full text row tall, so there it shows only while a rescan runs.
    const rail =
      e.surface !== 'terminal' && !busy ? null : 'Client' in els ? (
        <els.Client key="rail" module="./rail.tsx" width="100%" height={1} props={{ active: busy, width: W, color: tone.brand }} />
      ) : (
        <Text color={tone.quiet}>{'─'.repeat(W)}</Text>
      )

    const refresh = <Button key="refresh" plain dimColor label={busy ? 'rescanning…' : '↻ rescan'}
      onPress={act($, 'rescan', () => rescan($), { label: 'rescan', detach: true })} />
    const summary = (key: string, title: string, count: number, urgent: string, card: RenderElement | null, color: string = momentum.quiet) => card ? (
      <Box key={`summary-${key}`} flexDirection="column" gap="xs">
        <Button key={`summary-toggle-${key}`} plain label={`${title} · ${count}${urgent ? ` · ${clip(urgent, Math.max(16, e.props.bodyColumns - title.length - 18))}` : ''} ${shown.includes(`summary-${key}`) ? '⌄' : '›'}`}
          onPress={view($, () => update($, more, rows => rows.includes(`summary-${key}`) ? rows.filter(x => x !== `summary-${key}`) : [...rows, `summary-${key}`]))}>
          <Text color={color} wrap="truncate-end">{`${title} · ${count}${urgent ? ` · ${clip(urgent, Math.max(16, e.props.bodyColumns - title.length - 18))}` : ''} ${shown.includes(`summary-${key}`) ? '⌄' : '›'}`}</Text>
        </Button>
        {shown.includes(`summary-${key}`) ? card : null}
      </Box>
    ) : null

    // Every store says how old it is: quiet while fresh, amber past one scan interval, red past three, and the words change with the colour.
    const ageChipText = (key: string, generated: string | undefined) => {
      const at = Date.parse(generated ?? '')
      const c = ageChip(Number.isFinite(at) ? at : null, now, 45 * 60_000)
      return <Text key={key} size="caption" {...(c.level === 'red' ? { color: tone.fail } : c.level === 'amber' ? { color: tone.warn } : { dimColor: true })}>{c.text}</Text>
    }
    const mins = (t: { minutes: number | null }) => (t.minutes ? `${t.minutes}m` : '')
    // One heading style everywhere: a bold title, a quiet count, and red or amber only when something needs you.
    const label = (text: string, color: string, n?: number) => (
      <Box gap={1}>
        <Text size={skin.title} weight="bold" {...(color === tone.fail || color === tone.warn ? { color } : {})}>{text}</Text>
        {n ? <Text size="caption" dimColor tabular>{n}</Text> : null}
      </Box>
    )

    const cardNoteLine = (id: string) => note?.id === id ? (
      <Text key={`card-note-${id}`} size="caption" {...(note.kind === 'fail' ? { color: tone.fail } : note.kind === 'ok' ? { color: tone.done } : { dimColor: true })}>{note.text}</Text>
    ) : null
    const go = (t: Thread) =>
      /^https:\/\//.test(t.link) ? (
        <Link key={`open-${t.id}`} href={t.link} label={t.link_label || 'Open'} />
      ) : onMacMini(t) ? (
        // SN-08: no link opens a session that lives on the Mac Mini, so none is offered.
        <Box key={`mini-${t.id}`} gap="xs" alignItems="center" flexWrap="wrap">
          <Text size="caption" dimColor>{MAC_MINI}</Text>
          <Button key={`ssh-${t.id}`} label="Copy ssh command" onPress={act($, 'copy-ssh', (pe: UiPressArgument) => copySsh($, t, pe.surface), { label: 'copy the ssh command' })} />
        </Box>
      ) : isClaudeSession(t) ? (
        <Button key={`go-${t.id}`} label="Go to session" onPress={act($, 'go-to-session', (pe: UiPressArgument) => goTo($, t, pe.surface), { label: 'open the session' })} />
      ) : (
        <Button key={`res-${t.id}`} label={t.link_label || 'Resume'} onPress={act($, 'resume', (pe: UiPressArgument) => resume($, t, pe.surface), { label: 'copy the resume command' })} />
      )

    const showMore = (key: string, total: number, cap: number) =>
      total > cap ? (
        <Box key={`mb-${key}`} paddingX={1} hover={{ backgroundColor: skin.hover }}>
          <Button
            key={`more-${key}`}
            plain
            dimColor
            label={shown.includes(key) ? 'Show less' : cap ? `Show ${total - cap} more` : `Show all ${total}`}
            onPress={view($, () => update($, more, s => (s.includes(key) ? s.filter(x => x !== key) : [...s, key])))}
          />
        </Box>
      ) : null
    const capped = <T,>(key: string, items: T[], cap: number) => (shown.includes(key) ? items : items.slice(0, cap))

    // Where the session stood: its first ask, its latest ask, its last words, its branch.
    const context = (t: Thread) => {
      const lines = (
        [
          ['Left off', t.left_off],
          ['Goal', t.goal],
          ['Asked last', t.last_ask !== t.goal ? t.last_ask : ''],
        ] as const
      ).filter(([, v]) => v)
      const git = t.branch && t.branch !== 'HEAD' ? [t.branch, t.dirty ? `${t.dirty} uncommitted` : ''].filter(Boolean).join(' · ') : ''
      if (!lines.length && !git) return null
      return (
        <Box key={`ctx-${t.id}`} flexDirection="column" gap="xs" paddingX={1}>
          {lines.map(([k, v]) => (
            <Box key={`ctx-${t.id}-${k}`} flexDirection="column">
              <Text size="caption" weight="bold" color={k === 'Left off' ? tone.accent : tone.quiet}>{k}</Text>
              <Text size="caption" dimColor={k !== 'Left off'}>{clip(v ?? '', 120)}</Text>
            </Box>
          ))}
          {git ? <Text size="caption" dimColor>{git}</Text> : null}
        </Box>
      )
    }

    // Compact row: one line, the whole row is the press target; it opens in place.
    const row = (t: Thread, accent: (typeof tone)[keyof typeof tone] = tone.accent, withProject = false) =>
      expanded === t.id ? (
        <Box key={`c-${t.id}`} flexDirection="column" gap="xs" padding="sm" borderStyle="round" {...skin.card(accent)}>
          {/* A Button draws its own text weight, so the title is plain Text with a small close beside it. */}
          <Box justifyContent="space-between" alignItems="flex-start" gap={1}>
            <Text weight="bold" color={tone.accent} {...settlingProps(t.id)}>{s[t.id] !== undefined ? <Text color={tone.done}>✓ </Text> : null}{t.title}</Text>
            <Button key={`h-${t.id}`} plain dimColor label="Close" onPress={view($, () => { if (s[t.id] === undefined) return update($, openRow, () => null) })} />
          </Box>
          <Text>{t.finish}</Text>
          {context(t)}
          <Box key={`sp-${t.id}`} flexDirection="column" gap="xs" paddingX={1}>
            <Text size="caption" weight="bold" color={tone.quiet}>Suggested prompt</Text>
            <Text size="caption" dimColor>{clip(sidePrompt(t), 140)}</Text>
            {settledControls($, e, s[t.id] !== undefined, '', '', t.id, <Box gap="xs" flexWrap="wrap" alignItems="center" minHeight={1}>
              <Button key={`side-${t.id}`} label="Start side task" onPress={act($, 'side-task', (pe: UiPressArgument) => startSide($, t, pe.surface), { label: 'start a side task' })} />
              <Button key={`copy-${t.id}`} label="Copy prompt" plain onPress={act($, 'copy-prompt', async (pe: UiPressArgument) => { await $.ui.copy({ text: sidePrompt(t), surface: pe.surface }); return 'Prompt copied' }, { label: 'copy the prompt' })} />
            </Box>)}
          </Box>
          <Text size="caption" dimColor>{[t.project, mins(t)].filter(Boolean).join(' · ')}</Text>
          {progress(t, '', 5)}
          {settledControls($, e, s[t.id] !== undefined, `tick-${t.id}`, `undo-${t.id}`, t.id, <Box gap="xs" flexWrap="wrap" alignItems="center">
            <Button key={`tick-${t.id}`} label="Done" variant="primary" onPress={act($, 'done', () => markDone($, t.id), { label: 'mark it done' })} />
            {go(t)}{cardNoteLine(t.id)}
            <Button key={`plan-${t.id}`} label={inPlan(t.id) ? '✓ Today' : '+ Today'} plain onPress={togglePlan(t.id)} />
            <Button key={`park-${t.id}`} label="Not today" onPress={act($, 'park', () => applyMark($, 'park', [t.id]), { label: 'move it to tomorrow' })} />
            <Button key={`drop-${t.id}`} label="Drop" plain dimColor onPress={act($, 'drop', () => applyMark($, 'drop', [t.id]), { label: 'drop it' })} />
          </Box>)}
        </Box>
      ) : (
        <Box key={`rw-${t.id}`} flexDirection="column">
          {terminal ? null : <Box key={`rl-${t.id}`} width="100%" height={0.125} backgroundColor={desk.line} />}
          <Box key={`r-${t.id}`} paddingX={1} gap={1} justifyContent="space-between" alignItems="center" hover={{ backgroundColor: skin.hover }}>
            <Box gap={1} alignItems="center" flexShrink={1}>
              <Text color={s[t.id] !== undefined ? tone.done : tone.quiet}>{s[t.id] !== undefined ? '✓' : '○'}</Text>
              <Button key={`row-${t.id}`} plain onPress={view($, () => update($, openRow, () => t.id))}>
                <Text weight="medium" wrap="truncate-end" {...settlingProps(t.id)}>{t.title}</Text>
              </Button>
            </Box>
            <Text size="caption" dimColor tabular wrap="truncate">
              {[withProject ? t.project : '', mins(t)].filter(Boolean).join('  ·  ')}
            </Text>
          </Box>
        </Box>
      )

    // A panel groups one area of the Next view; its border turns red when something in it needs you.
    const panel = (key: string, children: unknown, color: string = tone.quiet) => (
      <Box key={`panel-${key}`} flexDirection="column" gap="xs" paddingX="sm" paddingY="xs" borderStyle="round" {...skin.card(color)}>
        {children as never}
      </Box>
    )
    const prsPanel =
      pullRequests.length > 0 || (prsWhy && pullRequests.length === 0)
        ? panel(
            'prs',
            <Box key="prs-in" flexDirection="column" gap="xs">
              {pullRequests.length === 0 && prsWhy ? <Text key="prs-why" size="caption" color={tone.warn}>{prsWhy}</Text> : null}
              {pullRequests.length > 0 ? (
                <Box key="prs" flexDirection="column" gap="xs">
                  {label('Pull requests', pullRequests.some(isRed) ? tone.fail : tone.done, pullRequests.length)}
                  {prsWhy ? <Text size="caption" color={tone.warn}>{prsWhy}</Text> : null}
                  {capped('prs', pullRequests, 5).map(p => {
                    const [glyph, color, word] = isRed(p)
                      ? ['✕', tone.fail, 'checks failing']
                      : prRank(p) === 1
                        ? ['●', tone.warn, 'checks running']
                        : p.checks === 'SUCCESS'
                          ? ['✓', tone.done, '']
                          : ['·', tone.quiet, 'no checks']
                    return (
                      <Box key={`pr-${p.repo}#${p.number}`} paddingX={1} gap={1} alignItems="flex-start" hover={{ backgroundColor: skin.hover }}>
                        {/* A fixed column, so ✕, ✓ and · line the titles up. */}
                        <Box width={2} flexShrink={0}>
                          <Text color={color}>{glyph}</Text>
                        </Box>
                        <Box flexDirection="column" flexShrink={1}>
                          <Link key={`pro-${p.repo}#${p.number}`} href={p.url} label={p.title} />
                          <Text size="caption" dimColor>
                            {[`${p.repo.split('/').pop()} #${p.number}`, p.draft ? 'draft' : '', word].filter(Boolean).join('  ·  ')}
                          </Text>
                        </Box>
                      </Box>
                    )
                  })}
                  {showMore('prs', pullRequests.length, 5)}
                </Box>
              ) : null}
            </Box>,
            pullRequests.some(isRed) ? tone.fail : tone.quiet,
          )
        : null

    const completed = doneBetween(m, midnight, now)
      .filter(x => s[x.id] === undefined)
      .map(x => [...(b?.threads ?? []), ...(b?.notes ?? [])].find(item => item.id === x.id))
      .filter((x): x is Thread | Note => !!x)
    const doneCard = completed.length ? panel('done-today', <Box flexDirection="column" gap="xs">
      {label('Done today', tone.done, completed.length)}
      {capped('done-today', completed, 5).map(x => <Box key={`done-${x.id}`} paddingX={1} gap={1} justifyContent="space-between" alignItems="center">
        <Box gap={1} flexShrink={1}><Text color={tone.done}>✓</Text><Text strikethrough dimColor wrap="truncate-end">{x.title || ('text' in x ? x.text : '')}</Text></Box>
        {undo(x.id)}
      </Box>)}
      {showMore('done-today', completed.length, 5)}
    </Box>) : null

    // ---------- Focus ----------
    const top = w.todo[0]
    const plannedMin = planned.reduce((n, x) => n + (x.minutes ?? 0), 0)
    const today = planned.length ? panel('today',
      <Box key="today" flexDirection="column" gap="xs">
        <Box justifyContent="space-between" alignItems="center" gap={1}>
          {label('Today', tone.accent, planned.length)}
          <Text size="caption" dimColor tabular>{`${plannedMin} min planned`}</Text>
        </Box>
        {planned.map((x, i) => (
          <Box key={`td-${x.id}`} paddingX={1} gap={1} justifyContent="space-between" alignItems="center" hover={{ backgroundColor: skin.hover }}>
            <Box gap={1} alignItems="center" flexShrink={1}>
              <Text color={s[x.id] !== undefined ? tone.done : 'text' in x ? tone.note : tone.accent}>{s[x.id] !== undefined ? '✓' : '○'}</Text>
              <Text weight="medium" wrap="truncate-end" {...settlingProps(x.id)}>{x.title || ('text' in x ? x.text : '')}</Text>
            </Box>
            <Box gap={1} alignItems="center">
              <Text size="caption" dimColor tabular>{mins(x)}</Text>
              {settledControls($, e, s[x.id] !== undefined, `tdd-${x.id}`, `undo-${x.id}`, x.id, <Box gap={1} alignItems="center">
              <Button key={`tdd-${x.id}`} plain label="Done" onPress={act($, 'done', () => markDone($, x.id), { label: 'mark it done' })} />
              {i > 0 ? <Button key={`tu-${x.id}`} plain dimColor label="Move up" onPress={act($, 'plan', () => planUp($, x.id), { label: 'change today\'s plan' })} /> : null}
              <Button key={`tx-${x.id}`} plain dimColor label="Remove" onPress={act($, 'plan', () => planDrop($, x.id), { label: 'change today\'s plan' })} />
              </Box>)}
            </Box>
          </Box>
        ))}
      </Box>) : null
    // The next thing on the calendar, from the 8am refresh's calendar.json.
    const calendar = event ? (
      <Box key="cal" paddingX={1} gap={1} alignItems="flex-start">
        <Text color={tone.accent}>◷</Text>
        <Box flexDirection="column" flexShrink={1}>
          <Box gap={1} alignItems="center">
            <Text weight="semibold" tabular>{event.start === 'all day' ? 'All day' : event.start}</Text>
            {/^https:\/\//.test(event.link) ? <Link key="cal-open" href={event.link} label={event.title} /> : <Text>{event.title}</Text>}
          </Box>
          {event.where || eventsLeft ? (
            <Text size="caption" dimColor>{[event.where, eventsLeft ? `${eventsLeft} more today` : ''].filter(Boolean).join('  ·  ')}</Text>
          ) : null}
        </Box>
      </Box>
    ) : null
    // Gmail drafts not sent yet; Open goes to the draft in Gmail.
    const draftList = waiting.length ? (
      <Box key="drafts" flexDirection="column" gap="xs">
        {label('Drafts to send', tone.warn, waiting.length)}
        {capped('drafts', waiting, 3).map(d => (
          <Box key={`dr-${d.id}`} paddingX={1} gap={1} alignItems="flex-start" hover={{ backgroundColor: skin.hover }}>
            <Text color={tone.warn}>✉</Text>
            <Box flexDirection="column" flexShrink={1}>
              {/^https:\/\//.test(d.link) ? <Link key={`dro-${d.id}`} href={d.link} label={d.subject || '(no subject)'} /> : <Text>{d.subject || '(no subject)'}</Text>}
              {d.to ? <Text size="caption" dimColor>{`to ${d.to}`}</Text> : null}
            </Box>
          </Box>
        ))}
        {showMore('drafts', waiting.length, 3)}
      </Box>
    ) : null
    // Sessions idle on a reply that asks you something, longest wait first; hidden when none or outside the desktop app.
    const waitingOnYou = rankedNeeds((await read($, needs)) ?? [])
    const elicit = await read($, ledger) as Awaited<ReturnType<typeof readLedger>>
    const answeredIds = new Set(elicit.answers.map(a => a.id))
    const askQueue = sortQueue(elicit.asks, now).filter(a => !answeredIds.has(a.id))
    const firstAsk = askQueue[0]
    const draft = firstAsk ? (await read($, askDrafts))[firstAsk.id] ?? { picked: initialValues(firstAsk), remember: false } : null
    const question = firstAsk && draft ? ElicitCard(els, {
      act: (action, fn, o) => act($, action, fn, o), view: fn => view($, fn),
      ask: firstAsk, more: askQueue.length - 1, now, ...draft, quiet: !elicit.answers.some(a => !a.cancel && a.at >= firstAsk.askedAt) && !elicit.log.some(r => r.at >= firstAsk.askedAt && r.status !== 'cancelled'),
      change: (name, value) => void update($, askDrafts, s => ({ ...s, [firstAsk.id]: { ...draft, picked: { ...draft.picked, [name]: value } } })),
      toggle: () => void update($, askDrafts, s => ({ ...s, [firstAsk.id]: { ...draft, remember: !draft.remember } })),
      send: async cancel => {
        try {
          await sendAnswer($, await dirOf($), firstAsk, draft.picked, draft.remember, cancel)
          await refreshLedger($)
        } catch (error) { $.ui.toast(error instanceof Error ? error.message : 'Could not save answer.'); throw error }
      },
      open: async url => { await $.process.run(['open', url || `claude://claude.ai/epitaxy/${firstAsk.thread}`]) },
    }) : null
    const dayStart = new Date(now)
    if (dayStart.getHours() < 4) dayStart.setDate(dayStart.getDate() - 1)
    dayStart.setHours(4, 0, 0, 0)
    const slept = sleptStats(elicit.log, dayStart.getTime())
    const autoRows = latest(elicit.log).filter(r => r.at >= dayStart.getTime() && (r.status === 'auto' || r.status === 'defaulted' || r.answeredBy === 'rule')).sort((a, b) => b.at - a.at).slice(0, 5)
    const elicitWins = slept.answered ? <Box key="ask-wins" flexDirection="column" gap="xs">
      <Text>{`Answered ${slept.answered} for you while you slept, median wait ${slept.medianWaitSec}s`}</Text>
      {autoRows.map(row => <Box key={`ask-auto-${row.id}`} flexDirection="column" gap="xs">
        <Text>{`${row.message}: ${stateLine(row)}`}</Text>
        {row.ruleId && latest(elicit.rules).some(r => r.id === row.ruleId && !r.revoked) ? <Button key={`ask-undo-${row.id}`} label="Undo" onPress={act($, 'revoke-rule', async () => {
          try { await revokeRule($, await dirOf($), row.ruleId!); await refreshLedger($) }
          catch { $.ui.toast('Could not revoke rule. Try again.'); throw new Error('the rule is still on') }
        }, { label: 'revoke the rule' })} /> : null}
      </Box>)}
    </Box> : null
    const needsWhy = await read($, needsProblem)
    const needIds = new Set(waitingOnYou.map(x => x.need.id))
    const permRows = ((await read($, permWaits)) ?? []).filter(x => !needIds.has(x.id)).sort((a, b) => a.since - b.since)
    const needsCard = firstAsk || waitingOnYou.length || permRows.length || needsWhy ? panel('needs',
      <Box key="needs" flexDirection="column" gap="xs">
        {label('Needs you', tone.warn, waitingOnYou.length + askQueue.length + permRows.length)}
        {question}
        <Text size="caption" dimColor>idle sessions whose last reply asks you something, and sessions stopped on a permission prompt</Text>
        {needsWhy ? <Text key="needs-why" size="caption" color={tone.warn}>{`Could not read your sessions: ${needsWhy}`}</Text> : null}
        {permRows.map(p => (
          <Box key={`perm-${p.id}`} paddingX={1} gap={1} alignItems="flex-start">
            <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0}>
              <Text weight="medium" wrap="truncate-end">{p.title}</Text>
              <Text size="caption" dimColor wrap="truncate-end">{p.tool ? `Waiting for permission to use ${p.tool}` : 'Waiting for your permission to use a tool'}</Text>
            </Box>
            <Text size="caption" color={tone.warn} tabular>{`waiting ${waitFor(now - p.since).replace(/([mhd])$/, ' $1')}`}</Text>
          </Box>
        ))}
        {capped('needs', waitingOnYou, 5).map(({ need: n, depth }) => (
          <Box key={`need-${n.id}`} paddingX={1} paddingLeft={1 + 2 * Math.min(depth, 2)} gap={1} alignItems="flex-start" hover={{ backgroundColor: skin.hover }}>
            <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0}>
              <Text weight="medium" wrap="truncate-end">
                {n.kind ? <Text color={tone.accent}>{n.kind === 'hq' ? 'HQ  ' : '↳ '}</Text> : null}
                {n.kind === 'child' ? n.title.replace(/^↳\s*/, '') : n.title}
              </Text>
              <Text size="caption" dimColor wrap="truncate-end">{n.ask}</Text>
            </Box>
            <Text size="caption" color={tone.warn} tabular>{`waiting ${waitFor(now - n.since).replace(/([mhd])$/, ' $1')}`}</Text>
            {n.link ? <Button key={`open-${n.id}`} label="Open" onPress={act($, 'open-session', () => openSession($, n), { label: 'open the session' })} /> : null}
          </Box>
        ))}
        {showMore('needs', waitingOnYou.length, 5)}
      </Box>, momentum.needs) : null
    // The live loop rereads a placed, visible Next pane's Attention each minute; a first draw reads it here.
    const attentionState = current === 'focus' && dataDir ? await drawnAttention($, attention, await dirOf($)) : null
    const allProjects = await read($, attentionAll)
    const attn = attentionState?.data
    const attentionCard = attn ? panel('attention', <Box flexDirection="column" gap="xs">
      <Text weight="semibold">Attention</Text>
      <Text>{`Interruptions today: ${attn.totals.find(d => d.day === attn.today)?.total ?? 0} (target 3 per project)`}</Text>
      <Text size="caption" dimColor>a gate · b direction · c avoidable · d noise</Text>
      {attn.projects.map(p => <Box key={`attention-project-${p.project}`} flexDirection="column" gap="xs">
        <Text>{projectFlag(p.counts) ? <Text color={tone.fail}>● </Text> : null}{`${p.project}${p.trial ? ' · trial' : ''} · ${p.counts.blocked_wait_min} min blocked waiting`}</Text>
        <Box gap={0}>
          {(['a', 'b', 'c', 'd'] as const).map((cls, i) => <Box key={cls} flexGrow={p.counts[cls]} paddingX="xs" backgroundColor={desk.track}>
            <Text size="caption" color={([tone.done, tone.brand, tone.warn, tone.fail] as const)[i]}>{`${cls} ${p.counts[cls]}`}</Text>
          </Box>)}
        </Box>
      </Box>)}
      <Text key="attention-sparkline" size="caption">{`${attentionSparkline(attn)} · 14 days through ${attn.today}`}</Text>
      <Box justifyContent="space-between" gap="xs">
        <Text weight="medium">Recent interruptions</Text>
        <Button key="attention-all" plain label={allProjects ? 'All projects ✓' : 'All projects'} onPress={view($, () => update($, attentionAll, v => !v))} />
      </Box>
      {attn.recent.filter(r => allProjects || attn.trials.includes(r.project)).slice(0, 20).map(r => <Box key={`attention-recent-${r.id}`} flexDirection="column" gap="xs" {...skin.rows}>
        <Text size="caption">{`${r.project} · ${r.ts.slice(0, 16).replace('T', ' ')} · ${r.cls} · ${r.wait_min} min wait`}</Text>
        <Text>{r.summary}</Text>
        <Box gap="sm" flexWrap="wrap" alignItems="center">
          {attentionState?.ratings[r.id] && <Text size="caption">{`Rated: ${attentionState.ratings[r.id]!.rating === 'worth' ? 'Worth it' : 'Not'}`}</Text>}
          {(['worth', 'not'] as const).map(rating => <Button key={`attention-${rating}-${r.id}`} plain label={rating === 'worth' ? 'Worth it' : 'Not'} onPress={act($, 'rate', async () => {
            try { await rateAttention($, attention, await dirOf($), r.id, rating) } catch { $.ui.toast('Could not save rating. Check interruption-ratings.json and try again.'); throw new Error('the rating was not saved') }
          }, { label: 'save the rating' })} />)}
        </Box>
      </Box>)}
    </Box>) : null
    const delegable = delegateThreads((b?.threads ?? []).filter(t => t.id !== top?.id && !w.working.some(x => x.id === t.id) && !isHidden(m, t.id, now) && s[t.id] === undefined), pullRequests as StagePR[], now)
    const delegateRows = await Promise.all(delegable.map(async t => <Box key={`delegate-${t.id}`} flexDirection="column" gap="xs" paddingX={1} {...skin.rows} hover={{ backgroundColor: skin.hover }}>
      <Text weight="medium" wrap="truncate-end">{t.title}</Text>
      <Text size="caption" dimColor>{rowPresentation(t).estimateText}</Text>
      <Button key={`delegate-details-${t.id}`} plain dimColor label="Thread details ›" onPress={view($, () => update($, openRow, () => expanded === t.id ? null : t.id))} />
      {expanded === t.id ? <Box flexDirection="column" gap="xs"><Text>{t.finish}</Text>{context(t)}</Box> : null}
      {await launchControl($, e, t, 'delegate', true)}
    </Box>))
    const delegateCard = delegateRows.length ? panel('delegate', <Box flexDirection="column" gap="xs">
      {label('Delegate', tone.done, delegateRows.length)}
      <Text size="caption" dimColor>Best payoff per hour of your time</Text>
      {delegateRows}
    </Box>, tone.done) : null
    const stats = b ? momentumStats(b, m, w.todo, now, top?.id) : null
    const momentumCard = stats && ready && !why ? panel('momentum', <Box flexDirection="column" gap="sm">
      <Box gap="sm" alignItems="center">
        {'Svg' in els ? <els.Svg key="wins-ring" source={winsRing(stats.wins)} alt={`${stats.wins} of ${WIN_GOAL} wins today`} width={64} height={64} /> :
          <Box key="wins-gauge">{gauge(stats.wins / WIN_GOAL, momentum.win)}</Box>}
        <Box flexDirection="column" flexGrow={1} gap="xs">
          <Text weight="bold" color={momentum.win}>{`${stats.wins} of ${WIN_GOAL} wins today`}</Text>
          <Text size="caption" dimColor>{stats.wins >= WIN_GOAL ? 'Goal reached. Every extra win counts.' : 'One small finish at a time.'}</Text>
        </Box>
      </Box>
      <Box key="points-hours" flexDirection="column" gap="xs">
        <Text size="caption" color={momentum.win}>{`Points: ${stats.points} completed this week`}</Text>
        {gauge(stats.pointFraction, momentum.win)}
        <Text size="caption" dimColor>{`Hours: ${stats.hours.toFixed(1)} h estimated completed this week`}</Text>
        {gauge(stats.hourFraction, momentum.hero)}
        <Text size="caption" dimColor>Bars compare completed estimates with remaining checked work.</Text>
        {stats.unknownValues ? <Text size="caption" dimColor>{`${stats.unknownValues} completed items have no points estimate`}</Text> : null}
        {stats.unknownEstimates ? <Text size="caption" dimColor>{`${stats.unknownEstimates} completed items have no time estimate`}</Text> : null}
      </Box>
      <Box key="day-parts" gap="sm" flexWrap="wrap">
        {['Morning', 'Midday', 'Night'].map((name, i) => stats.parts[i]! > 0 ? <Box key={`day-part-${i}`} flexDirection="column" flexGrow={1} gap="xs">
          {gauge(stats.parts[i]! / Math.max(1, stats.wins), i === 0 ? tone.warn : i === 1 ? momentum.hero : tone.note)}
          <Text size="caption" weight={i === (new Date(now).getHours() < 12 ? 0 : new Date(now).getHours() < 18 ? 1 : 2) ? 'bold' : 'regular'}>{`${name} · ${stats.parts[i]} ${stats.parts[i] === 1 ? 'win' : 'wins'}`}</Text>
        </Box> : null)}
      </Box>
      {stats.wins > 0 ? <Text size="caption" dimColor>Wins by completion time. Day parts have no set targets.</Text> : null}
    </Box>, momentum.win) : null
    const rescue = stats?.rescue
    const rescueCard = rescue && rescue.id !== top?.id && new Date(now).getHours() < 18 && ready && !why ? panel('rescue', <Box flexDirection="column" gap="xs">
      <Text weight="bold" color={momentum.slipped}>Rescue one</Text>
      <Text size="caption" dimColor>No recorded win for 90 minutes. Try one small step.</Text>
      <Text weight="medium">{rescue.title}</Text>
      <Text size="caption" dimColor>{`${rescue.minutes} min estimated`}</Text>
      <Button key={`rescue-${rescue.id}`} label="Rescue" onPress={act($, 'rescue', () => rescueRow($, rescue), { label: 'start the rescue' })} />
      {expanded === rescue.id ? <Box flexDirection="column" gap="xs"><Text>{rescue.finish}</Text>{context(rescue)}{go(rescue)}</Box> : null}
      {cardNoteLine(rescue.id)}
    </Box>, momentum.slipped) : null
    const focus = (
      <Box key="next-content" flexDirection="column" gap="md">
        {top ? (
          <Box key="hero" flexDirection="column" {...(terminal ? {} : { padding: 0.25, borderStyle: 'round' as const, borderColor: desk.ring })}>
          <Box key="hero-card" flexDirection="column" gap="sm" padding="md" borderStyle="round" {...skin.momentum('hero')}>
            <Box justifyContent="space-between">
              <Text size={terminal ? 'footnote' : 'caption'} weight={terminal ? 'semibold' : 'bold'}>
                <Text color={s[top.id] !== undefined ? momentum.win : momentum.hero}>{s[top.id] !== undefined ? '✓ Now' : terminal ? '● Now' : 'NOW'}</Text>
                {terminal ? <Text dimColor>{top.minutes ? `  ·  ${top.minutes} min` : ''}</Text> : null}
              </Text>
              <Text size="footnote" dimColor tabular>1 of {w.todo.length}</Text>
            </Box>
            {terminal ? <Text size="heading" weight="semibold" {...settlingProps(top.id)}>{top.title}</Text> : <Box gap="xs" alignItems="center" flexWrap="wrap">
              <Text size="title" weight="bold" {...settlingProps(top.id)}>{top.title}</Text>
              {!terminal && [mins(top), top.project].filter(Boolean).map(tag => <Box key={`tag-${tag}`} paddingX="xs" borderStyle="round" borderColor={desk.track} backgroundColor={desk.track}><Text size="caption">{tag}</Text></Box>)}
            </Box>}
            <Box key="hero-body" flexDirection="column" gap="xs">
              <Text>{top.finish}</Text>
              <Text key="hero-why" size="caption" color={momentum.hero}>{`Why this: ${whyThis(top)}`}</Text>
              {top.left_off || top.last_ask ? <Text key="hero-context" size="caption" dimColor>{`Where you were: ${clip(top.left_off || top.last_ask || '', 120)}`}</Text> : null}
              <Button key="hero-details" plain dimColor label="Thread details ›" onPress={view($, () => update($, openRow, () => expanded === top.id ? null : top.id))} />
            </Box>
            {s[top.id] === undefined ? await launchControl($, e, top, 'hero') : null}
            {s[top.id] === undefined && isStalled(top) ? <Button key={`hero-rescue-${top.id}`} label="Rescue" onPress={act($, 'rescue', () => rescueRow($, top), { label: 'start the rescue' })} /> : null}
            {expanded === top.id ? context(top) ?? <Text size="caption" dimColor>No earlier session context recorded.</Text> : null}
            <Box gap="xs" alignItems="center" flexWrap="wrap">{ageChipText('hero-freshness', b?.generated)}{refresh}</Box>
            {terminal ? <Text size="caption" color={tone.accent} wrap="truncate-end">{top.project}</Text> : null}
            {progress(top, ' done', 10, tone.brand)}
            {settledControls($, e, s[top.id] !== undefined, `tick-${top.id}`, `undo-${top.id}`, top.id, <Box gap="xs" flexWrap="wrap" alignItems="center">
              <Button key={`tick-${top.id}`} label="Done" variant="primary" hotkey="d" onPress={act($, 'done', () => markDone($, top.id), { label: 'mark it done' })} />
              {go(top)}{cardNoteLine(top.id)}
              <Button key={`park-${top.id}`} label="Not today" onPress={act($, 'park', () => applyMark($, 'park', [top.id]), { label: 'move it to tomorrow' })} />
            </Box>)}
          </Box>
          </Box>
        ) : ready && b && !why ? (
          <Box flexDirection="column" gap="xs" padding="md" borderStyle="round" {...skin.card(tone.done)}>
            <Text size="heading" weight="semibold" color={tone.done}>✓ Clear board</Text>
            <Text dimColor>Nothing checked and open. Rescan, or look at the unchecked list in Work.</Text>
            {w.notes.length > 0 && (
              <Box>
                <Button key="clear-notes" plain label={`${w.notes.length} note${w.notes.length === 1 ? '' : 's'} open ›`} onPress={view($, () => update($, tab, () => 'notes'))} />
              </Box>
            )}
          </Box>
        ) : null}
        {needsCard}
        {rescueCard}
        {elicitWins}
        {delegateCard}
        {summary('momentum', 'Wins & estimates', stats?.wins ?? 0, '', momentumCard, momentum.win)}
        <Box key="later-today" flexDirection="column" gap="xs" padding="sm" borderStyle="round" {...skin.momentum('quiet')}>
          {label('Later today', momentum.quiet)}
          {!top ? <Box gap="xs" alignItems="center">{ageChipText('later-freshness', b?.generated)}{refresh}</Box> : null}
          {summary('attention', 'Attention', attn?.totals.find(d => d.day === attn.today)?.total ?? 0, attn?.recent[0]?.summary ?? '', attentionCard)}
          {summary('calendar', 'Calendar', event ? eventsLeft + 1 : 0, event ? `${event.start} ${event.title}` : '', calendar)}
          {summary('today', 'Today plan', planned.length, planned[0]?.title ?? '', today)}
          {summary('then', 'Then', Math.max(0, w.todo.length - 1), w.todo[1]?.title ?? '', w.todo.length > 1 ? <Box flexDirection="column" gap="xs">{w.todo.slice(1).map(t => row(t, tone.accent, true))}</Box> : null)}
          {summary('prs', 'Pull requests', pullRequests.length, pullRequests[0]?.title ?? prsWhy ?? '', prsPanel, pullRequests.some(isRed) ? tone.fail : momentum.quiet)}
          {summary('drafts', 'Drafts to send', waiting.length, waiting[0]?.subject ?? '', draftList, momentum.slipped)}
          {summary('done', 'Done today', completed.length, completed.at(-1)?.title ?? '', doneCard, momentum.win)}
          {w.wins.length > 0 ? <Button key="go-wins" plain label={`${w.wins.length} finished, ready to tick off ›`} onPress={view($, () => update($, tab, () => 'wins'))} /> : null}
        </Box>
      </Box>
    )

    // ---------- Work ----------
    const byProject = new Map<string, Thread[]>()
    w.todo.forEach(t => byProject.set(t.project || 'Other', [...(byProject.get(t.project || 'Other') ?? []), t]))
    const work = (
      <Box flexDirection="column" gap="md">
        {[...byProject].map(([p, items]) => (
          <Box key={`p-${p}`} flexDirection="column" gap="xs">
            {label(humanize(p), tone.accent, items.length)}
            {capped(`p-${p}`, items, 3).map(t => row(t))}
            {showMore(`p-${p}`, items.length, 3)}
          </Box>
        ))}
        {w.ask.length > 0 && (
          <Box flexDirection="column" gap="xs">
            {label('Did you already do these?', tone.quiet, w.ask.length)}
            {capped('ask', w.ask, 0).map(t => row(t, tone.quiet))}
            {showMore('ask', w.ask.length, 0)}
          </Box>
        )}
        {w.waiting.length > 0 && (
          <Box flexDirection="column" gap="xs">
            {label('Waiting on someone', tone.quiet, w.waiting.length)}
            {w.waiting.map(t => row(t, tone.quiet))}
          </Box>
        )}
        {w.working.length > 0 && (
          <Box key="being-worked-on" flexDirection="column" gap="xs">
            {label('Being worked on', tone.quiet, w.working.length)}
            {await Promise.all(w.working.map(async t => <Box key={`working-${t.id}`} flexDirection="column">
              {row(t, tone.quiet)}
              <Box paddingX={1}>{(await activeLaunch($, t.id)) ? await launchControl($, e, t, 'working') : <Text size="caption" dimColor>A session is working on it</Text>}</Box>
            </Box>))}
          </Box>
        )}
        {!w.todo.length && !w.ask.length && !w.working.length && <Text dimColor>No open work.</Text>}
        {doneCard}
      </Box>
    )

    // ---------- Notes ----------
    const byHeading = new Map<string, Note[]>()
    w.notes.forEach(n => byHeading.set(n.project || 'Other', [...(byHeading.get(n.project || 'Other') ?? []), n]))
    const notes = (
      <Box flexDirection="column" gap="md">
        {[...byHeading].map(([heading, items]) => (
          <Box key={`n-${heading}`} flexDirection="column" gap="xs">
            {label(heading, tone.note, items.length)}
            {capped(`n-${heading}`, items, 5).map(n => (
              <Box key={`ni-${n.id}`} paddingX={1} gap={1} justifyContent="space-between" alignItems="center" hover={{ backgroundColor: skin.hover }}>
                <Box gap={1} alignItems="center" flexShrink={1}>
                  <Text color={s[n.id] !== undefined ? tone.done : tone.note}>{s[n.id] !== undefined ? '✓' : '○'}</Text>
                  <Text weight="medium" wrap="truncate-end" {...settlingProps(n.id)}>{clip(n.title || n.text, Math.max(14, e.props.bodyColumns - 36))}</Text>
                </Box>
                {settledControls($, e, s[n.id] !== undefined, `nt-${n.id}`, `undo-${n.id}`, n.id, <Box gap={1} alignItems="center">
                  <Button key={`nt-${n.id}`} label="Done" onPress={act($, 'done', () => markDone($, n.id), { label: 'mark it done' })} />
                  <Button key={`np-${n.id}`} plain label={inPlan(n.id) ? '✓ Today' : '+ Today'} onPress={togglePlan(n.id)} />
                  <Button key={`nside-${n.id}`} plain label="Side task" onPress={act($, 'side-task', (pe: UiPressArgument) => startSide($, n, pe.surface), { label: 'start a side task' })} />
                </Box>)}
              </Box>
            ))}
            {showMore(`n-${heading}`, items.length, 5)}
          </Box>
        ))}
        {!w.notes.length && <Text dimColor>No notes.</Text>}
        {doneCard}
      </Box>
    )

    // ---------- Done this week ----------
    // Each day's done marks (dropped ones never count) as a bar, then the items themselves, newest first.
    const DAY = 86_400_000
    const day0 = midnight
    const weekStart = new Date(day0).setDate(new Date(day0).getDate() - 6)
    const done = doneBetween(m, weekStart, now + 60_000)
    const dayStarts = Array.from({ length: 7 }, (_, i) => new Date(weekStart).setDate(new Date(weekStart).getDate() + i))
    const perDay = dayStarts.map((s, i) => done.filter(k => k.at >= s && k.at < (dayStarts[i + 1] ?? Infinity)).length)
    const peak = Math.max(1, ...perDay)
    const BARS = '▁▂▃▄▅▆▇█'
    const dayName = (at: number) => {
      const d = new Date(at).setHours(0, 0, 0, 0)
      return d === day0 ? 'Today' : Math.round((day0 - d) / DAY) === 1 ? 'Yesterday' : new Date(at).toLocaleDateString(undefined, { weekday: 'long' })
    }
    const titled = done
      .map(({ id, at }) => {
        const item = b?.threads.find(t => t.id === id) ?? b?.notes.find(n => n.id === id)
        return item ? { id, at, title: item.title || ('text' in item ? item.text : '') } : null
      })
      .filter((x): x is { id: string; at: number; title: string } => !!x)
    const shownDone = capped('hist', titled, 8)
    const week = (
      <Box key="week-box" flexDirection="column" gap="sm">
        <Box justifyContent="space-between" alignItems="center" gap={1}>
          {label('This week', tone.done)}
          <Text size="caption" dimColor tabular>{`${done.length} done in 7 days`}</Text>
        </Box>
        <Box key="week" gap="sm" justifyContent="space-between" paddingX={1}>
          {perDay.map((n, i) => (
            <Box key={`wk-${i}`} flexDirection="column" alignItems="center">
              <Text color={n ? (i === 6 ? tone.brand : tone.done) : tone.quiet}>{n ? BARS[Math.ceil((n / peak) * BARS.length) - 1] : '·'}</Text>
              <Text size="caption" tabular {...(i === 6 ? { weight: 'semibold' as const } : { dimColor: true })}>
                {new Date(dayStarts[i] ?? 0).toLocaleDateString(undefined, { weekday: 'short' })}
              </Text>
              <Text size="caption" dimColor tabular>{String(n)}</Text>
            </Box>
          ))}
        </Box>
        {shownDone.map((x, i) => (
          <Box key={`hb-${x.id}`} flexDirection="column">
            {i === 0 || dayName(x.at) !== dayName(shownDone[i - 1]?.at ?? 0) ? (
              <Box paddingX={1}>
                <Text size="caption" dimColor>{dayName(x.at)}</Text>
              </Box>
            ) : null}
            <Box key={`hs-${x.id}`} paddingX={1} gap={1} justifyContent="space-between" alignItems="center" hover={{ backgroundColor: skin.hover }}>
              <Box gap={1} alignItems="center" flexShrink={1}>
                <Text color={tone.done}>✓</Text>
                <Text wrap="truncate-end">{x.title}</Text>
              </Box>
              <Button key={`hu-${x.id}`} plain dimColor label="Undo" onPress={act($, 'undo', () => applyMark($, 'undo', [x.id]), { label: 'undo it' })} />
            </Box>
          </Box>
        ))}
        {showMore('hist', titled.length, 8)}
      </Box>
    )

    // ---------- To tick ----------
    const wins = (
      <Box flexDirection="column" gap="md">
        {w.wins.length ? (
          <Box flexDirection="column" gap="xs" padding="sm" borderStyle="round" {...skin.card(tone.done)}>
            <Box justifyContent="space-between" alignItems="center" flexWrap="wrap" gap={1}>
              <Text size={terminal ? 'footnote' : 'body'} weight={terminal ? 'semibold' : 'bold'}>
                <Text color={tone.done}>✓ </Text>FINISHED, NOTHING LEFT
              </Text>
              {asking === 'tick-all' ? (
                <Box gap={1} alignItems="center">
                  <Button
                    key="tick-all-yes"
                    variant="primary"
                    label={`Yes, tick all ${w.wins.length}`}
                    onPress={act($, 'tick-all', async () => {
                      try { await tickAll($, w.wins) }
                      catch (error) { await update($, problem, () => 'Some items could not be ticked. Check the board and try again.'); throw error }
                      finally { await update($, confirm, () => null) }
                    }, { label: 'tick them all' })}
                  />
                  <Button key="tick-all-no" plain label="Cancel" onPress={view($, () => update($, confirm, () => null))} />
                </Box>
              ) : (
                <Button key="tick-all" label={`Tick all ${w.wins.length}`} onPress={view($, () => update($, confirm, () => 'tick-all'))} />
              )}
            </Box>
            {capped('wins', w.wins, 8).map(t => (
              <Box key={`w-${t.id}`} paddingX={1} gap={1} justifyContent="space-between" alignItems="center" hover={{ backgroundColor: skin.hover }}>
                <Box gap={1} alignItems="center" flexShrink={1}>
                  <Text color={tone.done}>{s[t.id] !== undefined ? '✓' : '○'}</Text>
                  <Text weight="medium" wrap="truncate-end" {...settlingProps(t.id)}>{t.title}</Text>
                </Box>
                <Box gap={2} alignItems="center">
                  {e.props.bodyColumns >= 80 ? <Text size="caption" dimColor wrap="truncate">{humanize(t.project, 20)}</Text> : null}
                  {settledControls($, e, s[t.id] !== undefined, `wt-${t.id}`, `undo-${t.id}`, t.id, <Button key={`wt-${t.id}`} label="Done" onPress={act($, 'done', () => markDone($, t.id), { label: 'mark it done' })} />)}
                </Box>
              </Box>
            ))}
            {showMore('wins', w.wins.length, 8)}
          </Box>
        ) : (
          <Text dimColor>Nothing to tick.</Text>
        )}
        {week}
      </Box>
    )

    // ---------- Parked ----------
    const parkedList = (
      <Box flexDirection="column" gap="xs">
        {label('Back tomorrow', tone.quiet, parkedItems.length)}
        <Box paddingX={1}>
          <Text size="caption" dimColor>Back at 8am tomorrow.</Text>
        </Box>
        {parkedItems.map(x => (
          <Box key={`pk-${x.id}`} paddingX={1} gap={1} justifyContent="space-between" alignItems="center" hover={{ backgroundColor: skin.hover }}>
            <Box gap={1} alignItems="center" flexShrink={1}>
              <Text color={tone.quiet}>○</Text>
              <Text dimColor weight="medium" wrap="truncate-end">{x.title || ('text' in x ? x.text : '')}</Text>
            </Box>
            <Button key={`pb-${x.id}`} plain label="↩ Bring back" onPress={act($, 'undo', () => applyMark($, 'undo', [x.id]), { label: 'bring it back' })} />
          </Box>
        ))}
      </Box>
    )

    const tabs = (
      [
        ['focus', 'Focus', 0],
        ['work', 'Work', w.todo.length],
        ['notes', 'Notes', w.notes.length],
        ['wins', 'Wins', w.wins.length],
        ['parked', 'Parked', parkedItems.length],
        ['session', 'Session', calls],
      ] as const
    ).filter(([id, , n]) => (id !== 'parked' || n > 0) && (b || dataDir || id === 'session'))
    // darren-core's Hand off and clear, offered on the Session view only while darren-core serves it.
    // A quiet text control in the header row, never in the tab row: there it shrank the switch on the Session
    // tab alone, so the segments moved under the pointer. A narrow pane gets the short label so it never wraps.
    const handLabel = e.props.bodyColumns >= 70 ? 'Hand off and clear' : 'Hand off'
    const handoff = (current === 'session' || tabs.length <= 1) && ((await read($, handoffReady)) ?? await canHandOff($)) ? (
      <Box key="handoff-box" flexShrink={0} flexDirection="column" justifyContent="center" {...(e.surface !== 'terminal' ? { paddingX: 'xs' as const } : {})}>
        <Button key="handoff" plain dimColor label={handLabel} onPress={act($, 'handoff', () => handOff($), { label: 'hand off' })} />
      </Box>
    ) : null
    // The terminal takes a press only on the cells a Button draws, so each tab's label is centred in spaces to
    // its segment's width: the pane less its padding and the track's.
    const segment = e.surface === 'terminal' ? Math.floor((e.props.bodyColumns - 4) / 2) : 0
    const fill = (label: string) => {
      const gap = Math.max(0, segment - label.length)
      return `${' '.repeat(Math.floor(gap / 2))}${label}${' '.repeat(Math.ceil(gap / 2))}`
    }
    const mainTabs = tabs.filter(([id]) => id === 'focus' || id === 'session')
    const tabLabel = (id: string, text: string, n: number) => `${text === 'Focus' ? 'Next' : text}${id === 'session' && n ? ` ${n}` : ''}`

    // The Sentinel strip: what the checker found, with its age. Tapping it opens the cards; unknown is never green.
    const sn = await read($, sentinel)
    const snView = sn ? stripView(sn, now) : null
    const snOpen = shown.includes('sentinel')
    const snColor = snView?.tone === 'fail' ? tone.fail : snView?.tone === 'warn' ? tone.warn : undefined
    const sentinelCard = (c: Card) => (
      <Box key={`sentinel-card-${c.id}`} flexDirection="column" gap="xs" padding="sm" borderStyle="round" {...skin.card(c.severity === 'P0' ? tone.fail : tone.warn)}>
        <Box gap={1} alignItems="flex-start">
          <Text size="caption" weight="bold" color={c.severity === 'P0' ? tone.fail : tone.warn}>{c.severity}</Text>
          <Text weight="semibold" wrap="wrap">{c.title}</Text>
        </Box>
        {c.summary ? <Text size="caption" dimColor wrap="wrap">{c.summary}</Text> : null}
        <Text size="caption" dimColor tabular>{`${c.count === 1 ? 'seen once' : `seen ${c.count} times`}${c.recurrence ? `, came back ${c.recurrence === 1 ? 'once' : `${c.recurrence} times`}` : ''}${c.routeWhy ? ` · ${c.routeWhy}` : ''}`}</Text>
        {c.evidence.slice(0, 2).map((line, i) => <Text key={`sentinel-ev-${c.id}-${i}`} size="caption" dimColor wrap="wrap">{clip(line, 160)}</Text>)}
        {c.prompt ? (
          <Box gap="xs" flexWrap="wrap" alignItems="center">
            <Button key={`sentinel-copy-${c.id}`} label="Copy prompt" variant="primary" onPress={act($, 'copy-prompt', async (pe: UiPressArgument) => { await $.ui.copy({ text: c.prompt, surface: pe.surface }); return 'Prompt copied' }, { label: 'copy the prompt' })} />
            <Button key={`sentinel-side-${c.id}`} label="Start side task" onPress={act($, 'side-task', (pe: UiPressArgument) => startGoal($, c.prompt, '', pe.surface), { label: 'start a side task' })} />
          </Box>
        ) : <Text size="caption" dimColor>{c.fixHint || 'No prompt for this one.'}</Text>}
      </Box>
    )
    // With cards and a fresh check the strip is the button that opens them; any other state is one line of words, in the colour it earns.
    const snFound = !!snView && snView.cards.length > 0 && snView.text.endsWith('a look')
    const snToggle = view($, () => update($, more, x => (x.includes('sentinel') ? x.filter(k => k !== 'sentinel') : [...x, 'sentinel'])))
    const sentinelStrip = snView ? (
      <Box key="sentinel-box" flexDirection="column" gap="xs">
        {snFound ? (
          <Box gap="sm" alignItems="center" flexWrap="wrap">
            <Button key="sentinel-strip" plain label={snView.text} onPress={snToggle} />
            <Text size="caption" dimColor>{[snView.detail, snOpen ? 'tap to close' : ''].filter(Boolean).join(' · ')}</Text>
          </Box>
        ) : (
          <Box gap="sm" alignItems="center" flexWrap="wrap">
            <Box key="sentinel-strip"><Text size="caption" {...(snColor ? { color: snColor } : { dimColor: true })}>{snView.text}</Text></Box>
            {snView.cards.length ? <Button key="sentinel-cards" plain label={snOpen ? 'Hide' : snView.detail || 'Show'} onPress={snToggle} /> : null}
          </Box>
        )}
        {snOpen ? snView.cards.map(sentinelCard) : null}
      </Box>
    ) : null
    const fb0 = feedbackView(await read($, feedback), now)
    // A reload already shows its own line under the header, so the result line would only say it twice.
    const fb = fb0 && fb0.text === reload.message ? null : fb0
    const feedbackLine = fb ? (
      <Box key="feedback-line" gap="sm" alignItems="center">
        <Text size="caption" color={fb.kind === 'fail' ? tone.fail : fb.kind === 'ok' ? tone.done : fb.kind === 'noop' ? tone.warn : undefined} dimColor={fb.kind === 'pending'}>{fb.text}</Text>
        {fb.kind !== 'pending' ? <Button key="feedback-dismiss" plain dimColor label="Dismiss" onPress={view($, () => update($, feedback, () => null))} /> : null}
      </Box>
    ) : null

    return (
      <Box flexDirection="column" gap="md" padding="sm">
        <Box flexDirection="column" gap="xs">
          <Box key="head-row" justifyContent="space-between" alignItems="center" gap={1}>
            <Text weight="bold" wrap="truncate">Next up</Text>
            {'Select' in els ? <els.Select key="pane-more" value="" options={[
              { label: 'More', value: '' }, { label: reload.running ? 'Reloading plugins...' : 'Reload plugins', value: 'reload' },
            ]} onSelect={view($, (value: string) => { if (value === 'reload') return act($, 'reload-plugins', () => reloadPlugins($), { label: 'reload plugins', detach: true })() })} /> : null}
            {(!!handoff || !!dataDir) && (
              <Box alignItems="center" gap="sm">
                {handoff}
                {!!dataDir && (
                  <Text key="wins-count" size="caption" color={momentum.win} tabular>{doneToday ? `${doneToday} ${doneToday === 1 ? 'win' : 'wins'} today` : 'Your first win today awaits'}</Text>
                )}
              </Box>
            )}
          </Box>
          {reload.message ? <Box key="plugin-reload-status" gap="sm" alignItems="center"><Text size="caption" color={reload.failed ? tone.fail : tone.quiet}>{reload.message}</Text>{!reload.running ? <Button key="pane-reload-dismiss" plain dimColor label="Dismiss" onPress={view($, () => dismissReload($))} /> : null}</Box> : null}
          {feedbackLine}
          {sentinelStrip}
          {rail}
        </Box>

        {tabs.length > 1 && (
          <Box flexDirection="column" gap="xs">
            {/* One tab strip; secondary lists live below the pane content. */}
            {/* Desktop: two framed Buttons, as Done and Go to session: a desktop takes a click anywhere on a framed
                Button, while a plain one takes it only on its text, and every overlay tried to fill that gap missed.
                The view shown is primary; the lists sit under Next, so Next stays primary on them. */}
            {e.surface === 'terminal' ? (
              <Box key="tab-row" gap="sm" alignItems="stretch">
                <Box key="tab-track" flexGrow={1} padding={1} backgroundColor={tone.hover}>
                  {mainTabs.map(([id, text, n]) => (
                    <Box key={`tabbox-${id}`} flexGrow={1} width={0} justifyContent="center">
                      <Button key={`tab-${id}`} plain label={fill(tabLabel(id, text, n))} onPress={view($, () => showTab($, id))}>
                        <Text weight={current === id ? 'bold' : 'medium'} wrap="truncate" {...(current === id ? { color: tone.brand } : { dimColor: true })}>
                          {fill(tabLabel(id, text, n))}
                        </Text>
                      </Button>
                    </Box>
                  ))}
                </Box>
              </Box>
            ) : (
              <Box key="tab-row" gap="xs" padding="xs" borderStyle="round" borderColor={desk.track} backgroundColor={desk.track}>
                {mainTabs.map(([id, text, n]) => (
                  <Box key={`tabbox-${id}`} flexGrow={1} width={0} flexDirection="column" alignItems="stretch">
                    <Button key={`tab-${id}`} label={tabLabel(id, text, n)} {...((id === 'session') === (current === 'session') ? { variant: 'primary' as const } : {})}
                      onPress={view($, () => showTab($, id))} />
                  </Box>
                ))}
              </Box>
            )}
          </Box>
        )}

        {!ready && !!dataDir && current !== 'session' && (
          <Box flexDirection="column" gap="xs" alignItems="center">
            <Text dimColor>Reading your board…</Text>
          </Box>
        )}
        {ready && !b && !!dataDir && current !== 'session' && (
          <Box flexDirection="column" gap="xs" alignItems="center">
            <Text dimColor>Not scanned yet.</Text>
            <Button key="first-scan" variant="primary" label="Rescan" onPress={act($, 'rescan', () => rescan($), { label: 'rescan', detach: true })} />
          </Box>
        )}
        {!!why && current !== 'session' && (
          <Box flexDirection="column" gap="xs" padding="sm" borderStyle="round" {...skin.card(tone.fail)}>
            <Text weight="semibold" color={tone.fail}>✕ The board could not be read</Text>
            <Text size="caption">{why}</Text>
            <Box gap="xs" alignItems="center">
              <Button key="retry" label="Retry" onPress={act($, 'retry', () => retryBoard($), { label: 'read the board again' })} />
            </Box>
          </Box>
        )}
        {current === 'focus' &&
          (e.props.bodyColumns >= 110 ? (
            // Wide: your work on the left, the session's panels on the right, so nothing needs a tab.
            <Box key="wide" width="100%" flexShrink={1} minWidth={0} gap="md" alignItems="flex-start">
              <Box width="100%" flexGrow={1} flexShrink={1} minWidth={0} flexDirection="column">{focus}</Box>
              <Box width="100%" flexGrow={1} flexShrink={1} minWidth={0} flexDirection="column">{await drawActivity($, e, fast !== null ? { on: fast, toggle: () => toggleWorkerFast($) } : undefined)}</Box>
            </Box>
          ) : (
            focus
          ))}
        {current === 'work' && work}
        {current === 'notes' && notes}
        {current === 'wins' && wins}
        {current === 'parked' && parkedList}
        {current === 'session' && (await drawActivity($, e, fast !== null ? { on: fast, toggle: () => toggleWorkerFast($) } : undefined))}
        {current !== 'session' && tabs.some(([id]) => id !== 'focus' && id !== 'session') && (
          <Box gap="sm" flexWrap="wrap" justifyContent="center">
            <Text dimColor>Lists ›</Text>
            {tabs
              .filter(([id]) => id !== 'focus' && id !== 'session')
              .map(([id, text, n], i) => (
                <Box key={`lb-${id}`} gap="sm" alignItems="center">
                  {i > 0 && <Text color={tone.quiet}>·</Text>}
                  {/* As the main tabs: a box that stretches its one child, the native Button, and lights on hover. */}
                  <Box key={`lbtab-${id}`} {...(e.surface !== 'terminal' ? { flexDirection: 'column' as const, alignItems: 'stretch' as const, paddingX: 'xs' as const, hover: { backgroundColor: desk.raised } } : {})}>
                    <Button key={`tab-${id}`} plain onPress={view($, () => showTab($, id))}>
                      <Text weight={current === id ? 'bold' : 'medium'} {...(current === id ? { color: tone.brand } : { dimColor: true })}>
                        {`${text}${n ? ` ${n}` : ''}`}
                      </Text>
                    </Button>
                  </Box>
                </Box>
              ))}
          </Box>
        )}
        {!b && !dataDir && (
          <Box flexDirection="column" gap="xs" alignItems="center">
            <Text dimColor>No data folder set.</Text>
            <Text size="caption" dimColor>Set dataDir in this plugin's options to show your board.</Text>
          </Box>
        )}
      </Box>
    )
  }
}

// True when any darren-core command is served; its skills are then safe to name in a launch prompt.
async function hasDarrenCore($: E): Promise<boolean> {
  try {
    return (await $.command.list()).some(c => c.plugin === 'darren-core')
  } catch {
    return false
  }
}
// darren-core owns the hand-off (the prompt, the file check, the /clear and the pick-up line); nextup only asks
// for it through the slash command darren-core serves, so the button is absent when darren-core is.
async function canHandOff($: E): Promise<boolean> {
  try {
    return (await $.command.list()).some(c => c.name === 'handoff-and-clear' && c.plugin === 'darren-core')
  } catch {
    return false
  }
}

/** Look the hand-off command up again and store the answer; an unchanged answer writes nothing. */
async function refreshHandoff($: E) {
  const ready = await canHandOff($)
  if ((await read($, handoffReady)) !== ready) await update($, handoffReady, () => ready).catch(() => undefined)
}

// A plugin-run command can be refused (a desktop session is non-interactive), so the command is then filled
// into the prompt for the person to send, as /reload-plugins is.
async function handOff($: E): Promise<void> {
  try {
    await $.command.run({ command: 'handoff-and-clear' })
  } catch {
    await $.prompt.fill({ text: '/handoff-and-clear' }).catch(() => undefined)
    $.ui.toast('Press Enter to hand off and clear.')
  }
}
