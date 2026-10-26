import type { Board, Marks, Thread } from '../types'
import { doneBetween } from './marks'
import { threadRow } from './rowtext'

export const WIN_GOAL = 5
const positive = (v: number | null) => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0

/** Completion marks are evidence of wins, never a time sheet or revenue ledger. */
export function momentumStats(b: Board, m: Marks, todo: Thread[], now: number, heroId?: string) {
  const midnight = new Date(now).setHours(0, 0, 0, 0)
  const wins = doneBetween(m, midnight, now)
  const week = new Date(midnight)
  week.setDate(week.getDate() - ((week.getDay() + 6) % 7))
  const items = [...b.threads, ...b.notes]
  const marked = doneBetween(m, week.getTime(), now).map(x => items.find(t => t.id === x.id))
  const completed = marked.filter(x => !!x)
  const parts = [0, 0, 0]
  for (const win of wins) {
    const hour = new Date(win.at).getHours()
    parts[hour < 12 ? 0 : hour < 18 ? 1 : 2]!++
  }
  const start = new Date(now).setHours(8, 0, 0, 0)
  const lastWin = Math.max(start, ...wins.map(x => x.at))
  const stalled = now - lastWin >= 90 * 60_000
  const eligible = todo.filter(t => !m[t.id]?.done && typeof t.minutes === 'number' && t.minutes > 0 && Number.isFinite(t.minutes))
  const alternatives = eligible.filter(t => t.id !== heroId)
  const rescue = stalled ? [...(alternatives.length ? alternatives : eligible)]
    .sort((a, b) => a.minutes! - b.minutes! || a.id.localeCompare(b.id))[0] : undefined
  const points = completed.reduce((n, t) => n + ('value' in t ? positive(t.value) : 0), 0)
  const minutes = completed.reduce((n, t) => n + positive(t.minutes), 0)
  const remaining = todo.filter(t => !m[t.id]?.done)
  const pointTotal = points + remaining.reduce((n, t) => n + positive(t.value), 0)
  const minuteTotal = minutes + remaining.reduce((n, t) => n + positive(t.minutes), 0)
  const hero = b.threads.find(t => t.id === heroId)
  return {
    hero: hero ? threadRow(hero) : undefined,
    missingItems: marked.length - completed.length,
    unknownValues: completed.filter(t => !('value' in t) || t.value === null || !Number.isFinite(t.value) || t.value < 0).length,
    pointFraction: pointTotal ? points / pointTotal : 0,
    hourFraction: minuteTotal ? minutes / minuteTotal : 0,
    wins: wins.length, parts,
    points,
    hours: minutes / 60,
    unknownEstimates: completed.filter(t => t.minutes === null || !Number.isFinite(t.minutes) || t.minutes < 0).length,
    rescue: rescue ? threadRow(rescue) : undefined,
  }
}

/** A fixed accent stroke with no baked-in text or background. */
export function winsRing(wins: number) {
  const fraction = Math.min(1, Math.max(0, wins / WIN_GOAL))
  return `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><circle cx="32" cy="32" r="26" fill="none" stroke="rgba(128,128,128,0.22)" stroke-width="7"/><circle cx="32" cy="32" r="26" fill="none" stroke="#4cc3c8" stroke-width="7" stroke-linecap="round" stroke-dasharray="${fraction * 164} 164" transform="rotate(-90 32 32)"/></svg>`
}
