import {describe, expect, it} from 'vitest'
import * as cashu from '@cashu/cashu-ts'
import {bytesToHex, hexToBytes} from '@noble/hashes/utils.js'
import {TestNutftMint} from './fixture'
import {decodeCards, encodeCards} from './tokens'
import {
  MAX_TOKEN_LENGTH,
  MAX_WAITING_DELIVERIES,
  RECEIVE_CONVENTION,
  ReceiveProblem,
  WEBSITE_CARDS,
  checkLockedTo,
  isFinalRefusal,
  queueDelivery,
  readCardToken,
  receiveIntentToken,
  receiveProblem
} from './receive'

const mint = new TestNutftMint()
const edition = {mint: mint.url, units: [mint.unit]}
const MINE = '1d'.repeat(32)
const THEIRS = '2e'.repeat(32)
const pubkeyOf = (key: string) =>
  bytesToHex(cashu.getPubKeyFromPrivKey(hexToBytes(key)))

const reason = (work: () => unknown): string => {
  try {
    work()
  } catch (error) {
    expect(error).toBeInstanceOf(ReceiveProblem)
    return (error as ReceiveProblem).reason
  }
  return 'accepted'
}

describe('readCardToken', () => {
  it('reads a card token without asking the mint', () => {
    const token = mint.issue(pubkeyOf(MINE), 1)
    const card = readCardToken(token, edition, cashu)
    expect(card.token).toBe(token)
    expect(card.proofs).toHaveLength(1)
    expect(card.proofs[0].p2pk_e).toMatch(/^0[23][0-9a-f]{64}$/)
  })

  it('takes a pasted token with a cashu: prefix and stray whitespace', () => {
    const token = mint.issue(pubkeyOf(MINE), 2)
    expect(readCardToken(`\n  cashu:${token}  \n`, edition, cashu).token).toBe(
      token
    )
  })

  it('says a card from another mint belongs to a different mint', () => {
    const other = new TestNutftMint({url: 'https://other.test/e1'})
    expect(
      reason(() => readCardToken(other.issue(pubkeyOf(MINE)), edition, cashu))
    ).toBe('other-mint')
    expect(new ReceiveProblem('other-mint').message).toBe(
      'This card belongs to a different mint.'
    )
    for (const url of [
      `${mint.url}2`,
      'https://mint.test/e2',
      'https://mint.test'
    ])
      expect(
        reason(() =>
          readCardToken(
            encodeCards(
              {...decodeCards(mint.issue(pubkeyOf(MINE)), cashu), mint: url},
              cashu
            ),
            edition,
            cashu
          )
        )
      ).toBe('other-mint')
  })

  it('takes a trailing slash as this mint, and writes the token under its spelling', () => {
    const issued = mint.issue(pubkeyOf(MINE), 2)
    const slashed = encodeCards(
      {...decodeCards(issued, cashu), mint: `${mint.url}/`},
      cashu
    )
    const card = readCardToken(slashed, edition, cashu)
    /* The card library compares mints exactly when it imports. */
    expect(cashu.getTokenMetadata(card.token).mint).toBe(mint.url)
    expect(cashu.getDecodedToken(card.token, [mint.id]).proofs).toEqual(
      cashu.getDecodedToken(issued, [mint.id]).proofs
    )
    /* A token already spelt this way is passed on exactly as it came. */
    expect(readCardToken(issued, edition, cashu).token).toBe(issued)
  })

  it('refuses another collection on the same mint', () => {
    const g = new TestNutftMint({unit: '600B-G'})
    expect(
      reason(() => readCardToken(g.issue(pubkeyOf(MINE)), edition, cashu))
    ).toBe('other-collection')
  })

  it('refuses a sats token as holding no cards', () => {
    const sats = cashu.getEncodedToken({
      mint: mint.url,
      unit: mint.unit,
      proofs: [
        {
          id: mint.id,
          amount: cashu.Amount.from(8),
          secret: 'plain',
          C: '02' + 'ab'.repeat(32)
        }
      ]
    })
    expect(reason(() => readCardToken(sats, edition, cashu))).toBe('not-a-card')
  })

  it('refuses what is not a token, and never repeats it', () => {
    const cases: Array<[unknown, string]> = [
      ['', 'empty'],
      ['   \n', 'empty'],
      ['my card, please', 'not-a-token'],
      ['cashuB!notbase64', 'not-a-token'],
      ['cashuBc2VjcmV0LW1hdGVyaWFsLWluLWEtYnJva2VuLXRva2Vu', 'not-a-token'],
      [`cashuB${'A'.repeat(MAX_TOKEN_LENGTH)}`, 'not-a-token'],
      [42, 'not-a-token']
    ]
    for (const [input, expected] of cases) {
      expect(reason(() => readCardToken(input, edition, cashu))).toBe(expected)
      try {
        readCardToken(input, edition, cashu)
      } catch (error) {
        if (typeof input === 'string' && input.trim())
          expect(String((error as Error).stack)).not.toContain(
            input.slice(0, 40)
          )
      }
    }
  })
})

