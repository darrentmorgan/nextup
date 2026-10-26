import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const script = new URL('../../../scripts/nextup-answer', import.meta.url).pathname
const now = Date.now()
const row = (id, props, extra = {}) => ({ id, source: 's', thread: 'T', message: 'Pick?', schema: { type: 'object', properties: props }, askedAt: now - 1000, timeoutSec: 1200, status: 'waiting', at: now - 1000, ...extra })
async function withBoard(asks, fn) {
  const dir = await mkdtemp(join(tmpdir(), 'answer-'))
  try { await writeFile(join(dir, 'asks.json'), JSON.stringify(asks)); await fn(dir) } finally { await rm(dir, { recursive: true, force: true }) }
}
const run = (dir, ...args) => spawnSync('bash', [script, ...args], { env: { ...process.env, NEXTUP_BOARD: dir }, encoding: 'utf8' })
const answers = async dir => JSON.parse(await readFile(join(dir, 'answers.json'), 'utf8'))

test('oneOf field: lists its constants and accepts one', () => withBoard([row('a', { c: { type: 'string', oneOf: [{ const: 'red', title: 'Red' }, { const: 'blue', title: 'Blue' }] } })], async dir => {
  assert.match(run(dir).stdout, /c=red\|blue/)
  assert.equal(run(dir, 'a', 'blue').status, 0)
  assert.deepEqual((await answers(dir))[0].content, { c: 'blue' })
  assert.notEqual(run(dir, 'a', 'green').status, 0)
}))
test('an expired ask is not listed and cannot be answered', () => withBoard([row('old', { ok: { type: 'boolean' } }, { askedAt: now - 5000000, at: now - 5000000 })], async dir => {
  assert.match(run(dir).stdout, /Nothing waiting/)
  assert.notEqual(run(dir, 'old', 'yes').status, 0)
}))
test('two helpers answering at once both keep their rows', () => withBoard([row('a', { ok: { type: 'boolean' } }), row('b', { ok: { type: 'boolean' } })], async dir => {
  const { spawn } = await import('node:child_process')
  const go = id => new Promise(resolve => spawn('bash', [script, id, 'yes'], { env: { ...process.env, NEXTUP_BOARD: dir } }).on('close', resolve))
  await Promise.all([go('a'), go('b')])
  assert.deepEqual((await answers(dir)).map(r => r.id).sort(), ['a', 'b'])
}))
