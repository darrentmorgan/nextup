import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const fixtures = fileURLToPath(new URL('./fixtures/', import.meta.url))
const fixture = async name => JSON.parse(await readFile(join(fixtures, `permission-${name}.json`), 'utf8'))
const request = await fixture('request')
async function sandbox(fn) {
  const dir = await mkdtemp(join(fixtures, 'permission-temp-'))
  try { await fn(dir) } finally { await rm(dir, { recursive: true, force: true }) }
}
async function run(board, input = request, extra = {}) {
  const env = { ...process.env }
  for (const key of ['NEXTUP_BOARD', 'CLAUDE_PLUGIN_OPTION_dataDir', 'CLAUDE_PLUGIN_DATA']) delete env[key]
  if (board) env.CLAUDE_PLUGIN_OPTION_dataDir = board
  Object.assign(env, extra)
  const child = spawn(process.execPath, [fileURLToPath(new URL('./permission-wait.mjs', import.meta.url))], { env, stdio: ['pipe', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  const closed = new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve) })
  const watchdog = setTimeout(() => child.kill(), 5000)
  child.stdin.end(typeof input === 'string' ? input : JSON.stringify(input))
  try { assert.equal(await closed, 0) } finally { clearTimeout(watchdog) }
  assert.equal(stdout, '')
  assert.equal(stderr, '')
}
async function records(dir) {
  const folder = join(dir, 'permission-wait')
  const names = await readdir(folder).catch(error => { if (error.code === 'ENOENT') return []; throw error })
  assert.ok(names.every(name => /^[a-f0-9]{64}\.json$/.test(name)), 'only complete per-session JSON remains')
  return Promise.all(names.map(async name => JSON.parse(await readFile(join(folder, name), 'utf8'))))
}

test('PermissionRequest records only session, waiting status and current time, privately', () => sandbox(async dir => {
  const before = Date.now()
  await run(dir)
  const [row] = await records(dir)
  assert.deepEqual(Object.keys(row).sort(), ['at', 'session_id', 'status'])
  assert.equal(row.session_id, request.session_id)
  assert.equal(row.status, 'waiting-on-permission')
  assert.ok(row.at >= before && row.at <= Date.now())
  const [name] = await readdir(join(dir, 'permission-wait'))
  assert.equal((await stat(join(dir, 'permission-wait', name))).mode & 0o777, 0o600)
}))
for (const hook_event_name of ['PostToolUse', 'Stop', 'PermissionDenied', 'PostToolUseFailure']) {
  const input = { ...request, hook_event_name }
  test(`${hook_event_name} clears only its own session, repeatedly`, () => sandbox(async dir => {
    await Promise.all([run(dir), run(dir, { ...request, session_id: 'other-session' })])
    await run(dir, input)
    await run(dir, input)
    assert.deepEqual((await records(dir)).map(row => row.session_id), ['other-session'])
  }))
  test(`${hook_event_name} on an unknown session creates nothing`, () => sandbox(async dir => {
    await run(dir, input)
    assert.deepEqual(await readdir(dir), [])
  }))
}
test('concurrent sessions do not lose each other and repeated requests replace their own record', () => sandbox(async dir => {
  const ids = Array.from({ length: 12 }, (_, n) => `session-${n}`)
  await Promise.all(ids.map(session_id => run(dir, { ...request, session_id })))
  const first = (await records(dir)).find(row => row.session_id === ids[0]).at
  await run(dir, { ...request, session_id: ids[0] })
  const rows = await records(dir)
  assert.deepEqual(rows.map(row => row.session_id).sort(), ids.sort())
  assert.ok(rows.find(row => row.session_id === ids[0]).at >= first)
}))
test('session IDs cannot escape the data directory', () => sandbox(async dir => {
  const session_id = '../../outside/' + 'x'.repeat(300)
  await run(dir, { ...request, session_id })
  assert.equal((await records(dir))[0].session_id, session_id)
  assert.deepEqual(await readdir(dir), ['permission-wait'])
  await run(dir, { hook_event_name: 'Stop', session_id })
  assert.deepEqual(await records(dir), [])
}))
test('malformed, missing-session and unrelated events leave existing state untouched', () => sandbox(async dir => {
  await run(dir)
  const before = await records(dir)
  for (const input of ['{broken', 'null', {}, { ...request, session_id: '' }, { ...request, session_id: 12 }, { ...request, session_id: '  ' }, { ...request, hook_event_name: 'Notification', notification_type: 'idle_prompt' }, { ...request, hook_event_name: 'PreToolUse' }]) {
    await run(dir, input)
  }
  assert.deepEqual(await records(dir), before)
}))
test('missing configuration does not fall back to the working directory', async () => {
  await run(null)
})
for (const key of ['NEXTUP_BOARD', 'CLAUDE_PLUGIN_DATA']) {
  test(`${key} can supply the data folder`, () => sandbox(async dir => {
    await run(null, request, { [key]: dir })
    assert.equal((await records(dir)).length, 1)
  }))
}
test('tilde data folders expand using HOME', () => sandbox(async dir => {
  await run(null, request, { HOME: dir, CLAUDE_PLUGIN_OPTION_dataDir: '~/board' })
  assert.equal((await records(join(dir, 'board'))).length, 1)
}))
test('unwritable data path fails silently without affecting permission handling', () => sandbox(async dir => {
  const file = join(dir, 'not-a-folder')
  await writeFile(file, 'unchanged')
  await run(file)
  await run(file, await fixture('stop'))
  assert.equal(await readFile(file, 'utf8'), 'unchanged')
}))
test('hooks register synchronous PermissionRequest tracking and both clearing events, preserving Elicitation', async () => {
  const config = JSON.parse(await readFile(new URL('./hooks.json', import.meta.url), 'utf8'))
  for (const event of ['PermissionRequest', 'PostToolUse', 'Stop']) {
    const hooks = config.hooks[event].flatMap(entry => entry.hooks)
    assert.equal(hooks.length, 1)
    assert.equal(hooks[0].type, 'command')
    assert.equal(hooks[0].command, 'node "${CLAUDE_PLUGIN_ROOT}/hooks/node-guard.mjs" "${CLAUDE_PLUGIN_ROOT}/hooks/permission-wait.mjs"')
    assert.equal(hooks[0].async, undefined)
    assert.ok(hooks[0].timeout <= 5)
  }
  assert.equal(config.hooks.Elicitation[0].hooks[0].command, 'node "${CLAUDE_PLUGIN_ROOT}/hooks/node-guard.mjs" "${CLAUDE_PLUGIN_ROOT}/hooks/elicit/ask-hook.mjs"')
  assert.deepEqual(config.modules, ['./register.tsx'])
})