describe('checkLockedTo', () => {
  it('lets through a card locked to this wallet', () => {
    const card = readCardToken(mint.issue(pubkeyOf(MINE)), edition, cashu)
    expect(() => checkLockedTo(card, MINE, cashu)).not.toThrow()
  })

  it('points a card locked to someone else back at this address', () => {
    const card = readCardToken(mint.issue(pubkeyOf(THEIRS)), edition, cashu)
    expect(reason(() => checkLockedTo(card, MINE, cashu))).toBe('locked')
    expect(new ReceiveProblem('locked').message).toMatch(
      /locked to another address.*this collection's address/
    )
  })
})

describe('receiveProblem', () => {
  it('turns the card library refusals into sentences a holder can act on', () => {
    const cases: Array<[string, string]> = [
      ['token is already in this wallet', 'already-held'],
      ['token is spent or not addressed to this wallet', 'spent'],
      ['token mint, unit, or proofs are invalid', 'other-mint'],
      ['invalid NutFT proof', 'unknown-card'],
      ['catalog has no verified asset 600B-E1-999', 'unknown-card'],
      ['mint capabilities unavailable (503)', 'unreachable'],
      [
        'Shell request timed out. Reconcile the stored operation.',
        'unreachable'
      ],
      [
        'Mint request unavailable, denied, or interrupted. Check the stored operation before retrying.',
        'unreachable'
      ]
    ]
    for (const [message, expected] of cases)
      expect(receiveProblem(new Error(message)).reason).toBe(expected)
  })

  it('never passes a message it does not recognise through', () => {
    const quoted = new SyntaxError(
      'Unexpected token, "cashuBo2FteBdodHRwczovL21pbnQ" is not valid JSON'
    )
    const problem = receiveProblem(quoted)
    expect(problem.reason).toBe('failed')
    expect(problem.message).not.toContain('cashuB')
    expect(receiveProblem('a string thrown by someone').reason).toBe('failed')
  })
})

describe('receiveIntentToken', () => {
  it('takes {token} and nothing else', () => {
    expect(receiveIntentToken({token: 'cashuBabc'})).toBe('cashuBabc')
    for (const payload of [
      undefined,
      null,
      'cashuBabc',
      ['cashuBabc'],
      {note: 'cashuBabc'},
      {token: 7}
    ])
      expect(reason(() => receiveIntentToken(payload))).toBe('not-a-token')
  })

  it('names the convention other napplets hand cards over on', () => {
    expect(RECEIVE_CONVENTION).toBe('napplet:collection/receive')
  })
})

describe('a token after a refusal', () => {
  it('stays in the field unless no second try can change the answer', () => {
    const final = [
      'empty',
      'not-a-token',
      'other-mint',
      'other-collection',
      'not-a-card',
      'locked',
      'already-held',
      'spent'
    ] as const
    const retry = [
      'unknown-card',
      'unreachable',
      'waiting',
      'moving',
      'failed'
    ] as const
    for (const reason of final)
      expect(isFinalRefusal(new ReceiveProblem(reason))).toBe(true)
    for (const reason of retry)
      expect(isFinalRefusal(new ReceiveProblem(reason))).toBe(false)
  })
})

describe('queueDelivery', () => {
  it('lines up each delivered card once, oldest first', () => {
    let waiting = queueDelivery([], 'cashuBone', '')
    waiting = queueDelivery(waiting, 'cashuBtwo', '')
    waiting = queueDelivery(waiting, 'cashuBone', '')
    expect(waiting).toEqual(['cashuBone', 'cashuBtwo'])
  })

  it('never lines up the card that is already in the field', () => {
    expect(queueDelivery([], 'cashuBone', '  cashuBone\n')).toEqual([])
  })

  it('takes no more once the line is full', () => {
    const full = Array.from(
      {length: MAX_WAITING_DELIVERIES},
      (_, n) => `cashuB${n}`
    )
    expect(queueDelivery(full, 'cashuBmore', '')).toBe(full)
  })
})

describe('the paste help', () => {
  it('says where a card bought on the website goes first', () => {
    expect(WEBSITE_CARDS).toBe(
      "A card bought on tcg.nappelin.com is locked to that site's wallet: send it to your collection's address in the wallet there first, then paste the token into the collection."
    )
  })
})
