import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { Feedback } from '../types'

// Every button press ends in a visible result and one line in mod-events.jsonl, so a press that did nothing cannot be silent.
// act() wraps a handler: it draws "Working…" at once, then the outcome (done, failed, or nothing changed and why).
// The Sentinel reads mod-events.jsonl (SN-07: feedback within a second, no press without an outcome, no failure unseen).

type E = EngineInterface
export type Outcome = 'ok' | 'fail' | 'noop'
/** What a handler may return: nothing or true is ok, false is nothing changed, a string is an ok message. */
export type Done = void | boolean | string | { outcome?: Outcome; msg?: string; proof?: string }
type Result = { outcome: Outcome; msg: string; proof?: string }

// register.tsx declares the same atom: the state scan reads an atom only where its file declares it.
export const feedback = atom({ plugin: 'nextup', key: 'feedback' } as const, null as Feedback)

/** Thrown by a handler that did not act and knows why; the reason is the message and the outcome is a no-op. */
export class Declined extends Error {}

const OK_MS = 6_000
const FAIL_MS = 30_000
const PENDING_MS = 30_000
const NOTHING = 'Nothing changed.'
const MAX_FILE = 1_048_576

let dataDir = ''
/** register() gives the data folder option; with no folder nothing is logged, but results still show. */
export const bindEvents = (dir: string) => { dataDir = dir }
async function dirOf($: E): Promise<string> {
  if (!dataDir.startsWith('~')) return dataDir.replace(/\/+$/, '')
  return `${(await $.env.get('HOME')) ?? ''}${dataDir.slice(1)}`.replace(/\/+$/, '')
}

const clip = (v: string, n: number) => (v.length > n ? `${v.slice(0, n - 1)}…` : v)

export function eventLine(e: { t: number; action: string; outcome: Outcome; msg: string; feedbackMs: number; proof?: string }): string {
  return JSON.stringify({ ...e, msg: clip(e.msg.replace(/\s+/g, ' ').trim(), 200), ...(e.proof ? { proof: clip(e.proof, 120) } : {}) })
}

const reason = (e: unknown) => (e instanceof Error ? e.message : String(e ?? '')).split('\n')[0]!.trim()

/** The outcome of a handler's return value or throw, as words for the pane. */
export function outcomeOf(r: unknown, label: string): Result {
  if (r instanceof Declined) return { outcome: 'noop', msg: r.message }
  if (r instanceof Error) {
    const why = clip(reason(r), 140)
    return { outcome: 'fail', msg: why ? `Couldn't ${label}: ${why}` : `Couldn't ${label}.` }
  }
  if (r === false) return { outcome: 'noop', msg: NOTHING }
  if (typeof r === 'string') return { outcome: 'ok', msg: r }
  if (r && typeof r === 'object') {
    const o = r as { outcome?: Outcome; msg?: string; proof?: string }
    return { outcome: o.outcome ?? 'ok', msg: o.msg ?? '', ...(o.proof ? { proof: o.proof } : {}) }
  }
  return { outcome: 'ok', msg: '' }
}

/** What the pane draws for the last press: null once it has expired; a pending press that never ends reads as a failure. */
export function feedbackView(f: Feedback, now: number): Feedback {
  if (!f) return null
  const age = now - f.at
  if (f.kind === 'pending') return age > PENDING_MS ? { ...f, kind: 'fail', text: `${f.action} is taking longer than expected.` } : f
  return age > (f.kind === 'ok' ? OK_MS : FAIL_MS) ? null : f
}

async function append($: E, line: string) {
  const dir = await dirOf($).catch(() => '')
  if (!dir) return
  const file = `${dir}/mod-events.jsonl`
  // One short append is atomic enough for one writer; past 1 MB the file keeps its last 2000 lines.
  const script = `printf '%s\\n' "$L" >> "$F"; n=$(wc -c < "$F"); if [ "$n" -gt ${MAX_FILE} ]; then tail -n 2000 "$F" > "$F.tmp" && mv "$F.tmp" "$F"; fi`
  try { await $.process.run(['/bin/sh', '-c', script], { env: { F: file, L: line }, timeoutMs: 5_000 }) } catch { /* A log that cannot be written must not hide the result. */ }
}

