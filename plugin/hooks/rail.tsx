// A rail that runs a packet left to right while the board rescans, and rests as a dim line otherwise.
// Drawn on the surface's own frame clock, so only this line redraws.
import type { ClientModule } from 'claude-code'
import { tone } from './theme'

type Props = { active: boolean; width: number; color: string }
type Ref = { phase: number; active: boolean }

const Rail: ClientModule<Props, { ref: Ref }> = (props, surface) => {
  const { Text } = surface.elements
  const ref = surface.state?.ref ?? { phase: 0, active: props.active }
  ref.active = props.active
  if (surface.state === undefined) {
    surface.setState({ ref })
    surface.every(110, () => {
      if (ref.active) {
        ref.phase += 1
        surface.setState({ ref })
      }
    })
  }
  const width = Math.max(1, surface.columns || props.width)
  if (!ref.active) return <Text color={tone.quiet}>{'─'.repeat(width)}</Text>
  const head = ref.phase % (width + 8)
  const cells = Array.from({ length: width }, (_, i) => (i === head ? '●' : i === head - 1 ? '•' : '─'))
  return <Text color={props.color}>{cells.join('')}</Text>
}

export default Rail
