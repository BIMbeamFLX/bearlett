// The LNURL layer against the conformance suite's wire vectors: links and
// inputs, URL admission, BOLT-11 amounts, payRequests and their invoices,
// LUD-21 verify, the informational GET, and mint fees.
import {describe, expect, it} from 'vitest'
import {vectors} from '../conformance.ts'
import {
  buildNoteLink,
  decodeLnurl,
  encodeLnurl,
  fromLud17,
  invoiceAmountMsat,
  isInvoice,
  parseNoteLink,
  resolveLnurlInput,
  resolveMintInput
} from '../../src/lnurl/links.ts'
import {isAllowedServiceUrl, type Net} from '../../src/lnurl/net.ts'
import {
  expectedMintValue,
  grossForNet,
  parseMintFee,
  parsePayRequest,
  parseSettlement,
  requestInvoice,
  type MintFee
} from '../../src/lnurl/pay.ts'
import {fetchNoteInfo, parseNoteInfo} from '../../src/lnurl/withdraw.ts'

/** A Net that answers every GET with one body and records what was asked. */
const answering = (
  body: Record<string, unknown>,
  asked: string[] = []
): Net => ({
  async get(url) {
    asked.push(url)
    return body
  }
})

const fee = (f: {baseFeeMsat: number; feePpm: number}): MintFee => ({
  baseMsat: f.baseFeeMsat,
  ppm: f.feePpm
})

describe('bech32 LNURLs (LUD-01)', () => {
  const v = vectors('bech32')

  it.each(v.encode.map((c: any) => [c.url, c.lnurl]))(
    'encodes %s',
    (url, lnurl) => {
      expect(encodeLnurl(url)).toBe(lnurl)
      expect(decodeLnurl(lnurl)).toBe(url)
    }
  )

  it.each(v.decodeInvalid.map((c: any) => [c.why, c.input]))(
    'refuses %s',
    (_, input) => {
      expect(decodeLnurl(input)).toBeNull()
    }
  )

  it('decodes either casing to the same URL', () => {
    expect(decodeLnurl(v.caseInsensitive.lower)).toBe(v.caseInsensitive.url)
    expect(decodeLnurl(v.caseInsensitive.upper)).toBe(v.caseInsensitive.url)
  })
})

describe('BOLT-11 amounts', () => {
  const v = vectors('bolt11')

  it.each(v.decodeAmountMsat.map((c: any) => [c.pr, c.expect]))(
    '%s -> %s msat',
    (pr, msat) => {
      expect(invoiceAmountMsat(pr)).toBe(msat)
    }
  )

  it.each(v.isInvoice.map((c: any) => [c.pr, c.expect]))(
    '%s is an invoice: %s',
    (pr, expected) => {
      expect(isInvoice(pr)).toBe(expected)
    }
  )
})

describe('URL admission', () => {
  const v = vectors('url-admission')

  it.each(v.allowed.map((url: string) => [url]))('allows %s', url => {
    expect(isAllowedServiceUrl(url)).toBe(true)
  })

  it.each(v.rejected.map((c: any) => [c.url, c.why]))(
    'refuses %s (%s)',
    url => {
      expect(isAllowedServiceUrl(url)).toBe(false)
    }
  )
})

describe('resolving what a user hands over', () => {
  const v = vectors('input-resolution')

  it.each(v.lnurl.map((c: any) => [JSON.stringify(c.input), c.expect, c]))(
    'an LNURL %s -> %s',
    (_, expected, c: any) => {
      expect(resolveLnurlInput(c.input)).toBe(expected)
    }
  )

  it.each(v.mint.map((c: any) => [JSON.stringify(c.input), c.expect, c]))(
    'a mint %s -> %s',
    (_, expected, c: any) => {
      expect(resolveMintInput(c.input)).toBe(expected)
    }
  )

  it.each(v.note.map((c: any) => [c.input.slice(0, 48), c.expect, c]))(
    'a note %s… -> %s',
    (_, expected, c: any) => {
      if (expected === null) {
        expect(parseNoteLink(c.input)).toBeNull()
      } else {
        expect(parseNoteLink(c.input)).not.toBeNull()
        expect(resolveLnurlInput(c.input)).toBe(expected)
      }
    }
  )
})

describe('note links', () => {
  const v = vectors('note-url')

  it.each(v.parse.map((c: any) => [c.url.slice(0, 60), c]))(
    'parses %s…',
    (_, c: any) => {
      const link = parseNoteLink(c.url)
      if (c.k1 === null) {
        expect(link).toBeNull()
        return
      }
      expect(link!.k1).toBe(c.k1)
      expect(link!.amountMsat ?? null).toBe(c.declaredAmountMsat)
      expect(link!.c ?? null).toBe(c.signature)
      // the endpoint carries none of the note's own parameters
      for (const name of ['k1', 'amount', 'c', 'sig'])
        expect(new URL(link!.endpoint).searchParams.has(name)).toBe(false)
    }
  )

  it.each(v.build.map((c: any) => [c.withdrawLink, c]))(
    'builds from %s',
    (_, c: any) => {
      const built = buildNoteLink({
        endpoint: fromLud17(c.withdrawLink),
        k1: c.k1,
        amountMsat: c.amountMsat ?? undefined
      })
      // Bearlett hands links out in their lnurlw:// form; LUD-17 maps it back
      expect(fromLud17(built)).toBe(c.expect)
    }
  )
})

