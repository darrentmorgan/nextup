// Who is already on a thread. A thread with a live delegated or working session is not a to-do:
// it waits under "Being worked on" until that session finishes (review) or goes quiet (stalled).
import type { Thread } from '../types'

/** A delegated session with no activity for this long is stalled and comes back once as "Stalled: <title>". */
export const STALL_MS = 6 * 3600_000

export type SessionRow = { sessionId?: unknown; title?: unknown; firstPrompt?: unknown; isRunning?: unknown; isArchived?: unknown; lastActivityAt?: unknown; createdAt?: unknown }
export type Launch = { id: string; at: number }
export type Work = 'free' | 'working' | 'review' | 'stalled'

const stamp = (v: unknown) => typeof v === 'number' ? v : typeof v === 'string' ? Date.parse(v) : NaN
const norm = (v: unknown) => typeof v === 'string' ? v.replace(/[^\p{L}\p{N}]+/gu, ' ').trim().toLowerCase() : ''
export const sessionToken = (id: string) => `nu-${id.slice(0, 8)}`

/** The one session created after the launch that carries the thread's tag or title; ambiguity is no match. */
export function childOf(t: Thread, launch: Launch, rows: SessionRow[], now: number): SessionRow | undefined {
  const title = norm(t.title)
  const token = ` ${norm(sessionToken(t.id))} `
  const hit = rows.filter(r => {
    if (typeof r.sessionId !== 'string' || !/^[\w-]+$/.test(r.sessionId)) return false
    const created = stamp(r.createdAt ?? r.lastActivityAt)
    return Number.isFinite(created) && created >= launch.at && created <= now
      && [r.title, r.firstPrompt].some(v => { const n = ` ${norm(v)} `; return n.includes(token) || (!!title && n.includes(` ${title} `)) })
  })
  return hit.length === 1 ? hit[0] : undefined
}

const quiet = (r: SessionRow, now: number) => {
  const at = stamp(r.lastActivityAt ?? r.createdAt)
  return !Number.isFinite(at) || now - at >= STALL_MS
}

/**
 * working: a live session is on it, so it is not a to-do. review: the delegated session ended.
 * stalled: the session (or an unseen launch) has been quiet for STALL_MS. free: nothing is on it.
 * `rows` are the live session rows; the thread's own session id is `local_<thread id>` in the desktop app.
 */
export function workOf(t: Thread, launch: Launch | undefined, rows: SessionRow[], now: number): Work {
  const own = rows.find(r => r.sessionId === `local_${t.id}` || r.sessionId === t.id)
  const lastCheck = Date.parse(t.last)
  const ownLive = !!own && own.isArchived !== true && own.isRunning === true && !quiet(own, now)
  // A session worked on it since the board last looked at it.
  const ownSince = !!own && own.isArchived !== true && !quiet(own, now) && Number.isFinite(lastCheck) && stamp(own.lastActivityAt) > lastCheck
  if (!launch) return ownLive || ownSince ? 'working' : 'free'
  const child = childOf(t, launch, rows, now)
  if (child) {
    if (child.isRunning !== false && child.isArchived !== true) return quiet(child, now) ? 'stalled' : 'working'
    return ownLive ? 'working' : 'review'
  }
  if (ownLive || ownSince) return 'working'
  return now - launch.at >= STALL_MS ? 'stalled' : 'working'
}

/** Identifies one stall: it changes when the launch or any session on the thread has new activity. */
export function stallKey(t: Thread, launch: Launch | undefined, rows: SessionRow[], now: number): number {
  const own = rows.find(r => r.sessionId === `local_${t.id}` || r.sessionId === t.id)
  const child = launch ? childOf(t, launch, rows, now) : undefined
  const at = (r?: SessionRow) => { const v = stamp(r?.lastActivityAt ?? r?.createdAt); return Number.isFinite(v) ? v : 0 }
  return Math.max(launch?.at ?? 0, at(own), at(child))
}
