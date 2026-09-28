// A reference card mint for the tests: the rules of src/cards/ledger.ts
// behind LUD-25 HTTP (docs/CARDS-LNURLCASH.md, The card mint), with packs
// sold through a LUD-06 payRequest whose invoice the test hook
// /_test/settle?payment_hash= pays. Fresh issuer and mint keys every start.
// It listens on this machine; with `origin` it names another origin in its
// documents, for a test that reaches it through a Net mapping that origin
// here (an https card mint, as the Hangar's inventory needs).
import {createServer, type ServerResponse} from 'node:http'
import type {AddressInfo} from 'node:net'
import {
  bytesToHex,
  hexToBytes,
  randomBytes,
  sha256
} from '../../src/spec/bytes.ts'
import {decodeCp1} from '../../src/spec/encoding.ts'
import {CardLedger, CARD_MSAT} from '../../src/cards/ledger.ts'

export type CardMintOptions = {
  /** the card names one pack holds, in order */
  pack?: string[]
  priceSat?: number
  edition?: string
  collection?: string
  /** a fixed port, for trying the web app against it by hand */
  port?: number
  /** the origin its documents name, e.g. `https://cards.test` */
  origin?: string
}

const BECH32 = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'
const fakeInvoice = (sat: number) =>
  `lnbc${sat * 10}n1` +
  Array.from(randomBytes(52), byte => BECH32[byte % 32]).join('')

export const startCardMint = async (options: CardMintOptions = {}) => {
  const pack = options.pack ?? ['E1-001', 'E1-042', 'E1-042']
  const priceSat = options.priceSat ?? 21
  const collection = options.collection ?? '600B-E1'
  const issuerKey = randomBytes(32)
  let ledger: CardLedger
  let origin = ''
  let local = ''
  const serials = new Map<string, number>()
  const invoices = new Map<
    string,
    {pr: string; owner: Uint8Array; preimage: Uint8Array; settled: boolean}
  >()

  const issuePack = (owner: Uint8Array) => {
    for (const name of pack) {
      const serial = (serials.get(name) ?? 0) + 1
      serials.set(name, serial)
      ledger.issue(name, `${collection}#${serial}`, owner)
    }
  }

  const send = (res: ServerResponse, body: unknown) => {
    // LNURL services answer browsers from any origin (LUD-01)
    res.writeHead(200, {
      'content-type': 'application/json',
      'access-control-allow-origin': '*'
    })
    res.end(JSON.stringify(body))
  }
  const error = (res: ServerResponse, reason: string) =>
    send(res, {status: 'ERROR', reason})

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', origin)
    const query = url.searchParams
    const path = url.pathname
    if (path === '/.well-known/lnurlcash-cards')
      return send(res, {
        v: 0,
        issuer: bytesToHex(ledger.issuer),
        withdraw: `${origin}/w`,
        lookup: `${origin}/cards`,
        packs: [
          {
            lnurlp: `${origin}/.well-known/lnurlp/pack`,
            edition: options.edition ?? '600b-e1',
            collection_id: collection,
            catalog_uri: ''
          }
        ]
      })
    if (path === '/w') {
      const k1 = query.get('k1')
      const p = query.get('p')
      const q = p ? decodeCp1(p) : null
      const found = k1 ? ledger.lookupSpend(k1) : q ? ledger.lookup(q) : null
      if (!found) return error(res, 'Ask for a note by k1 or p.')
      if ('refused' in found) return error(res, found.refused)
      return send(res, {
        tag: 'withdrawRequest',
        callback: `${origin}/w/cb`,
        ...(k1 ? {k1} : {}),
        minWithdrawable: CARD_MSAT,
        maxWithdrawable: CARD_MSAT,
        defaultDescription: 'A 600B card',
        mintPubkey: ledger.mintPubkey,
        c: found.c
      })
    }
    if (path === '/w/cb') {
      const answer = ledger.burn({
        k1s: query.getAll('k1'),
        p1: query.get('p1') ?? undefined,
        state: query.get('state') ?? undefined,
        amount: query.get('amount') ?? undefined,
        p2: query.get('p2') ?? undefined,
        pr: query.get('pr') ?? undefined
      })
      if ('refused' in answer) return error(res, answer.refused)
      return send(res, {
        status: 'OK',
        c: answer.c,
        receipt: bytesToHex(answer.receipt)
      })
    }
    if (path === '/cards') {
      const owner = query.get('owner') ?? ''
      if (!/^[0-9a-f]{64}$/.test(owner)) return error(res, 'Name an owner key.')
      return send(res, ledger.lookupOwner(hexToBytes(owner)))
    }
    if (path === '/.well-known/lnurlp/pack')
      return send(res, {
        tag: 'payRequest',
        callback: `${origin}/pack/cb`,
        minSendable: priceSat * 1000,
        maxSendable: priceSat * 1000,
        metadata: JSON.stringify([
          ['text/plain', `A pack of ${pack.length} 600B cards`]
        ]),
        commentAllowed: 100
      })
    if (path === '/pack/cb') {
      const owner = decodeCp1(query.get('comment') ?? '')
      if (!owner) return error(res, 'Name the key the pack is for.')
      if (query.get('amount') !== String(priceSat * 1000))
        return error(res, 'A pack has one price.')
      const preimage = randomBytes(32)
      const hash = bytesToHex(sha256(preimage))
      const pr = fakeInvoice(priceSat)
      invoices.set(hash, {pr, owner, preimage, settled: false})
      return send(res, {pr, routes: [], verify: `${origin}/verify/${hash}`})
    }
    const verify = /^\/verify\/([0-9a-f]{64})$/.exec(path)
    if (verify) {
      const invoice = invoices.get(verify[1])
      if (!invoice) return error(res, 'Unknown invoice.')
      return send(res, {
        status: 'OK',
        settled: invoice.settled,
        preimage: invoice.settled ? bytesToHex(invoice.preimage) : null,
        pr: invoice.pr
      })
    }
    if (path === '/_test/settle') {
      const invoice = invoices.get(query.get('payment_hash') ?? '')
      if (!invoice) return error(res, 'Unknown invoice.')
      if (!invoice.settled) issuePack(invoice.owner)
      invoice.settled = true
      return send(res, {status: 'OK', settled: true})
    }
    res.writeHead(404).end()
  })
  await new Promise<void>(resolve =>
    server.listen(options.port ?? 0, '127.0.0.1', resolve)
  )
  local = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  origin = options.origin ?? local
  ledger = new CardLedger({
    withdraw: `${origin}/w`,
    issuerKey,
    mintKey: randomBytes(32)
  })
  return {
    url: origin,
    /** where it listens: `url` itself unless it names another origin */
    local,
    get ledger() {
      return ledger
    },
    /** Pays a pack's invoice, by the hash in its verify URL. */
    async settle(verify: string): Promise<void> {
      const hash = new URL(verify).pathname.split('/').pop()
      const answer = await fetch(`${local}/_test/settle?payment_hash=${hash}`)
      if (!(await answer.json()).settled) throw new Error('not settled')
    },
    close: () => new Promise<void>(resolve => server.close(() => resolve()))
  }
}

export type CardMint = Awaited<ReturnType<typeof startCardMint>>
