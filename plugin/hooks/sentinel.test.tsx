import { expect, test } from 'claude-code/testing'

import { ageChip, ageText, parseSentinel, stripView, STALE_MS } from './sentinel'
import sample from './fixtures/sentinel.sample'

// The Sentinel strip at its own interface: the three files it reads, a fixed time, no engine.
// The failures replayed here are the census ones: a refresh that lied, a state nobody could age, a check that stopped.

const MIN = 60_000
const NOW = Date.parse('2026-10-26T11:32:00+10:30')
const text = JSON.stringify(sample)
const state = (t: number | string, status = 'attention') => JSON.stringify({ t, status, version: 1 })

test('a sample with two cards reads as two things that need a look', () => {
  const r = parseSentinel(text, state(NOW - 2 * MIN), true)
  expect(r.installed).toBe(true)
  expect(r.cards.map(c => c.id)).toEqual(['sentinel-3f9a1c20', 'sentinel-81be07d4'])
  const s = stripView(r, NOW)
  expect(s.text).toBe('2 things need a look')
  expect(s.detail).toBe('checked 2 min ago')
  expect(s.cards.map(c => c.id)).toEqual(['sentinel-3f9a1c20', 'sentinel-81be07d4'])
})

test('a P0 card makes the strip red, and one card reads in the singular', () => {
  const one = JSON.stringify({ ...sample, cards: [sample.cards[1]] })
  expect(stripView(parseSentinel(one, state(NOW - MIN), true), NOW).text).toBe('1 thing needs a look')
  expect(stripView(parseSentinel(one, state(NOW - MIN), true), NOW).tone).toBe('warn')
  const p0 = JSON.stringify({ ...sample, cards: [sample.cards[0]] })
  expect(stripView(parseSentinel(p0, state(NOW - MIN), true), NOW).tone).toBe('fail')
})

test('zero cards is one quiet line that says how long ago it checked', () => {
  const none = JSON.stringify({ ...sample, status: 'ok', cards: [] })
  const s = stripView(parseSentinel(none, state(NOW - 3 * MIN, 'ok'), true), NOW)
  expect(s.text).toBe('All clear, checked 3 min ago')
  expect(s.tone).toBe('quiet')
  expect(s.cards).toEqual([])
})

test('no sentinel.py, or no state file, is not installed and never green', () => {
  for (const r of [parseSentinel(null, null, false), parseSentinel(text, state(NOW), false), parseSentinel(text, null, true)]) {
    const s = stripView(r, NOW)
    expect(s.text).toBe('Sentinel not installed')
    expect(s.tone).toBe('quiet')
    expect(s.cards).toEqual([])
  }
})

test('a state older than 15 minutes is amber and names the last check time, even with no cards', () => {
  const none = JSON.stringify({ ...sample, status: 'ok', cards: [] })
  const t = NOW - STALE_MS - MIN
  const s = stripView(parseSentinel(none, state(t, 'ok'), true), NOW)
  const hhmm = new Date(t).toTimeString().slice(0, 5)
  expect(s.text).toBe(`Sentinel has not checked since ${hhmm}`)
  expect(s.tone).toBe('warn')
  // The cards it last found stay visible: stale is not resolved.
  expect(stripView(parseSentinel(text, state(t), true), NOW).cards.length).toBe(2)
})

test('state times in seconds or as an ISO string read the same as milliseconds', () => {
  const ms = parseSentinel(text, state(NOW - MIN), true).checkedAt
  expect(parseSentinel(text, state(Math.floor((NOW - MIN) / 1000)), true).checkedAt).toBe(Math.floor((NOW - MIN) / 1000) * 1000)
  expect(parseSentinel(text, state(new Date(NOW - MIN).toISOString()), true).checkedAt).toBe(ms)
})

test('a blind or failing Sentinel is never green and says why', () => {
  const none = (status: string) => JSON.stringify({ ...sample, status, cards: [] })
  const blind = stripView(parseSentinel(none('blind'), state(NOW - MIN, 'blind'), true), NOW)
  expect(blind.text).toBe('Not checked: Sentinel cannot see some of your data')
  expect(blind.tone).toBe('warn')
  const failing = stripView(parseSentinel(none('failing'), state(NOW - MIN, 'failing'), true), NOW)
  expect(failing.text).toBe('Sentinel itself is failing')
  expect(failing.tone).toBe('fail')
})

