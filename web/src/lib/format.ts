export const fmtUsd = (n: number | null | undefined): string =>
  n == null ? '?' : `$${n.toFixed(n < 0.1 ? 4 : 2)}`

export const fmtTokens = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))

export const fmtMs = (ms: number): string => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`)

export const fmtTime = (ts: number, lang: string): string =>
  new Date(ts).toLocaleTimeString(lang, { hour12: false })

export const shortHash = (h: string | null | undefined, n = 12): string =>
  h ? h.replace('sha256:', '').slice(0, n) : '—'
