import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

// The shapes the card draws live in the state contract (types/index.d.ts): the last read is kept in state.
import type { Attention, AttentionRead, Counts, Ratings, Recent } from '../types'
export type { Attention, AttentionRead, Counts, Ratings, Recent }
export const ATTENTION_MS = 60_000
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const list = (v: unknown) => Array.isArray(v) ? v.filter(object) : []
const number = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0
const isDay = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d\d-\d\d$/.test(v) && Number.isFinite(Date.parse(`${v}T00:00:00Z`))
const counts = (v: Record<string, unknown>): v is Record<string, unknown> & Counts => isDay(v.day) && ['a', 'b', 'c', 'd', 'total', 'blocked_wait_min'].every(k => number(v[k]))

export function parseAttention(raw: unknown): Attention | null {
  if (!object(raw)) return null
  const totals = list(raw.totals).filter(counts).sort((a, b) => a.day.localeCompare(b.day))
  const today = totals[totals.length - 1]?.day
  if (!today) return null
  const projects = list(raw.projects).filter(p => typeof p.project === 'string')
  return {
    today, totals,
    trials: projects.filter(p => p.trial === true).map(p => p.project as string),
    projects: projects.flatMap(p => {
      const c = list(p.days).filter(counts).find(d => d.day === today)
      return c && c.total > 0 ? [{ project: p.project as string, trial: p.trial === true, counts: c }] : []
    }).sort((a, b) => Number(b.trial) - Number(a.trial) || a.project.localeCompare(b.project)),
    recent: list(raw.recent).filter(r => typeof r.id === 'string' && typeof r.project === 'string' && typeof r.ts === 'string' && Number.isFinite(Date.parse(r.ts)) && isDay(r.day) && ['a', 'b', 'c', 'd'].includes(String(r.cls)) && typeof r.summary === 'string' && number(r.wait_min))
      .map(r => r as unknown as Recent).sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts)),
  }
}

export const projectFlag = (c: Counts) => c.total > 3 || (c.total > 0 && (c.a + c.b) / c.total < 0.9)

function parseRatings(raw: unknown): Ratings {
  if (!object(raw) || Object.values(raw).some(v => !object(v) || !['worth', 'not'].includes(String(v.rating)) || typeof v.at !== 'string' || !Number.isFinite(Date.parse(v.at)))) throw new Error('Ratings unreadable')
  return raw as Ratings
}

export function mergeRatings(a: Ratings, b: Ratings): Ratings {
  const result = { ...a }
  for (const [id, value] of Object.entries(b)) {
    if (!Object.hasOwn(result, id) || Date.parse(value.at) >= Date.parse(result[id]!.at)) {
      Object.defineProperty(result, id, { value, enumerable: true, configurable: true, writable: true })
    }
  }
  return result
}

// What the card draws lives in state, so a write redraws it on its own and a hot reload keeps it.
const attentionAtom = atom({ plugin: 'nextup', key: 'attention' } as const, null)
/** Session-local coordination only: a read in flight (kept until state holds it) and the rating writes queue. */
export const createAttention = () => ({ pending: Promise.resolve() as Promise<void>, loading: null as { dir: string; promise: Promise<AttentionRead> } | null })
type State = ReturnType<typeof createAttention>
async function readRatings($: EngineInterface, dir: string): Promise<Ratings> {
  return await $.fs.exists(`${dir}/interruption-ratings.json`) ? parseRatings(JSON.parse(await $.fs.read(`${dir}/interruption-ratings.json`) as string)) : {}
}
const fresh = (r: AttentionRead | null, dir: string, now: number): r is AttentionRead => r?.dir === dir && now - r.at < ATTENTION_MS

/** For a drawing: the read in state while it is under a minute old, else a new one (shared by overlapping draws).
 * A drawing cannot write state, so the clock stores the new read; until then later draws reuse it.
 */
