import { expect, test } from 'claude-code/testing'

import { Declined, eventLine, feedbackView, outcomeOf } from './events'

// Every press ends in a visible result and one line in mod-events.jsonl. The words and the expiry are tested here;
// the wiring (the pending state, the log line, S21 to S24) is tested through the pane in actions.test.tsx.

const NOW = Date.parse('2026-10-26T11:32:00+10:30')

test('an event line is one JSON line with the action, outcome and message, cut to a safe length', () => {
  const line = eventLine({ t: NOW, action: 'tick', outcome: 'fail', msg: `bad\nnews ${'x'.repeat(400)}`, feedbackMs: 3 })
  expect(line).not.toContain('\n')
  const v = JSON.parse(line) as Record<string, unknown>
  expect(v).toMatchObject({ t: NOW, action: 'tick', outcome: 'fail', feedbackMs: 3 })
  expect((v.msg as string).length).toBeLessThanOrEqual(200)
})

test('outcomes: nothing or true is ok, false is a no-op with a reason, a string is an ok message, a throw is a failure', () => {
  expect(outcomeOf(undefined, 'tick')).toEqual({ outcome: 'ok', msg: '' })
  expect(outcomeOf(true, 'tick')).toEqual({ outcome: 'ok', msg: '' })
  expect(outcomeOf('Copied', 'tick')).toEqual({ outcome: 'ok', msg: 'Copied' })
  expect(outcomeOf(false, 'tick').outcome).toBe('noop')
  expect(outcomeOf(false, 'tick').msg).not.toBe('')
  expect(outcomeOf({ outcome: 'fail', msg: 'No', proof: 'p' }, 'tick')).toEqual({ outcome: 'fail', msg: 'No', proof: 'p' })
  expect(outcomeOf(new Declined('No data folder is set.'), 'tick')).toEqual({ outcome: 'noop', msg: 'No data folder is set.' })
  expect(outcomeOf(new Error('read-only'), 'mark that done')).toEqual({ outcome: 'fail', msg: "Couldn't mark that done: read-only" })
  expect(outcomeOf('weird' as never, 'x').outcome).toBe('ok')
})

test('a failure never shows a stack or a code, only its first line', () => {
  const e = new Error('EACCES: permission denied\n    at write (file.ts:1:1)')
  expect(outcomeOf(e, 'save').msg).toBe("Couldn't save: EACCES: permission denied")
  expect(outcomeOf(new Error(''), 'save').msg).toBe("Couldn't save.")
})

test('feedback expires: ok after 6 s, failures after 30 s, and a pending press that never finishes turns into a failure', () => {
  const at = NOW
  const f = (kind: 'pending' | 'ok' | 'fail' | 'noop') => ({ id: 'a:1', action: 'tick', kind, text: 'T', at })
  expect(feedbackView(null, NOW)).toBeNull()
  expect(feedbackView(f('ok'), NOW + 5_999)).toMatchObject({ kind: 'ok' })
  expect(feedbackView(f('ok'), NOW + 6_001)).toBeNull()
  expect(feedbackView(f('fail'), NOW + 29_000)).toMatchObject({ kind: 'fail' })
  expect(feedbackView(f('fail'), NOW + 31_000)).toBeNull()
  expect(feedbackView(f('noop'), NOW + 29_000)).toMatchObject({ kind: 'noop' })
  expect(feedbackView(f('pending'), NOW + 10_000)).toMatchObject({ kind: 'pending', text: 'T' })
  expect(feedbackView(f('pending'), NOW + 31_000)).toMatchObject({ kind: 'fail', text: 'tick is taking longer than expected.' })
})
