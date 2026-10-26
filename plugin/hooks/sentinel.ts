import type { SentinelCard, SentinelRead } from '../types'

// The Sentinel strip: what the checker found, and how old that finding is.
// sentinel.py (in the data folder) writes sentinel.json (the cards) and sentinel-state.json ({t, status, version}).
// This file only reads them. It never writes either, and it never reports good news it cannot age.

export type Severity = SentinelCard['severity']
export type Card = SentinelCard
export type SentinelStatus = SentinelRead['status']

/** A state older than this means the checker has stopped; nothing it said last is current. */
export const STALE_MS = 15 * 60_000
const MIN = 60_000

const text = (v: unknown, d = '') => (typeof v === 'string' ? v : d)
const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d)
const SEVERITIES: Severity[] = ['P0', 'P1', 'P2']

function card(raw: unknown): Card | null {
  if (!raw || typeof raw !== 'object') return null
  const c = raw as Record<string, unknown>
  if (typeof c.id !== 'string' || !c.id || typeof c.title !== 'string' || !c.title) return null
  return {
    id: c.id, fp: text(c.fp), invariant: text(c.invariant),
    severity: SEVERITIES.includes(c.severity as Severity) ? (c.severity as Severity) : 'P2',
    title: c.title, summary: text(c.summary),
    evidence: Array.isArray(c.evidence) ? c.evidence.filter((x): x is string => typeof x === 'string') : [],
    firstSeen: text(c.firstSeen), lastSeen: text(c.lastSeen), count: num(c.count, 1), recurrence: num(c.recurrence, 0),
    state: text(c.state, 'open'), route: text(c.route, 'quick-fix'), routeWhy: text(c.routeWhy), prompt: text(c.prompt), fixHint: text(c.fixHint),
  }
}

/** The state's time as epoch ms: milliseconds, seconds or an ISO string; null when it is none of them. */
function stamp(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v < 1e11 ? Math.round(v * 1000) : v
  if (typeof v === 'string' && v) {
    const t = Date.parse(v)
    return Number.isFinite(t) ? t : null
  }
  return null
}
const statusOf = (v: unknown): SentinelStatus | null => (v === 'ok' || v === 'attention' || v === 'blind' || v === 'failing' ? v : null)

/** Reads the report and the state. `hasScript` is whether sentinel.py is in the data folder; a missing file is passed as null. */
export function parseSentinel(report: string | null, state: string | null, hasScript: boolean): SentinelRead {
  const out: SentinelRead = { installed: hasScript && state !== null, status: 'ok', cards: [], checkedAt: null, problem: null }
  if (!out.installed) return out
  let reportStatus: SentinelStatus | null = null
  if (report === null) out.problem = 'report'
  else {
    try {
      const v = JSON.parse(report) as { status?: unknown; cards?: unknown }
      if (!v || typeof v !== 'object' || !Array.isArray(v.cards)) throw new Error('shape')
      out.cards = v.cards.map(card).filter((c): c is Card => !!c)
      reportStatus = statusOf(v.status)
    } catch { out.problem = 'report' }
  }
  let stateStatus: SentinelStatus | null = null
  try {
    const v = JSON.parse(state ?? '') as { t?: unknown; status?: unknown }
    if (!v || typeof v !== 'object') throw new Error('shape')
    out.checkedAt = stamp(v.t)
    stateStatus = statusOf(v.status)
    if (out.checkedAt === null) throw new Error('no time')
  } catch { out.problem = out.problem ?? 'state' }
  const WORSE: SentinelStatus[] = ['ok', 'attention', 'blind', 'failing']
  out.status = [stateStatus, reportStatus].reduce<SentinelStatus>((w, x) => (x && WORSE.indexOf(x) > WORSE.indexOf(w) ? x : w), 'ok')
  return out
}

export type Tone = 'quiet' | 'warn' | 'fail'
export type StripView = { text: string; detail: string; tone: Tone; cards: Card[] }

const isOpen = (c: Card) => c.state === 'open' || c.state === 'reopened'
const RANK: Record<Severity, number> = { P0: 0, P1: 1, P2: 2 }
const hhmm = (at: number) => new Date(at).toTimeString().slice(0, 5)

/** How old, in words: minutes, then hours, then days. */
export function ageText(ms: number): string {
  const m = Math.max(0, Math.floor(ms / MIN))
  if (m < 60) return `${m} min ago`
  const h = Math.floor(m / 60)
  return h < 24 ? `${h} h ago` : `${Math.floor(h / 24)} d ago`
}

/** The one strip: unknown is never green, a stale check is amber with its time, and the cards stay while it is. */
export function stripView(r: SentinelRead, now: number): StripView {
  if (!r.installed) return { text: 'Sentinel not installed', detail: '', tone: 'quiet', cards: [] }
  const cards = r.cards.filter(isOpen).sort((a, b) => RANK[a.severity] - RANK[b.severity] || b.count - a.count)
  const n = cards.length
  const found = n ? `${n} ${n === 1 ? 'thing needs' : 'things need'} a look` : ''
  if (r.problem) return { text: r.problem === 'report' ? 'Sentinel report is unreadable' : 'Sentinel state is unreadable', detail: found, tone: 'fail', cards }
  const at = r.checkedAt!
  if (at > now + 2 * MIN) return { text: 'Sentinel state is unreadable', detail: found, tone: 'fail', cards }
  if (now - at > STALE_MS) return { text: `Sentinel has not checked since ${hhmm(at)}`, detail: n ? `${found} at the last check` : '', tone: 'warn', cards }
  if (r.status === 'failing') return { text: 'Sentinel itself is failing', detail: found, tone: 'fail', cards }
  if (r.status === 'blind') return { text: 'Not checked: Sentinel cannot see some of your data', detail: found, tone: 'warn', cards }
  if (n) return { text: found, detail: `checked ${ageText(now - at)}`, tone: cards.some(c => c.severity === 'P0') ? 'fail' : 'warn', cards }
  return { text: `All clear, checked ${ageText(now - at)}`, detail: '', tone: 'quiet', cards }
}

export type AgeLevel = 'ok' | 'amber' | 'red'

/** A store's age as a chip: amber past one interval, red past three, and the words change with the colour. */
export function ageChip(at: number | null, now: number, every: number, label = 'updated'): { text: string; level: AgeLevel } {
  if (at === null || !Number.isFinite(at)) return { text: 'age unknown', level: 'amber' }
  const age = Math.max(0, now - at)
  const base = `${label} ${ageText(age)}`
  if (age >= 3 * every) return { text: `${base}, out of date`, level: 'red' }
  if (age > every) return { text: `${base}, older than usual`, level: 'amber' }
  return { text: base, level: 'ok' }
}
