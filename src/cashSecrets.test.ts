import {beforeEach, describe, expect, it, vi} from 'vitest'
import {HDKey} from '@scure/bip32'
import {bytesToHex, hexToBytes} from '@noble/hashes/utils.js'
import {CASH_ROOT_PURPOSE, encodeCx1} from '@lnurlcash/kit'

// same in-memory localStorage stand-in as storage.test.ts/trustedMints.test.ts -
// cashSecrets.ts persists per-SERVICE indices there, and a fresh module graph
// per test keeps them from bleeding across cases
const store = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => void store.set(key, String(value)),
  removeItem: (key: string) => void store.delete(key),
  clear: () => store.clear(),
  key: () => null,
  get length() {
    return store.size
  }
})

const SEED =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

let cashSecrets: typeof import('./cashSecrets')
let keys: typeof import('./keys')

beforeEach(async () => {
  store.clear()
  vi.resetModules()
  cashSecrets = await import('./cashSecrets')
  keys = await import('./keys')
})

const loadRoot = () => {
  const node = keys.deriveLud25CashRootNode(SEED)
  cashSecrets.setCashRoot(node)
  return node
}

describe('generateNoteSecret fallback without a loaded root', () => {
  it('cashSecretAtIndex/nextCashSecret are null with no root set', () => {
    expect(cashSecrets.cashSecretAtIndex('mint.example', 0)).toBeNull()
    expect(cashSecrets.nextCashSecret('mint.example')).toBeNull()
  })

  it('goes back to null after setCashRoot(null)', () => {
    loadRoot()
    expect(cashSecrets.nextCashSecret('mint.example')).not.toBeNull()
    cashSecrets.setCashRoot(null)
    expect(cashSecrets.nextCashSecret('mint.example')).toBeNull()
  })

  it('refuses a payable mint secret when it cannot be recovered from the seed', () => {
    expect(() =>
      cashSecrets.requireRecoverableCashSecret('mint.example')
    ).toThrow(/seed-derived cash key/)
    expect(cashSecrets.nextCashSecretIndex('mint.example')).toBe(0)
  })
})

describe('deterministic secrets', () => {
  it('the same seed + domain + index always yields the same secret', () => {
    loadRoot()
    const a = cashSecrets.cashSecretAtIndex('mint.example', 0)
    cashSecrets.setCashRoot(null)
    loadRoot() // re-derive from the same seed, as a fresh install would
    const b = cashSecrets.cashSecretAtIndex('mint.example', 0)
    expect(a).not.toBeNull()
    expect(a).toBe(b)
  })

  it('differs per domain and per index', () => {
    loadRoot()
    const a0 = cashSecrets.cashSecretAtIndex('a.example', 0)
    const b0 = cashSecrets.cashSecretAtIndex('b.example', 0)
    const a1 = cashSecrets.cashSecretAtIndex('a.example', 1)
    expect(a0).not.toBe(b0)
    expect(a0).not.toBe(a1)
  })

  it('is a bare 32-byte hex value, the same shape a preimage already is', () => {
    loadRoot()
    expect(cashSecrets.cashSecretAtIndex('mint.example', 0)).toMatch(
      /^[0-9a-f]{64}$/
    )
  })

  it('cashSecretAtIndex is pure - repeated calls never advance the counter', () => {
    loadRoot()
    cashSecrets.cashSecretAtIndex('mint.example', 0)
    cashSecrets.cashSecretAtIndex('mint.example', 0)
    expect(cashSecrets.nextCashSecretIndex('mint.example')).toBe(0)
  })
})

