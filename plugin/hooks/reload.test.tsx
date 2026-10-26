import { expect, test } from 'claude-code/testing'
import { reloadMessage, reloadView } from './reload'

const uuid = (n: number) => `0000000${n}-aaaa-bbbb-cccc-${String(n).padStart(12, '0')}`
const ids = (n: number) => Array.from({ length: n }, (_, i) => uuid(i + 1))

const NONE = 'Sent, not confirmed: no session has said it reloaded.'

test('reload message leads with the version, counts the sessions the app logged and never prints ids', () => {
  const m = reloadMessage({ version: '0.5.1', reloaded: ids(2), reloaded_by_app: ids(3).slice(0, 1), pending_app_reload: ids(2), needs_restart: ids(11) }, [], 3)
  expect(m).toBe('Updated to 0.5.1. Reloaded 3 sessions. The app is reloading 2 more. 11 sessions still need /reload-plugins typed.')
  expect(m).not.toMatch(/[0-9a-f]{8}-/)
})

test('reload message: what the helper says it sent is not what landed (census 3 and 16)', () => {
  const sent = { version: '0.5.1', reloaded: ids(4), reloaded_by_app: ids(4), needs_restart: [] }
  expect(reloadMessage(sent, [], 0)).toBe(`Updated to 0.5.1. ${NONE}`)
  expect(reloadMessage(sent, [], null)).toBe('Updated to 0.5.1. Sent, not confirmed: the app log could not be read.')
  expect(reloadMessage(sent, [])).toBe('Updated to 0.5.1. Sent, not confirmed: the app log could not be read.')
})

test('reload message: already current, singular, and nothing left over', () => {
  expect(reloadMessage({ version: '0.5.1', needs_restart: [], already_current: true }, [], 1)).toBe('Already current. Reloaded 1 session.')
  expect(reloadMessage({ needs_restart: [] }, [], 0)).toBe(`Updated. ${NONE}`)
})

test('reload message counts unnamed sessions in +N more and survives a bad board', () => {
  expect(reloadMessage({ needs_restart: ids(5) }, [{ id: uuid(1), title: 'Task 1' }, { id: uuid(2), title: 'Task 2' }], 0))
    .toBe(`Updated. ${NONE} 5 sessions still need /reload-plugins typed: Task 1, Task 2 +3 more.`)
  expect(reloadMessage({ needs_restart: ids(2) }, undefined as never, 0)).toBe(`Updated. ${NONE} 2 sessions still need /reload-plugins typed.`)
})

test('reload message names at most 3 sessions by title, then +N more, skipping unknown ids', () => {
  const titles = [1, 2, 3, 4].map(n => ({ id: uuid(n), title: `Task ${n}` }))
  expect(reloadMessage({ version: '0.5.1', needs_restart: ids(5) }, titles, 2))
    .toBe('Updated to 0.5.1. Reloaded 2 sessions. 5 sessions still need /reload-plugins typed: Task 1, Task 2, Task 3 +2 more.')
  expect(reloadMessage({ version: '0.5.1', needs_restart: [uuid(1)] }, titles, 2))
    .toBe('Updated to 0.5.1. Reloaded 2 sessions. 1 session still needs /reload-plugins typed: Task 1.')
})

const MIN = 60_000
const done = { running: false, message: 'Updated.', failed: false }

test('a finished reload message shows for 10 minutes, then is gone', () => {
  expect(reloadView({ ...done, at: 1000 }, 1000 + 10 * MIN)).toEqual({ running: false, message: 'Updated.', failed: false })
  expect(reloadView({ ...done, at: 1000 }, 1001 + 10 * MIN).message).toBe('')
})

test('a saved message with no time counts as expired', () => {
  expect(reloadView(done, 5_000_000).message).toBe('')
  expect(reloadView({ ...done, failed: true }, 5_000_000)).toEqual({ running: false, message: '', failed: false })
})

test('a running reload shows its message, but over 5 minutes it is stuck and the button works again', () => {
  const run = { running: true, message: 'Reloading plugins...', failed: false, at: 1000 }
  expect(reloadView(run, 1000 + 5 * MIN)).toEqual({ running: true, message: 'Reloading plugins...', failed: false })
  expect(reloadView(run, 1001 + 5 * MIN)).toEqual({ running: false, message: '', failed: false })
  expect(reloadView({ ...run, at: undefined }, 2000).running).toBe(false)
})
