import type { EngineInterface } from 'claude-code'
import type { Mark, Marks } from '../types'

/** The four file operations the Marks ledger needs. */
export type Files = {
  exists(path: string): Promise<boolean>
  read(path: string): Promise<string>
  write(path: string, text: string): Promise<void>
  mtime(path: string): Promise<number>
}

/** Adapts the engine's file operations to the Marks ledger. */
export function filesOf($: EngineInterface): Files {
  return {
    exists: path => $.fs.exists(path),
    read: async path => await $.fs.read(path) as string,
    write: async (path, text) => { await $.fs.write(path, text) },
    mtime: async path => (await $.fs.stat(path)).mtimeMs,
  }
}

async function mark(f: Files, dir: string, ids: string[], fields: Omit<Mark, 'at'>, now: number): Promise<Marks> {
  const path = `${dir}/mod-marks.json`
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = await f.exists(path) ? await f.mtime(path) : null
    const marks = await readMarks(f, dir)
    for (const id of ids) {
      const current = marks[id]
      if (current && current.at > now) continue
      marks[id] = { ...(current?.keep ? { keep: true } : {}), ...fields, at: now }
    }
    const after = await f.exists(path) ? await f.mtime(path) : null
    if (before !== after && attempt < 2) continue
    await f.write(path, JSON.stringify(marks, null, 1))
    return marks
  }
  throw new Error('Unreachable Marks attempt')
}

export const done = (f: Files, dir: string, ids: string[], now: number): Promise<Marks> => mark(f, dir, ids, { done: true }, now)
export const drop = (f: Files, dir: string, ids: string[], now: number): Promise<Marks> => mark(f, dir, ids, { dropped: true }, now)
export const park = (f: Files, dir: string, ids: string[], until: number, now: number): Promise<Marks> => mark(f, dir, ids, { parkUntil: until }, now)
export const undo = (f: Files, dir: string, ids: string[], now: number): Promise<Marks> => mark(f, dir, ids, {}, now)

export function isHidden(m: Marks, id: string, now: number): boolean {
  return !!m[id]?.done || !!m[id]?.dropped || (m[id]?.parkUntil ?? -Infinity) > now
}

export function doneBetween(m: Marks, from: number, to: number): { id: string; at: number }[] {
  return Object.entries(m).filter(([, k]) => !!k?.done && !k.dropped && Number.isFinite(k.at) && from <= k.at && k.at <= to)
    .map(([id, k]) => ({ id, at: k.at })).sort((a, b) => b.at - a.at)
}

export function isParked(m: Marks, id: string, now: number): boolean {
  return (m[id]?.parkUntil ?? -Infinity) > now && !m[id]?.done && !m[id]?.dropped
}

export function isKept(m: Marks, id: string): boolean {
  return !!m[id]?.keep
}

export async function readMarks(f: Files, dir: string): Promise<Marks> {
  const path = `${dir}/mod-marks.json`
  if (!(await f.exists(path))) return {}
  const text = await f.read(path)
  let value: unknown
  try { value = JSON.parse(text) } catch { throw new MarksUnreadable() }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new MarksUnreadable()
  return value as Marks
}

export class MarksUnreadable extends Error {
  constructor() {
    super('mod-marks.json is unreadable (not valid JSON). Fix or restore it, then Retry.')
    this.name = 'MarksUnreadable'
  }
}
