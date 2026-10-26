import type { EngineInterface } from 'claude-code'
import type { Ask, Answer, Rule, LogRow } from './model'
import { buildContent, latest, ruleEligible, ruleId, shapeOf, sortQueue } from './model'
import { choicesOf, initialValues } from './ElicitCard'

type E = EngineInterface
export async function readRows<T>($: E, dir: string, name: string): Promise<T[]> {
  if (!dir) return []
  try {
    const path = `${dir}/${name}.json`
    if (!await $.fs.exists(path)) return []
    const rows: unknown = JSON.parse(await $.fs.read(path) as string)
    return Array.isArray(rows) ? rows.filter(row => row && typeof row === 'object' && typeof row.id === 'string' && typeof row.at === 'number') as T[] : []
  } catch { return [] }
}
// The engine's fs has no lock or rename, so another writer (the helper, another pane) can overwrite between our read and
// write. Read back after writing and retry until the row is there; the helper takes a lock that narrows the window further.
async function append<T extends { id: string; at: number }>($: E, dir: string, name: string, row: T) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const rows = await readRows<T>($, dir, name)
    await $.fs.write(`${dir}/${name}.json`, JSON.stringify([...rows, row]))
    if ((await readRows<T>($, dir, name)).some(r => r.id === row.id && r.at === row.at)) return
  }
  throw new Error('Could not save the answer; try again.')
}
export async function readLedger($: E, dir: string) {
  const [asks, answers, rules, log] = await Promise.all([
    readRows<Ask>($, dir, 'asks'), readRows<Answer>($, dir, 'answers'), readRows<Rule>($, dir, 'elicit-rules'), readRows<LogRow>($, dir, 'elicit-log'),
  ])
  return { asks, answers, rules, log }
}
export async function sendAnswer($: E, dir: string, ask: Ask, picked: Record<string, unknown>, remember = false, cancel = false) {
  if (!dir) throw new Error('No data folder set.')
  const content = cancel ? {} : buildContent(ask.schema, picked)
  if (!content) throw new Error('Choose a valid answer for every required field.')
  const at = await $.clock.now()
  const saveRule = !cancel && remember && ruleEligible(ask)
  const row: Answer = { id: ask.id, content, at, answeredBy: 'darren', remember: saveRule, ...(cancel ? { cancel: true } : {}) }
  // Save the rule first: a failed rule write must not consume the waiting question.
  if (saveRule) await append<Rule>($, dir, 'elicit-rules', { id: ruleId(ask.source, ask.message, ask.schema), server: ask.source, shape: shapeOf(ask.schema), value: content, createdAt: at, at })
  await append($, dir, 'answers', row)
}
export async function revokeRule($: E, dir: string, id: string) {
  const rule = latest(await readRows<Rule>($, dir, 'elicit-rules')).find(r => r.id === id)
  if (!rule || rule.revoked) return
  await append($, dir, 'elicit-rules', { ...rule, revoked: true, at: Math.max(await $.clock.now(), rule.at + 1) })
}
export async function waitingAsks($: E, dir: string) {
  const ledger = await readLedger($, dir)
  const queue = sortQueue(ledger.asks, await $.clock.now())
  // An answer counts only if it is newer than the ask, so a reused id never hides a new question.
  return queue.filter(a => !ledger.answers.some(r => r.id === a.id && r.at >= a.askedAt))
}
export async function askCommand($: E, dir: string, args?: string) {
  if (!dir) return { text: 'Next up has no data folder set.' }
  const queue = await waitingAsks($, dir)
  if (args === undefined) return { text: queue.map(a => `${a.id}: ${a.thread}: ${a.message}\n${Object.entries(a.schema?.properties ?? {}).map(([name, f]) => `${name}: ${choicesOf(f, a.default?.[name] ?? f.default).map(o => `${o.value}${o.recommended ? ' (Recommended)' : ''}`).join(', ') || 'text'}`).join('\n')}`).join('\n') || 'No questions waiting.' }
  const match = args.trim().match(/^(\S+)\s+([\s\S]+)$/)
  if (!match) return { text: 'Usage: nextup-answer <id> <choice>' }
  const ask = queue.find(a => a.id === match[1])
  if (!ask) return { text: 'No waiting question with that id.' }
  const fields = Object.keys(ask.schema?.properties ?? {})
  let picked: Record<string, unknown>
  if (fields.length === 1) picked = { ...initialValues(ask), [fields[0]!]: match[2] }
  else {
    try { picked = JSON.parse(match[2]!) as Record<string, unknown> } catch { return { text: 'For multiple fields, supply a JSON object as the choice.' } }
  }
  try { await sendAnswer($, dir, ask, picked); return { text: `Answered ${ask.id}.` } }
  catch (error) { return { text: error instanceof Error ? error.message : 'Could not save answer.' } }
}
