import {
  Amount,
  OutputData,
  createBlindSignature,
  createDLEQProof,
  getEncodedToken,
  getTag,
  hashToCurve,
  pointFromHex,
  schnorrSignDigest
} from '@cashu/cashu-ts'
import {schnorr, secp256k1} from '@noble/curves/secp256k1.js'
import {sha256} from '@noble/hashes/sha2.js'
import {bytesToHex, hexToBytes, utf8ToBytes} from '@noble/hashes/utils.js'
import type {
  NutftHost,
  NutftRequest,
  NutftResponse
} from '../../host/nutft-contract'
import type {CardAsset} from './cards'

/**
 * A NutFT mint for tests and the local preview; never a production mint.
 *
 * Real blind signatures with DLEQ proofs, a catalogue signed the way the card
 * library verifies it, NUT-09 restore over every signature it ever issued, and
 * idempotent trades that refuse to change a card into another one. What it
 * leaves out is everything a collection napplet does not call: sales,
 * Lightning, P2PK witness checks and persistence.
 */

type Signature = {
  id: string
  amount: number
  C_: string
  dleq: {e: string; s: string}
}

export type TestCatalog = {
  collection_id: string
  catalog_uri: string
  assets: CardAsset[]
  issuer_pubkey: string
  signature: string
}

