// Blocker Ledger model: pure functions and the record shapes shared by the hook (ask-hook.mjs),
// the card (ElicitCard.tsx) and the board files (asks.json, answers.json, elicit-rules.json, elicit-log.json).
// No I/O and no clock reads here: callers pass `now`. Keep this file to erasable TypeScript (the hook imports it
// directly under Node's type stripping), and use no `.ts` extension imports.

export type Status = 'waiting' | 'answered' | 'auto' | 'defaulted' | 'cancelled'
export type AskClass = 'boolean' | 'enum' | 'text' | 'secret-like' | 'url'
export type Field = { type?: string; title?: string; description?: string; enum?: string[]; oneOf?: { const: string; title?: string }[]; default?: unknown; maxLength?: number }
export type Schema = { type?: string; properties?: Record<string, Field>; required?: string[] }
/** The Elicitation hook's stdin, as far as we use it. */
export type ElicitRequest = { mode?: string; message?: string; mcp_server_name?: string; requested_schema?: Schema; elicitation_id?: string; url?: string }
/** One row of asks.json (an array). `at` is a ms stamp; for the same id the newest `at` wins. */
export type Ask = {
  id: string; source: string; thread: string; message: string; schema: Schema
  askedAt: number; timeoutSec: number
  default?: Record<string, unknown>; safe?: boolean; neverAuto?: boolean
  status: Status; at: number
}
/** One row of answers.json (an array). Written by the card, /nextup answer and nextup-answer; read by the hook. */
export type Answer = { id: string; content: Record<string, unknown>; at: number; answeredBy: 'darren'; remember?: boolean; cancel?: boolean }
/** One row of elicit-rules.json. `shape` comes from shapeOf. */
export type Rule = { id: string; server: string; shape: string; value: Record<string, unknown>; createdAt: number; revoked?: boolean; at: number }
/** One row of elicit-log.json: an audit line per finished ask. */
export type LogRow = { id: string; source: string; message: string; status: Exclude<Status, 'waiting'>; answeredBy: 'darren' | 'rule' | 'timeout' | 'hook'; content?: Record<string, unknown>; waitedSec: number; ruleId?: string; at: number }

/** Words that make an ask never auto-answerable by a rule or a timeout default. */
export const NEVER_AUTO = /\b(deploy\w*|delet\w*|spen[dt]\w*|send\w*|sent|production|prod|merg\w*|push\w*|publish\w*|releas\w*|pay\w*|purchas\w*|buy\w*|transfer\w*|drop\w*|wipe\w*|destroy\w*|remov\w*|overwrit\w*|reset\w*|refund\w*|invoice\w*|email\w*)\b|[$€£¥]/i
/** Field names or titles that look like secrets. */
export const SECRET_LIKE = /key|token|password|passphrase|passcode|secret|credential|\bpin\b|\botp\b|cvv|\bssn\b/i
/** Default seconds a hook waits for Darren (20 minutes). */
export const DEFAULT_TIMEOUT_SEC = 20 * 60

