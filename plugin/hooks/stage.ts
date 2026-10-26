import type { PR, Thread } from '../types'
import { rowText, threadRow } from './rowtext'

export type StagePR = PR & { branch?: string }
export type StageName = 'red-ci' | 'ready-to-merge' | 'build' | 'stuck' | 'idea'
export type Stage = { stage: StageName; skill: string; reason: string; live: boolean }
export const LIVE_STAGES = new Set<StageName>(['red-ci', 'ready-to-merge'])
export const threadRepo = (t: Thread) => (/cd "([^"]+)"/.exec(t.resume)?.[1] ?? '').replace(/\/\.claude\/worktrees\/[^/]+.*$/, '')
const result = (stage: StageName, skill: string, reason: string): Stage => ({ stage, skill, reason: rowText(reason), live: LIVE_STAGES.has(stage) })

/** Match both branch and repository; a common branch name alone is not launch evidence. */
export function stageOf(t: Thread, prs: StagePR[], now = Date.now()): Stage | null {
  if (t.progress >= 100) return null
  const repo = /(?:^|\/)github\.com\/([^/]+\/[^/]+)(?:\/|$)/.exec(threadRepo(t))?.[1]
    ?? /^https:\/\/github\.com\/([^/]+\/[^/]+)(?:\/|$)/.exec(t.link)?.[1]
  const matching = t.branch && t.branch !== 'HEAD' && repo
    ? prs.filter(p => p.branch === t.branch && p.repo.toLowerCase() === repo.toLowerCase()) : []
  const red = matching.find(p => p.checks === 'FAILURE' || p.checks === 'ERROR')
  if (red) return result('red-ci', 'mattpocock-skills:diagnosing-bugs', `PR #${red.number} checks failing`)
  const green = matching.find(p => !p.draft && p.checks === 'SUCCESS')
  if (green) return result('ready-to-merge', 'code-review', `PR #${green.number} checks passing; not a draft`)
  const last = Date.parse(t.last)
  if (t.blocked || (Number.isFinite(last) && now - last >= 2 * 86400_000))
    return result('stuck', 'darren-core:ambitious-prompt', t.blocked ? 'Thread is blocked' : `No progress since ${t.last}`)
  if ((threadRepo(t) || (t.branch && t.branch !== 'HEAD')) && t.finish.trim())
    return result('build', 'darren-core:worker-dispatch', `Finish line: ${t.finish.trim()}`)
  if (t.progress === 0 && !t.finish.trim() && (!t.branch || ['HEAD', 'main', 'master'].includes(t.branch)))
    return result('idea', 'mattpocock-skills:grilling', 'No finish line or feature branch; progress is 0')
  return null
}

export const delegateThreads = (threads: Thread[], prs: StagePR[], now: number) => threads
  .filter(t => threadRepo(t) && t.finish.trim() && !t.blocked && stageOf(t, prs, now)?.stage === 'build')
  .sort((a, b) => (b.value ?? 2) - (a.value ?? 2) || a.id.localeCompare(b.id))
  .slice(0, 3)
  .map(threadRow)

export const stageHint = (s: Stage) => `Next stage: ${s.stage}. ${({ build: 'Worker dispatch', stuck: 'Ambitious prompt', idea: 'Grilling', 'red-ci': 'Diagnosing bugs', 'ready-to-merge': 'Code review' })[s.stage]} fits.`
export const launchLabel = (s: Stage) => `${s.stage === 'red-ci' ? 'Fix' : s.stage === 'ready-to-merge' ? 'Review' : 'Delegate'} with ${s.skill.split(':').pop()}`
