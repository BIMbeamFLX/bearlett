import {readFileSync} from 'node:fs'
import {fileURLToPath} from 'node:url'
import {afterEach, describe, expect, it, vi} from 'vitest'
import {
  NAPPELIN_TOKENS,
  TOKEN_NAMES,
  applyTheme,
  namesAny,
  startTheme,
  themeTokens,
  tokenValue
} from './theme'

// the stylesheet is the one source: its :root block must declare exactly the
// defaults this reader paints, or the fallback (no shell, no theme domain) and
// a shell that sends the Nappelin theme would look different
const css = readFileSync(
  fileURLToPath(new URL('./style.css', import.meta.url)),
  'utf8'
)
const rootBlock = /:root\s*\{([^}]*)\}/
  .exec(css)![1]
  .replace(/\/\*[\s\S]*?\*\//g, '')
// a font list quotes its families either way; the token table and the
// stylesheet may not agree on which
const plain = (value: string): string => value.replace(/'/g, '"')
const declared: Record<string, string> = {}
for (const line of rootBlock.split(';')) {
  const m = /^\s*(--[a-z0-9-]+)\s*:\s*(.+?)\s*$/s.exec(line)
  if (m) declared[m[1]] = m[2].trim()
}

const fakeRoot = () => {
  const set: Record<string, string> = {}
  return {
    set,
    style: {setProperty: (n: string, v: string) => void (set[n] = v)}
  }
}

describe('the defaults are the stylesheet', () => {
  it('declares every token, with the same value, and no unknown Hypershell token', () => {
    for (const name of TOKEN_NAMES) {
      expect(plain(declared[name] ?? ''), name).toBe(
        plain(NAPPELIN_TOKENS[name])
      )
    }
  })
})

describe('tokenValue', () => {
  it('takes colours, font lists and lengths by kind', () => {
    expect(tokenValue('--brass', '#F7931A')).toBe('#F7931A')
    expect(tokenValue('--panel', 'rgba(231, 191, 118, 0.03)')).toBe(
      'rgba(231, 191, 118, 0.03)'
    )
    expect(tokenValue('--brass', ' black ')).toBe('black')
    expect(
      tokenValue('--headline', '"Josefin Sans", Georgia, sans-serif')
    ).toBe('"Josefin Sans", Georgia, sans-serif')
    expect(tokenValue('--r', '4px')).toBe('4px')
    expect(tokenValue('--r', '0')).toBe('0')
  })
  it('keeps the default for the wrong kind, a keyword or anything dangerous', () => {
    expect(tokenValue('--brass', '"Josefin Sans"')).toBeNull()
    expect(tokenValue('--headline', '#fff')).toBeNull()
    expect(tokenValue('--r', '#fff')).toBeNull()
    expect(tokenValue('--r', '50%')).toBeNull()
    expect(tokenValue('--brass', 'inherit')).toBeNull()
    expect(tokenValue('--mono', 'unset')).toBeNull()
    expect(tokenValue('--brass', 'url(https://x/y.png)')).toBeNull()
    expect(tokenValue('--brass', 'var(--x)')).toBeNull()
    expect(tokenValue('--brass', '#fff; background: red')).toBeNull()
    expect(tokenValue('--brass', 'a'.repeat(161))).toBeNull()
    expect(tokenValue('--brass', 42)).toBeNull()
  })
})

describe('themeTokens and applyTheme', () => {
  it('reads only known names from a {tokens} payload; a colours-only payload names nothing', () => {
    expect(
      themeTokens({tokens: {'--brass': '#f7931a', '--ember': '#ff6a00', x: 1}})
    ).toEqual({'--brass': '#f7931a'})
    expect(
      namesAny({colors: {background: '#000', text: '#fff', primary: '#00f'}})
    ).toBe(false)
    expect(namesAny(null)).toBe(false)
    expect(namesAny({tokens: []})).toBe(false)
  })

  it('paints from the defaults on every call, so a skin taken off leaves nothing', () => {
    const root = fakeRoot()
    applyTheme({tokens: {'--brass': '#f7931a', '--brass-2': '#c9731a'}}, root)
    expect(root.set['--brass']).toBe('#f7931a')
    expect(root.set['--iron']).toBe(NAPPELIN_TOKENS['--iron'])
    applyTheme({tokens: {}}, root)
    expect(root.set['--brass']).toBe(NAPPELIN_TOKENS['--brass'])
    expect(Object.keys(root.set)).toHaveLength(TOKEN_NAMES.length)
  })
})

describe('startTheme', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('paints the defaults without a shell', () => {
    vi.stubGlobal('napplet', undefined)
    const root = fakeRoot()
    expect(startTheme(root)).toBeUndefined()
    expect(root.set['--brass']).toBe(NAPPELIN_TOKENS['--brass'])
  })

  it('takes an async theme.get and follows theme.changed', async () => {
    const skin = {tokens: {'--brass': '#f7931a'}}
    let handler: ((t: unknown) => void) | null = null
    vi.stubGlobal('napplet', {
      theme: {
        get: async () => skin,
        onChanged: (fn: (t: unknown) => void) => void (handler = fn)
      }
    })
    const root = fakeRoot()
    await startTheme(root)
    expect(root.set['--brass']).toBe('#f7931a')
    handler!({tokens: {'--brass-2': '#111111'}})
    expect(root.set['--brass']).toBe(NAPPELIN_TOKENS['--brass'])
    expect(root.set['--brass-2']).toBe('#111111')
  })

  it('a get that answers after a change was pushed is stale', async () => {
    let handler: ((t: unknown) => void) | null = null
    let resolve!: (t: unknown) => void
    vi.stubGlobal('napplet', {
      theme: {
        get: () => new Promise(r => (resolve = r)),
        onChanged: (fn: (t: unknown) => void) => void (handler = fn)
      }
    })
    const root = fakeRoot()
    const pending = startTheme(root)
    handler!({tokens: {'--brass': '#222222'}})
    resolve({tokens: {'--brass': '#333333'}})
    await pending
    expect(root.set['--brass']).toBe('#222222')
  })

  it('a sync get, a colours-only answer and a throwing service keep the palette', () => {
    vi.stubGlobal('napplet', {
      theme: {
        get: () => ({
          colors: {background: '#0000ff', text: '#fff', primary: '#00f'}
        })
      }
    })
    const root = fakeRoot()
    startTheme(root)
    expect(root.set['--brass']).toBe(NAPPELIN_TOKENS['--brass'])
    vi.stubGlobal('napplet', {
      theme: {
        get: () => {
          throw new Error('no')
        },
        onChanged: () => {
          throw new Error('no')
        }
      }
    })
    startTheme(root)
    expect(root.set['--iron']).toBe(NAPPELIN_TOKENS['--iron'])
  })
})
