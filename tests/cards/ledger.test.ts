// A card mint's rules (src/cards/ledger.ts): what it issues and vouches for,
// what it refuses, and what a forger holds without it.
import {schnorr} from '@noble/curves/secp256k1.js'
import {describe, expect, it} from 'vitest'
import {makeMove} from '../../src/cards/holder.ts'
import {
  CardLedger,
  CARD_MSAT,
  MOVED_OUT,
  ONLY_MOVES,
  SPENT,
  UNKNOWN,
  type Moved,
  type Refusal
} from '../../src/cards/ledger.ts'
import {
  buildConsignment,
  signGenesis,
  signMove,
  verifyConsignment,
  type Card,
  type Consignment
} from '../../src/cards/proofs.ts'
import {
  cardNote,
  encodeState,
  genesisState,
  nextState,
  type CardState
} from '../../src/cards/state.ts'
import {
  bytesToHex,
  hexToBytes,
  sha256,
  utf8ToBytes
} from '../../src/spec/bytes.ts'
import {encodeCp1} from '../../src/spec/encoding.ts'
import {verifyCertificate} from '../../src/spec/certificate.ts'

const MINT = 'https://cards.example/w'
const DOMAIN = 'cards.example'
const key = (n: number) => sha256(utf8ToBytes(`card ledger test ${n}`))
const pub = (sk: Uint8Array) => schnorr.getPublicKey(sk)
const [issuerKey, alice, bob, eve] = [key(0), key(1), key(2), key(3)]
const options = {withdraw: MINT, issuerKey, mintKey: key(100)}

const verified = (ledger: CardLedger, consignment: Consignment): Card => {
  const card = verifyConsignment(consignment, ledger.issuer)
  if (typeof card === 'string') throw new Error(card)
  return card
}
const moved = (answer: Moved | Refusal): Moved => {
  if ('refused' in answer) throw new Error(answer.refused)
  return answer
}
const refusal = (answer: Moved | Refusal | object): string =>
  'refused' in answer ? (answer as Refusal).refused : 'accepted'

const issued = () => {
  const ledger = new CardLedger(options)
  const card = verified(
    ledger,
    ledger.issue('E1-042', '600B-E1#17', pub(alice))
  )
  return {ledger, card}
}
const moveOf = (
  card: Card,
  from: Uint8Array,
  to: Uint8Array,
  domain = DOMAIN
) => makeMove(card.head, from, to, domain)

