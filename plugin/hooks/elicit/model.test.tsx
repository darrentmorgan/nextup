import { expect, test } from 'claude-code/testing'
import { classify, shapeOf, normalize, ruleId, matchRule, ruleEligible, isAnswerable, buildContent, optionsOf, sortQueue, latest, minutesBlocked, sleptStats, stateLine } from './model'
import type { Schema, Ask, Rule, LogRow } from './model'

const bool: Schema = { type: 'object', properties: { approve: { type: 'boolean', default: false } }, required: ['approve'] }
const choice: Schema = { type: 'object', properties: { action: { type: 'string', enum: ['ship', 'hold'], default: 'hold' } }, required: ['action'] }
const text: Schema = { type: 'object', properties: { answer: { type: 'string' } } }
const probe = { mode: 'form', mcp_server_name: 'probe', message: 'Probe: what should next task be?', requested_schema: { type: 'object', properties: { answer: { type: 'string', title: 'Answer' }, urgent: { type: 'boolean', title: 'Urgent?' } }, required: ['answer'] } }

test('classification covers all classes and the probe', () => {
  expect(classify({ requested_schema: bool })).toBe('boolean')
  expect(classify({ requested_schema: choice })).toBe('enum')
  expect(classify(probe)).toBe('text')
  expect(classify({ requested_schema: { properties: { api_key: { type: 'string' } } } })).toBe('secret-like')
  expect(classify({ mode: 'url' })).toBe('url')
})
test('normalization and stable shape and ids', () => {
  expect(normalize('  Deploy 34 NOW?! ')).toBe('deploy # now')
  expect(shapeOf(bool)).toBe('boolean:approve')
  expect(shapeOf(choice)).toBe('enum:ship|hold')
  expect(shapeOf({ properties: { z: { type: 'string' }, a: { type: 'boolean' } } })).toBe(shapeOf({ properties: { a: { type: 'boolean' }, z: { type: 'string' } } }))
  expect(ruleId('probe', 'Pick 2?', bool)).toBe('probe|boolean:approve|pick #')
})
test('rules require a safe default, matching server and shape, and newest non-revoked row', () => {
  const req = { server: 'probe', message: 'Approve?', schema: bool, default: { approve: false } }
  const rule: Rule = { id: ruleId(req.server, req.message, bool), server: 'probe', shape: shapeOf(bool), value: { approve: true }, createdAt: 1, at: 1 }
  expect(matchRule([rule], req)).toEqual(rule)
  expect(matchRule([rule], { ...req, server: 'other' })).toBeUndefined()
  expect(matchRule([rule], { ...req, schema: choice })).toBeUndefined()
  expect(matchRule([{ ...rule, value: {} }], req)).toBeUndefined()
  expect(matchRule([{ ...rule, revoked: true }], req)).toBeUndefined()
  expect(matchRule([rule, { ...rule, revoked: true, at: 2 }], req)).toBeUndefined()
  expect(matchRule([rule, { ...rule, value: { approve: false }, at: 2 }], req)?.at).toBe(2)
  expect(matchRule([rule], { ...req, message: 'deploy now' })).toBeUndefined()
  for (const word of ['deploy', 'delete', 'spend', 'send', 'production']) expect(ruleEligible({ ...req, message: word })).toBe(false)
  expect(ruleEligible({ ...req, neverAuto: true })).toBe(false)
  expect(ruleEligible({ ...req, default: undefined })).toBe(false)
  expect(ruleEligible({ ...req, schema: choice, default: undefined })).toBe(false)
  for (const schema of [text, { properties: { token: { type: 'string' } } }, {}]) expect(ruleEligible({ ...req, schema })).toBe(false)
})
test('answerability and content validation', () => {
  expect(isAnswerable(probe.requested_schema)).toBe(true)
  expect(isAnswerable(bool)).toBe(true)
  expect(isAnswerable(choice)).toBe(true)
  expect(isAnswerable({ properties: { a: { oneOf: [{ const: 'one' }] } } })).toBe(true)
  expect(isAnswerable(undefined)).toBe(false)
  expect(isAnswerable({ properties: {} })).toBe(false)
  expect(isAnswerable({ properties: { a: { type: 'number' } } })).toBe(false)
  expect(isAnswerable({ properties: { a: { type: 'string', maxLength: 281 } } })).toBe(false)
  expect(isAnswerable({ properties: { a: { type: 'boolean' }, b: { type: 'boolean' }, c: { type: 'boolean' }, d: { type: 'boolean' } } })).toBe(false)
  expect(buildContent(choice, { action: 'hold' })).toEqual({ action: 'hold' })
  expect(buildContent(choice, { action: 'bad' })).toBeNull()
  expect(buildContent(bool, {})).toBeNull()
  expect(buildContent(bool, { approve: 'false' })).toEqual({ approve: false })
  expect(buildContent(bool, { approve: 'true' })).toEqual({ approve: true })
  expect(buildContent(text, { answer: ' hi ' })).toEqual({ answer: 'hi' })
  expect(buildContent({ properties: { a: { type: 'string', maxLength: 2 } } }, { a: 'long' })).toBeNull()
})
test('options put recommendation first and preserve titles', () => {
  expect(optionsOf({ oneOf: [{ const: 'a', title: 'Alpha' }, { const: 'b', title: 'Beta' }] }, 'b')).toEqual([{ value: 'b', label: 'Beta', recommended: true }, { value: 'a', label: 'Alpha', recommended: false }])
})
test('queue takes latest rows, drops finished and expired, oldest first', () => {
  const ask: Ask = { id: 'a', source: 'probe', thread: 't', message: '?', schema: bool, askedAt: 1000, timeoutSec: 10, status: 'waiting', at: 1000 }
  const rows: Ask[] = [ask, { ...ask, id: 'b', askedAt: 2000 }, { ...ask, id: 'done' }, { ...ask, id: 'done', status: 'answered', at: 3000 }, { ...ask, id: 'expired', askedAt: 0, timeoutSec: 1 }]
  expect(sortQueue(rows, 4000).map(r => r.id)).toEqual(['a', 'b'])
  expect(latest([ask, { ...ask, at: 2_000 }])[0]?.at).toBe(2000)
  expect(sortQueue([ask], 11000)).toEqual([])
  expect(minutesBlocked(ask, 121000)).toBe(2)
  expect(minutesBlocked(ask, 0)).toBe(0)
})
test('sleep stats and state wording', () => {
  const row: LogRow = { id: 'a', source: 's', message: '?', status: 'auto', answeredBy: 'rule', waitedSec: 10, content: { approve: true }, at: 10 }
  expect(sleptStats([row, { ...row, id: 'b', status: 'defaulted', answeredBy: 'timeout', waitedSec: 20 }, { ...row, id: 'c', status: 'answered', answeredBy: 'darren' }], 0)).toEqual({ answered: 2, medianWaitSec: 15 })
  expect(sleptStats([row], 11)).toEqual({ answered: 0, medianWaitSec: 0 })
  expect(sleptStats([{ ...row, status: 'answered' }], 0)).toEqual({ answered: 1, medianWaitSec: 10 })
  expect(stateLine(row)).toBe('Answered by rule: true')
  expect(stateLine({ ...row, status: 'defaulted' }, 20)).toBe('Defaulted to true after 20 min')
  expect(stateLine({ ...row, status: 'cancelled' })).toBe('Cancelled, thread is blocked')
})
