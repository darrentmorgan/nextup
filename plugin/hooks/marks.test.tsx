import { expect, test } from 'claude-code/testing'

import { done, drop, park, undo, isHidden, isParked, isKept, doneBetween, readMarks, MarksUnreadable } from './marks'
import type { Files } from './marks'

// The Marks ledger at its own interface: a data folder held in memory and a fixed time.
// See GLOSSARY.md for the terms and docs/adr/0001-marks-format.md for the rules.

const DIR = '/data/board'
const FILE = `${DIR}/mod-marks.json`
const NOW = Date.UTC(2026, 9, 23, 10, 0)

/** A data folder in memory; each write moves the file's modified time on. */
function memory(start: Record<string, string> = {}) {
  const files: Record<string, string> = { ...start }
  const mtimes: Record<string, number> = Object.fromEntries(Object.keys(start).map(p => [p, 1]))
  const port: Files = {
    exists: async p => p in files,
    read: async p => files[p] ?? '',
    write: async (p, text) => {
      files[p] = text
      mtimes[p] = (mtimes[p] ?? 0) + 1
    },
    mtime: async p => mtimes[p] ?? 0,
  }
  return { port, files }
}

test('Done on a kept step keeps it kept and takes it off the board', async () => {
  const { port, files } = memory({ [FILE]: JSON.stringify({ t1: { keep: true, at: 1 } }) })
  const marks = await done(port, DIR, ['t1'], NOW)
  expect(marks.t1).toEqual({ keep: true, done: true, at: NOW })
  expect(JSON.parse(files[FILE] ?? '')).toEqual(marks)
  expect(isHidden(marks, 't1', NOW)).toBe(true)
})

test('Keep survives Park, Drop and Undo after Done', async () => {
  const { port } = memory({ [FILE]: JSON.stringify({ t1: { keep: true, done: true, at: 1 }, other: { at: 2 } }) })
  expect((await park(port, DIR, ['t1'], NOW + 1000, NOW)).t1).toEqual({ keep: true, parkUntil: NOW + 1000, at: NOW })
  expect((await drop(port, DIR, ['t1'], NOW)).t1).toEqual({ keep: true, dropped: true, at: NOW })
  expect(await undo(port, DIR, ['t1'], NOW)).toEqual({ t1: { keep: true, at: NOW }, other: { at: 2 } })
})

test('Undo keeps its stamp and brings the item back from Done', async () => {
  const { port, files } = memory({ [FILE]: JSON.stringify({ t1: { done: true, at: 1 } }) })
  const marks = await undo(port, DIR, ['t1'], NOW)
  expect(marks.t1).toEqual({ at: NOW })
  expect(JSON.parse(files[FILE] ?? '')).toEqual(marks)
  expect(isHidden(marks, 't1', NOW)).toBe(false)
})


test('Drop writes dropped alone, hides the item and never counts as Done', async () => {
  const { port, files } = memory({ [FILE]: JSON.stringify({ t1: { done: true, at: 1 } }) })
  const marks = await drop(port, DIR, ['t1'], NOW)
  expect(marks.t1).toEqual({ dropped: true, at: NOW })
  expect(JSON.parse(files[FILE] ?? '')).toEqual(marks)
  expect(isHidden(marks, 't1', NOW)).toBe(true)
  expect(doneBetween({ ...marks, both: { done: true, dropped: true, at: NOW } }, 0, NOW)).toEqual([])
})


test('Park hides until its time, then returns; isParked matches and excludes Done and Drop', async () => {
  const { port } = memory({ [FILE]: '{}' })
  const marks = await park(port, DIR, ['t1'], NOW + 1000, NOW)
  for (const at of [NOW, NOW + 999, NOW + 1000, NOW + 1001]) {
    expect(isHidden(marks, 't1', at)).toBe(at < NOW + 1000)
    expect(isParked(marks, 't1', at)).toBe(at < NOW + 1000)
  }
  expect(isHidden(marks, 'missing', NOW)).toBe(false)
  expect(isParked(marks, 'missing', NOW)).toBe(false)
  expect(isParked({ t1: { ...marks.t1!, done: true } }, 't1', NOW)).toBe(false)
  expect(isParked({ t1: { ...marks.t1!, dropped: true } }, 't1', NOW)).toBe(false)
})


test('isKept recognises Keep through Done, Drop and Park', () => {
  expect(isKept({ t1: { keep: true, at: 1 } }, 't1')).toBe(true)
  expect(isKept({ t1: { keep: true, done: true, at: 1 } }, 't1')).toBe(true)
  expect(isKept({ t1: { keep: true, dropped: true, at: 1 } }, 't1')).toBe(true)
  expect(isKept({ t1: { keep: true, parkUntil: NOW, at: 1 } }, 't1')).toBe(true)
  expect(isKept({ t1: { at: 1 } }, 't1')).toBe(false)
  expect(isKept({}, 'missing')).toBe(false)
})

