// One place for what each theme colour means; every surface takes its colour from here.
// quiet is for decoration that must still be seen, never `subtle`, which is near the background.
export const tone = { accent: 'suggestion', brand: 'claude', done: 'success', warn: 'warning', fail: 'error', note: 'remember', quiet: 'inactive', hover: 'subtle' } as const

// Momentum roles use semantic theme colours on every surface.
export const momentum = { hero: tone.brand, needs: tone.fail, win: tone.done, slipped: tone.warn, quiet: tone.quiet } as const

// Identity (PRODUCT.md, Visual Identity): Darren's 22 Oct pick, B "Panels" with C's Next | Session segmented tabs.
// The host gives a plugin theme keys (which follow light and dark) or raw strings (which do not), and no way to ask which
// theme is on. So text and accents use theme keys, and fills are neutral or tinted alphas that read on both. The spec's
// terracotta accent is the host's own `claude` key; its good/bad/warn are `success`/`error`/`warning`.
// Spec tokens (modern.html) for reference: light panel #fff on #f5f3ee, line #e4dfd3, track #ece8dd, accent #c4623b tint #f6e4da;
// dark panel #211f1c on #171614, line #34312b, track #2e2b26, accent #e08a63 tint #3a2a22.
export const desk = {
  card: 'rgba(128,128,128,0.09)', track: 'rgba(128,128,128,0.18)', raised: 'rgba(128,128,128,0.28)', line: 'rgba(128,128,128,0.32)',
  hero: 'rgba(128,128,128,0.09)', ring: 'rgba(217,119,87,0.40)', needs: 'rgba(230,80,70,0.07)', win: 'rgba(60,175,105,0.08)', slipped: 'rgba(225,160,30,0.09)',
} as const

export const surfaceTheme = (surface: string) => {
  const terminal = surface === 'terminal'
  return {
    hover: terminal ? tone.hover : desk.track,
    title: terminal ? 'caption' as const : 'body' as const,
    // A card is a 1px bordered panel: the border is the spec's line grey unless the card carries a role colour.
    card: (color: string = tone.quiet) => terminal ? { borderColor: color } : { backgroundColor: desk.card, borderColor: color === tone.quiet ? desk.line : color },
    momentum: (role: keyof typeof momentum) => terminal ? { borderColor: momentum[role] } : { borderColor: role === 'quiet' ? desk.line : momentum[role], backgroundColor: role === 'quiet' ? desk.card : desk[role] },
    rows: terminal ? {} : { paddingY: 'xs' as const },
  }
}

/** A project folder name as a heading: dashes and underscores to spaces, kept short. */
export const humanize = (v: string, n = 28) => {
  const t = v.replace(/[-_]+/g, ' ').trim()
  return t.length <= n ? t : `${t.slice(0, n - 1).trimEnd()}…`
}
