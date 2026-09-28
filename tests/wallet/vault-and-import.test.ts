// Secrets at rest, and the one-time import from the Bearlett before the
// rebuild, against the real old kit (0.19.5, pinned as kit-0.19.5).
import {afterEach, describe, expect, it} from 'vitest'
import {HDKey} from '@scure/bip32'
import {schnorr} from '@noble/curves/secp256k1.js'
import * as oldKit from 'kit-0.19.5'
import {bytesToHex, sha256} from '../../src/spec/bytes.ts'
import {cashRoot} from '../../src/spec/derivation.ts'
import {encodeCp1} from '../../src/spec/encoding.ts'
import {fetchNet} from '../../src/platform/web.ts'
import {legacyPreimage, legacySecretKey} from '../../src/wallet/legacy.ts'
import {STATE_KEY, VAULT_KEY, memoryStore} from '../../src/wallet/store.ts'
import {
  WrongPassphraseError,
  isMnemonic,
  newMnemonic,
  openJson,
  sealJson,
  seedOf,
  stateKey
} from '../../src/wallet/vault.ts'
import {Wallet} from '../../src/wallet/wallet.ts'
import {hostOfMint, startMint, walletAt, type Mint} from './harness.ts'

const mints: Mint[] = []
afterEach(async () => {
  while (mints.length) await mints.pop()!.close()
})

describe('secrets at rest', () => {
  it('seals the words with the passphrase and nothing readable is stored', async () => {
    const store = memoryStore()
    const words = newMnemonic()
    expect(isMnemonic(words)).toBe(true)
    await Wallet.create({net: fetchNet, store}, words, 'correct horse')
    const vault = (await store.get(VAULT_KEY))!
    // nothing but what sealing needs, and the words in none of it; a word
    // may be a field's name ("salt" is one of them), never what it holds
    const sealed = JSON.parse(vault) as Record<string, unknown>
    expect(Object.keys(sealed).sort()).toEqual([
      'data',
      'iterations',
      'iv',
      'salt',
      'v'
    ])
    expect(vault).not.toContain(words)
    for (const value of Object.values(sealed))
      expect(words.split(' ')).not.toContain(String(value))
    expect(await Wallet.revealWords(store, 'correct horse')).toBe(words)
    await expect(
      Wallet.unlock({net: fetchNet, store}, 'wrong')
    ).rejects.toBeInstanceOf(WrongPassphraseError)
  })

  it('keeps invoices paid before, by their text, for 30 days from their payment', async () => {
    const store = memoryStore()
    const words = newMnemonic()
    const created = await Wallet.create({net: fetchNet, store}, words, '')
    await created.setGapLimit(20)
    // a state written before paid invoices were kept by their hash
    const key = await stateKey(seedOf(words))
    const state = await openJson(key, (await store.get(STATE_KEY))!)
    const paidAt = 1_790_000_000_000
    delete state.paid
    state.paidInvoices = {lnbc100n1old: paidAt}
    await store.set(STATE_KEY, await sealJson(key, state))
    const wallet = await Wallet.unlock({net: fetchNet, store}, '')
    expect(wallet.snapshot.paid).toEqual({
      lnbc100n1old: paidAt + 30 * 24 * 3600 * 1000
    })
    expect(wallet.snapshot.paidInvoices).toBeUndefined()
  })

  it('reopens with its bookkeeping, sealed under a key from the seed', async () => {
    const mint = await startMint()
    mints.push(mint)
    const store = memoryStore()
    const wallet = await walletAt(mint, 5_000, {store, passphrase: 'p'})
    const sealed = (await store.get(STATE_KEY))!
    expect(sealed).not.toContain(hostOfMint(mint))
    const reopened = await Wallet.unlock({net: fetchNet, store}, 'p')
    expect(reopened.balanceMsat()).toBe(wallet.balanceMsat())
    expect(reopened.snapshot.counters).toEqual(wallet.snapshot.counters)
  })

  it('starts clean when new words replace old ones on the device', async () => {
    const mint = await startMint()
    mints.push(mint)
    const store = memoryStore()
    await walletAt(mint, 5_000, {store})
    const fresh = await Wallet.create({net: fetchNet, store}, newMnemonic(), '')
    expect(fresh.balanceMsat()).toBe(0)
    expect(Object.keys(fresh.snapshot.mints)).toHaveLength(0)
  })
})

describe('the import from the Bearlett before the rebuild', () => {
  it('reconstructs the old key ladder exactly as kit 0.19.5 derived it', () => {
    const root = cashRoot(HDKey.fromMasterSeed(seedOf(newMnemonic())))
    const branch = oldKit.deriveDomainBranchNode(root, 'mint.example')
    for (const index of [0, 1, 7, 1000])
      expect(bytesToHex(legacySecretKey(branch, index))).toBe(
        bytesToHex(
          oldKit.deriveNoteSecretKey(
            branch.privateKey!,
            branch.chainCode!,
            index
          )
        )
      )
  })

  it("finds old key and bearer notes and rotates them into today's keys", async () => {
    const mint = await startMint()
    mints.push(mint)
    const words = newMnemonic()
    // the old wallet derived with the host as the URL gave it, port included
    const root = cashRoot(HDKey.fromMasterSeed(seedOf(words)))
    const branch = oldKit.deriveDomainBranchNode(root, hostOfMint(mint))
    const oldKey = oldKit.deriveNoteSecretKey(
      branch.privateKey!,
      branch.chainCode!,
      1
    )
    const oldPreimage = legacyPreimage(branch, 3)
    await fetch(
      `${mint.url}/_test/credit?p=${encodeCp1(schnorr.getPublicKey(oldKey))}&amount=21000`
    )
    await fetch(
      `${mint.url}/_test/credit?p=${bytesToHex(sha256(oldPreimage))}&amount=5000`
    )

    const wallet = await walletAt(mint, 0, {words})
    expect(await wallet.importLegacy(hostOfMint(mint))).toBe(2)
    expect(wallet.balanceMsat()).toBe(26_000)
    expect(wallet.notes({role: 'incoming', status: 'live'})).toHaveLength(0)
    expect(await wallet.importLegacy(hostOfMint(mint))).toBe(0)
  })
})