describe('issuing', () => {
  it('issues a card its first holder can prove offline', () => {
    const {ledger, card} = issued()
    expect(card.head).toMatchObject({
      index: 0,
      name: 'E1-042',
      description: '600B-E1#17'
    })
    expect(card.head.owner).toEqual(pub(alice))
    const live = ledger.lookup(card.q)
    expect(
      'c' in live && verifyCertificate(live.c, card.q, ledger.mintPubkey)
    ).toBe(CARD_MSAT)
    expect(ledger.byOwner(pub(alice))).toEqual([card.consignment])
  })

  it('issues to a key only, and writes nothing down otherwise', () => {
    const written: Consignment[] = []
    const ledger = new CardLedger({...options, persist: c => written.push(c)})
    const notAKey = new Uint8Array(32).fill(0xff)
    expect(() => ledger.issue('E1-001', '600B-E1#1', notAKey)).toThrow(
      /key only/
    )
    expect(written).toEqual([])
    expect(ledger.save()).toEqual([])
  })

  it('names its withdraw URL as a holder reads it', () => {
    const ledger = new CardLedger({
      ...options,
      withdraw: 'https://cards.example'
    })
    expect(ledger.withdraw).toBe('https://cards.example/')
    const card = verified(
      ledger,
      ledger.issue('E1-001', '600B-E1#1', pub(alice))
    )
    expect(card.consignment.mint).toBe('https://cards.example/')
  })

  it('issues a pack all or none, and holds it only once kept', () => {
    const written: Consignment[] = []
    let failAt = -1
    const ledger = new CardLedger({
      ...options,
      persist: c => {
        if (written.length === failAt) throw new Error('disk full')
        written.push(c)
      }
    })
    const pack = (serial: number, owner: Uint8Array) =>
      ['E1-001', 'E1-042'].map(name => ({
        name,
        description: `600B-E1#${serial}`,
        owner
      }))
    const pending = ledger.issuePending(pack(1, pub(alice)))
    expect(written).toEqual(pending.consignments)
    // written down, not held: nothing sees the cards before keep()
    const qs = pending.consignments.map(c => verified(ledger, c).q)
    for (const q of qs) expect(refusal(ledger.lookup(q))).toBe(UNKNOWN)
    expect(ledger.lookupOwner(pub(alice))).toEqual({cards: [], used: false})
    pending.keep()
    pending.keep()
    expect(ledger.byOwner(pub(alice))).toHaveLength(2)
    for (const q of qs) expect(ledger.lookup(q)).toHaveProperty('c')
    // a pack whose writing fails part way is held not at all, and can be issued again
    failAt = written.length + 1
    expect(() => ledger.issuePending(pack(2, pub(bob)))).toThrow(/disk full/)
    expect(ledger.lookupOwner(pub(bob))).toEqual({cards: [], used: false})
    failAt = -1
    ledger.issuePending(pack(2, pub(bob))).keep()
    expect(ledger.byOwner(pub(bob))).toHaveLength(2)
    // one card twice in a pack is refused before anything is written
    const before = written.length
    const [twice] = pack(3, pub(eve))
    expect(() => ledger.issuePending([twice, twice])).toThrow(/issued already/)
    expect(written).toHaveLength(before)
  })

  it('reserves a pending card until it is kept or abandoned', () => {
    const ledger = new CardLedger(options)
    const card = {name: 'E1-001', description: '600B-E1#1', owner: pub(alice)}
    const first = ledger.issuePending([card])
    // not held yet, but nobody else is issued it meanwhile
    expect(() => ledger.issuePending([{...card, owner: pub(bob)}])).toThrow(
      /issued already/
    )
    // a rollback gives it back, and a pack given back is never held
    first.abandon()
    expect(() => first.keep()).toThrow(/abandoned/)
    expect(ledger.byOwner(pub(alice))).toEqual([])
    const second = ledger.issuePending([{...card, owner: pub(bob)}])
    second.keep()
    second.abandon()
    expect(ledger.byOwner(pub(bob))).toHaveLength(1)
    expect(() => ledger.issuePending([card])).toThrow(/issued already/)
  })

  it('issues a card and serial once', () => {
    const {ledger} = issued()
    expect(() => ledger.issue('E1-042', '600B-E1#17', pub(bob))).toThrow(
      /issued already/
    )
    expect(() => ledger.issue('E1-042', '600B-E1#18', pub(bob))).not.toThrow()
  })

  it('answers for notes it never issued as LUD-25 does', () => {
    const {ledger} = issued()
    expect(refusal(ledger.lookup(pub(eve)))).toBe(UNKNOWN)
  })
})

