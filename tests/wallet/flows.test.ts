// The wallet's flows end to end against an adversarial mock mint over real
// HTTP: minting, handing out and receiving, paying, lost answers and
// crashes, trust, recovery and timelocks.
import {afterEach, describe, expect, it} from 'vitest'
import {fetchNet} from '../../src/platform/web.ts'
import {
  ProtocolError,
  ServiceError,
  TransportError
} from '../../src/lnurl/errors.ts'
import {parseNoteLink} from '../../src/lnurl/links.ts'
import {fetchNoteInfo} from '../../src/lnurl/withdraw.ts'
import {notePubkey, PURPOSE} from '../../src/spec/derivation.ts'
import {decodeCp1, encodeCp1} from '../../src/spec/encoding.ts'
import {memoryStore} from '../../src/wallet/store.ts'
import {newMnemonic} from '../../src/wallet/vault.ts'
import {
  MintKeyChangedError,
  UnknownMintError,
  Wallet
} from '../../src/wallet/wallet.ts'
import {
  hanging,
  hostOfMint,
  isBurn,
  isCallback,
  losing,
  payInvoice,
  payUrl,
  rewriting,
  startMint,
  walletAt,
  type Mint
} from './harness.ts'

const mints: Mint[] = []
const start = async (options = {}) => {
  const mint = await startMint(options)
  mints.push(mint)
  return mint
}
afterEach(async () => {
  while (mints.length) await mints.pop()!.close()
})

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

describe('minting', () => {
  it('credits a fresh key of its own once the invoice is paid, less the fee', async () => {
    const mint = await start({baseFeeMsat: 1000})
    const wallet = await walletAt(mint)
    const host = hostOfMint(mint)
    const op = await wallet.requestMint(host, 100_000)
    expect(await wallet.settleMint(op)).toBe(false)
    await payInvoice(mint, op.verify!)
    expect(await wallet.settleMint(op)).toBe(true)
    expect(wallet.balanceMsat()).toBe(99_000)
    const [note] = wallet.notes({role: 'own', status: 'live'})
    expect(note.spend).toEqual({kind: 'key', key: {purpose: 0, index: 0}})
    expect(note.c).toBeDefined()
    expect(wallet.snapshot.mints[host].mintPubkey).toMatch(
      /^0[23][0-9a-f]{64}$/
    )
  })

  it('keeps an unpaid invoice underway until it is forgotten', async () => {
    const mint = await start()
    const wallet = await walletAt(mint)
    const op = await wallet.requestMint(hostOfMint(mint), 5_000)
    await wallet.settle()
    expect(wallet.snapshot.operations[op.id]).toBeDefined()
    await wallet.dropMint(op)
    expect(wallet.snapshot.operations[op.id]).toBeUndefined()
  })
})

