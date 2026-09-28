// The card state against dni's seals addon: the same bytes, hashes, output
// keys and spends as lnurl-wallet's seals.ts computes (seal-vectors.json),
// and a strict reading of everything else.
import {readFileSync} from 'node:fs'
import {describe, expect, it} from 'vitest'
import {bytesToHex, hexToBytes} from '../../src/spec/bytes.ts'
import {checkSpend, decodeSpend} from '../../src/spec/notes.ts'
import {
  cardAssetId,
  cardLeaf,
  cardNote,
  decodeState,
  encodeState,
  genesisState,
  moveProblem,
  nextState,
  stateHash,
  STATE_TAG,
  type CardState
} from '../../src/cards/state.ts'

type Vector = {
  state: {
    assetId: string
    name: string
    description: string
    stateIndex: number
    ownerPubkeyHex: string
    prevStateHash: string
  }
  hash: string
  q: string
  cw1: string
}
const {vectors} = JSON.parse(
  readFileSync(new URL('./seal-vectors.json', import.meta.url), 'utf8')
) as {vectors: Vector[][]}

const stateOf = ({state}: Vector): CardState => ({
  assetId: hexToBytes(state.assetId),
  name: state.name,
  description: state.description,
  index: state.stateIndex,
  owner: hexToBytes(state.ownerPubkeyHex),
  prev: state.prevStateHash
    ? hexToBytes(state.prevStateHash)
    : new Uint8Array(32)
})

const all = vectors.flat()

describe('the same seal as lnurl-wallet', () => {
  it.each(all.map(v => [`${v.state.name} #${v.state.stateIndex}`, v]))(
    '%s: state hash and note key',
    (_, vector) => {
      const state = stateOf(vector as Vector)
      expect(bytesToHex(stateHash(state))).toBe((vector as Vector).hash)
      expect(bytesToHex(cardNote(state).q)).toBe((vector as Vector).q)
    }
  )

  it.each(all.map(v => [`${v.state.name} #${v.state.stateIndex}`, v]))(
    '%s: its move opens the note, bound to the mint',
    (_, vector) => {
      const {cw1} = vector as Vector
      const state = stateOf(vector as Vector)
      const spend = decodeSpend(cw1)
      expect(spend?.kind).toBe('script')
      if (spend?.kind !== 'script') return
      expect(bytesToHex(spend.q)).toBe((vector as Vector).q)
      expect(bytesToHex(spend.script)).toBe(bytesToHex(cardLeaf(state)))
      expect(bytesToHex(spend.witness[1])).toBe(bytesToHex(encodeState(state)))
      expect(checkSpend(spend, 'cards.example')).toEqual({status: 'valid'})
      expect(checkSpend(spend, 'other.example').status).toBe('invalid')
    }
  )

  it('chains the next state as seals.ts does', () => {
    for (const chain of vectors)
      for (let i = 1; i < chain.length; i++) {
        const next = nextState(stateOf(chain[i - 1]), stateOf(chain[i]).owner)
        expect(encodeState(next)).toEqual(encodeState(stateOf(chain[i])))
        expect(moveProblem(stateOf(chain[i - 1]), next)).toBeNull()
      }
  })
})

describe('reading a state', () => {
  const issuer = hexToBytes('11'.repeat(32))
  const owner = cardNote(stateOf(all[0])).q
  const card = genesisState(
    issuer,
    'E1-042',
    '600B-E1#17',
    stateOf(all[0]).owner
  )

  it('reads back exactly what it wrote', () => {
    const decoded = decodeState(encodeState(card))
    expect(decoded && encodeState(decoded)).toEqual(encodeState(card))
    for (const vector of all) {
      const spend = decodeSpend(vector.cw1)
      if (spend?.kind !== 'script') throw new Error('not a script spend')
      expect(decodeState(spend.witness[1])?.name).toBe(vector.state.name)
    }
  })

  it('refuses anything that is not one exact state', () => {
    const bytes = encodeState(card)
    const changed = (at: number, value: number) => {
      const copy = bytes.slice()
      copy[at] = value
      return copy
    }
    expect(decodeState(bytes.slice(0, -1))).toBeNull()
    expect(decodeState(new Uint8Array([...bytes, 0]))).toBeNull()
    expect(decodeState(changed(0, 0x6d))).toBeNull()
    // the name's first byte, made an invalid UTF-8 lead byte
    expect(decodeState(changed(STATE_TAG.length + 34, 0xff))).toBeNull()
    // an owner that is no point on the curve
    const offCurve = bytes.slice()
    offCurve.set(new Uint8Array(32).fill(0xff), bytes.length - 64)
    expect(decodeState(offCurve)).toBeNull()
  })

  it('fits a state into the 520 bytes a witness item may have', () => {
    const room = 520 - encodeState({...card, name: '', description: ''}).length
    expect(room).toBe(393)
    const full = {...card, name: 'x'.repeat(room), description: ''}
    expect(encodeState(full)).toHaveLength(520)
    expect(() => encodeState({...full, name: `${full.name}x`})).toThrow(/520/)
  })

  it('gives every card of an issuer its own id', () => {
    const id = (name: string, description: string) =>
      bytesToHex(cardAssetId(issuer, name, description))
    expect(id('E1-042', '600B-E1#17')).toBe(bytesToHex(card.assetId))
    expect(id('E1-042', '600B-E1#18')).not.toBe(bytesToHex(card.assetId))
    // the length prefixes keep "E1-04" + "2600B" apart from "E1-042" + "600B"
    expect(id('E1-04', '2600B-E1#17')).not.toBe(id('E1-042', '600B-E1#17'))
    expect(
      bytesToHex(
        cardAssetId(hexToBytes('22'.repeat(32)), 'E1-042', '600B-E1#17')
      )
    ).not.toBe(bytesToHex(card.assetId))
  })

  it('says why a state does not follow another', () => {
    const next = nextState(card, owner)
    expect(moveProblem(card, next)).toBeNull()
    expect(moveProblem(card, {...next, index: 2})).toMatch(/index/)
    expect(moveProblem(card, {...next, name: 'E1-043'})).toMatch(/identity/)
    expect(moveProblem(card, {...next, prev: new Uint8Array(32)})).toMatch(
      /chain/
    )
    expect(
      moveProblem(card, {...next, owner: new Uint8Array(32).fill(0xff)})
    ).toMatch(/key/)
  })
})