describe('moving', () => {
  it('moves a card when its holder asks, and vouches for the move', () => {
    const {ledger, card} = issued()
    const move = moveOf(card, alice, pub(bob))
    const answer = moved(
      ledger.burn({k1s: [move.k1], p1: move.p1, state: move.state})
    )
    const after = verified(ledger, answer.consignment)
    expect(after.states).toHaveLength(2)
    expect(after.head.owner).toEqual(pub(bob))
    expect(refusal(ledger.lookup(card.q))).toBe(SPENT)
    expect(verifyCertificate(answer.c, after.q, ledger.mintPubkey)).toBe(
      CARD_MSAT
    )
    expect(ledger.byOwner(pub(alice))).toEqual([])
    expect(ledger.byOwner(pub(bob))).toEqual([answer.consignment])
  })

  it('answers the same move the same way when asked again', () => {
    const {ledger, card} = issued()
    const move = moveOf(card, alice, pub(bob))
    const request = {k1s: [move.k1], p1: move.p1, state: move.state}
    const first = moved(ledger.burn(request))
    expect(moved(ledger.burn(request))).toEqual(first)
  })

  it('moves a card on and on', () => {
    const {ledger, card} = issued()
    const toBob = moveOf(card, alice, pub(bob))
    const atBob = verified(
      ledger,
      moved(ledger.burn({k1s: [toBob.k1], p1: toBob.p1, state: toBob.state}))
        .consignment
    )
    const toEve = moveOf(atBob, bob, pub(eve))
    const atEve = verified(
      ledger,
      moved(ledger.burn({k1s: [toEve.k1], p1: toEve.p1, state: toEve.state}))
        .consignment
    )
    expect(atEve.states.map(s => s.index)).toEqual([0, 1, 2])
    expect(ledger.byOwner(pub(eve))).toHaveLength(1)
    // the first move, asked again later, still gets its own receipt
    const again = moved(
      ledger.burn({k1s: [toBob.k1], p1: toBob.p1, state: toBob.state})
    )
    expect(again.receipt).toEqual(hexToBytes(atEve.consignment.receipts[0]))
  })

  it('refuses the move past the most states a card may have', () => {
    const ledger = new CardLedger({...options, maxStates: 3})
    let card = verified(
      ledger,
      ledger.issue('E1-042', '600B-E1#17', pub(alice))
    )
    for (const [from, to] of [
      [alice, bob],
      [bob, alice]
    ]) {
      const move = moveOf(card, from, pub(to))
      card = verified(
        ledger,
        moved(ledger.burn({k1s: [move.k1], p1: move.p1, state: move.state}))
          .consignment
      )
    }
    const move = moveOf(card, alice, pub(bob))
    expect(
      refusal(ledger.burn({k1s: [move.k1], p1: move.p1, state: move.state}))
    ).toBe(MOVED_OUT)
    // still alice's, still live
    expect(ledger.lookup(card.q)).toHaveProperty('c')
    expect(ledger.byOwner(pub(alice))).toHaveLength(1)
  })
})

describe('refusing', () => {
  it('refuses every other burn of a card', () => {
    const {ledger, card} = issued()
    const {k1, p1, state} = moveOf(card, alice, pub(bob))
    for (const request of [
      {k1s: [k1], p1, state, amount: '500', p2: p1},
      {k1s: [k1, k1], p1, state},
      {k1s: [k1], pr: 'lnbc10n1qqqq'},
      {k1s: [k1], p1},
      {k1s: [k1], state}
    ])
      expect(refusal(ledger.burn(request))).toBe(ONLY_MOVES)
    expect(ledger.lookup(card.q)).toHaveProperty('c')
  })

  it('checks the signature before anything the request carries', () => {
    const {ledger, card} = issued()
    const theft = moveOf(card, eve, pub(eve))
    expect(
      refusal(ledger.burn({k1s: [theft.k1], p1: 'cp1', state: 'zz'}))
    ).toMatch(/does not open the card/)
  })

  it('refuses a move its holder did not sign', () => {
    const {ledger, card} = issued()
    const {p1, state} = moveOf(card, alice, pub(eve))
    const stolen = moveOf(card, eve, pub(eve))
    expect(refusal(ledger.burn({k1s: [stolen.k1], p1, state}))).toMatch(
      /does not open/
    )
  })

  it('refuses a spend signed for another mint', () => {
    const {ledger, card} = issued()
    const move = moveOf(card, alice, pub(bob), 'other.example')
    expect(
      refusal(ledger.burn({k1s: [move.k1], p1: move.p1, state: move.state}))
    ).toMatch(/does not open/)
  })

  it('refuses a next state that does not follow, or does not lock to p1', () => {
    const {ledger, card} = issued()
    const move = moveOf(card, alice, pub(bob))
    const skipped = nextState(nextState(card.head, pub(bob)), pub(bob))
    const renamed: CardState = {...move.next, name: 'E1-001'}
    for (const [state, reason] of [
      [skipped, /index/],
      [renamed, /identity/]
    ] as const) {
      const p1 = encodeCp1(cardNote(state).q)
      const answer = ledger.burn({
        k1s: [move.k1],
        p1,
        state: bytesToHex(encodeState(state))
      })
      expect(refusal(answer)).toMatch(reason)
    }
    const other = moveOf(card, alice, pub(eve))
    expect(
      refusal(ledger.burn({k1s: [move.k1], p1: other.p1, state: move.state}))
    ).toMatch(/lock to p1/)
  })

  it('refuses the old holder a second move', () => {
    const {ledger, card} = issued()
    const toBob = moveOf(card, alice, pub(bob))
    moved(ledger.burn({k1s: [toBob.k1], p1: toBob.p1, state: toBob.state}))
    const toEve = moveOf(card, alice, pub(eve))
    expect(
      refusal(ledger.burn({k1s: [toEve.k1], p1: toEve.p1, state: toEve.state}))
    ).toBe(SPENT)
    expect(ledger.byOwner(pub(eve))).toEqual([])
  })
})