describe('per-SERVICE index counters', () => {
  it('persists a recoverable mint secret before returning it', () => {
    loadRoot()
    const secret = cashSecrets.requireRecoverableCashSecret('mint.example')
    expect(secret).toBe(cashSecrets.cashSecretAtIndex('mint.example', 0))
    expect(cashSecrets.nextCashSecretIndex('mint.example')).toBe(1)
  })

  it('nextCashSecret claims and persists sequential indices per domain', () => {
    loadRoot()
    const first = cashSecrets.nextCashSecret('mint.example')
    const second = cashSecrets.nextCashSecret('mint.example')
    expect(first).not.toBe(second)
    expect(first).toBe(cashSecrets.cashSecretAtIndex('mint.example', 0))
    expect(second).toBe(cashSecrets.cashSecretAtIndex('mint.example', 1))
    expect(cashSecrets.nextCashSecretIndex('mint.example')).toBe(2)
  })

  it('tracks each domain independently', () => {
    loadRoot()
    cashSecrets.nextCashSecret('a.example')
    cashSecrets.nextCashSecret('a.example')
    cashSecrets.nextCashSecret('b.example')
    expect(cashSecrets.nextCashSecretIndex('a.example')).toBe(2)
    expect(cashSecrets.nextCashSecretIndex('b.example')).toBe(1)
  })

  it('survives a fresh module load (persisted, not just in-memory)', async () => {
    loadRoot()
    cashSecrets.nextCashSecret('mint.example')
    cashSecrets.nextCashSecret('mint.example')
    vi.resetModules()
    const reloaded: typeof import('./cashSecrets') =
      await import('./cashSecrets')
    expect(reloaded.nextCashSecretIndex('mint.example')).toBe(2)
  })

  it('clearCashSecretIndices resets every domain', () => {
    loadRoot()
    cashSecrets.nextCashSecret('mint.example')
    cashSecrets.clearCashSecretIndices()
    expect(cashSecrets.nextCashSecretIndex('mint.example')).toBe(0)
  })
})

describe('mergeCashSecretIndices (backup restore)', () => {
  it('raises a domain counter to the incoming value', () => {
    cashSecrets.mergeCashSecretIndices({'mint.example': 5})
    expect(cashSecrets.nextCashSecretIndex('mint.example')).toBe(5)
  })

  it('never lowers an existing counter', () => {
    loadRoot()
    cashSecrets.nextCashSecret('mint.example') // -> index 1
    cashSecrets.mergeCashSecretIndices({'mint.example': 0})
    expect(cashSecrets.nextCashSecretIndex('mint.example')).toBe(1)
  })

  it('ignores malformed entries without throwing', () => {
    expect(() =>
      cashSecrets.mergeCashSecretIndices({
        'mint.example': -1,
        'other.example': 1.5,
        'huge.example': 10_000_000,
        [123 as unknown as string]: 'not a number',
        __proto__: {polluted: true}
      } as unknown)
    ).not.toThrow()
    expect(cashSecrets.nextCashSecretIndex('mint.example')).toBe(0)
    expect(cashSecrets.nextCashSecretIndex('other.example')).toBe(0)
    expect(cashSecrets.nextCashSecretIndex('huge.example')).toBe(0)
    // the prototype-pollution attempt above must not have actually reached
    // Object.prototype - an unrelated fresh domain must read as 0, not
    // {polluted: true}
    expect((({} as Record<string, unknown>).polluted as unknown) ?? null).toBe(
      null
    )
  })

  it('no-ops on non-object input', () => {
    expect(() => cashSecrets.mergeCashSecretIndices(null)).not.toThrow()
    expect(() => cashSecrets.mergeCashSecretIndices(undefined)).not.toThrow()
    expect(() => cashSecrets.mergeCashSecretIndices('nope')).not.toThrow()
  })
})

describe('readCashSecretIndices (backup build)', () => {
  it('reflects the current counters', () => {
    loadRoot()
    cashSecrets.nextCashSecret('mint.example')
    expect(cashSecrets.readCashSecretIndices()).toEqual({'mint.example': 1})
  })

  it('is empty on a fresh wallet', () => {
    expect(cashSecrets.readCashSecretIndices()).toEqual({})
  })
})

// LUD-25 test vector 1 (lnurl/luds branch lnurlcash at 265759f): the
// spec's own BIP-32 seed, domain mint.example, branch key with odd y. The
// Part 2 ladder must land on these bytes exactly or a mint scanning the
// same branch (a registered username's auto-mint) and this wallet would
// disagree about which keys are whose.
const VECTOR_SEED = '000102030405060708090a0b0c0d0e0f'
const VECTOR_DOMAIN = 'mint.example'
const VECTOR_CX1 =
  'cx1k7pa9ycdcpf6ju0sryz5efp70jw72rs8d80gwtw3mh096zl5e8g6hywvzxh28902dd3zj2npgl63aaq4p6l2qnn52ymmdpceugu0jpqes280t'
const VECTOR_SK0 =
  '944a9631dbda27cf989e27df8be7317a5a9dfb517a6b71358d175f58dd2dc99f'
const VECTOR_CK1_0 =
  'ck14tf6pcmvpqltp5ke9mqgvzthm3rdzry49uccxrnygwcl4gvewc62s0003psm2kxx7p8dsal9arwd7e6usu04cjens0qhywer99jc5sz9zqptmg4gyjlgg2zpglhl8atjj6zsfsh5ffnzn4k73naafcukpgdezzqx'

