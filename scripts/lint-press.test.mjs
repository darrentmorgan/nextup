import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const script = fileURLToPath(new URL('./lint-press.mjs', import.meta.url))
const fixture = name => fileURLToPath(new URL(`./fixtures/lint-press/${name}.tsx`, import.meta.url))
function lint(...names) {
  const result = spawnSync(process.execPath, [script, ...names.map(fixture)], { encoding: 'utf8' })
  assert.ifError(result.error)
  assert.equal(result.stderr, '')
  return result
}

for (const [name, lines] of [
  ['bad-inline', [1, 2, 3, 4, 5]],
  ['bad-ternary', [1, 2, 3, 4, 5, 6]],
  ['bad-use-callback', [3, 4, 5, 6, 7]],
]) {
  test(`${name}: each unsafe attribute fails with its source line`, () => {
    const result = lint(name)
    assert.equal(result.status, 1)
    assert.deepEqual(result.stdout.trim().split('\n'), lines.map(line =>
      `${fixture(name)}:${line}: raw onPress; wrap it in act() or view() (events.ts)`))
  })
}

test('wrapped handlers, safe conditionals, comments and strings pass', () => {
  const result = lint('good')
  assert.equal(result.status, 0)
  assert.equal(result.stdout, '')
})

test('checks all supplied files and preserves failure status', () => {
  const result = lint('good', 'bad-ternary', 'bad-use-callback')
  assert.equal(result.status, 1)
  assert.equal(result.stdout.trim().split('\n').length, 11)
})
