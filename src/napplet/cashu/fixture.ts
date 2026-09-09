import {
  deriveKeysetId,
  hashToCurve,
  getEncodedToken,
  Amount
} from '@cashu/cashu-ts'
import {secp256k1} from '@noble/curves/secp256k1.js'
import {bytesToHex, hexToBytes} from '@noble/hashes/utils.js'
import {sha256} from '@noble/hashes/sha2.js'
import {bech32} from '@scure/base'
import type {CashuHost, CashuRequest} from './transport'
import {invoiceDigest} from './invoice'

/** Deterministic protocol fixture with real blind signatures; never a production mint. */
export class TestMint implements CashuHost {
  readonly url = 'https://cashu.test/mint'
  readonly keys = Object.fromEntries(
    Array.from({length: 20}, (_, i) => [
      2 ** i,
      bytesToHex(
        secp256k1.getPublicKey(
          hexToBytes((i + 1).toString(16).padStart(64, '0'))
        )
      )
    ])
  )
  readonly id: string
  readonly spent = new Set<string>()
  readonly signatures = new Map<
    string,
    {amount: number; id: string; C_: string}
  >()
  readonly calls: CashuRequest[] = []
  readonly quotes = new Map<string, Record<string, any>>()
  lost?: CashuRequest['operation']
  before?: CashuRequest['operation']
  constructor(readonly inputFee = 0) {
    this.id = deriveKeysetId(this.keys, {unit: 'sat', input_fee_ppk: inputFee})
  }
  private key(amount: number): bigint {
    return BigInt(Math.log2(amount) + 1)
  }
  /** Issue a transferable test note, using independently calculated C = a * H(secret). */
  token(amount = 32): string {
    const secret = crypto.randomUUID()
    return getEncodedToken({
      mint: this.url,
      unit: 'sat',
      proofs: [
        {
          id: this.id,
          amount: Amount.from(amount),
          secret,
          C: hashToCurve(new TextEncoder().encode(secret))
            .multiply(this.key(amount))
            .toHex()
        }
      ]
    })
  }
  private sign(output: any, amount = Number(output.amount)) {
    const signature = {
      amount,
      id: this.id,
      C_: secp256k1.Point.fromHex(output.B_).multiply(this.key(amount)).toHex()
    }
    this.signatures.set(output.B_, signature)
    return signature
  }
  private consume(inputs: any[]) {
    const secrets = new Set<string>()
    for (const p of inputs) {
      if (
        p.id !== this.id ||
        this.spent.has(p.secret) ||
        secrets.has(p.secret) ||
        p.C !==
          hashToCurve(new TextEncoder().encode(p.secret))
            .multiply(this.key(Number(p.amount)))
            .toHex()
      )
        throw new Error('Invalid or spent test proof.')
      secrets.add(p.secret)
    }
    secrets.forEach(s => this.spent.add(s))
  }
  /** Return protocol responses with optional loss after the mint has committed. */
  async request(request: CashuRequest) {
    if (request.mint !== this.url) throw new Error('Unknown test mint.')
    this.calls.push(request)
    if (this.before === request.operation) {
      this.before = undefined
      throw new Error('Disconnected before mint mutation.')
    }
    const data = JSON.parse(request.body ?? '{}')
    const keyset = {
      id: this.id,
      unit: 'sat',
      active: true,
      input_fee_ppk: this.inputFee,
      keys: this.keys
    }
    let result: any
    switch (request.operation) {
      case 'info':
        result = {
          name: 'Test only',
          pubkey: this.keys[1],
          version: 'fixture/1',
          nuts: {
            4: {
              methods: [
                {
                  method: 'bolt11',
                  unit: 'sat',
                  min_amount: 1,
                  max_amount: 100000
                }
              ],
              disabled: false
            },
            5: {
              methods: [
                {
                  method: 'bolt11',
                  unit: 'sat',
                  min_amount: 1,
                  max_amount: 100000
                }
              ],
              disabled: false
            },
            7: {supported: true},
            8: {supported: true},
            9: {supported: true}
          }
        }
        break
      case 'keys':
        result = {keysets: [keyset]}
        break
      case 'keysets':
        result = {keysets: [keyset]}
        break
      case 'checkstate':
        result = {
          states: data.Ys.map((Y: string) => ({
            Y,
            state: [...this.spent].some(
              s => hashToCurve(new TextEncoder().encode(s)).toHex() === Y
            )
              ? 'SPENT'
              : 'UNSPENT'
          }))
        }
        break
      case 'swap': {
        const total = data.inputs.reduce(
          (n: number, p: any) => n + Number(p.amount),
          0
        )
        const fee = Math.ceil((data.inputs.length * this.inputFee) / 1000)
        if (
          data.outputs.reduce(
            (n: number, o: any) => n + Number(o.amount),
            0
          ) !==
          total - fee
        )
          throw new Error('Swap does not conserve value.')
        this.consume(data.inputs)
        result = {signatures: data.outputs.map((o: any) => this.sign(o))}
        break
      }
      case 'restore': {
        const outputs = data.outputs.filter((o: any) =>
          this.signatures.has(o.B_)
        )
        result = {
          outputs,
          signatures: outputs.map((o: any) => this.signatures.get(o.B_))
        }
        break
      }
      case 'mintQuote': {
        const quote = crypto.randomUUID()
        result = {
          quote,
          request: testInvoice(Number(data.amount)),
          state: 'UNPAID',
          expiry: Math.floor(Date.now() / 1000) + 3600
        }
        this.quotes.set(quote, result)
        break
      }
      case 'mintQuoteState':
      case 'meltQuoteState':
        result = this.quotes.get(request.parameter!)
        break
      case 'mint': {
        const quote = this.quotes.get(data.quote)!
        if (quote.state !== 'PAID') throw new Error('Quote is not paid.')
        result = {signatures: data.outputs.map((o: any) => this.sign(o))}
        quote.state = 'ISSUED'
        break
      }
      case 'meltQuote': {
        const quote = crypto.randomUUID()
        const amount = Number(data.request.match(/^lnbc(\d+)n/)[1]) / 10
        result = {
          quote,
          amount,
          fee_reserve: 2,
          state: 'UNPAID',
          expiry: Math.floor(Date.now() / 1000) + 3600,
          request: data.request
        }
        this.quotes.set(quote, result)
        break
      }
      case 'melt': {
        const quote = this.quotes.get(data.quote)!
        if (quote.state !== 'UNPAID') throw new Error('Repeated melt.')
        const total = data.inputs.reduce(
          (n: number, p: any) => n + Number(p.amount),
          0
        )
        let change =
          total -
          quote.amount -
          1 -
          Math.ceil((data.inputs.length * this.inputFee) / 1000)
        if (change < 1) throw new Error('Insufficient test funds.')
        this.consume(data.inputs)
        const amounts = []
        for (let bit = 1; change; bit *= 2)
          if (change & bit) {
            amounts.push(bit)
            change -= bit
          }
        quote.state = 'PAID'
        quote.payment_preimage = '11'.repeat(32)
        quote.change = amounts.map((amount, i) =>
          this.sign(data.outputs[i], amount)
        )
        result = quote
        break
      }
      default:
        throw new Error('Unsupported fixture operation.')
    }
    if (this.lost === request.operation) {
      this.lost = undefined
      throw new Error('Response lost after mint commit.')
    }
    return {status: 200, body: JSON.stringify(result)}
  }
}

/** Signed fixture invoice; no Lightning node is needed for protocol fault tests. */
export function testInvoice(
  sats: number,
  timestamp = Math.floor(Date.now() / 1000)
): string {
  const time = Array.from(
    {length: 7},
    (_, i) => Math.floor(timestamp / 32 ** (6 - i)) % 32
  )
  const hash = bech32.toWords(sha256(hexToBytes('11'.repeat(32))))
  const prefix = `lnbc${sats * 10}n`,
    words = [...time, 1, 1, 20, ...hash]
  const signature = secp256k1.sign(
    invoiceDigest(prefix, words),
    hexToBytes('22'.repeat(32)),
    {prehash: false, format: 'recovered'}
  )
  return bech32.encode(
    prefix,
    [
      ...words,
      ...bech32.toWords(new Uint8Array([...signature.slice(1), signature[0]]))
    ],
    4096
  )
}