describe('payRequests (Minting)', () => {
  const v = vectors('pay-request')
  const url = 'https://mint.example/.well-known/lnurlp/mint'

  it.each(v.accepted.map((c: any) => [c.name, c]))(
    'accepts %s',
    (_, c: any) => {
      const pay = parsePayRequest(url, c.body)
      expect(pay.withdrawLink ?? null).toBe(
        c.withdrawLink ? fromLud17(c.withdrawLink) : null
      )
      if (c.commentAllowed !== undefined)
        expect(pay.commentAllowed).toBe(c.commentAllowed)
      expect(pay.mintFee ?? null).toEqual(c.mintFee ? fee(c.mintFee) : null)
    }
  )

  it.each(v.rejected.map((c: any) => [c.name, c]))(
    'refuses %s',
    (_, c: any) => {
      expect(() => parsePayRequest(url, c.body)).toThrow()
    }
  )

  const mintPay = parsePayRequest(url, v.accepted[0].body)

  it.each(v.invoice.accepted.map((c: any) => [c.name, c]))(
    'takes an invoice: %s',
    async (_, c: any) => {
      const invoice = await requestInvoice(
        answering(c.body),
        mintPay,
        c.requestedMsat
      )
      expect(invoice.pr).toBe(c.body.pr)
      expect(invoice.verify ?? null).toBe(c.verify ?? null)
    }
  )

  it.each(v.invoice.rejected.map((c: any) => [c.name, c]))(
    'refuses an invoice: %s',
    async (_, c: any) => {
      await expect(
        requestInvoice(answering(c.body), mintPay, c.requestedMsat)
      ).rejects.toThrow()
    }
  )

  it.each(v.verify.accepted.map((c: any) => [c.name, c]))(
    'reads LUD-21 verify: %s',
    (_, c: any) => {
      const settlement = parseSettlement(c.body)
      expect(settlement.settled).toBe(c.settled)
      expect(settlement.preimage ?? null).toBe(c.preimage)
    }
  )

  it.each(v.verify.rejected.map((c: any) => [c.name, c]))(
    'refuses LUD-21 verify: %s',
    (_, c: any) => {
      expect(() => parseSettlement(c.body)).toThrow()
    }
  )
})

describe('the informational GET', () => {
  const v = vectors('withdraw-info')
  const endpoint = 'https://mint.example/w'
  const k1 = 'a'.repeat(64)

  it.each(v.accepted.map((c: any) => [c.name, c]))(
    'accepts %s',
    (_, c: any) => {
      expect(parseNoteInfo(endpoint, {k1}, c.body).amountMsat).toBe(
        c.maxWithdrawable
      )
    }
  )

  const refused = v.rejected.filter((c: any) => c.name !== 'no mintPubkey')

  it.each(refused.map((c: any) => [c.name, c]))('refuses %s', (_, c: any) => {
    expect(() => parseNoteInfo(endpoint, {k1}, c.body)).toThrow()
  })

  it('deviates on a missing mintPubkey: LUD-25 makes certifying a SHOULD', () => {
    // withdraw-info.json refuses it as "offline verification is mandatory in
    // the current draft"; lnurl/luds 50d740a says SERVICE SHOULD certify, and
    // the suite's own grader only warns. Such a note is kept, uncertified.
    const body = v.rejected.find((c: any) => c.name === 'no mintPubkey').body
    const info = parseNoteInfo(endpoint, {k1}, body)
    expect(info.mintPubkey).toBeUndefined()
  })

  it("sends the k1 unchanged and never the note link's own certificate", async () => {
    const link = parseNoteLink(v.queriedUrl)!
    const asked: string[] = []
    await fetchNoteInfo(answering(v.accepted[0].body, asked), link.endpoint, {
      k1: link.k1
    })
    const sent = new URL(asked[0])
    for (const name of v.requestMustNotSend)
      expect(sent.searchParams.has(name)).toBe(false)
    for (const name of v.requestMustSendUnchanged)
      expect(sent.searchParams.get(name)).toBe(
        new URL(v.queriedUrl).searchParams.get(name)
      )
  })
})

describe('mint fees', () => {
  const v = vectors('fees')

  it.each(v.parse.map((c: any) => [c.metadata, c.expect]))(
    'reads %s',
    (metadata, expected) => {
      expect(parseMintFee(metadata) ?? null).toEqual(
        expected ? fee(expected) : null
      )
    }
  )

  it.each(v.apply.map((c: any) => [c.grossMsat, c.fee, c.expect]))(
    'nets %i msat under %o as %i',
    (gross, f, net) => {
      expect(expectedMintValue(gross, fee(f))).toBe(net)
    }
  )

  it.each(v.grossUp.map((c: any) => [c.netMsat, c.fee, c.expect]))(
    'needs %i msat net under %o paid as %i',
    (net, f, gross) => {
      expect(grossForNet(net, fee(f))).toBe(gross)
    }
  )

  it('finds the true minimum on every round trip', () => {
    const {fees, netAmountsMsat} = v.grossUpRoundTrip
    for (const f of fees)
      for (const net of netAmountsMsat) {
        const gross = grossForNet(net, fee(f))
        expect(expectedMintValue(gross, fee(f))).toBe(net)
        expect(expectedMintValue(gross - 1, fee(f))).toBeLessThan(net)
      }
  })
})