export async function drawnAttention($: EngineInterface, state: State, dir: string) {
  if (!dir) return null
  const now = await $.clock.now().catch(() => Date.now())
  const held = await read($, attentionAtom)
  if (fresh(held, dir, now)) return held
  if (state.loading?.dir === dir) return state.loading.promise
  const promise = readAttention($, dir, now)
  state.loading = { dir, promise }
  $.clock.after(0, async () => {
    try { await store($, state, dir, promise) } catch { /* The next draw reads again. */ }
  })
  return promise
}

/** For the live loop: reread when the read in state is a minute old, and store it. */
export async function refreshAttention($: EngineInterface, state: State, dir: string) {
  if (!dir) return
  const now = await $.clock.now().catch(() => Date.now())
  if (fresh(await read($, attentionAtom), dir, now)) return
  if (state.loading?.dir === dir) return store($, state, dir, state.loading.promise)
  const promise = readAttention($, dir, now)
  state.loading = { dir, promise }
  await store($, state, dir, promise)
}

async function store($: EngineInterface, state: State, dir: string, promise: Promise<AttentionRead>) {
  try {
    const next = await promise
    // A rating saved meanwhile is newer than this read: keep it.
    await update($, attentionAtom, held => held?.dir === dir && held.at >= next.at ? held : next)
  } finally {
    if (state.loading?.promise === promise) state.loading = null
  }
}

async function readAttention($: EngineInterface, dir: string, now: number): Promise<AttentionRead> {
  let data: Attention | null = null
  let ratings: Ratings = {}
  try { data = parseAttention(JSON.parse(await $.fs.read(`${dir}/interruptions.json`) as string)) } catch { /* Missing or invalid input hides the card. */ }
  if (data) { try { ratings = await readRatings($, dir) } catch { /* A rating action reports unreadable ratings without overwriting them. */ } }
  return { dir, at: now, data, ratings }
}
async function ratingStamp($: EngineInterface, dir: string) {
  const path = `${dir}/interruption-ratings.json`
  if (!(await $.fs.exists(path))) return null
  const stat = await $.fs.stat(path)
  return `${stat.mtimeMs}:${stat.size}`
}
/** Reread on a concurrent file change; refuse a busy file instead of overwriting unseen ids.
 * The engine has no atomic rename or cross-process transaction, so this is optimistic concurrency.
 */
export function rateAttention($: EngineInterface, state: State, dir: string, id: string, rating: 'worth' | 'not') {
  const run = state.pending.then(async () => {
    const at = new Date(await $.clock.now()).toISOString()
    for (let attempt = 0; attempt < 3; attempt++) {
      // The read the card drew: in state, or one a drawing has not stored yet.
      const held = await read($, attentionAtom)
      const base = held?.dir === dir ? held : state.loading?.dir === dir ? await state.loading.promise : null
      const before = await ratingStamp($, dir)
      const disk = await readRatings($, dir)
      const ratings = mergeRatings(mergeRatings(base?.ratings ?? {}, disk), { [id]: { rating, at } })
      if (before !== await ratingStamp($, dir)) continue
      await $.fs.write(`${dir}/interruption-ratings.json`, JSON.stringify(ratings, null, 2))
      if (base) await update($, attentionAtom, () => ({ ...base, ratings }))
      return
    }
    throw new Error('Ratings changed repeatedly; try again')
  })
  state.pending = run.catch(() => undefined)
  return run
}

/** Fourteen calendar days ending at the newest totals day, filling gaps with zero. */
export function attentionSparkline(data: Attention): string {
  const end = Date.parse(`${data.today}T00:00:00Z`)
  const values = Array.from({ length: 14 }, (_, i) => {
    const day = new Date(end - (13 - i) * 86_400_000).toISOString().slice(0, 10)
    return data.totals.find(d => d.day === day)?.total ?? 0
  })
  const max = Math.max(1, ...values)
  return values.map(n => '▁▂▃▄▅▆▇█'[Math.round(n / max * 7)]).join('')
}
