import type { EngineInterface } from 'claude-code'
import { isAnswerable, minutesBlocked, optionsOf, ruleEligible } from './model'
import type { Ask, Field } from './model'

/** Choices for a field: enum options with the recommended one first, or Yes/No for a boolean. */
export function choicesOf(field: Field, recommended?: unknown) {
  if (field.type !== 'boolean') return optionsOf(field, recommended)
  const yes = recommended !== false && recommended !== 'false'
  return [{ value: 'true', label: 'Yes', recommended: yes && recommended !== undefined }, { value: 'false', label: 'No', recommended: !yes }].sort((x, y) => Number(y.recommended) - Number(x.recommended))
}
/** What the card starts with: the ask's default, else the field default, else the first choice. */
export function initialValues(ask: Ask) {
  return Object.fromEntries(Object.entries(ask.schema?.properties ?? {}).map(([name, f]) => [name, ask.default?.[name] ?? f.default ?? (f.type === 'boolean' ? true : optionsOf(f)[0]?.value ?? '')]))
}
type Els = ReturnType<EngineInterface['ui']['resolve']>
export type CardProps = {
  /** Every press goes through these, so it always shows a result (events.ts act/view, bound to the engine by the caller). */
  act: <A extends unknown[]>(action: string, fn: (...a: A) => unknown, o?: { label?: string }) => (...a: A) => Promise<void>
  view: <A extends unknown[]>(fn: (...a: A) => unknown) => (...a: A) => Promise<void>
  ask: Ask; more: number; now: number; picked: Record<string, unknown>; remember: boolean; quiet: boolean
  change: (name: string, value: unknown) => void | Promise<void>; toggle: () => void | Promise<void>
  send: (cancel?: boolean) => void | Promise<void>; open: (url?: string) => void | Promise<void>
}
export function ElicitCard(els: Els, props: CardProps) {
  const { Box, Text, Button } = els
  const { ask, picked } = props
  const browser = ask as Ask & { kind?: string; mode?: string; url?: string }
  const inBrowser = browser.kind === 'browser' || browser.mode === 'url'
  const answerable = !inBrowser && isAnswerable(ask.schema)
  const minutes = minutesBlocked(ask, props.now)
  return <Box key="ask-card" flexDirection="column" gap="xs">
    <Text weight="bold">One question</Text>
    <Text>{`${ask.thread} is blocked, ${minutes} min`}</Text>
    <Text>{ask.message}</Text>
    {inBrowser ? <Box flexDirection="column"><Text>Needs you in the browser</Text><Button key="ask-open" label={browser.url ? `Open ${browser.url}` : 'Open'} onPress={props.act('open-question', () => props.open(browser.url), { label: 'open the question' })} /></Box> : !answerable ? <Button key="ask-open" label="Open session" onPress={props.act('open-question', () => props.open(), { label: 'open the question' })} /> : <Box flexDirection="column" gap="xs">
      {Object.entries(ask.schema.properties ?? {}).map(([name, field]) => {
        const choices = choicesOf(field, ask.default?.[name] ?? field.default)
        return <Box key={`ask-row-${name}`} flexDirection="column" gap="xs">
          <Text>{field.title ?? name}</Text>
          {choices.length ? ('Select' in els ? <els.Select key={`ask-field-${name}`} value={String(picked[name] ?? '')} options={choices.map(o => ({ value: o.value, label: `${o.label}${o.recommended ? ' (Recommended)' : ''}` }))} onSelect={props.view((value: string) => props.change(name, value))} /> : choices.map(o => <Button key={`ask-option-${name}-${o.value}`} label={`${o.label}${o.recommended ? ' (Recommended)' : ''}${String(picked[name]) === o.value ? ' ✓' : ''}`} onPress={props.view(() => props.change(name, o.value))} />)) : 'Input' in els ? <els.Input key={`ask-field-${name}`} value={String(picked[name] ?? '')} onInput={value => void props.change(name, value)} onSubmit={() => void props.send()} /> : <Text>Use nextup-answer to enter text.</Text>}
        </Box>
      })}
      {ruleEligible(ask) ? <Button key="ask-remember" plain label={`${props.remember ? '☑' : '☐'} Always answer this way`} onPress={props.view(() => props.toggle())} /> : null}
      <Box gap="xs"><Button key="ask-send" label="Send answer" onPress={props.act('answer', () => props.send(), { label: 'send the answer' })} /><Button key="ask-skip" label="Skip (cancel)" onPress={props.act('skip-question', () => props.send(true), { label: 'skip the question' })} /></Box>
    </Box>}
    {props.quiet && props.now - ask.askedAt > 120_000 ? <Text key="ask-quiet" size="caption">{`Quiet for ${minutes} min`}</Text> : null}
    {props.more > 0 ? <Text key="ask-more" size="caption">{`${props.more} more waiting`}</Text> : null}
  </Box>
}
