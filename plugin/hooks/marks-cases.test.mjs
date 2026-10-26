import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { done, drop, park, undo, isHidden, isParked, isKept, doneBetween } from './marks.ts'

// Node 24 runs the ledger's TypeScript directly, without an engine or dependencies.
// Keep this fixture outside plugin/: other languages consume the same plain JSON.
const fixture = JSON.parse(await readFile(new URL('../../scripts/fixtures/marks-cases.json', import.meta.url), 'utf8'))
assert.equal(fixture.version, 1)
assert.ok(fixture.cases.length > 0)
assert.equal(new Set(fixture.cases.map(c => c.name)).size, fixture.cases.length)

for (const c of fixture.cases) {
  test(c.name, async () => {
    const dir = '/fixture'
    const path = `${dir}/mod-marks.json`
    let text = JSON.stringify(c.current)
    let mtime = 1
    const files = {
      exists: async p => { assert.equal(p, path); return true },
      read: async p => { assert.equal(p, path); return text },
      write: async (p, value) => { assert.equal(p, path); text = value; mtime++ },
      mtime: async p => { assert.equal(p, path); return mtime },
    }

    // There is no exported snapshot merge. Exercise the real ledger write/merge
    // path, not a second implementation of timestamp selection in this test.
    // Incoming entries here are the four verbs the ledger can currently write.
    // In particular, do NOT skip older entries here: production must reject them.
    let actual = c.current
    for (const [id, entry] of Object.entries(c.incoming)) {
      assert.ok(Number.isSafeInteger(entry.at))
      assert.ok(Object.keys(entry).every(k => ['at', 'done', 'dropped', 'parkUntil'].includes(k)))
      assert.ok([entry.done === true, entry.dropped === true, entry.parkUntil !== undefined].filter(Boolean).length <= 1)
      if (entry.done) actual = await done(files, dir, [id], entry.at)
      else if (entry.dropped) actual = await drop(files, dir, [id], entry.at)
      else if (entry.parkUntil !== undefined) actual = await park(files, dir, [id], entry.parkUntil, entry.at)
      else actual = await undo(files, dir, [id], entry.at)
    }

    assert.deepEqual(actual, c.expected, 'ledger result must follow ADR-0001')
    assert.deepEqual(JSON.parse(text), c.expected, 'persisted marks must match the result')
    for (const o of c.observations ?? []) {
      assert.equal(isHidden(actual, o.id, o.now), o.hidden)
      assert.equal(isParked(actual, o.id, o.now), o.parked)
      assert.equal(isKept(actual, o.id), o.kept)
      assert.equal(doneBetween(actual, 0, o.now).some(m => m.id === o.id), o.countedDone)
    }
  })
}
