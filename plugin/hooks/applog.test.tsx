import { expect, test } from 'claude-code/testing'

import { appliedSince, logTime, missingSince, stampOf } from './applog'

// The Claude desktop app's main.log is the only witness to what the app did after a press.
// These lines are real ones from 25 and 26 Oct (ids shortened): the proof reads them, never a process exit code.

const MIN = 60_000
const at = (s: string) => new Date(s.replace(' ', 'T')).getTime()
const MISSING = (when: string, id: string) => `${when} [error] Failed to import CLI session { error: 'Error', sessionId: '${id}', category: 'transcript_missing' }`
const APPLIED = (when: string, id: string) => `${when} [info] [CCD] reload_plugins applied for local_${id}: 10 plugin(s), 135 command(s), 0 plugin error(s)`

test('a log line carries its local time', () => {
  expect(logTime(MISSING('2026-10-26 11:31:19', 'abc'))).toBe(at('2026-10-26 11:31:19'))
  expect(logTime('no stamp here')).toBeNull()
  expect(logTime('2026-13-45 99:99:99 [info] nonsense')).toBeNull()
})

test('stampOf writes the same local time back out', () => {
  expect(stampOf(at('2026-10-26 07:05:09'))).toBe('2026-10-26 07:05:09')
})

test('transcript_missing for the pressed session after the press is a failure to open (census 2)', () => {
  const press = at('2026-10-26 11:31:18')
  const log = [MISSING('2026-10-26 11:31:19', 'd02ded59'), MISSING('2026-10-26 11:31:50', 'other')].join('\n')
  expect(missingSince(log, 'd02ded59', press)).toBe(true)
  expect(missingSince(log, 'unrelated', press)).toBe(false)
})

test('a transcript_missing from before the press is old news', () => {
  const log = MISSING('2026-10-26 11:31:19', 'd02ded59')
  expect(missingSince(log, 'd02ded59', at('2026-10-26 11:31:20'))).toBe(false)
  expect(missingSince(log, 'd02ded59', at('2026-10-26 11:31:19'))).toBe(true)
})

test('applied lines count one per session, only from the press on (census 3, 16)', () => {
  const press = at('2026-10-25 22:55:00')
  const log = [
    APPLIED('2026-10-25 22:50:00', 'old'),
    APPLIED('2026-10-25 22:55:52', '1bb4'), APPLIED('2026-10-25 22:55:52', '4366'), APPLIED('2026-10-25 22:55:53', '4366'),
    '2026-10-25 22:55:52 [info] [CCD] reload_plugins broadcast (installed_plugins.json changed): 14 of 14 live local session(s)',
  ].join('\n')
  expect(appliedSince(log, press)).toBe(2)
  expect(appliedSince(log, at('2026-10-25 23:00:00'))).toBe(0)
  expect(appliedSince('', press)).toBe(0)
})

test('a plugin error line is not a clean reload', () => {
  const bad = '2026-10-25 22:55:52 [info] [CCD] reload_plugins applied for local_zz: 10 plugin(s), 135 command(s), 1 plugin error(s)'
  expect(appliedSince(bad, at('2026-10-25 22:55:00'))).toBe(0)
})

test('a line from a minute before the press does not count', () => {
  const log = APPLIED('2026-10-26 10:00:00', 'a')
  expect(appliedSince(log, at('2026-10-26 10:00:00') + MIN)).toBe(0)
})

test('a line in the same second as the press counts as after it', () => {
  const log = MISSING('2026-10-26 11:31:19', 'abc')
  expect(missingSince(log, 'abc', at('2026-10-26 11:31:19') + 700)).toBe(true)
  expect(appliedSince(APPLIED('2026-10-26 11:31:19', 'a'), at('2026-10-26 11:31:19') + 700)).toBe(1)
})
