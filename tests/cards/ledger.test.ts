// A card mint's rules (src/cards/ledger.ts): what it issues and vouches for,
// what it refuses, and what a forger holds without it.
import {schnorr} from '@noble/curves/secp256k1.js'
import {describe, expect, it} from 'vitest'
import {makeMove} from '../../src/cards/holder.ts'
import {
  CardLedger,
  CARD_MSAT,
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

describe('restoring', () => {
  it('restores itself from what it saved, and nothing tampered with', () => {
    const {ledger, card} = issued()
    const move = moveOf(card, alice, pub(bob))
    moved(ledger.burn({k1s: [move.k1], p1: move.p1, state: move.state}))
    ledger.issue('E1-001', '600B-E1#1', pub(alice))
    const again = CardLedger.restore(options, ledger.save())
    expect(again.save()).toEqual(ledger.save())
    expect(refusal(again.lookup(card.q))).toBe(SPENT)
    expect(again.byOwner(pub(bob))).toHaveLength(1)
    const [first] = ledger.save()
    const receipt = first.receipts[0]
    const flipped = (receipt[0] === '0' ? '1' : '0') + receipt.slice(1)
    expect(() =>
      CardLedger.restore(options, [{...first, receipts: [flipped]}])
    ).toThrow(/Not restorable/)
  })
})
