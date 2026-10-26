import { readFile, writeFile, rename, mkdir, unlink, rmdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
// model.ts needs a Node with TypeScript stripping (22.18+ or 23.6+). It loads inside main() so an older Node fails
// into the cancel below, not into Claude's own prompt.
let classify, isAnswerable, matchRule, buildContent, ruleEligible, latest, NEVER_AUTO, DEFAULT_TIMEOUT_SEC

// The hook entry in hooks.json times out at 1320 s; stay under it so a late answer is never half-handled.
const MAX_TIMEOUT_SEC = 1300
const output = (action, content) => ({ hookSpecificOutput: { hookEventName: 'Elicitation', action, ...(action === 'accept' ? { content } : {}) } })
async function rows(board, file) {
  try {
    const value = JSON.parse(await readFile(join(board, file), 'utf8'))
    return Array.isArray(value) ? value : []
  } catch { return [] }
}
// Writers take a per-file lock (mkdir is atomic) so two hooks never lose each other's row.
async function withLock(board, file, work) {
  const lock = join(board, `.${file}.lock`)
  const until = Date.now() + 5000
  for (;;) {
    try { await mkdir(lock); break } catch (error) {
      if (error?.code !== 'EEXIST') break
      const age = await stat(lock).then(s => Date.now() - s.mtimeMs).catch(() => 0)
      if (age > 10000) await rmdir(lock).catch(() => {})
      else if (Date.now() > until) break
      else await sleep(25 + Math.random() * 50)
    }
  }
  try { return await work() } finally { await rmdir(lock).catch(() => {}) }
}
async function append(board, file, row) {
  await withLock(board, file, async () => {
    let data = []
    try {
      const value = JSON.parse(await readFile(join(board, file), 'utf8'))
      data = Array.isArray(value) ? value : []
    } catch (error) {
      // A missing file starts fresh. An unreadable one is kept aside, never wiped.
      if (error?.code !== 'ENOENT') await rename(join(board, file), join(board, `${file}.corrupt-${Date.now()}`)).catch(() => {})
    }
    data.push(row)
    const temp = join(board, `.${file}.${randomUUID()}.tmp`)
    try {
      await writeFile(temp, JSON.stringify(data) + '\n', { mode: 0o600 })
      await rename(temp, join(board, file))
    } finally { await unlink(temp).catch(() => {}) }
  })
}
let armed = false
async function main() {
  // Opt out: no output, so Claude shows its own prompt as if this hook were not installed.
  if (process.env.NEXTUP_ASK_OFF === '1') return null
  const location = process.env.NEXTUP_BOARD || process.env.CLAUDE_PLUGIN_OPTION_dataDir
  // No board: step aside so Claude shows its own prompt.
  if (!location) return null
  const board = location.replace(/^~(?=\/|$)/, homedir())
  // From here on the board is in use, so any failure must cancel the ask, never fall through to a prompt nobody may see.
  armed = true
  ;({ classify, isAnswerable, matchRule, buildContent, ruleEligible, latest, NEVER_AUTO, DEFAULT_TIMEOUT_SEC } = await import('./model.ts'))
  let input = ''
  for await (const chunk of process.stdin) input += chunk
  const req = JSON.parse(input)
  const source = req.mcp_server_name ?? 'unknown'
  const id = req.elicitation_id || randomUUID()
  const message = req.message ?? ''
  const schema = req.requested_schema ?? {}
  const askedAt = Date.now()
  const configured = Number(process.env.NEXTUP_ASK_TIMEOUT)
  const timeoutSec = process.env.NEXTUP_ASK_TIMEOUT !== undefined && Number.isFinite(configured) && configured >= 0 ? Math.min(configured, MAX_TIMEOUT_SEC) : DEFAULT_TIMEOUT_SEC
  const kind = classify(req)
  const wording = [message, ...Object.entries(schema.properties ?? {}).flatMap(([name, f]) => [name, f?.title ?? '', f?.description ?? '', ...(f?.enum ?? []).map(String), ...(f?.oneOf ?? []).map(o => `${o?.const ?? ''} ${o?.title ?? ''}`)])].join(' ')
  const neverAuto = NEVER_AUTO.test(wording) || !['boolean', 'enum'].includes(kind)
  const fields = Object.entries(schema.properties ?? {})
  const defaults = fields.length && fields.every(([, f]) => Object.hasOwn(f, 'default')) ? Object.fromEntries(fields.map(([name, f]) => [name, f.default])) : undefined
  const safe = ruleEligible({ message, schema, neverAuto, default: defaults })
  const ask = { id, source, thread: process.env.NEXTUP_THREAD ?? source, message, schema, askedAt, timeoutSec, default: defaults, safe, neverAuto, status: 'waiting', at: askedAt }
  await mkdir(board, { recursive: true })
  const log = async (status, answeredBy, content, ruleId) => {
    const at = Date.now()
    await append(board, 'elicit-log.json', { id, source, message, status, answeredBy, ...(content ? { content } : {}), waitedSec: Math.max(0, (at - askedAt) / 1000), ...(ruleId ? { ruleId } : {}), at })
  }
  if (req.mode === 'url') {
    // Browser prompts are visible in the ledger but never answered by the hook.
    await append(board, 'asks.json', { ...ask, status: 'cancelled', kind: 'browser', ...(req.url ? { url: req.url } : {}) })
    return output('decline')
  }
  if (kind === 'secret-like' || (!isAnswerable(schema) && !['boolean', 'enum'].includes(kind))) {
    await log('cancelled', 'hook')
    return output('cancel')
  }
  const rule = matchRule(await rows(board, 'elicit-rules.json'), { server: source, message, schema, neverAuto, default: defaults })
  if (rule) {
    const content = buildContent(schema, rule.value)
    await log('auto', 'rule', content, rule.id)
    return output('accept', content)
  }
  await append(board, 'asks.json', ask)
  const finish = async (status, answeredBy, content) => {
    await append(board, 'asks.json', { ...ask, status, at: Math.max(Date.now(), askedAt + 1) })
    await log(status, answeredBy, content)
    return content ? output('accept', content) : output('cancel')
  }
  const deadline = askedAt + timeoutSec * 1000
  while (Date.now() < deadline) {
    const answer = latest(await rows(board, 'answers.json')).find(row => row.id === id)
    // Reading the file can cross the deadline. Never consume a late answer.
    if (Date.now() >= deadline) break
    if (answer && answer.at >= askedAt && answer.at <= deadline) {
      const content = answer.cancel ? null : buildContent(schema, answer.content)
      return finish(content ? 'answered' : 'cancelled', 'darren', content)
    }
    await sleep(Math.min(500, Math.max(0, deadline - Date.now())))
  }
  const content = safe ? buildContent(schema, defaults) : null
  return finish(content ? 'defaulted' : 'cancelled', 'timeout', content)
}

let result
try { result = await main() } catch { result = armed ? output('cancel') : null }
process.stdout.on('error', () => { process.exitCode = 0 })
if (result) process.stdout.write(JSON.stringify(result) + '\n')
process.exitCode = 0
