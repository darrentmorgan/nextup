import type { Thread } from '../types'

// Match balanced delimiters rather than cutting a URL at its first closing parenthesis.
const closing = (text: string, start: number, open: string, close: string) => {
  let depth = 1
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] === '\\') { i++; continue }
    if (text[i] === open) depth++
    if (text[i] === close && --depth === 0) return i
  }
  return -1
}
const labels = (text: string): string => {
  let out = ''
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '[') {
      const end = closing(text, i, '[', ']')
      const urlEnd = end >= 0 && text[end + 1] === '(' ? closing(text, end + 1, '(', ')') : -1
      if (urlEnd >= 0) {
        out += labels(text.slice(i + 1, end))
        i = urlEnd
        continue
      }
    }
    out += text[i]
  }
  return out
}

/** Plain scan text, with a total character budget and no partial final word. */
export function rowText(text: string, max = 160): string {
  const plain = labels(text).replace(/<\/?pasted_content[^>]*>|\*\*|`/g, '').replace(/\s+/g, ' ').trim()
  if (max <= 0) return ''
  if (plain.length <= max) return plain
  const prefix = plain.slice(0, max - 1)
  const whole = /\s/.test(plain[max - 1] ?? '') ? prefix.trimEnd() : prefix.replace(/\S+$/, '').trimEnd()
  return `${whole}…`
}

/** Presentation copies preserve launch fields and never mutate board evidence. */
export function threadRow(t: Thread) {
  const estimate = typeof t.minutes === 'number' && Number.isFinite(t.minutes) && t.minutes >= 0 ? t.minutes : undefined
  const progressValue = typeof t.progress === 'number' && Number.isFinite(t.progress) && t.progress >= 0 && t.progress <= 100 ? t.progress : undefined
  return {
    ...t,
    title: rowText(t.title ?? ''),
    finish: rowText(t.finish ?? ''),
    project: rowText(t.project ?? ''),
    goal: t.goal === undefined ? undefined : rowText(t.goal),
    link_label: rowText(t.link_label ?? ''),
    source: rowText(t.source ?? ''),
    left_off: t.left_off === undefined ? undefined : rowText(t.left_off),
    last_ask: t.last_ask === undefined ? undefined : rowText(t.last_ask),
    estimate,
    estimateText: estimate === undefined ? 'estimate unknown' : `${estimate} min estimated`,
    progressValue,
  }
}