/* The card library's canonical JSON: sorted keys, no whitespace. */
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map(
        key =>
          `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`
      )
      .join(',')}}`
  return JSON.stringify(value)
}

const sha256Hex = (text: string): string =>
  bytesToHex(sha256(utf8ToBytes(text)))

export class TestNutftMint implements NutftHost {
  readonly url: string
  readonly unit: string
  readonly id = '00b3a41e7c9d2f58'
  readonly catalog: TestCatalog
  readonly calls: NutftRequest[] = []
  /** Curve points of spent proofs. */
  readonly spent = new Set<string>()
  /** Every signature issued, by blinded message, so restore can find it. */
  readonly signatures = new Map<string, Signature>()
  /** Settled trades by idempotency key: a retry gets the same answer. */
  readonly trades = new Map<string, string>()
  /** Fail the next call to this operation before the mint changes anything. */
  before?: NutftRequest['operation']
  /** Fail the next call to this operation after the mint has committed it. */
  lost?: NutftRequest['operation']
  private readonly key = hexToBytes('3c'.repeat(32))
  private readonly issuer = hexToBytes('4d'.repeat(32))

  constructor(options: {url?: string; unit?: string; cards?: number} = {}) {
    this.url = options.url ?? 'https://mint.test/e1'
    this.unit = options.unit ?? '600B-E1'
    const catalog_uri = `${this.url}/nutft/catalog`
    const assets = Array.from({length: options.cards ?? 4}, (_, index) => {
      const asset_id = `${this.unit}-${String(index + 1).padStart(3, '0')}`
      /* Each entry repeats its collection and catalogue: restore builds the
         deterministic outputs straight from these entries, so without them it
         derives different secrets than the trades did and finds nothing. */
      return {
        collection_id: this.unit,
        catalog_uri,
        asset_id,
        name: `Test card ${index + 1}`,
        tier: index ? 'Common' : 'Rare',
        type_line: 'Test',
        copies: index ? 100 : 10,
        face: {
          sha256: sha256Hex(asset_id),
          mime: 'image/webp',
          bytes: 1,
          urls: []
        },
        asset_binding: sha256Hex(
          `Cashu_NutFT_v1${canonical({collection_id: this.unit, asset_id, catalog_uri})}`
        )
      }
    })
    const payload = {collection_id: this.unit, catalog_uri, assets}
    this.catalog = {
      ...payload,
      issuer_pubkey: bytesToHex(schnorr.getPublicKey(this.issuer)),
      signature: schnorrSignDigest(
        sha256(utf8ToBytes(canonical(payload))),
        this.issuer
      )
    }
  }

  get keyset() {
    return {
      id: this.id,
      unit: this.unit,
      active: true,
      keys: {'1': bytesToHex(secp256k1.getPublicKey(this.key, true))}
    }
  }

  /** One card locked to `pubkey`, as a token any wallet can be handed. */
  issue(pubkey: string, card = 0): string {
    const asset = this.catalog.assets[card]
    const output = OutputData.createSingleP2PKData(
      {
        pubkey,
        blindKeys: true,
        additionalTags: [
          [
            'nutft',
            '1',
            this.unit,
            asset.asset_id,
            this.catalog.catalog_uri,
            asset.asset_binding
          ]
        ]
      },
      1,
      this.id
    )
    const proof = output.toProof(
      {
        ...this.sign(output.blindedMessage.B_),
        amount: Amount.from(1)
      } as never,
      this.keyset as never
    )
    return getEncodedToken({mint: this.url, unit: this.unit, proofs: [proof]})
  }

  /** The curve point the mint files a proof's state under. */
  pointOf(secret: string): string {
    return hashToCurve(utf8ToBytes(secret)).toHex(true)
  }

  private sign(B_: string): Signature {
    const point = pointFromHex(B_)
    const signature = {
      id: this.id,
      amount: 1,
      C_: createBlindSignature(point, this.key, this.id).C_.toHex(true),
      dleq: (({e, s}) => ({e: bytesToHex(e), s: bytesToHex(s)}))(
        createDLEQProof(point, this.key)
      )
    }
    this.signatures.set(B_, signature)
    return signature
  }

  private trade(body: Record<string, any>): {status: number; result: unknown} {
    const settled = this.trades.get(body.idempotency_key)
    if (settled) return {status: 200, result: JSON.parse(settled)}
    const inputs = Array.isArray(body.inputs) ? body.inputs : []
    const outputs = Array.isArray(body.outputs) ? body.outputs : []
    if (inputs.length !== 1 || outputs.length !== 1)
      return {status: 400, result: {error: 'one card in, one card out'}}
    /* The library sends each input through cashu-ts `serializeProofs`, which
       makes it a JSON string rather than an object. */
    const input =
      typeof inputs[0] === 'string' ? JSON.parse(inputs[0]) : inputs[0]
    const [output] = outputs
    const Y = this.pointOf(input.secret)
    if (this.spent.has(Y))
      return {status: 400, result: {error: 'proof already spent'}}
    const expected = hashToCurve(utf8ToBytes(input.secret))
      .multiply(BigInt(`0x${bytesToHex(this.key)}`))
      .toHex(true)
    if (input.C !== expected)
      return {status: 400, result: {error: 'invalid proof'}}
    const was = getTag(input.secret, 'nutft')
    const becomes = output?.nutft?.secret
      ? getTag(output.nutft.secret, 'nutft')
      : undefined
    if (!was || !becomes || was[4] !== becomes[4])
      return {status: 400, result: {error: 'a trade cannot change the card'}}
    this.spent.add(Y)
    const result = {
      signature: this.sign(output.B_),
      asset_id: was[2],
      unit: this.unit
    }
    this.trades.set(body.idempotency_key, JSON.stringify(result))
    return {status: 200, result}
  }

  async request(request: NutftRequest): Promise<NutftResponse> {
    if (request.mint !== this.url) throw new Error('Unknown test mint.')
    this.calls.push(request)
    if (this.before === request.operation) {
      this.before = undefined
      throw new Error('Disconnected before the mint changed anything.')
    }
    const body = request.body ? JSON.parse(request.body) : {}
    let status = 200
    let result: unknown
    switch (request.operation) {
      case 'info':
        result = {
          name: 'Test NutFT mint',
          nuts: {
            9: {supported: true},
            31: {
              supported: true,
              versions: [1],
              output_openings: true,
              p2bk: true,
              dleq: true,
              catalog_issuer: this.catalog.issuer_pubkey
            }
          }
        }
        break
      case 'keys':
      case 'keysets':
        result = {keysets: [this.keyset]}
        break
      case 'catalog':
        result = this.catalog
        break
      case 'checkstate':
        result = {
          states: body.Ys.map((Y: string) => ({
            Y,
            state: this.spent.has(Y) ? 'SPENT' : 'UNSPENT'
          }))
        }
        break
      case 'restore': {
        const known = body.outputs.filter((output: {B_: string}) =>
          this.signatures.has(output.B_)
        )
        result = {
          outputs: known,
          signatures: known.map((output: {B_: string}) =>
            this.signatures.get(output.B_)
          )
        }
        break
      }
      case 'trade':
        ;({status, result} = this.trade(body))
        break
      default:
        status = 404
        result = {error: 'The test mint does not serve this operation.'}
    }
    if (this.lost === request.operation) {
      this.lost = undefined
      throw new Error('The answer was lost after the mint committed.')
    }
    return {status, body: JSON.stringify(result)}
  }
}