describe('handing out and receiving', () => {
  it('hands out a bearer link that another wallet receives and rotates', async () => {
    const mint = await start({baseFeeMsat: 1000})
    const alice = await walletAt(mint, 100_000)
    const bob = await walletAt(mint)
    const sent = await alice.send(hostOfMint(mint), 30_000, 'for bob')
    expect(alice.balanceMsat()).toBe(99_000 - 30_000 - 1000)
    const link = parseNoteLink(alice.noteLink(sent.q))!
    // the link is a bearer note: its k1 is the 64-hex preimage
    expect(link.k1).toMatch(/^[0-9a-f]{64}$/)
    await bob.receive(link)
    expect(bob.balanceMsat()).toBe(30_000)
    expect(bob.notes({role: 'incoming', status: 'live'})).toHaveLength(0)
    await alice.checkOutgoing()
    expect(alice.snapshot.notes[sent.q].status).toBe('spent')
    await expect(bob.receive(link)).rejects.toThrow(/already spent/)
  })

  it('refuses a note from an unknown mint until the holder trusts it', async () => {
    const mint = await start()
    const alice = await walletAt(mint, 10_000)
    const carol = await Wallet.create(
      {net: fetchNet, store: memoryStore()},
      newMnemonic(),
      ''
    )
    const link = parseNoteLink(
      alice.noteLink((await alice.send(hostOfMint(mint), 10_000)).q)
    )!
    await expect(carol.receive(link)).rejects.toBeInstanceOf(UnknownMintError)
    await carol.trustMintOf(link.endpoint)
    await carol.receive(link)
    expect(carol.balanceMsat()).toBe(10_000)
  })

  it('takes back a note nobody rotated', async () => {
    const mint = await start()
    const alice = await walletAt(mint, 10_000)
    const sent = await alice.send(hostOfMint(mint), 4_000)
    expect(alice.balanceMsat()).toBe(6_000)
    await alice.reclaim(sent.q)
    expect(alice.balanceMsat()).toBe(10_000)
  })

  it('marks a note spent when taking it back finds it rotated', async () => {
    const mint = await start()
    const alice = await walletAt(mint, 10_000)
    const bob = await walletAt(mint)
    const sent = await alice.send(hostOfMint(mint), 4_000)
    await bob.receive(parseNoteLink(alice.noteLink(sent.q))!)
    await expect(alice.reclaim(sent.q)).rejects.toThrow(/already spent/)
    expect(alice.snapshot.notes[sent.q].status).toBe('spent')
    expect(alice.notes({role: 'outgoing', status: 'live'})).toEqual([])
  })

  it('keeps a note received offline and rotates it once the mint answers', async () => {
    const mint = await start()
    const alice = await walletAt(mint, 10_000)
    let online = false
    const flaky = {
      async get(
        url: string,
        options?: {signal?: AbortSignal; secret?: boolean}
      ) {
        if (!online && new URL(url).searchParams.has('k1'))
          throw new TransportError('No answer.')
        return fetchNet.get(url, options)
      }
    }
    const bob = await walletAt(mint, 1_000, {net: flaky})
    const link = parseNoteLink(
      alice.noteLink((await alice.send(hostOfMint(mint), 10_000)).q)
    )!
    const kept = await bob.receive(link)
    // offline: its amount comes from the certificate, under the pinned key
    expect(kept.role).toBe('incoming')
    expect(kept.amountMsat).toBe(10_000)
    online = true
    await bob.settle()
    expect(bob.balanceMsat()).toBe(11_000)
  })
})

describe('paying', () => {
  it('splits off the exact amount and melts it', async () => {
    const mint = await start({baseFeeMsat: 1000})
    const wallet = await walletAt(mint, 50_000)
    const melt = await wallet.pay(
      hostOfMint(mint),
      'lnbc100n1' + 'q'.repeat(52)
    )
    expect(melt.state).toBe('in-flight')
    await sleep(60)
    await wallet.settle()
    expect(Object.keys(wallet.snapshot.operations)).toHaveLength(0)
    expect(wallet.balanceMsat()).toBe(49_000 - 10_000 - 1000)
  })

  it('restores the note when the payment fails', async () => {
    const mint = await start({meltAlwaysFails: true})
    const wallet = await walletAt(mint, 20_000)
    await wallet.pay(hostOfMint(mint), 'lnbc200n1' + 'q'.repeat(52))
    await sleep(60)
    await wallet.settle()
    expect(Object.keys(wallet.snapshot.operations)).toHaveLength(0)
    expect(wallet.balanceMsat()).toBe(20_000)
  })

  it('keeps a payment that never settles underway, its note pending', async () => {
    const mint = await start({meltNeverSettles: true})
    const wallet = await walletAt(mint, 20_000)
    const melt = await wallet.pay(
      hostOfMint(mint),
      'lnbc200n1' + 'q'.repeat(52)
    )
    await wallet.settle()
    expect(wallet.snapshot.operations[melt.id]).toBeDefined()
    expect(wallet.snapshot.notes[melt.input].status).toBe('pending')
  })

  it('sends to a note key someone gave as a cp1', async () => {
    const mint = await start()
    const alice = await walletAt(mint, 20_000)
    const bob = await walletAt(mint)
    const cp1 = encodeCp1(
      decodeCp1(
        (bob as any).keys.cp1(hostOfMint(mint), {purpose: 0, index: 5})
      )!
    )
    await alice.sendToKey(hostOfMint(mint), 7_000, decodeCp1(cp1)!)
    expect(alice.balanceMsat()).toBe(13_000)
    // whoever holds the key finds it by scanning
    expect(await bob.recover(hostOfMint(mint))).toBe(1)
    expect(bob.balanceMsat()).toBe(7_000)
  })

  it('pays an address at the same mint by internal transfer, skipping a taken index', async () => {
    const mint = await start({registeredAddress: true})
    const alice = await walletAt(mint, 30_000)
    const pay = await alice.payRequest(payUrl(mint))
    expect(pay.cpub).toBeDefined()
    expect(alice.transferMint(pay)).toBe(hostOfMint(mint))
    // someone got to the hinted index first
    const taken = notePubkey(
      pay.cpub!.branch,
      PURPOSE.lightningAddress,
      pay.cpub!.index
    )
    await fetch(`${mint.url}/_test/credit?p=${encodeCp1(taken)}&amount=1000`)
    await alice.transfer(pay, 8_000)
    expect(alice.balanceMsat()).toBe(22_000)
    const next = notePubkey(
      pay.cpub!.branch,
      PURPOSE.lightningAddress,
      pay.cpub!.index + 1
    )
    const credited = await fetchNoteInfo(fetchNet, `${mint.url}/w`, {
      p: encodeCp1(next)
    })
    expect(credited.amountMsat).toBe(8_000)
  })
})

