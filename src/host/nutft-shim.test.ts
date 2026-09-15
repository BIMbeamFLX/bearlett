import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {installNutftShim} from './nutft-shim'
import {UNSAFE_OPEN_MESSAGE, readNutftLease} from './nutft-contract'

const SEED = '0c9e'.repeat(16)

/**
 * A frame with a parent and nothing else. The shim posts to the parent and
 * listens for replies whose source is that parent, so this is all it touches.
 */
const frame = () => {
  const listeners = new Set<(event: MessageEvent) => void>()
  const posted: Array<{type: string; id: string}> = []
  const parent = {
    postMessage: vi.fn((message: {type: string; id: string}) => {
      posted.push(message)
    })
  }
  return {
    parent,
    posted,
    addEventListener: (
      _type: string,
      listener: (event: MessageEvent) => void
    ) => listeners.add(listener),
    removeEventListener: (
      _type: string,
      listener: (event: MessageEvent) => void
    ) => listeners.delete(listener),
    reply: (data: unknown, source: unknown = parent) =>
      listeners.forEach(listener => listener({source, data} as MessageEvent))
  }
}

let inner: ReturnType<typeof frame>
let quiet: Array<ReturnType<typeof vi.spyOn>>

beforeEach(() => {
  inner = frame()
  vi.stubGlobal('window', inner)
  quiet = (['log', 'info', 'warn', 'error', 'debug', 'trace'] as const).map(
    method => vi.spyOn(console, method).mockImplementation(() => {})
  )
})

afterEach(() => {
  /* Nothing in the lease path writes to the console, whatever it carried. */
  for (const spy of quiet) expect(spy).not.toHaveBeenCalled()
  quiet.forEach(spy => spy.mockRestore())
  vi.unstubAllGlobals()
})

/** Acquire, answer from the parent with `result`, and hand back the outcome. */
const acquireWith = async (result: unknown) => {
  const shim = installNutftShim()
  const lease = shim.acquire()
  const message = inner.posted[inner.posted.length - 1]
  expect(message.type).toBe('nutft.acquire')
  inner.reply({type: 'nutft.acquire.result', id: message.id, ok: true, result})
  try {
    return await lease
  } finally {
    shim.dispose()
  }
}

describe('installNutftShim().acquire', () => {
  it('keeps the random wallet when the lease carries no seed', async () => {
    for (const result of [undefined, null, {}, {seed: undefined}])
      expect(await acquireWith(result)).toEqual({})
  })

  it('hands over a 64-hex seed exactly as the shell sent it', async () => {
    expect(await acquireWith({seed: SEED})).toEqual({seed: SEED})
  })

  const refused: Array<[string, unknown]> = [
    ['an empty string', {seed: ''}],
    ['null', {seed: null}],
    ['a number', {seed: 4242424242}],
    ['63 characters', {seed: SEED.slice(1)}],
    ['65 characters', {seed: SEED + '0'}],
    ['uppercase hex', {seed: SEED.toUpperCase()}],
    ['non-hex characters', {seed: 'xy'.repeat(32)}],
    ['a trailing newline', {seed: SEED + '\n'}],
    ['surrounding spaces', {seed: ` ${SEED} `}],
    ['a mnemonic', {seed: 'zoo '.repeat(11) + 'wrong'}],
    ['a seed sent bare instead of in a lease', SEED],
    ['a list', [SEED]]
  ]

  for (const [name, result] of refused)
    it(`fails closed on ${name}`, async () => {
      const outcome = await acquireWith(result).then(
        () => null,
        (error: Error) => error
      )
      expect(outcome).toBeInstanceOf(Error)
      expect(outcome!.message).toBe(UNSAFE_OPEN_MESSAGE)
      const said = `${outcome!.message} ${String(outcome!.stack)}`
      for (const secret of [SEED, SEED.toUpperCase(), 'xy'.repeat(32)])
        expect(said).not.toContain(secret)
      expect(said).not.toContain('zoo')
    })

  it('ignores a reply that does not come from its parent', async () => {
    const shim = installNutftShim()
    const lease = shim.acquire()
    const [message] = inner.posted
    inner.reply(
      {type: 'nutft.acquire.result', id: message.id, ok: true, result: {}},
      {postMessage: vi.fn()}
    )
    inner.reply({
      type: 'nutft.acquire.result',
      id: message.id,
      ok: true,
      result: {seed: SEED}
    })
    expect(await lease).toEqual({seed: SEED})
    shim.dispose()
  })

  it('passes a refusal from the shell through without adding to it', async () => {
    const shim = installNutftShim()
    const lease = shim.acquire()
    const [message] = inner.posted
    inner.reply({
      type: 'nutft.acquire.result',
      id: message.id,
      ok: false,
      error: UNSAFE_OPEN_MESSAGE
    })
    await expect(lease).rejects.toThrow(UNSAFE_OPEN_MESSAGE)
    shim.dispose()
  })
})

describe('readNutftLease', () => {
  it('never repairs a seed into a valid one', () => {
    for (const seed of [SEED.toUpperCase(), ` ${SEED}`, SEED.slice(0, 62)])
      expect(() => readNutftLease({seed})).toThrow(UNSAFE_OPEN_MESSAGE)
  })

  it('reads only undefined, null or a plain object holding at most a seed', () => {
    expect(readNutftLease(undefined)).toEqual({})
    expect(readNutftLease(null)).toEqual({})
    expect(readNutftLease({})).toEqual({})
    expect(readNutftLease({seed: undefined})).toEqual({})
    expect(readNutftLease({seed: SEED})).toEqual({seed: SEED})
    expect(readNutftLease(JSON.parse(`{"seed":"${SEED}"}`))).toEqual({
      seed: SEED
    })
  })

  /* Each of these is a seed in the wrong place, not the absence of one. Read
     as "no seed", it would open a random wallet instead of the account's. */
  const shapes: Array<[string, () => unknown]> = [
    ['32 bytes', () => new Uint8Array(32)],
    [
      'the seed as bytes',
      () => Uint8Array.from(SEED.match(/../g)!, byte => parseInt(byte, 16))
    ],
    ['a String object', () => new String(SEED)],
    ['a Map', () => new Map([['seed', SEED]])],
    ['a seed under seedHex', () => ({seedHex: SEED})],
    ['a mnemonic field', () => ({mnemonic: 'abandon '.repeat(23) + 'art'})],
    ['a nested lease', () => ({lease: {seed: SEED}})],
    ['a seed on the prototype', () => ({__proto__: {seed: SEED}})],
    ['a seed beside another key', () => ({seed: SEED, account: 'a'})],
    ['an empty lease with another key', () => ({extra: true})],
    [
      'an object without a prototype',
      () => Object.assign(Object.create(null), {seed: SEED})
    ],
    ['a symbol key', () => ({[Symbol('seed')]: SEED})],
    ['a class instance', () => new (class Lease {})()],
    ['a date', () => new Date()],
    ['a number', () => 42],
    ['a boolean', () => true]
  ]

  for (const [name, shape] of shapes)
    it(`refuses ${name}`, () => {
      let said = ''
      try {
        readNutftLease(shape())
        said = 'accepted'
      } catch (error) {
        said = String((error as Error).message)
      }
      expect(said).toBe(UNSAFE_OPEN_MESSAGE)
    })
})
