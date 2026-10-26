/** The Reload plugins result as one short line set: counts, never session ids. */
export type ReloadReport = {
  version?: string
  already_current?: boolean
  reloaded?: string[]
  reloaded_by_app?: string[]
  pending_app_reload?: string[]
  needs_restart?: string[]
}

const list = (l?: string[]) => (Array.isArray(l) ? l : []).filter(id => typeof id === 'string')
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/**
 * What a reload may claim. `applied` is how many sessions the app's own log says reloaded since the press, or null when
 * the log could not be read. The helper's lists are what it sent; only the log says what landed.
 */
export function reloadMessage(r: ReloadReport, threads: { id: string; title?: string }[], applied: number | null = null): string {
  const pending = list(r.pending_app_reload).length
  const stuck = list(r.needs_restart)
  const rows = Array.isArray(threads) ? threads : []
  const titles = stuck.map(id => rows.find(t => t.id === id)?.title).filter((t): t is string => !!t)
  const named = titles.length ? `: ${titles.slice(0, 3).join(', ')}${stuck.length > Math.min(3, titles.length) ? ` +${stuck.length - Math.min(3, titles.length)} more` : ''}` : ''
  return [
    r.already_current ? 'Already current.' : r.version ? `Updated to ${r.version}.` : 'Updated.',
    applied === null ? 'Sent, not confirmed: the app log could not be read.'
      : applied > 0 ? `Reloaded ${plural(applied, 'session', 'sessions')}.`
      : 'Sent, not confirmed: no session has said it reloaded.',
    pending ? `The app is reloading ${pending} more.` : '',
    stuck.length ? `${plural(stuck.length, 'session still needs', 'sessions still need')} /reload-plugins typed${named}.` : '',
  ].filter(Boolean).join(' ')
}

export type ReloadState = { running: boolean; message: string; failed: boolean; at?: number }

const SHOW_MS = 10 * 60_000
const STUCK_MS = 5 * 60_000
const none = { running: false, message: '', failed: false }

/** What the card shows. `at` is when the run started (running) or finished; no `at` is old saved state and counts as expired. */
export function reloadView(s: ReloadState, now: number): { running: boolean; message: string; failed: boolean } {
  const at = typeof s.at === 'number' ? s.at : -Infinity
  if (s.running) return now - at <= STUCK_MS ? { running: true, message: s.message, failed: s.failed } : none
  return s.message && now - at <= SHOW_MS ? { running: false, message: s.message, failed: s.failed } : none
}