describe('lost answers and crashes', () => {
  it('settles a burn whose answer was lost after it landed', async () => {
    const mint = await start()
    const wallet = await walletAt(mint, 10_000, {net: losing(isBurn)})
    await expect(wallet.send(hostOfMint(mint), 3_000)).rejects.toBeInstanceOf(
      TransportError
    )
    const [op] = Object.values(wallet.snapshot.operations)
    expect(op.kind === 'burn' && op.state).toBe('unknown')
    await wallet.settle()
    expect(Object.keys(wallet.snapshot.operations)).toHaveLength(0)
    expect(wallet.balanceMsat()).toBe(7_000)
    expect(wallet.notes({role: 'outgoing', status: 'live'})).toHaveLength(1)
  })

  it('settles it at a mint that drops the answer and refuses replays', async () => {
    const mint = await start({
      dropAfterMutation: true,
      retriedMutation: 'refuse'
    })
    const wallet = await walletAt(mint, 10_000)
    await expect(wallet.send(hostOfMint(mint), 3_000)).rejects.toThrow()
    await wallet.settle()
    expect(Object.keys(wallet.snapshot.operations)).toHaveLength(0)
    expect(wallet.balanceMsat()).toBe(7_000)
  })

  it('settles a burn the mint answered without confirming', async () => {
    const mint = await start({unconfirmedMutation: true})
    const wallet = await walletAt(mint, 10_000)
    await expect(wallet.send(hostOfMint(mint), 2_500)).rejects.toThrow(
      /did not confirm/
    )
    await wallet.settle()
    expect(wallet.balanceMsat()).toBe(7_500)
  })

  it('resolves a burn left behind by a crash after it was sent', async () => {
    const mint = await start()
    const store = memoryStore()
    const words = newMnemonic()
    const crashing = await walletAt(mint, 10_000, {
      net: hanging(isBurn),
      store,
      words
    })
    void crashing.send(hostOfMint(mint), 4_000)
    await sleep(300)
    // the app restarts from what it stored: the burn is still "prepared"
    const reopened = await Wallet.unlock({net: fetchNet, store}, '')
    const [op] = Object.values(reopened.snapshot.operations)
    expect(op.kind === 'burn' && op.state).toBe('prepared')
    await reopened.settle()
    expect(Object.keys(reopened.snapshot.operations)).toHaveLength(0)
    expect(reopened.balanceMsat()).toBe(6_000)
  })

  it('marks a received note spent when its sender spent it first, and says so', async () => {
    const mint = await start()
    const alice = await walletAt(mint, 10_000)
    const sent = await alice.send(hostOfMint(mint), 10_000)
    const link = parseNoteLink(alice.noteLink(sent.q))!
    let online = false
    const offline = await walletAt(mint, 0, {
      net: {
        async get(url, options) {
          if (!online && new URL(url).searchParams.has('k1'))
            throw new TransportError('No answer.')
          return fetchNet.get(url, options)
        }
      }
    })
    await offline.receive(link)
    // the sender takes it back before the holder is online again
    await alice.reclaim(sent.q)
    online = true
    await offline.settle()
    const [note] = offline.notes({role: 'incoming'})
    expect(note.status).toBe('spent')
    expect(offline.balanceMsat()).toBe(0)
    expect(offline.snapshot.activity[0].text).toMatch(/spent by someone else/)
  })
})

