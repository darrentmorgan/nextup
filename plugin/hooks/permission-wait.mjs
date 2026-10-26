import { mkdir, writeFile, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createHash, randomUUID } from 'node:crypto'

// Claude Agent SDK entrypoints/sdk/coreTypes.d.ts defines PermissionRequestHookInput
// with hook_event_name: 'PermissionRequest' and BaseHookInput.session_id.
// Unlike generic Notifications, this event specifically requests tool permission.
// Data only: never return a permission decision or print anything to Claude.
async function main() {
  const location = process.env.NEXTUP_BOARD || process.env.CLAUDE_PLUGIN_OPTION_dataDir || process.env.CLAUDE_PLUGIN_DATA
  if (!location?.trim()) return
  let input = ''
  for await (const chunk of process.stdin) input += chunk
  const req = JSON.parse(input)
  if (!req || typeof req.session_id !== 'string' || !req.session_id.trim()) return
  const waiting = req.hook_event_name === 'PermissionRequest'
  // The supplied SDK defines both denial and tool-failure events.
  if (!waiting && !['PostToolUse', 'PermissionDenied', 'PostToolUseFailure', 'Stop'].includes(req.hook_event_name)) return

  const board = location.replace(/^~(?=\/|$)/, homedir())
  const directory = join(board, 'permission-wait')
  // Hash untrusted IDs to prevent traversal and avoid filesystem name limits.
  // Separate files avoid read/modify/write races between different sessions.
  const key = createHash('sha256').update(req.session_id).digest('hex')
  const file = join(directory, `${key}.json`)
  if (!waiting) {
    await unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error })
    return
  }
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const temp = join(directory, `.${key}.${randomUUID()}.tmp`)
  try {
    // Do not persist tool inputs, notification messages, or transcript paths.
    await writeFile(temp, JSON.stringify({ session_id: req.session_id, status: 'waiting-on-permission', at: Date.now() }) + '\n', { mode: 0o600 })
    await rename(temp, file)
  } finally {
    await unlink(temp).catch(() => {})
  }
}

// Tracking failure must never block a tool or change Claude's permission behavior.
try { await main() } catch {}
