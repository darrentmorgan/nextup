// Four stale finishes, two recent finishes (including the exact boundary),
// and four live lanes, including one that started more than two hours ago.
export const now = 12 * 60 * 60_000
export const twoHours = 2 * 60 * 60_000
export const lanes = Array.from({ length: 10 }, (_, i) => ({
  id: `lane-${i}`,
  name: `Worker ${i}`,
  at: now - 4 * 60 * 60_000 + i * 1000,
  ...(i < 4 ? { end: now - twoHours - 1 - i * 1000 } :
    i === 4 ? { end: now - twoHours } :
    i === 5 ? { end: now - 60_000 } : {}),
}))