describe('what a forger holds', () => {
  it('a look-alike next state carries no receipt from the mint', () => {
    const {ledger, card} = issued()
    // eve knows alice's state (say she sold her the card): the next one is easy
    const forged = nextState(card.head, pub(eve))
    const consignment = buildConsignment(
      MINT,
      ledger.issuer,
      [card.head, forged],
      hexToBytes(card.consignment.genesis),
      [signMove(eve, card.head, forged, DOMAIN)]
    )
    expect(verifyConsignment(consignment, ledger.issuer)).toMatch(/no receipt/)
  })

  it('a card the issuer never signed is no card', () => {
    const {ledger} = issued()
    const state = genesisState(ledger.issuer, 'E1-001', '600B-E1#1', pub(eve))
    const byEve = buildConsignment(
      MINT,
      ledger.issuer,
      [state],
      signGenesis(eve, state, DOMAIN),
      []
    )
    expect(verifyConsignment(byEve, ledger.issuer)).toMatch(/did not sign/)
    const ownIssuer = buildConsignment(
      MINT,
      pub(eve),
      [state],
      signGenesis(eve, state, DOMAIN),
      []
    )
    expect(verifyConsignment(ownIssuer, ledger.issuer)).toMatch(
      /another issuer/
    )
    // the issuer's key on a card id that is not the issuer's
    const odd: CardState = {...state, assetId: sha256(utf8ToBytes('any id'))}
    const oddId = buildConsignment(
      MINT,
      ledger.issuer,
      [odd],
      signGenesis(issuerKey, odd, DOMAIN),
      []
    )
    expect(verifyConsignment(oddId, ledger.issuer)).toMatch(/card id/)
  })

  it('a genesis signed for another mint does not travel', () => {
    const {ledger, card} = issued()
    const elsewhere = {...card.consignment, mint: 'https://other.example/w'}
    expect(verifyConsignment(elsewhere, ledger.issuer)).toMatch(/did not sign/)
  })
})

describe('writing down', () => {
  it('writes every issue and move down before it holds it', () => {
    const written: Consignment[] = []
    const ledger = new CardLedger({...options, persist: c => written.push(c)})
    const card = verified(
      ledger,
      ledger.issue('E1-042', '600B-E1#17', pub(alice))
    )
    const move = moveOf(card, alice, pub(bob))
    const answer = moved(
      ledger.burn({k1s: [move.k1], p1: move.p1, state: move.state})
    )
    expect(written).toEqual([card.consignment, answer.consignment])
    // a replay writes nothing new
    moved(ledger.burn({k1s: [move.k1], p1: move.p1, state: move.state}))
    expect(written).toHaveLength(2)
  })

  it('changes nothing when writing fails', () => {
    let failing = false
    const ledger = new CardLedger({
      ...options,
      persist: () => {
        if (failing) throw new Error('disk full')
      }
    })
    const card = verified(
      ledger,
      ledger.issue('E1-042', '600B-E1#17', pub(alice))
    )
    failing = true
    expect(() => ledger.issue('E1-001', '600B-E1#1', pub(alice))).toThrow(
      /disk full/
    )
    expect(ledger.byOwner(pub(alice))).toHaveLength(1)
    const move = moveOf(card, alice, pub(bob))
    expect(() =>
      ledger.burn({k1s: [move.k1], p1: move.p1, state: move.state})
    ).toThrow(/disk full/)
    // still alice's, still live: the same move goes through once writing works
    expect(ledger.lookup(card.q)).toHaveProperty('c')
    expect(ledger.byOwner(pub(bob))).toEqual([])
    failing = false
    moved(ledger.burn({k1s: [move.k1], p1: move.p1, state: move.state}))
    expect(ledger.byOwner(pub(bob))).toHaveLength(1)
  })

  it('restores without writing anything back', () => {
    const {ledger} = issued()
    let writes = 0
    CardLedger.restore({...options, persist: () => writes++}, ledger.save())
    expect(writes).toBe(0)
  })
})