describe('trust', () => {
  it('refuses a mint that echoes another note', async () => {
    const mint = await start({echoWrongK1: true})
    const alice = await walletAt(mint, 5_000)
    const bob = await walletAt(mint)
    const link = parseNoteLink(
      alice.noteLink((await alice.send(hostOfMint(mint), 5_000)).q)
    )!
    await expect(bob.receive(link)).rejects.toBeInstanceOf(ProtocolError)
    // and it is not quietly kept as if the mint were offline
    expect(bob.notes({role: 'incoming'})).toHaveLength(0)
  })

  it('refuses a mint whose key changed since it was pinned', async () => {
    const mint = await start()
    let swap = false
    const net = rewriting((_, body) =>
      swap && typeof body.mintPubkey === 'string'
        ? {
            ...body,
            // a valid key, just not the one pinned: the generator point
            mintPubkey:
              '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
          }
        : body
    )
    const wallet = await walletAt(mint, 5_000, {net})
    const alice = await walletAt(mint, 5_000)
    const link = parseNoteLink(
      alice.noteLink((await alice.send(hostOfMint(mint), 5_000)).q)
    )!
    swap = true
    await expect(wallet.receive(link)).rejects.toBeInstanceOf(
      MintKeyChangedError
    )
  })

  it('refuses a lookup that is not a withdrawRequest', async () => {
    const mint = await start({malformedJson: true})
    await expect(
      fetchNoteInfo(fetchNet, `${mint.url}/w`, {p: 'cp1' + 'q'.repeat(58)})
    ).rejects.toThrow()
  })
})

describe('recovery from the words alone', () => {
  it('finds every purpose and advances each counter past what it found', async () => {
    const mint = await start({baseFeeMsat: 1000, registeredAddress: true})
    const words = newMnemonic()
    const alice = await walletAt(mint, 60_000, {words})
    await alice.send(hostOfMint(mint), 10_000)
    await alice.pay(hostOfMint(mint), 'lnbc50n1' + 'q'.repeat(52))
    await sleep(60)
    await alice.settle()
    const restored = await walletAt(mint, 0, {words})
    await restored.recover(hostOfMint(mint))
    expect(restored.balanceMsat()).toBe(alice.balanceMsat())
    const [w0, w1] = alice.snapshot.counters[hostOfMint(mint)]
    const [r0, r1] = restored.snapshot.counters[hostOfMint(mint)]
    expect([r0, r1]).toEqual([w0, w1])
  })

  it('waits out a rate limit without counting it toward the gap', async () => {
    const mint = await start()
    const words = newMnemonic()
    const alice = await walletAt(mint, 5_000, {words})
    let limited = 1
    const net = {
      async get(
        url: string,
        options?: {signal?: AbortSignal; secret?: boolean}
      ) {
        if (limited > 0 && new URL(url).searchParams.has('p')) {
          limited--
          throw new ServiceError('rate limited')
        }
        return fetchNet.get(url, options)
      }
    }
    const restored = await walletAt(mint, 0, {words, net})
    await restored.recover(hostOfMint(mint))
    expect(restored.balanceMsat()).toBe(alice.balanceMsat())
  })
})

describe('offline mode', () => {
  it('sends nothing to any mint', async () => {
    const mint = await start()
    const wallet = await walletAt(mint, 5_000)
    await wallet.setOffline(true)
    await expect(wallet.send(hostOfMint(mint), 1_000)).rejects.toThrow(
      /Offline mode/
    )
    expect(wallet.balanceMsat()).toBe(5_000)
    expect(Object.keys(wallet.snapshot.operations)).toHaveLength(0)
  })
})

describe('timelocks', () => {
  it('locks sats until a time; neither the wallet nor the mint lets them out early', async () => {
    const mint = await start()
    const wallet = await walletAt(mint, 20_000)
    const until = Math.floor(Date.now() / 1000) + 3600
    const locked = await wallet.lock(hostOfMint(mint), 8_000, until)
    expect(locked.role).toBe('locked')
    expect(wallet.balanceMsat()).toBe(12_000)
    await expect(wallet.unlock(locked.q)).rejects.toThrow(/still locked/)
    const cw1 = (wallet as any).spendOf(locked)
    await expect(
      fetchNoteInfo(fetchNet, `${mint.url}/w`, {k1: cw1})
    ).rejects.toThrow(/future/)
  })
})
