import { expect, test } from 'claude-code/testing'
import { rowText } from './rowtext'

test('Row text strips links, including balanced URL parentheses, before measuring', () => {
  expect(rowText('[Read report](https://example.com/a_(b)) now', 20)).toBe('Read report now')
  expect(rowText('[Read [nested] report](https://example.com/a_(b_(c))) now')).toBe('Read [nested] report now')
  expect(rowText('**Read** `report`\n now')).toBe('Read report now')
})

test('Row text respects the whole-word boundary and ellipsis budget', () => {
  expect(rowText('alpha beta gamma', 11)).toBe('alpha beta…')
  expect(rowText('alpha beta gamma', 10)).toBe('alpha…')
  expect(rowText('abcdefghijk', 5)).toBe('…')
  expect(rowText('[abcdefghijk](https://example.com)', 5)).toBe('…')
  expect(rowText('alpha beta', 10)).toBe('alpha beta')
  expect(rowText('alpha', 1)).toBe('…')
  expect(rowText('alpha', 0)).toBe('')
})