describe('the lookup by owner', () => {
  it('names the live cards, and whether the key ever held one', () => {
    const {ledger, card} = issued()
    expect(ledger.lookupOwner(pub(alice))).toEqual({
      cards: [card.consignment],
      used: true
    })
    const move = moveOf(card, alice, pub(bob))
    const answer = moved(
      ledger.burn({k1s: [move.k1], p1: move.p1, state: move.state})
    )
    // handed on, alice's key is still used: a holder's scan goes past it
    expect(ledger.lookupOwner(pub(alice))).toEqual({cards: [], used: true})
    expect(ledger.lookupOwner(pub(bob))).toEqual({
      cards: [answer.consignment],
      used: true
    })
    expect(ledger.lookupOwner(pub(eve))).toEqual({cards: [], used: false})
  })
})

describe('restoring', () => {
  const twoCards = () => {
    const {ledger, card} = issued()
    const move = moveOf(card, alice, pub(bob))
    moved(ledger.burn({k1s: [move.k1], p1: move.p1, state: move.state}))
    ledger.issue('E1-001', '600B-E1#1', pub(alice))
    return {ledger, card}
  }

  it('restores itself from what it saved', () => {
    const {ledger, card} = twoCards()
    const again = CardLedger.restore(options, ledger.save())
    expect(again.save()).toEqual(ledger.save())
    expect(refusal(again.lookup(card.q))).toBe(SPENT)
    expect(again.byOwner(pub(bob))).toHaveLength(1)
    expect(again.lookupOwner(pub(alice)).used).toBe(true)
  })

  it('leaves out a card that does not check out, and starts with the rest', () => {
    const {ledger, card} = twoCards()
    const [first, second] = ledger.save()
    const receipt = first.receipts[0]
    const flipped = (receipt[0] === '0' ? '1' : '0') + receipt.slice(1)
    const skipped: [string, number][] = []
    const again = CardLedger.restore(
      options,
      [{...first, receipts: [flipped]}, second],
      (problem, at) => skipped.push([problem, at])
    )
    expect(skipped).toEqual([[expect.stringMatching(/does not check out/), 0]])
    expect(again.save()).toEqual([second])
    expect(refusal(again.lookup(card.q))).toBe(UNKNOWN)
  })

  it('refuses to start under another issuer key or withdraw URL', () => {
    const {ledger} = twoCards()
    expect(() =>
      CardLedger.restore({...options, issuerKey: key(9)}, ledger.save())
    ).toThrow(/Not restorable/)
    expect(() =>
      CardLedger.restore(
        {...options, withdraw: 'https://moved.example/w'},
        ledger.save()
      )
    ).toThrow(/Not restorable/)
  })

  it('refuses a store holding one card of another issuer key or withdraw URL', () => {
    const {ledger} = twoCards()
    const [first, second] = ledger.save()
    // however many of its own cards, and damaged ones, come with it
    for (const other of [
      {...second, mint: 'https://moved.example/w'},
      {...second, issuer: bytesToHex(pub(key(9)))}
    ])
      expect(() =>
        CardLedger.restore(options, [first, {} as Consignment, other])
      ).toThrow(/another issuer key or withdraw URL/)
  })

  it('leaves out a damaged card among good ones, and never issues it again', () => {
    const {ledger} = twoCards()
    const [first, second] = ledger.save()
    const upper = {...second, states: second.states.map(s => s.toUpperCase())}
    const skipped: number[] = []
    const again = CardLedger.restore(options, [first, upper], (_, at) =>
      skipped.push(at)
    )
    expect(skipped).toEqual([1])
    expect(again.save()).toEqual([first])
    expect(() => again.issue('E1-001', '600B-E1#1', pub(alice))).toThrow(
      /issued already/
    )
  })

  it('restores from a log of everything it wrote, the latest of every card', () => {
    const log: Consignment[] = []
    const ledger = new CardLedger({...options, persist: c => log.push(c)})
    const card = verified(
      ledger,
      ledger.issue('E1-042', '600B-E1#17', pub(alice))
    )
    const move = moveOf(card, alice, pub(bob))
    moved(ledger.burn({k1s: [move.k1], p1: move.p1, state: move.state}))
    ledger.issue('E1-001', '600B-E1#1', pub(alice))
    expect(log).toHaveLength(3)
    const again = CardLedger.restore(options, log)
    expect(again.save()).toEqual(ledger.save())
    expect(refusal(again.lookup(card.q))).toBe(SPENT)
  })

  it('reports every history that forks the one kept, whatever its length', () => {
    const log: Consignment[] = []
    const ledger = new CardLedger({...options, persist: c => log.push(c)})
    const card = verified(
      ledger,
      ledger.issue('E1-042', '600B-E1#17', pub(alice))
    )
    const toBob = moveOf(card, alice, pub(bob))
    const atBob = verified(
      ledger,
      moved(ledger.burn({k1s: [toBob.k1], p1: toBob.p1, state: toBob.state}))
        .consignment
    )
    const toEve = moveOf(atBob, bob, pub(eve))
    moved(ledger.burn({k1s: [toEve.k1], p1: toEve.p1, state: toEve.state}))
    // an old backup restored, and the old owner's move signed again
    const old = CardLedger.restore(options, [log[0]])
    const toCarol = moveOf(card, alice, pub(key(4)))
    const forked = moved(
      old.burn({k1s: [toCarol.k1], p1: toCarol.p1, state: toCarol.state})
    ).consignment
    const skipped: [string, number][] = []
    const again = CardLedger.restore(options, [...log, forked], (p, at) =>
      skipped.push([p, at])
    )
    // the shorter fork is named; the kept history's own past is not
    expect(skipped).toEqual([[expect.stringMatching(/forks the one kept/), 3]])
    expect(again.save()).toEqual([log[2]])
  })

  it('refuses a store none of whose records checks out, naming each', () => {
    const {ledger} = twoCards()
    const [first] = ledger.save()
    const skipped: [string, number][] = []
    const damaged = [
      null,
      {},
      {...first, issuer: 'zz'},
      {...first, genesis: '00'.repeat(64)},
      {...first, states: first.states.map(s => s.toUpperCase())}
    ] as unknown as Consignment[]
    expect(() =>
      CardLedger.restore(options, damaged, (p, at) => skipped.push([p, at]))
    ).toThrow(/none of the cards checks out/)
    expect(skipped.map(([, at]) => at).sort()).toEqual([0, 1, 2, 3, 4])
    for (const [problem] of skipped)
      expect(problem).toMatch(/does not check out/)
    // an empty store is a new card mint
    expect(CardLedger.restore(options, []).save()).toEqual([])
  })

  it('keeps the same history of a card whatever the order of its records', () => {
    // one card and serial issued twice, to two holders: a double issue
    const [a, b] = [alice, bob].map(owner =>
      new CardLedger(options).issue('E1-001', '600B-E1#1', pub(owner))
    )
    const kept = (records: Consignment[]) => {
      const skipped: number[] = []
      const again = CardLedger.restore(options, records, (_, at) =>
        skipped.push(at)
      )
      return {saved: again.save(), skipped}
    }
    const forward = kept([a, b])
    const backward = kept([b, a])
    expect(forward.saved).toEqual(backward.saved)
    expect(forward.skipped).toHaveLength(1)
    expect(backward.skipped).toHaveLength(1)
  })

  it('takes only a whole number of states, at least 1, as its bound', () => {
    for (const maxStates of [Number.NaN, 0, 1.5, -3, Infinity])
      expect(() => new CardLedger({...options, maxStates})).toThrow(
        /whole number/
      )
    const still = new CardLedger({...options, maxStates: 1})
    const card = verified(
      still,
      still.issue('E1-042', '600B-E1#17', pub(alice))
    )
    const move = moveOf(card, alice, pub(bob))
    expect(
      refusal(still.burn({k1s: [move.k1], p1: move.p1, state: move.state}))
    ).toBe(MOVED_OUT)
  })
})
