import { atom, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { Need } from '../types'

// Needs you: the other desktop sessions that sit idle with a reply asking you something.
// Read through the desktop app's ccd_session_mgmt server; outside the app there is none and the card hides.
// A permission prompt shows as a running session, so it is not detected.

type E = EngineInterface
const SERVER = 'ccd_session_mgmt'
export const NEEDS_EVERY_MS = 60_000

// register.tsx declares the same atom: the state scan reads an atom only where its file declares it.
const needs = atom({ plugin: 'nextup', key: 'needs' } as const, null)
const needsProblem = atom({ plugin: 'nextup', key: 'needsProblem' } as const, null)

// The reply rules mark every reply that needs an answer with [HQ] or [↳ child of ...] on its first line.
const MARK = /^\[(HQ|↳ child of [^\]\n]*)\]\s*/
const NEXT_ACTION = /^\s*Next action:/i
const clip = (v: string, n = 140) => (v.length > n ? `${v.slice(0, n - 1).trimEnd()}…` : v)
const lines = (v: string) => v.split('\n').map(x => x.trim()).filter(Boolean)

// A "Next action:" is the agent's own step only when it says so ("I will...", "wait for the review", "run the tests").
// Anything else, or one that asks, names you or waits on you, still waits on your answer.
const OWN_STEP = /^(i\b|i'll\b|wait (for|on|until) (?!you|darren)|(run|rerun|check|monitor|watch|build|fix|ship|push|merge|deploy|report|tell you|send you)\b)/i
const ON_YOU = /\?[.*_)]*$|\byour (go|ok|okay|answer|reply|approval|input|call|pick|choice|decision|review|sign-off|eyes|hands|word|permission|confirmation|feedback|thoughts|say)\b|\bneeds? you\b|\b(once|when|if|unless|after) you\b|\bwait(ing)? (for|on) (you|darren)\b/i
const ownStep = (next: string) => OWN_STEP.test(next) && !ON_YOU.test(next)

/** What a reply asks you, one line, or null when it asks nothing. A mark alone is no sign: status reports carry it too. */
export function askOf(reply: string): string | null {
  const all = lines(reply)
  const nexts = all.filter(x => NEXT_ACTION.test(x)).map(x => x.replace(NEXT_ACTION, '').trim())
  const text = all.filter(x => !NEXT_ACTION.test(x))
  if (!text.length) return null
  if (MARK.test(text[0]!)) {
    const rest = [text[0]!.replace(MARK, ''), ...text.slice(1)].filter(Boolean)
    const question = rest.find(x => x.endsWith('?'))
    if (question) return clip(question)
    if (nexts.length && nexts.every(ownStep)) return null
    return clip(rest[0] ?? 'Waiting on your answer')
  }
  const last = text[text.length - 1]!
  return last.endsWith('?') ? clip(last) : null
}

// list_events rows start with a role in brackets; a reply's own lines may start with [HQ], so only these roles split rows.
const ROW = /^\[(assistant|user|result|system|tool[\w ]*)\] ?/
const LOCAL = /^<(command-name|command-message|command-args|local-command)/

/** The last assistant text of an idle session's transcript, or null when it is running, has none, or you answered since. */
export function lastReply(events: string): string | null {
  if (!/^Session ".*" \(idle\)/m.test(events.split('\n')[0] ?? '')) return null
  const rows: { role: string; text: string }[] = []
  for (const line of events.split('\n')) {
    const m = ROW.exec(line)
    if (m) rows.push({ role: m[1]!, text: line.slice(m[0].length) })
    else if (rows.length) rows[rows.length - 1]!.text += `\n${line}`
  }
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i]!
    // A prompt you sent after the reply answered it; a slash command you ran did not.
    if (r.role === 'user' && !LOCAL.test(r.text.trim())) return null
    if (r.role === 'assistant' && !/^\(called [^)]*\)$/.test(r.text.trim())) return r.text.trim() || null
  }
  return null
}

