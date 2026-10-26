// Reads the Claude desktop app's main.log for proof of what it did after a press.
// A press that exits 0 proves a command ran; only the app's own log says whether the session opened or reloaded.

const LINE = /^(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d) /

/** A log line's local time as epoch ms; null when the line has none. */
export function logTime(line: string): number | null {
  const m = LINE.exec(line)
  if (!m) return null
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number) as [number, number, number, number, number, number]
  const at = new Date(y, mo - 1, d, h, mi, s)
  // A date the calendar rolled over (month 13) is not a time.
  return at.getFullYear() === y && at.getMonth() === mo - 1 && at.getDate() === d && at.getHours() === h ? at.getTime() : null
}

/** Epoch ms as the log writes it, local time. */
export function stampOf(at: number): string {
  const d = new Date(at)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

const lines = (log: string) => log.split('\n')
// The log keeps whole seconds, so a line written in the second of the press counts as after it.
const wholeSecond = (at: number) => Math.floor(at / 1000) * 1000

/** True when the app logged transcript_missing for this session at or after `since` (the press). */
export function missingSince(log: string, id: string, since: number): boolean {
  since = wholeSecond(since)
  return lines(log).some(l => {
    const t = logTime(l)
    return t !== null && t >= since && l.includes('transcript_missing') && l.includes(`'${id}'`)
  })
}

/** How many distinct sessions the app says it reloaded cleanly at or after `since`. */
export function appliedSince(log: string, since: number): number {
  since = wholeSecond(since)
  const ids = new Set<string>()
  for (const l of lines(log)) {
    const t = logTime(l)
    if (t === null || t < since) continue
    const m = /reload_plugins applied for (local_[\w-]+): .*?(\d+) plugin error\(s\)/.exec(l)
    if (m && m[2] === '0') ids.add(m[1]!)
  }
  return ids.size
}
