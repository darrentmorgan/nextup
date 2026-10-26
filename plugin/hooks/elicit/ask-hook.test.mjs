import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ruleId, shapeOf } from './model.ts'

const schema = { type: 'object', properties: { approve: { type: 'boolean', default: false } }, required: ['approve'] }
const request = { mode: 'form', mcp_server_name: 'probe', message: 'Approve?', elicitation_id: 'test', requested_schema: schema }
async function run(board, req = request, extra = {}, delayed) {
  const env = { ...process.env, NEXTUP_ASK_TIMEOUT: '1', ...extra }
  delete env.NEXTUP_BOARD
  delete env.CLAUDE_PLUGIN_OPTION_dataDir
  if (board) env.NEXTUP_BOARD = board
  const start = Date.now()
  const child = spawn(process.execPath, [new URL('./ask-hook.mjs', import.meta.url).pathname], { env, stdio: ['pipe', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''
  child.stdout.on('data', b => { stdout += b })
  child.stderr.on('data', b => { stderr += b })
  child.stdin.end(JSON.stringify(req))
  const timer = delayed ? setTimeout(() => { delayed().catch(() => {}) }, 1000) : undefined
  const watchdog = setTimeout(() => child.kill(), 6000)
  const code = await new Promise(resolve => child.on('close', resolve))
  clearTimeout(timer); clearTimeout(watchdog)
  assert.equal(code, 0, stderr)
  if (!stdout.trim()) return { action: 'none', elapsed: Date.now() - start }
  assert.equal(stdout.trim().split('\n').length, 1)
  const out = JSON.parse(stdout).hookSpecificOutput
  assert.equal(out.hookEventName, 'Elicitation')
  return { ...out, elapsed: Date.now() - start }
}
async function boardTest(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'elicit-'))
  try { await fn(dir) } finally { await rm(dir, { recursive: true, force: true }) }
}
const put = (dir, file, value) => writeFile(join(dir, file), JSON.stringify(value))
const logs = async dir => JSON.parse(await readFile(join(dir, 'elicit-log.json'), 'utf8'))

test('an answer older than the ask is ignored', () => boardTest(async dir => {
  await put(dir, 'answers.json', [{ id: 'test', content: { approve: true }, at: Date.now() - 5000, answeredBy: 'darren' }])
  const out = await run(dir)
  assert.equal(out.action, 'accept'); assert.deepEqual(out.content, { approve: false })
  assert.equal((await logs(dir))[0].answeredBy, 'timeout')
}))
test('answer written after the ask is accepted and audited', () => boardTest(async dir => {
  const out = await run(dir, request, { NEXTUP_ASK_TIMEOUT: '3' }, () => put(dir, 'answers.json', [{ id: 'test', content: { approve: true }, at: Date.now(), answeredBy: 'darren' }]))
  assert.equal(out.action, 'accept'); assert.deepEqual(out.content, { approve: true })
  assert.equal((await logs(dir))[0].answeredBy, 'darren')
}))
test('two concurrent asks both reach asks.json', () => boardTest(async dir => {
  await Promise.all([1, 2, 3, 4].map(n => run(dir, { ...request, elicitation_id: `c${n}` })))
  const ids = new Set(JSON.parse(await readFile(join(dir, 'asks.json'), 'utf8')).map(r => r.id))
  for (const n of [1, 2, 3, 4]) assert.ok(ids.has(`c${n}`))
  assert.equal((await logs(dir)).length, 4)
}))
test('a corrupt asks.json is kept aside, not wiped', () => boardTest(async dir => {
  await writeFile(join(dir, 'asks.json'), '{bad')
  await run(dir)
  const { readdir } = await import('node:fs/promises')
  assert.ok((await readdir(dir)).some(f => f.startsWith('asks.json.corrupt-')))
}))
for (const message of ['Deleting the old branch?', 'Merge the PR?', 'Publish the release?', 'Pay $5?']) {
  test(`risky wording never defaults: ${message}`, () => boardTest(async dir => {
    assert.equal((await run(dir, { ...request, message })).action, 'cancel')
  }))
}
test('a risky field title never defaults', () => boardTest(async dir => {
  const requested_schema = { type: 'object', properties: { go: { type: 'boolean', title: 'Deploy now', default: true } } }
  assert.equal((await run(dir, { ...request, requested_schema })).action, 'cancel')
}))
test('passphrase field cancels immediately', () => boardTest(async dir => {
  const out = await run(dir, { ...request, requested_schema: { properties: { passphrase: { type: 'string' } } } })
  assert.equal(out.action, 'cancel'); assert.ok(out.elapsed < 1000)
}))
test('saved rule answers in under a second', () => boardTest(async dir => {
  await put(dir, 'elicit-rules.json', [{ id: ruleId('probe', request.message, schema), server: 'probe', shape: shapeOf(schema), value: { approve: true }, createdAt: 1, at: 1 }])
  const out = await run(dir)
  assert.equal(out.action, 'accept'); assert.ok(out.elapsed < 1000)
  assert.equal((await logs(dir))[0].answeredBy, 'rule')
}))
test('url declines immediately and records browser ask', () => boardTest(async dir => {
  const out = await run(dir, { ...request, mode: 'url', url: 'https://example.com' })
  assert.equal(out.action, 'decline'); assert.ok(out.elapsed < 1000)
  const rows = JSON.parse(await readFile(join(dir, 'asks.json'), 'utf8'))
  assert.equal(rows[0].kind, 'browser'); assert.equal(rows[0].url, 'https://example.com')
}))
test('safe boolean defaults after a second', () => boardTest(async dir => {
  const out = await run(dir)
  assert.equal(out.action, 'accept'); assert.deepEqual(out.content, { approve: false }); assert.ok(out.elapsed >= 1000)
  assert.equal((await logs(dir))[0].status, 'defaulted')
}))
for (const [name, requested_schema] of [['text', { type: 'object', properties: { answer: { type: 'string' } } }], ['no default', { type: 'object', properties: { approve: { type: 'boolean' } } }]]) {
  test(`${name} times out with cancel`, () => boardTest(async dir => {
    assert.equal((await run(dir, { ...request, requested_schema })).action, 'cancel')
    assert.equal((await logs(dir))[0].answeredBy, 'timeout')
  }))
}
test('corrupt board files do not crash', () => boardTest(async dir => {
  for (const file of ['asks.json', 'answers.json', 'elicit-rules.json']) await writeFile(join(dir, file), '{bad')
  const out = await run(dir)
  assert.ok(['accept', 'cancel'].includes(out.action))
}))
test('secret field cancels immediately', () => boardTest(async dir => {
  const out = await run(dir, { ...request, requested_schema: { properties: { api_key: { type: 'string' } } } })
  assert.equal(out.action, 'cancel'); assert.ok(out.elapsed < 1000)
  assert.equal((await logs(dir))[0].answeredBy, 'hook')
}))
test('answer arriving after one second is accepted', () => boardTest(async dir => {
  const out = await run(dir, request, { NEXTUP_ASK_TIMEOUT: '3' }, () => put(dir, 'answers.json', [{ id: 'test', content: { approve: true }, at: Date.now(), answeredBy: 'darren' }]))
  assert.equal(out.action, 'accept'); assert.deepEqual(out.content, { approve: true })
}))
test('invalid answer cancels', () => boardTest(async dir => {
  assert.equal((await run(dir, request, { NEXTUP_ASK_TIMEOUT: '3' }, () => put(dir, 'answers.json', [{ id: 'test', content: {}, at: Date.now() }]))).action, 'cancel')
}))
test('missing board steps aside so Claude shows its own prompt', async () => { assert.equal((await run(null)).action, 'none') })
test('newest answer wins and explicit cancellation is audited', () => boardTest(async dir => {
  const t = Date.now()
  assert.equal((await run(dir, request, { NEXTUP_ASK_TIMEOUT: '3' }, () => put(dir, 'answers.json', [{ id: 'test', content: { approve: true }, at: t + 900 }, { id: 'test', content: {}, cancel: true, at: t + 1000 }]))).action, 'cancel')
  assert.equal((await logs(dir))[0].answeredBy, 'darren')
  const asks = JSON.parse(await readFile(join(dir, 'asks.json'), 'utf8'))
  assert.equal(asks.at(-1).status, 'cancelled')
  assert.ok(asks.at(-1).at > asks[0].at)
}))
test('never-auto message cancels rather than using a default', () => boardTest(async dir => {
  assert.equal((await run(dir, { ...request, message: 'Deploy to production?' })).action, 'cancel')
  assert.equal((await logs(dir))[0].status, 'cancelled')
}))
test('unsupported schema cancels immediately', () => boardTest(async dir => {
  const out = await run(dir, { ...request, requested_schema: { type: 'object', properties: { count: { type: 'number' } } } })
  assert.equal(out.action, 'cancel'); assert.ok(out.elapsed < 1000)
}))
test('answer timestamp after deadline is discarded', () => boardTest(async dir => {
  await put(dir, 'answers.json', [{ id: 'test', content: { approve: true }, at: Date.now() + 60000 }])
  const out = await run(dir)
  assert.equal(out.action, 'accept'); assert.deepEqual(out.content, { approve: false })
  assert.equal((await logs(dir))[0].answeredBy, 'timeout')
}))

test('NEXTUP_ASK_OFF=1 prints nothing so Claude shows its own prompt', async () => {
  const env = { ...process.env, NEXTUP_ASK_OFF: '1' }
  const child = spawn(process.execPath, [new URL('./ask-hook.mjs', import.meta.url).pathname], { env, stdio: ['pipe', 'pipe', 'pipe'] })
  let stdout = ''
  child.stdout.on('data', b => { stdout += b })
  child.stdin.end(JSON.stringify(request))
  const code = await new Promise(resolve => child.on('close', resolve))
  assert.equal(code, 0)
  assert.equal(stdout, '')
})

test('unreadable request cancels rather than falling through to Claude', () => boardTest(async dir => {
  const env = { ...process.env, NEXTUP_BOARD: dir }
  const child = spawn(process.execPath, [new URL('./ask-hook.mjs', import.meta.url).pathname], { env, stdio: ['pipe', 'pipe', 'pipe'] })
  let stdout = ''
  child.stdout.on('data', b => { stdout += b })
  child.stdin.end('{not json')
  assert.equal(await new Promise(resolve => child.on('close', resolve)), 0)
  assert.equal(JSON.parse(stdout).hookSpecificOutput.action, 'cancel')
}))
test('a node that cannot load the model cancels rather than falling through', () => boardTest(async dir => {
  const { copyFile } = await import('node:fs/promises')
  const lone = join(dir, 'lone'); const { mkdir } = await import('node:fs/promises'); await mkdir(lone)
  await copyFile(new URL('./ask-hook.mjs', import.meta.url).pathname, join(lone, 'ask-hook.mjs'))
  const env = { ...process.env, NEXTUP_BOARD: dir }
  const child = spawn(process.execPath, [join(lone, 'ask-hook.mjs')], { env, stdio: ['pipe', 'pipe', 'pipe'] })
  let stdout = ''
  child.stdout.on('data', b => { stdout += b })
  child.stdin.end(JSON.stringify(request))
  assert.equal(await new Promise(resolve => child.on('close', resolve)), 0)
  assert.equal(JSON.parse(stdout).hookSpecificOutput.action, 'cancel')
}))
