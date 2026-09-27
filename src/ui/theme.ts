// NAP-THEME for the Bearlett napplets, the way the 600B Timelock TCG reads it
// (TCG600nap site/napplet.js, docs/brand-hypershell.md): the chrome is the
// Nappelin Hypershell, painted from the shell's theme service when there is
// one and from these defaults when there is not. The nineteen names are
// nappelin's own design-system.css names (apps/hangar/src/theme.ts) and the
// ONLY ones a shell may set; theme.test.ts holds this table to hypershell.css
// so the stylesheet stays the one source. A payload is laid over the defaults
// on every paint, so a guild skin that is taken off leaves nothing behind.
//
// NAP-THEME's `colors` map is not read: a colours-only payload names nothing
// and keeps the palette. Only a `tokens` payload naming these tokens repaints,
// which is what the Hypershell theme service sends.

export const TOKEN_NAMES = [
  '--iron',
  '--brass',
  '--brass-2',
  '--brass-3',
  '--parchment',
  '--signal',
  '--panel',
  '--well',
  '--hairline',
  '--emphasis',
  '--divider',
  '--body-ink',
  '--iron-850',
  '--iron-800',
  '--iron-750',
  '--rust',
  '--headline',
  '--mono',
  '--r'
] as const

export type TokenName = (typeof TOKEN_NAMES)[number]
export type Tokens = Record<TokenName, string>

export const NAPPELIN_TOKENS: Readonly<Tokens> = Object.freeze({
  '--iron': '#0f0c08',
  '--brass': '#e7bf76',
  '--brass-2': '#c9973f',
  '--brass-3': '#8f6a2a',
  '--parchment': '#ece3d0',
  '--signal': '#6de8a6',
  '--panel': 'rgba(231, 191, 118, 0.03)',
  '--well': 'rgba(231, 191, 118, 0.05)',
  '--hairline': 'rgba(231, 191, 118, 0.14)',
  '--emphasis': 'rgba(231, 191, 118, 0.25)',
  '--divider': 'rgba(231, 191, 118, 0.12)',
  '--body-ink': 'rgba(236, 227, 208, 0.82)',
  '--iron-850': '#14100b',
  '--iron-800': '#191410',
  '--iron-750': '#201a13',
  '--rust': '#d06b45',
  '--headline': '"Josefin Sans", Georgia, sans-serif',
  '--mono': '"IBM Plex Mono", ui-monospace, Consolas, monospace',
  '--r': '0'
})

// A colour is hex, rgb()/rgba()/hsl()/hsla() with numbers only, or
// black/white/transparent; --headline and --mono are font family lists; --r is
// 0 or a px/rem/em length. Anything holding url(, image-set(, var(, env(,
// expression(, @, ;, {, }, <, a backslash or a line break keeps the default:
// a url() in a token would be fetched by every viewer.
const NUMBER = '[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:%|deg|rad|grad|turn)?'
const COLOR = new RegExp(
  '^(?:#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})' +
    `|(?:rgba?|hsla?)\\(\\s*${NUMBER}(?:\\s*[,/]\\s*${NUMBER}|\\s+${NUMBER}){2,3}\\s*\\)` +
    '|black|white|transparent)$',
  'i'
)
const FAMILY = '(?:"[\\w .-]+"|\'[\\w .-]+\'|[a-z][\\w-]*(?: [a-z][\\w-]*)*)'
const FONT_LIST = new RegExp(`^${FAMILY}(?:\\s*,\\s*${FAMILY})*$`, 'i')
const LENGTH = /^(?:0|(?:\d+(?:\.\d+)?|\.\d+)(?:px|rem|em))$/
const CSS_WIDE = /^(?:inherit|initial|unset|revert|revert-layer)$/i
const NEVER = /url\(|image-set\(|var\(|env\(|expression\(|[@;{}<\\\n\r\f]/i

/** The value a token may take from a payload, or null to keep the default. */
export const tokenValue = (name: TokenName, value: unknown): string | null => {
  if (typeof value !== 'string' || value.length > 160 || NEVER.test(value))
    return null
  const clean = value.trim()
  const shape =
    name === '--r'
      ? LENGTH
      : name === '--headline' || name === '--mono'
        ? FONT_LIST
        : COLOR
  if (!shape.test(clean) || CSS_WIDE.test(clean)) return null
  // the shape admits rgb(1 2 3 4) which a browser drops; where the page can
  // ask, a colour the browser would not paint keeps the default
  const css = (
    globalThis as {CSS?: {supports?: (p: string, v: string) => boolean}}
  ).CSS
  if (shape === COLOR && css?.supports && !css.supports('color', clean))
    return null
  return clean
}

/** The tokens a `{tokens}` payload names, each already checked. */
export const themeTokens = (payload: unknown): Partial<Tokens> => {
  const out: Partial<Tokens> = {}
  const tokens =
    payload && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as {tokens?: unknown}).tokens
      : null
  if (!tokens || typeof tokens !== 'object' || Array.isArray(tokens)) return out
  for (const name of TOKEN_NAMES) {
    const value = tokenValue(name, (tokens as Record<string, unknown>)[name])
    if (value !== null) out[name] = value
  }
  return out
}

export const namesAny = (payload: unknown): boolean =>
  Object.keys(themeTokens(payload)).length > 0

/** Where the tokens are written: the document root, or a stand-in in tests. */
export type PaintRoot = {
  style: {setProperty(name: string, value: string): void}
}

let painted: Tokens = {...NAPPELIN_TOKENS}

/** The chrome tokens as last painted. */
export const paintedTokens = (): Tokens => ({...painted})

// Every paint starts from the defaults: a skin that sets three tokens and is
// then taken off must leave nothing of itself behind.
export const applyTheme = (
  payload: unknown,
  root?: PaintRoot | null
): Tokens => {
  const target =
    root ??
    (typeof document !== 'undefined'
      ? (document.documentElement as unknown as PaintRoot)
      : null)
  const next: Tokens = {...NAPPELIN_TOKENS, ...themeTokens(payload)}
  if (target?.style?.setProperty) {
    for (const [name, value] of Object.entries(next)) {
      target.style.setProperty(name, value)
    }
  }
  painted = next
  return next
}

type ThemeService = {
  get?: () => unknown
  onChanged?: (handler: (theme: unknown) => void) => unknown
}

/**
 * Paint now and repaint on every shell change. Sources, first that names a
 * token wins: the theme service (`napplet.theme.get()`, then `theme.changed`
 * pushes), else the defaults. Safe to call anywhere; without a shell or
 * without the theme domain it paints the defaults and returns.
 */
export const startTheme = (
  root?: PaintRoot | null
): Promise<void> | undefined => {
  applyTheme(null, root)
  const shell = (globalThis as {napplet?: {theme?: ThemeService}}).napplet
  const service = shell?.theme
  if (!service) return undefined
  let changed = false
  if (typeof service.onChanged === 'function') {
    try {
      service.onChanged(next => {
        changed = true
        applyTheme(next, root)
      })
    } catch {
      // keeps its palette
    }
  }
  // a get() that answers after a change was already pushed is stale
  const paint = (payload: unknown): void => {
    if (!changed && namesAny(payload)) applyTheme(payload, root)
  }
  let first: unknown = null
  try {
    first = typeof service.get === 'function' ? service.get() : service
  } catch {
    first = null
  }
  if (first && typeof (first as Promise<unknown>).then === 'function') {
    return (first as Promise<unknown>).then(paint, () => undefined)
  }
  paint(first)
  return undefined
}