let seq = 0
/** The engine's clock, or the system's in a host with no clock adapter. */
async function clockNow($: E): Promise<number> {
  try { return await $.clock.now() } catch { return Date.now() }
}
/** Clears this result's line after its time, unless a newer one replaced it. */
function expireLater($: E, ms: number, id: string) {
  try { $.clock.after(ms + 1, () => void update($, feedback, f => (f && f.id === id ? null : f))) } catch { /* No clock: the next press replaces it. */ }
}
type Opts = { /** The action in a failure sentence: "Couldn't <label>: why". Defaults to the action name. */ label?: string
  /** Why nothing changed, when the handler returns false. */ noop?: string
  /** A toggle: no pending state, no ok message, no log line unless it fails. */ quiet?: boolean
  /** Long work (a rescan, a reload): the press answers once Working… shows and the work finishes behind it, so nothing queues behind the press. */ detach?: boolean }

/** Wraps a button handler: pending at once, then done, failed or nothing changed (with the reason), and one logged line. */
export function act<A extends unknown[]>($: E, action: string, fn: (...a: A) => unknown, o: Opts = {}): (...a: A) => Promise<void> {
  const label = o.label ?? action
  return async (...a: A) => {
    const me = ++seq
    const id = `${action}:${me}`
    const t0 = await clockNow($)
    const show = (kind: NonNullable<Feedback>['kind'], text: string) => update($, feedback, () => ({ id, action, kind, text, at: t0 }))
    if (!o.quiet) await show('pending', 'Working…')
    const t1 = await clockNow($)
    const finish = async () => {
    let r: Result
    try { r = outcomeOf(await fn(...a), label) } catch (error) { r = outcomeOf(error, label) }
    if (r.outcome === 'noop' && (!r.msg || r.msg === NOTHING)) r.msg = `${NOTHING} ${o.noop ?? 'Check the Next up data folder option.'}`
    // An older press finishing late never replaces what a newer one is showing.
    const mine = async (fn2: (f: Feedback) => Feedback) => update($, feedback, f => (f && Number(f.id.split(':')[1]) > me ? f : fn2(f)))
    if (r.outcome === 'ok' && !r.msg) await mine(f => (f && f.id === id ? null : f))
    else await mine(() => ({ id, action, kind: r.outcome, text: r.msg, at: t0 }))
    if (r.outcome !== 'ok' || r.msg) {
      const ms = r.outcome === 'ok' ? OK_MS : FAIL_MS
      expireLater($, ms, id)
    }
    if (o.quiet && r.outcome === 'ok') return
    await append($, eventLine({ t: t0, action, outcome: r.outcome, msg: r.msg, feedbackMs: Math.max(0, t1 - t0), ...(r.proof ? { proof: r.proof } : {}) }))
    }
    if (o.detach) void finish().catch(() => undefined)
    else await finish()
  }
}

/**
 * A result that arrives after the press has already answered: the app's log said the session never opened, say.
 * It takes the pane's result line like a press does, and is logged like one, with what proved it.
 */
export async function late($: E, action: string, outcome: Outcome, msg: string, proof?: string) {
  const t = await clockNow($)
  const id = `${action}:${++seq}`
  await update($, feedback, () => ({ id, action, kind: outcome, text: msg, at: t }))
  expireLater($, outcome === 'ok' ? OK_MS : FAIL_MS, id)
  await append($, eventLine({ t, action, outcome, msg, feedbackMs: 0, ...(proof ? { proof } : {}) }))
}

/** A pure view change (a tab, an expand): quiet while it works, loud when it fails. */
export function view<A extends unknown[]>($: E, fn: (...a: A) => unknown) {
  return act($, 'view', async (...a: A) => { await fn(...a) }, { quiet: true, label: 'update the view' })
}

/** The live loop's heartbeat: when it last ran and whether the pane was shown. The Sentinel flags a shown pane whose beat stopped. */
export async function beat($: E, dir: string, shown: boolean) {
  if (!dir) return
  try { await $.fs.write(`${dir}/mod-heartbeat.json`, JSON.stringify({ t: await clockNow($), shown })) } catch { /* Read-only folders are reported by the board read. */ }
}