test('Done on several ids writes all Marks together once, preserving other ids', async () => {
  const { port, files } = memory({ [FILE]: JSON.stringify({ other: { parkUntil: NOW + 5000, at: 2 } }) })
  let writes = 0
  const marks = await done({ ...port, write: async (p, text) => { writes++; await port.write(p, text) } }, DIR, ['t1', 't2'], NOW)
  expect(writes).toBe(1)
  expect(marks).toEqual({ other: { parkUntil: NOW + 5000, at: 2 }, t1: { done: true, at: NOW }, t2: { done: true, at: NOW } })
  expect(files[FILE]).toBe(JSON.stringify(marks, null, 1))
})


test('A missing Marks file reads empty and the first Done creates it', async () => {
  const { port, files } = memory()
  expect(await readMarks(port, DIR)).toEqual({})
  expect(await done(port, DIR, ['t1'], NOW)).toEqual({ t1: { done: true, at: NOW } })
  expect(JSON.parse(files[FILE] ?? '')).toEqual({ t1: { done: true, at: NOW } })
})


test('Unreadable Marks make reads and every verb throw without writing', async () => {
  for (const text of ['{bad JSON', 'null', '[]', '"text"', '42', 'true']) {
    const { port, files } = memory({ [FILE]: text })
    let writes = 0
    const f = { ...port, write: async () => { writes++ } }
    for (const call of [() => readMarks(f, DIR), () => done(f, DIR, ['t1'], NOW), () => drop(f, DIR, ['t1'], NOW), () => park(f, DIR, ['t1'], NOW + 1, NOW), () => undo(f, DIR, ['t1'], NOW)]) {
      let error: unknown
      try { await call() } catch (e) { error = e }
      expect(error instanceof MarksUnreadable).toBe(true)
      expect((error as Error).message).toBe('mod-marks.json is unreadable (not valid JSON). Fix or restore it, then Retry.')
    }
    expect(files[FILE]).toBe(text)
    expect(writes).toBe(0)
  }
})

test('Done keeps another writer\'s new Mark when mtime changes between read and write', async () => {
  const { port } = memory({ [FILE]: '{}' })
  let changed = false
  let reads = 0
  let writes = 0
  const f: Files = { ...port,
    read: async p => {
      reads++
      const text = await port.read(p)
      if (!changed) {
        changed = true
        await port.write(p, JSON.stringify({ other: { keep: true, at: NOW - 1 } }))
      }
      return text
    },
    write: async (p, text) => { writes++; await port.write(p, text) },
  }
  expect(await done(f, DIR, ['t1'], NOW)).toEqual({ other: { keep: true, at: NOW - 1 }, t1: { done: true, at: NOW } })
  expect(reads).toBe(2)
  expect(writes).toBe(1)
})

test('Done retries changed Marks at most three times, then writes anyway', async () => {
  const { port } = memory({ [FILE]: '{}' })
  let reads = 0
  let writes = 0
  const f: Files = { ...port,
    read: async p => {
      reads++
      const text = await port.read(p)
      await port.write(p, JSON.stringify({ other: { at: reads } }))
      return text
    },
    write: async (p, text) => { writes++; await port.write(p, text) },
  }
  expect(await done(f, DIR, ['t1'], NOW)).toEqual({ other: { at: 2 }, t1: { done: true, at: NOW } })
  expect(reads).toBe(3)
  expect(writes).toBe(1)
})

test('A retry preserves a newer Undo on the same id while marking other ids', async () => {
  const { port } = memory({ [FILE]: JSON.stringify({ t1: { done: true, at: NOW - 1 } }) })
  let changed = false
  const f: Files = { ...port,
    read: async p => {
      const text = await port.read(p)
      if (!changed) {
        changed = true
        await port.write(p, JSON.stringify({ t1: { keep: true, at: NOW + 1 } }))
      }
      return text
    },
  }
  const marks = await done(f, DIR, ['t1', 't2'], NOW)
  expect(marks).toEqual({ t1: { keep: true, at: NOW + 1 }, t2: { done: true, at: NOW } })
  expect(await readMarks(port, DIR)).toEqual(marks)
})

test('doneBetween includes its range, newest first, and skips non-finite Done times', () => {
  expect(doneBetween({
    older: { done: true, at: NOW - 1 },
    first: { done: true, at: NOW },
    last: { done: true, at: NOW + 100 },
    middle: { done: true, at: NOW + 50 },
    future: { done: true, at: NOW + 101 },
    infinite: { done: true, at: Infinity },
    invalid: { done: true, at: NaN },
    negative: { done: true, at: -Infinity },
    undone: { at: NOW },
    dropped: { done: true, dropped: true, at: NOW },
  }, NOW, NOW + 100)).toEqual([{ id: 'last', at: NOW + 100 }, { id: 'middle', at: NOW + 50 }, { id: 'first', at: NOW }])
})
