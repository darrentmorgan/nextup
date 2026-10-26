import { expect, test } from 'claude-code/testing'
import { momentumStats, winsRing } from './momentum'
import type { Board, Thread } from '../types'

const now = new Date(2026, 9, 22, 14).getTime()
const task = (id: string, minutes: number | null = 30, value: number | null = 3) => ({ id, minutes, value } as Thread)
const board = (threads: Thread[]): Board => ({ threads, notes: [], generated: '' })

test('Momentum totals exclude future, prior-week and dropped marks; unknown estimates stay explicit', () => {
  const stats = momentumStats(board([task('today'), task('old'), task('missing', null), task('bad', -20, -8)]), {
    today: { done: true, at: now },
    old: { done: true, at: new Date(2026, 9, 18, 14).getTime() },
    missing: { done: true, at: now },
    bad: { done: true, at: now },
    future: { done: true, at: now + 1 },
    dropped: { done: true, dropped: true, at: now },
  }, [], now)
  expect(stats.wins).toBe(3)
  expect(stats.parts).toEqual([0, 3, 0])
  expect(stats.hours).toBe(0.5)
  expect(stats.points).toBe(6)
  expect(stats.unknownEstimates).toBe(2)
  expect(stats.rescue).toBeUndefined()
})

test('Momentum bars compare completed estimates with remaining checked work, without currency or time tracking', () => {
  const stats = momentumStats(board([task('done'), task('open')]), { done: { done: true, at: now } }, [task('open')], now)
  expect(stats.pointFraction).toBe(0.5)
  expect(stats.hourFraction).toBe(0.5)
})

test('Rescue uses a finite positive small task, only after 90 minutes since 8am or the last win', () => {
  const tasks = [task('large', 90), task('small', 5), task('unknown', null), task('bad', -1)]
  expect(momentumStats(board(tasks), {}, tasks, new Date(2026, 9, 22, 9, 29).getTime()).rescue).toBeUndefined()
  expect(momentumStats(board(tasks), {}, tasks, new Date(2026, 9, 22, 9, 30).getTime()).rescue?.id).toBe('small')
  expect(momentumStats(board(tasks), { small: { done: true, at: now - 60_000 } }, tasks, now).rescue).toBeUndefined()
})

test('Wins ring clamps its stroke at the goal and preserves bonus wins in its caller', () => {
  expect(winsRing(7)).toContain('stroke-dasharray="164 164"')
  expect(winsRing(0)).toContain('stroke-dasharray="0 164"')
})

test('Rescue falls back to the hero when alternatives have no usable estimate', () => {
  const tasks = [task('hero', 5), task('unknown', null)]
  expect(momentumStats(board(tasks), {}, tasks, now, 'hero').rescue?.id).toBe('hero')
})

test('Hero model uses board text and progress, never todo guesses or completion marks', () => {
  const hero = { ...task('hero'), title: '[Ship report](https://example.com/report)',
    finish: `Ship ${'completeword '.repeat(30)}`, progress: 37,
    last_ask: '[Review](https://example.com/review) the report' } as Thread
  const stats = momentumStats(board([hero]), {}, [{ ...hero, progress: 99 }], now, 'hero')
  expect(stats.hero?.title).toBe('Ship report')
  expect(stats.hero?.finish).toBe(`Ship ${'completeword '.repeat(11).trimEnd()}…`)
  expect(stats.hero?.last_ask).toBe('Review the report')
  expect(stats.hero?.progressValue).toBe(37)
  expect(hero.title).toContain('](https://')
  const absent = momentumStats(board([]), { hero: { done: true, at: now } }, [hero], now, 'hero')
  expect(absent.hero).toBeUndefined()
  for (const progress of [undefined, NaN, Infinity, -1, 101]) {
    const unknown = momentumStats(board([{ ...hero, progress } as Thread]), {}, [], now, 'hero')
    expect(unknown.hero?.progressValue).toBeUndefined()
  }
})

test('Rescue model strips links and never splits an oversized first word', () => {
  const rescue = { ...task('rescue', 5), title: '[Review](https://example.com/a_(b)) results',
    finish: 'x'.repeat(200), progress: 0 } as Thread
  const row = momentumStats(board([rescue]), {}, [rescue], now).rescue
  expect(row?.title).toBe('Review results')
  expect(row?.finish).toBe('…')
})

test('Completed marks missing from the board disclose the gap in totals', () => {
  const stats = momentumStats(board([task('unknown', null, null)]), {
    unknown: { done: true, at: now }, gone: { done: true, at: now },
  }, [], now)
  expect(stats.missingItems).toBe(1)
  expect(stats.unknownValues).toBe(1)
})