const loadVectorRoot = () =>
  cashSecrets.setCashRoot(
    HDKey.fromMasterSeed(hexToBytes(VECTOR_SEED)).deriveChild(CASH_ROOT_PURPOSE)
  )

describe('Part 2 address branch (LUD-25 Seed & derivation)', () => {
  it('is null without a loaded root', () => {
    expect(cashSecrets.cashAddressBranch(VECTOR_DOMAIN)).toBeNull()
    expect(cashSecrets.cashAddressSecretAtIndex(VECTOR_DOMAIN, 0)).toBeNull()
    expect(cashSecrets.nextCashAddressSecret(VECTOR_DOMAIN)).toBeNull()
    expect(() =>
      cashSecrets.requireRecoverableCashAddressSecret(VECTOR_DOMAIN)
    ).toThrow(/seed/)
  })

  it('exports the spec vector cx1 for the domain branch', () => {
    loadVectorRoot()
    const branch = cashSecrets.cashAddressBranch(VECTOR_DOMAIN)!
    expect(encodeCx1(branch.pubkeyXOnly, branch.chainCode)).toBe(VECTOR_CX1)
  })

  it('derives sk_0 and its ck1 exactly as the spec vectors do', () => {
    loadVectorRoot()
    expect(
      bytesToHex(cashSecrets.cashAddressSecretAtIndex(VECTOR_DOMAIN, 0)!)
    ).toBe(VECTOR_SK0)
    expect(cashSecrets.nextCashAddressSecret(VECTOR_DOMAIN)).toBe(VECTOR_CK1_0)
  })

  it('keeps its own counter, separate from the Part 1 ladder', () => {
    loadVectorRoot()
    expect(cashSecrets.nextCashAddressSecretIndex(VECTOR_DOMAIN)).toBe(0)
    const first = cashSecrets.nextCashAddressSecret(VECTOR_DOMAIN)
    const second = cashSecrets.nextCashAddressSecret(VECTOR_DOMAIN)
    expect(first).not.toBe(second)
    expect(cashSecrets.nextCashAddressSecretIndex(VECTOR_DOMAIN)).toBe(2)
    expect(cashSecrets.nextCashSecretIndex(VECTOR_DOMAIN)).toBe(0)
    expect(cashSecrets.readCashAddressSecretIndices()).toEqual({
      [VECTOR_DOMAIN]: 2
    })
    expect(cashSecrets.readCashSecretIndices()).toEqual({})
  })

  it('never hands out a Part 1 preimage shape', () => {
    loadVectorRoot()
    const secret = cashSecrets.nextCashAddressSecret(VECTOR_DOMAIN)!
    expect(secret.startsWith('ck1')).toBe(true)
    expect(secret).toHaveLength(163)
  })

  it('cashAddressSecretAtIndex is pure and the ck1 is deterministic', () => {
    loadVectorRoot()
    const a = cashSecrets.ck1ForSecretKey(
      cashSecrets.cashAddressSecretAtIndex(VECTOR_DOMAIN, 3)!
    )
    const b = cashSecrets.ck1ForSecretKey(
      cashSecrets.cashAddressSecretAtIndex(VECTOR_DOMAIN, 3)!
    )
    expect(a).toBe(b)
    expect(cashSecrets.nextCashAddressSecretIndex(VECTOR_DOMAIN)).toBe(0)
  })

  it('merges backup counters upward only and clears independently', () => {
    cashSecrets.mergeCashAddressSecretIndices({[VECTOR_DOMAIN]: 5, bad: -1})
    expect(cashSecrets.nextCashAddressSecretIndex(VECTOR_DOMAIN)).toBe(5)
    cashSecrets.mergeCashAddressSecretIndices({[VECTOR_DOMAIN]: 2})
    expect(cashSecrets.nextCashAddressSecretIndex(VECTOR_DOMAIN)).toBe(5)
    cashSecrets.mergeCashSecretIndices({[VECTOR_DOMAIN]: 9})
    cashSecrets.clearCashAddressSecretIndices()
    expect(cashSecrets.nextCashAddressSecretIndex(VECTOR_DOMAIN)).toBe(0)
    expect(cashSecrets.nextCashSecretIndex(VECTOR_DOMAIN)).toBe(9)
  })
})
