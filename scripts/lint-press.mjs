#!/usr/bin/env node
// Press handlers must enter act() or view() for feedback and event logging.
import { readFileSync } from 'node:fs'

// Tokenize rather than matching the start of the attribute: handlers may be
// nested in parentheses, conditionals, or useCallback(). Ignore comment/string
// contents so examples and labels do not look like handlers.
function tokenize(src) {
  const tokens = []
  const pattern = /\/\/[^\n]*|\/\*[\s\S]*?\*\/|'(?:\\[\s\S]|[^'\\])*'|"(?:\\[\s\S]|[^"\\])*"|`(?:\\[\s\S]|[^`\\])*`|[A-Za-z_$][\w$]*|=>|\?\.|\?\?|[^\s]/g
  for (const m of src.matchAll(pattern)) {
    if (m[0].startsWith('//') || m[0].startsWith('/*')) continue
    tokens.push({ text: m[0], index: m.index })
  }
  return tokens
}

function closing(tokens, start) {
  const pairs = { '(': ')', '[': ']', '{': '}' }
  const stack = []
  for (let i = start; i < tokens.length; i++) {
    const t = tokens[i].text
    if (Object.hasOwn(pairs, t)) stack.push(pairs[t])
    else if (t === stack.at(-1)) {
      stack.pop()
      if (!stack.length) return i
    }
  }
  return tokens.length - 1
}

function isRaw(tokens, callbacks, branch = false) {
  while (tokens[0]?.text === '(' && closing(tokens, 0) === tokens.length - 1) {
    tokens = tokens.slice(1, -1)
  }
  if (!tokens.length) return false
  // Only a complete wrapper call is trusted, not a wrapper followed by a
  // conditional or another expression.
  if (['act', 'view'].includes(tokens[0].text) && tokens[1]?.text === '(' &&
      closing(tokens, 1) === tokens.length - 1) return false

  // Locate a top-level conditional, including nested conditional branches.
  let question = -1
  let depth = 0
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i].text
    if (['(', '[', '{'].includes(t)) { i = closing(tokens, i); continue }
    if (t === '?') {
      if (question < 0) question = i
      depth++
    } else if (t === ':' && question >= 0 && --depth === 0) {
      return isRaw(tokens.slice(0, question), callbacks) ||
        isRaw(tokens.slice(question + 1, i), callbacks, true) ||
        isRaw(tokens.slice(i + 1), callbacks, true)
    }
  }
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i].text
    // Wrapped callbacks are safe even inside a larger expression.
    if (['act', 'view'].includes(t) && tokens[i + 1]?.text === '(') {
      i = closing(tokens, i + 1)
      continue
    }
    if (t === '=>' || t === 'function' || t === 'useCallback' || callbacks.has(t)) return true
  }
  // A conditional choosing opaque callbacks cannot establish that either
  // branch enters a wrapper. Empty/disabled branches are fine.
  return branch && !(tokens.length === 1 && ['null', 'undefined', 'false'].includes(tokens[0].text))
}

let bad = 0
for (const f of process.argv.slice(2)) {
  const src = readFileSync(f, 'utf8')
  const tokens = tokenize(src)
  const callbacks = new Set()
  // Also catch handlers declared with useCallback and passed by name.
  for (let i = 0; i < tokens.length; i++) {
    if (!['const', 'let', 'var'].includes(tokens[i].text) || tokens[i + 2]?.text !== '=') continue
    let start = i + 3
    while (tokens[start]?.text === '(') start++
    if (tokens[start]?.text === 'useCallback' ||
        (tokens[start]?.text === 'React' && tokens[start + 1]?.text === '.' && tokens[start + 2]?.text === 'useCallback')) {
      callbacks.add(tokens[i + 1].text)
    }
  }
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].text !== 'onPress' || tokens[i + 1]?.text !== '=' || tokens[i + 2]?.text !== '{') continue
    const end = closing(tokens, i + 2)
    if (isRaw(tokens.slice(i + 3, end), callbacks)) {
      const line = src.slice(0, tokens[i].index).split('\n').length
      console.log(`${f}:${line}: raw onPress; wrap it in act() or view() (events.ts)`)
      bad++
    }
    i = end
  }
}
process.exit(bad ? 1 : 0)