/** How long a session has waited: under a minute, minutes, hours, then days. */
export function waitFor(ms: number): string {
  const m = Math.floor(ms / 60_000)
  if (m < 1) return '<1m'
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`
}

type Row = { sessionId?: unknown; title?: unknown; isRunning?: unknown; isArchived?: unknown; lastActivityAt?: unknown; link?: unknown; startedBy?: unknown }
const str = (v: unknown) => (typeof v === 'string' ? v : '')
const textOf = (r: { content?: { type: string; text?: string }[] }) => (r.content ?? []).map(c => (c.type === 'text' ? c.text ?? '' : '')).join('\n')
const firstLine = (r: { content?: { type: string; text?: string }[] }) => clip(lines(textOf(r))[0] ?? 'the session server returned an error', 200)

// Each session's verdict, kept until its lastActivityAt moves, so an unchanged session is read once.
const verdicts = new Map<string, { at: string; ask: string | null }>()
let polling = false
let polled: { at: number; rows: Row[] } | undefined
/** The session list the last poll read, for other draws that need to know which sessions are alive. */
export const polledSessions = () => polled
/** Forgets the cached verdicts; session.start calls it so a restarted session reads each session afresh. */
export const resetNeeds = () => {
  verdicts.clear()
  polling = false
  polled = undefined
}

/** Reads the sessions, asks list_events only of idle ones whose activity time changed, and stores who waits on you. */
export async function loadNeeds($: E) {
  // Up to 30 transcripts are read one by one, so a slow poll must not overlap the next.
  if (polling) return
  polling = true
  try {
    await poll($)
  } catch {
    // A poll cut off mid-way (the session ending, say) leaves the last card standing.
  } finally {
    polling = false
  }
}

async function poll($: E) {
  let rows: Row[]
  try {
    const r = await $.mcp.call(SERVER, 'list_sessions', { limit: 60 })
    // A refusal (a permission denial, say) is said on the card, so the card never goes quiet for a reason you can fix.
    if (r.isError) return void (await update($, needsProblem, () => firstLine(r as never)))
    const parsed: unknown = JSON.parse(textOf(r as never))
    rows = Array.isArray(parsed) ? (parsed as Row[]) : []
    polled = { at: await $.clock.now(), rows }
  } catch {
    // No session server: this is not the desktop app, so the card stays hidden.
    await update($, needs, () => null)
    await update($, needsProblem, () => null)
    return
  }
  let problem: string | null = null
  const found: Need[] = []
  for (const s of rows) {
    const id = str(s.sessionId)
    const at = str(s.lastActivityAt)
    const since = Date.parse(at)
    if (!id || !Number.isFinite(since) || s.isRunning !== false || s.isArchived === true) continue
    let v = verdicts.get(id)
    if (!v || v.at !== at) {
      try {
        const r = await $.mcp.call(SERVER, 'list_events', { session_id: id, limit: 30 })
        if (r.isError) {
          problem ??= firstLine(r as never)
          continue
        }
        const reply = lastReply(textOf(r as never))
        v = { at, ask: reply ? askOf(reply) : null }
        verdicts.set(id, v)
      } catch {
        continue
      }
    }
    if (!v.ask) continue
    const title = str(s.title) || id
    found.push({
      id,
      title,
      kind: /(^|\s)HQ(:|$)/.test(title) && !title.startsWith('↳') ? 'hq' : str(s.startedBy) || title.startsWith('↳') ? 'child' : '',
      ...(str(s.startedBy) ? { parent: str(s.startedBy) } : {}),
      ask: v.ask,
      since,
      link: /^claude:\/\//.test(str(s.link)) ? str(s.link) : '',
    })
  }
  // A child with no startedBy nests under the one listed HQ its title prefix names ("↳ app: ..." under "app HQ: ...").
  for (const n of found) {
    if (n.kind !== 'child' || n.parent) continue
    const project = /^↳\s*([^:]+):/.exec(n.title)?.[1]?.trim()
    const hqs = project ? found.filter(x => x.kind === 'hq' && x.title.startsWith(`${project} HQ`)) : []
    if (hqs.length === 1) n.parent = hqs[0]!.id
  }
  // Sessions no longer listed drop out of the cache.
  const live = new Set(rows.map(r => str(r.sessionId)))
  for (const id of verdicts.keys()) if (!live.has(id)) verdicts.delete(id)
  await update($, needs, () => found)
  await update($, needsProblem, () => problem)
}

/** Money mentioned in a waiting ask, in dollars; no new persisted fields. */
export function needMoney(n: Pick<Need, 'title' | 'ask'>): number {
  const amounts = [...`${n.title} ${n.ask}`.matchAll(/\$([\d,]+(?:\.\d+)?)\s*([km])?\b/gi)]
  return Math.max(0, ...amounts.map(m => Number(m[1]!.replace(/,/g, '')) * (m[2]?.toLowerCase() === 'k' ? 1000 : m[2]?.toLowerCase() === 'm' ? 1_000_000 : 1)))
}

/** Strict money-first order, then oldest wait, even when a child outranks its parent. */
export function rankedNeeds(items: Need[]): { need: Need; depth: number }[] {
  return [...items].sort((a, b) => needMoney(b) - needMoney(a) || a.since - b.since || a.id.localeCompare(b.id))
    .map(need => ({ need, depth: 0 }))
}

/** Longest wait first; each session sits under its parent when that one is listed, at any depth. */
export function grouped(items: Need[]): { need: Need; depth: number }[] {
  const listed = new Set(items.map(x => x.id))
  const kids = (id: string) => items.filter(x => x.parent === id).sort((a, b) => a.since - b.since)
  const out: { need: Need; depth: number }[] = []
  const seen = new Set<string>()
  const walk = (n: Need, depth: number) => {
    if (seen.has(n.id)) return
    seen.add(n.id)
    out.push({ need: n, depth })
    kids(n.id).forEach(k => walk(k, depth + 1))
  }
  const byWait = (a: Need, b: Need) => a.since - b.since
  items.filter(x => !x.parent || !listed.has(x.parent)).sort(byWait).forEach(n => walk(n, 0))
  // A startedBy loop has no root: its oldest member leads it.
  items.filter(x => !seen.has(x.id)).sort(byWait).forEach(n => walk(n, 0))
  return out
}

export async function openSession($: E, n: Need) {
  if (n.link) await $.process.run(['open', n.link])
}