test('files that are not valid JSON show as unreadable, never as all clear', () => {
  const s = stripView(parseSentinel('{nope', state(NOW - MIN), true), NOW)
  expect(s.text).toBe('Sentinel report is unreadable')
  expect(s.tone).toBe('fail')
  const t = stripView(parseSentinel(text, '{nope', true), NOW)
  expect(t.text).toBe('Sentinel state is unreadable')
  expect(stripView(parseSentinel(JSON.stringify({ cards: 'x' }), state(NOW), true), NOW).tone).toBe('fail')
})

test('healed and resolved cards do not count as open; reopened ones do', () => {
  const cards = [{ ...sample.cards[0], state: 'healed' }, { ...sample.cards[1], state: 'reopened' }]
  const s = stripView(parseSentinel(JSON.stringify({ ...sample, cards }), state(NOW - MIN), true), NOW)
  expect(s.text).toBe('1 thing needs a look')
  expect(s.cards.map(c => c.state)).toEqual(['reopened'])
})

test('malformed cards are dropped, valid ones kept, and nothing is invented', () => {
  const cards = [sample.cards[0], { id: 'x' }, null, 'junk', { ...sample.cards[1], evidence: 'not a list', count: 'many' }]
  const r = parseSentinel(JSON.stringify({ ...sample, cards }), state(NOW), true)
  expect(r.cards.map(c => c.id)).toEqual(['sentinel-3f9a1c20', 'sentinel-81be07d4'])
  expect(r.cards[1]!.evidence).toEqual([])
  expect(r.cards[1]!.count).toBe(1)
})

test('age text reads in minutes, then hours, then days', () => {
  expect(ageText(0)).toBe('0 min ago')
  expect(ageText(5 * MIN)).toBe('5 min ago')
  expect(ageText(59 * MIN)).toBe('59 min ago')
  expect(ageText(2 * 60 * MIN)).toBe('2 h ago')
  expect(ageText(49 * 60 * MIN)).toBe('2 d ago')
  expect(ageText(-5 * MIN)).toBe('0 min ago')
})

test('an age chip is amber at one interval and red at three, and its words change with the colour', () => {
  const every = 30 * MIN
  expect(ageChip(NOW - 5 * MIN, NOW, every)).toEqual({ text: 'updated 5 min ago', level: 'ok' })
  expect(ageChip(NOW - every, NOW, every).level).toBe('ok')
  const amber = ageChip(NOW - every - MIN, NOW, every)
  expect(amber).toEqual({ text: 'updated 31 min ago, older than usual', level: 'amber' })
  expect(ageChip(NOW - 3 * every + MIN, NOW, every).level).toBe('amber')
  const red = ageChip(NOW - 3 * every, NOW, every)
  expect(red).toEqual({ text: 'updated 1 h ago, out of date', level: 'red' })
  // The one word that differs is never the colour alone.
  expect(new Set([ageChip(NOW - MIN, NOW, every).text.replace(/\d+/, 'N'), amber.text.replace(/\d+/, 'N'), red.text.replace(/\d+/, 'N')]).size).toBe(3)
})

test('an unknown age is never green', () => {
  expect(ageChip(null, NOW, 30 * MIN)).toEqual({ text: 'age unknown', level: 'amber' })
  expect(ageChip(Number.NaN, NOW, 30 * MIN).level).toBe('amber')
})

test('a chip takes a label so each store names itself', () => {
  expect(ageChip(NOW - 2 * MIN, NOW, 30 * MIN, 'drafts read').text).toBe('drafts read 2 min ago')
})

test('a state time in the future is unreadable, never fresh', () => {
  const s = stripView(parseSentinel(text, state(NOW + 60 * MIN), true), NOW)
  expect(s.text).toBe('Sentinel state is unreadable')
  expect(s.tone).toBe('fail')
})

test('a missing report beside a state is unreadable, never all clear', () => {
  const s = stripView(parseSentinel(null, state(NOW - MIN, 'ok'), true), NOW)
  expect(s.text).toBe('Sentinel report is unreadable')
  expect(s.tone).toBe('fail')
})

test('the worse of the report and state status wins', () => {
  const none = (status: string) => JSON.stringify({ ...sample, status, cards: [] })
  expect(parseSentinel(none('failing'), state(NOW - MIN, 'ok'), true).status).toBe('failing')
  expect(stripView(parseSentinel(none('blind'), state(NOW - MIN, 'ok'), true), NOW).tone).toBe('warn')
})