/** Lowercase, collapse whitespace, replace digit runs with #, strip punctuation at the ends: so "Deploy 3 now?" and "deploy 4 now" match. */
export function normalize(message: string): string {
  return message.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim().replace(/^[^\p{L}\p{N}#]+|[^\p{L}\p{N}#]+$/gu, '').trim()
}
/** A stable string for a schema's shape, e.g. "enum:ship|hold" or "boolean:approve"; field names sorted. */
export function shapeOf(schema: Schema | undefined): string {
  return Object.entries(schema?.properties ?? {}).sort(([a], [b]) => a.localeCompare(b)).map(([name, field]) => {
    const options = optionsOf(field)
    return options.length ? `enum:${options.map(o => o.value).join('|')}` : `${field.type ?? 'unknown'}:${name}`
  }).join(';')
}
/** url when mode is url; secret-like when any field name or title matches SECRET_LIKE; boolean when every field is boolean; enum when every field is boolean or enum and at least one is enum; else text. */
export function classify(req: Pick<ElicitRequest, 'mode' | 'requested_schema'>): AskClass {
  if (req.mode === 'url') return 'url'
  const fields = Object.entries(req.requested_schema?.properties ?? {})
  if (fields.some(([name, field]) => SECRET_LIKE.test(name) || SECRET_LIKE.test(field.title ?? ''))) return 'secret-like'
  if (fields.length && fields.every(([, f]) => f.type === 'boolean')) return 'boolean'
  if (fields.length && fields.every(([, f]) => f.type === 'boolean' || optionsOf(f).length > 0)) return 'enum'
  return 'text'
}
/** Flat object, 1 to 3 fields, each boolean, enum/oneOf, or a string with maxLength absent or <= 280. Anything else is not answerable here (the card shows Open session). */
export function isAnswerable(schema: Schema | undefined): boolean {
  if (!schema || (schema.type !== undefined && schema.type !== 'object')) return false
  const fields = Object.values(schema.properties ?? {})
  return fields.length >= 1 && fields.length <= 3 && fields.every(f =>
    f.type === 'boolean' || ((f.type === undefined || f.type === 'string') && optionsOf(f).length > 0) ||
    (f.type === 'string' && !f.enum && !f.oneOf && (f.maxLength === undefined || (f.maxLength >= 0 && f.maxLength <= 280))))
}
/** True only for boolean or enum asks with a default and no never-auto word in the message and no neverAuto flag. Text, secret-like and url are never eligible. */
export function ruleEligible(ask: { message: string; schema: Schema; neverAuto?: boolean; default?: Record<string, unknown> }): boolean {
  const kind = classify({ requested_schema: ask.schema })
  return (kind === 'boolean' || kind === 'enum') && !ask.neverAuto && !NEVER_AUTO.test(ask.message) &&
    ask.default !== undefined && buildContent(ask.schema, ask.default) !== null
}
/** The newest rule (by `at`, per id) that is not revoked, whose id equals ruleId(server, message, schema) (server + normalised message + shape), whose value passes buildContent for the schema, and only when the ask is ruleEligible. Else undefined. */
export function matchRule(rules: Rule[], req: { server: string; message: string; schema: Schema; neverAuto?: boolean; default?: Record<string, unknown> }): Rule | undefined {
  if (!ruleEligible(req)) return undefined
  return latest(rules).filter(r => !r.revoked && r.server === req.server && r.shape === shapeOf(req.schema) &&
    r.id === ruleId(req.server, req.message, req.schema) && buildContent(req.schema, r.value) !== null).sort((a, b) => b.at - a.at)[0]
}
/** The rule id the card writes for "Always answer this way": `${server}|${shapeOf(schema)}|${normalize(message)}`. */
export function ruleId(server: string, message: string, schema: Schema): string {
  return `${server}|${shapeOf(schema)}|${normalize(message)}`
}
/** The MCP `content` for a picked value set, or null when it is not valid for the schema (enum value not in options, string over maxLength, required field missing). Booleans are coerced; strings trimmed. */
export function buildContent(schema: Schema, picked: Record<string, unknown>): Record<string, unknown> | null {
  if (!schema?.properties || !picked || typeof picked !== 'object' || Array.isArray(picked)) return null
  if (schema.required?.some(name => !Object.hasOwn(picked, name) || picked[name] === undefined)) return null
  const entries: [string, unknown][] = []
  for (const [name, field] of Object.entries(schema.properties)) {
    if (!Object.hasOwn(picked, name) || picked[name] === undefined) continue
    let value = picked[name]
    if (field.type === 'boolean') {
      if (typeof value === 'string') {
        const word = value.trim().toLowerCase()
        if (['true', '1', 'yes'].includes(word)) value = true
        else if (['false', '0', 'no', ''].includes(word)) value = false
        else return null
      } else if (typeof value === 'boolean' || value === 0 || value === 1) value = Boolean(value)
      else return null
    } else {
      if (typeof value !== 'string') return null
      value = value.trim()
      const options = optionsOf(field)
      if ((field.enum || field.oneOf) && !options.some(o => o.value === value)) return null
      if (!options.length && field.type !== 'string') return null
      if (field.maxLength !== undefined && (value as string).length > field.maxLength) return null
    }
    entries.push([name, value])
  }
  return Object.fromEntries(entries)
}
/** Options of an enum field in display order: the one equal to `recommended` first. Labels come from oneOf titles when present. */
export function optionsOf(field: Field, recommended?: unknown): { value: string; label: string; recommended: boolean }[] {
  return (field.oneOf?.map(o => ({ value: o.const, label: o.title ?? o.const })) ??
    field.enum?.map(value => ({ value, label: value })) ?? []).map(o => ({ ...o, recommended: o.value === recommended }))
    .sort((a, b) => Number(b.recommended) - Number(a.recommended))
}
/** Waiting asks only (newest `at` per id, status waiting, not past askedAt + timeoutSec), longest blocked first. */
export function sortQueue(asks: Ask[], now: number): Ask[] {
  return latest(asks).filter(a => a.status === 'waiting' && now < a.askedAt + a.timeoutSec * 1000).sort((a, b) => a.askedAt - b.askedAt)
}
/** The current rows of a log-like array: newest `at` per id. */
export function latest<T extends { id: string; at: number }>(rows: T[]): T[] {
  const current = new Map<string, T>()
  for (const row of rows) {
    if (!row || typeof row.id !== 'string' || !Number.isFinite(row.at)) continue
    const prev = current.get(row.id)
    if (!prev || row.at >= prev.at) current.set(row.id, row)
  }
  return [...current.values()]
}
/** Whole minutes blocked, at least 0. */
export function minutesBlocked(ask: Pick<Ask, 'askedAt'>, now: number): number {
  return Math.max(0, Math.floor((now - ask.askedAt) / 60000))
}
/** "Answered N for you while you slept, median wait Xs" inputs from the log since `dayStart` (ms): count of auto/defaulted/answered-by-rule rows and median waitedSec, 0 when none. */
export function sleptStats(log: LogRow[], dayStart: number): { answered: number; medianWaitSec: number } {
  const waits = latest(log).filter(r => r.at >= dayStart && (r.status === 'auto' || r.status === 'defaulted' || (r.status === 'answered' && r.answeredBy === 'rule'))).map(r => r.waitedSec).sort((a, b) => a - b)
  const n = waits.length
  return { answered: n, medianWaitSec: n ? (waits[Math.floor((n - 1) / 2)]! + waits[Math.floor(n / 2)]!) / 2 : 0 }
}
/** The wording for a finished ask's state line. defaulted: "Defaulted to <value> after N min"; cancelled: "Cancelled, thread is blocked"; auto: "Answered by rule: <value>". */
export function stateLine(row: LogRow, defaultMinutes?: number): string {
  const value = Object.values(row.content ?? {}).map(v => typeof v === 'string' ? v : JSON.stringify(v)).join(', ')
  if (row.status === 'defaulted') return `Defaulted to ${value} after ${defaultMinutes ?? Math.floor(row.waitedSec / 60)} min`
  if (row.status === 'cancelled') return 'Cancelled, thread is blocked'
  if (row.status === 'auto') return `Answered by rule: ${value}`
  return `Answered by ${row.answeredBy}: ${value}`
}
