#!/usr/bin/env node
// Demo MCP server for Blocker Ledger. One tool, ask_darren, that raises a form elicitation
// (one enum + one boolean) and returns what the client answered. Plain JSON-RPC over stdio,
// no dependencies. Try it: claude -p --strict-mcp-config --mcp-config demo/mcp.json "call ask_darren".
import { createInterface } from 'node:readline'

const send = m => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`)
let nextId = 1000
const waiting = new Map()
let canElicit = false

const TOOL = {
  name: 'ask_darren',
  description: 'Ask Darren one question when you are blocked on a decision. Give 2 to 4 options, recommended first. Use this instead of asking in chat.',
  inputSchema: {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'The one question.' },
      options: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 4, description: 'Choices, recommended first.' },
      confirm: { type: 'boolean', description: 'Also ask a yes/no "go ahead?" field.' },
    },
    required: ['question', 'options'],
  },
}

async function ask({ question, options, confirm }) {
  if (!canElicit) return { isError: true, content: [{ type: 'text', text: 'The client does not support elicitation.' }] }
  const opts = (Array.isArray(options) && options.length ? options : ['Yes', 'No']).slice(0, 4).map(String)
  const properties = { choice: { type: 'string', title: 'Choice', enum: opts, default: opts[0] } }
  if (confirm) properties.go = { type: 'boolean', title: 'Go ahead?', default: true }
  const id = nextId++
  const reply = new Promise(resolve => waiting.set(id, resolve))
  send({ id, method: 'elicitation/create', params: { mode: 'form', message: String(question ?? 'Which way?'), requestedSchema: { type: 'object', properties, required: ['choice'] } } })
  const r = await reply
  return { content: [{ type: 'text', text: `action=${r.action ?? 'error'} content=${JSON.stringify(r.content ?? null)}` }] }
}

const rl = createInterface({ input: process.stdin })
rl.on('line', async line => {
  let m
  try { m = JSON.parse(line) } catch { return }
  if (m.id !== undefined && !m.method && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? { action: 'cancel' }); waiting.delete(m.id); return }
  if (m.method === 'initialize') {
    canElicit = !!m.params?.capabilities?.elicitation
    send({ id: m.id, result: { protocolVersion: m.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'nextup-demo', version: '0.1.0' } } })
  } else if (m.method === 'tools/list') send({ id: m.id, result: { tools: [TOOL] } })
  else if (m.method === 'tools/call' && m.params?.name === 'ask_darren') send({ id: m.id, result: await ask(m.params.arguments ?? {}) })
  else if (m.id !== undefined && m.method) send({ id: m.id, error: { code: -32601, message: 'Method not found' } })
})
rl.on('close', () => process.exit(0))
