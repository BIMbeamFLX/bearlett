// A reference TollGate for the tests: the merchant side of the draft TIP
// (docs/TOLLGATE-LNURLCASH-TIP.md) over Bearlett's LNURL layer, behind
// HTTP-01 on node:http. Its device identity is the socket address, or the
// `x-test-device` header, which a real TollGate would never trust.
import {createServer, type IncomingMessage} from 'node:http'
import type {AddressInfo} from 'node:net'
import {HDKey} from '@scure/bip32'
import {schnorr} from '@noble/curves/secp256k1.js'
import {
  bytesToHex,
  equalBytes,
  randomBytes,
  sha256
} from '../../src/spec/bytes.ts'
import {
  PURPOSE,
  branchExport,
  branchNode,
  cashRoot,
  notePubkey,
  noteSecretKey
} from '../../src/spec/derivation.ts'
import {encodeCp1, encodeCx1} from '../../src/spec/encoding.ts'
import {decodeSpend, signKeySpend} from '../../src/spec/notes.ts'
import {ServiceError, TransportError, reason} from '../../src/lnurl/errors.ts'
import {parseNoteLink} from '../../src/lnurl/links.ts'
import type {Net} from '../../src/lnurl/net.ts'
import {burn, fetchNoteInfo} from '../../src/lnurl/withdraw.ts'
import {fetchNet} from '../../src/platform/web.ts'
import {signEvent, type NostrEvent} from '../../src/tollgate/nostr.ts'
import {endpointOf, parseKeyPayment} from '../../src/tollgate/tollgate.ts'
import {hostOf, spendDomainOfHost} from '../../src/wallet/keys.ts'

export type GateMint = {
  withdrawUrl: string
  priceMsat: number
  minSteps?: number
  /** publish the branch at this mint, so customers can pay by key */
  byKey?: boolean
}

export type GateOptions = {
  mints: GateMint[]
  metric?: 'milliseconds' | 'bytes'
  stepSize?: number
  /** the TollGate's own upstream to the mints */
  net?: Net
  /** answer every payment with this notice code, as a broken TollGate would */
  refuse?: string
}

type Accepted = GateMint & {
  endpoint: string
  host: string
  node: HDKey
  /** the next purpose-2 index the advertisement hints */
  next: number
}

/** A note this TollGate holds: a bearer preimage, or a key on its branch. */
type Held = {endpoint: string; amountMsat: number} & (
  {preimage: Uint8Array} | {index: number}
)

type Answer = {status: number; event: NostrEvent}

const GAP = 20

export const createGate = (options: GateOptions) => {
  const identity = randomBytes(32)
  const root = cashRoot(HDKey.fromMasterSeed(randomBytes(32)))
  const metric = options.metric ?? 'milliseconds'
  const stepSize = options.stepSize ?? 60_000
  const net = options.net ?? fetchNet
  const mints = new Map<string, Accepted>()
  for (const mint of options.mints) {
    const endpoint = endpointOf(mint.withdrawUrl)!
    const host = hostOf(endpoint)
    mints.set(endpoint, {
      ...mint,
      endpoint,
      host,
      node: branchNode(root, host),
      next: 0
    })
  }
  /** granted sessions by the note that paid them */
  const granted = new Map<string, {device: string; event: NostrEvent}>()
  /** rotations sent but not answered, so a resubmission replays them */
  const rotating = new Map<
    string,
    {
      k1: string
      callback: string
      preimage: Uint8Array
      amountMsat: number
      sent: boolean
    }
  >()
  const allotments = new Map<string, number>()
  const held: Held[] = []

  const sign = (kind: number, tags: string[][], content = ''): NostrEvent =>
    signEvent(identity, {
      kind,
      created_at: Math.floor(Date.now() / 1000),
      tags,
      content
    })

  const notice = (status: number, code: string, message: string): Answer => ({
    status,
    event: sign(
      21023,
      [
        ['level', 'error'],
        ['code', code]
      ],
      message
    )
  })

  const advertisement = (): NostrEvent => {
    const tags = [
      ['metric', metric],
      ['step_size', String(stepSize)],
      ['tips', '1']
    ]
    for (const mint of mints.values()) {
      const sat = mint.priceMsat % 1000 === 0
      tags.push([
        'price_per_step',
        'lnurlcash',
        String(sat ? mint.priceMsat / 1000 : mint.priceMsat),
        sat ? 'sat' : 'msat',
        mint.endpoint,
        String(mint.minSteps ?? 0)
      ])
      if (mint.byKey)
        tags.push([
          'lnurlcash_cpub',
          mint.endpoint,
          `${encodeCx1(branchExport(mint.node))}:${mint.next}`
        ])
    }
    return sign(10021, tags)
  }

  const grant = (q: string, device: string, steps: number): Answer => {
    const allotment = (allotments.get(device) ?? 0) + steps * stepSize
    allotments.set(device, allotment)
    const event = sign(1022, [
      ['device-identifier', 'ip', device],
      ['allotment', String(allotment)],
      ['metric', metric],
      ['start-time', String(Math.floor(Date.now() / 1000))]
    ])
    granted.set(q, {device, event})
    return {status: 200, event}
  }

  /** The same session again for the device it was granted to; nobody else. */
  const replay = (q: string, device: string): Answer | null => {
    const grant = granted.get(q)
    if (!grant) return null
    if (grant.device === device) return {status: 200, event: grant.event}
    return notice(
      400,
      'payment-error-token-spent',
      'This payment already bought a session.'
    )
  }

  const mintFailure = (err: unknown, sent: boolean): Answer => {
    if (err instanceof ServiceError && reason.spent(err.reason))
      return notice(
        400,
        'payment-error-token-spent',
        'Token has already been spent'
      )
    if (err instanceof ServiceError && reason.unknown(err.reason))
      return notice(
        400,
        'payment-error-invalid-token',
        'The mint does not know this note.'
      )
    if (err instanceof TransportError)
      return sent
        ? notice(
            400,
            'payment-outcome-unknown',
            'The mint has not answered yet. Send the same payment again in a moment.'
          )
        : notice(
            400,
            'payment-error-mint-unreachable',
            'The mint is out of reach.'
          )
    return notice(400, 'payment-processing-failed', (err as Error).message)
  }

  const byNote = async (body: string, device: string): Promise<Answer> => {
    const link = parseNoteLink(body)
    if (!link)
      return notice(
        400,
        'payment-error-invalid-token',
        'This is not a payment.'
      )
    const endpoint = endpointOf(link.endpoint)
    const mint = endpoint ? mints.get(endpoint) : undefined
    if (!mint)
      return notice(
        400,
        'payment-error-mint-not-accepted',
        'This TollGate does not accept notes from that mint.'
      )
    const q = bytesToHex(decodeSpend(link.k1)!.q)
    const again = replay(q, device)
    if (again) return again
    let rotation = rotating.get(q)
    if (!rotation) {
      let info
      try {
        info = await fetchNoteInfo(net, mint.endpoint, {k1: link.k1})
      } catch (err) {
        return mintFailure(err, false)
      }
      // refused before anything is spent: the customer keeps the note
      if (
        Math.floor(info.amountMsat / mint.priceMsat) <
        Math.max(mint.minSteps ?? 0, 1)
      )
        return notice(
          400,
          'payment-error-below-min-steps',
          'This note buys less than the minimum purchase.'
        )
      rotation = {
        k1: link.k1,
        callback: info.callback,
        preimage: randomBytes(32),
        amountMsat: info.amountMsat,
        sent: false
      }
      rotating.set(q, rotation)
    }
    const p1 = bytesToHex(sha256(rotation.preimage))
    try {
      // an unanswered rotation that landed shows as p1 existing
      const landed =
        rotation.sent &&
        (await fetchNoteInfo(net, mint.endpoint, {p: p1}).then(
          () => true,
          () => false
        ))
      rotation.sent = true
      if (!landed) await burn(net, rotation.callback, [rotation.k1], p1)
    } catch (err) {
      if (!(err instanceof TransportError)) rotating.delete(q)
      return mintFailure(err, true)
    }
    rotating.delete(q)
    held.push({
      endpoint: mint.endpoint,
      amountMsat: rotation.amountMsat,
      preimage: rotation.preimage
    })
    return grant(q, device, Math.floor(rotation.amountMsat / mint.priceMsat))
  }

  const byKey = async (body: string, device: string): Promise<Answer> => {
    const payment = parseKeyPayment(body)!
    const mint = mints.get(payment.endpoint)
    if (!mint)
      return notice(
        400,
        'payment-error-mint-not-accepted',
        'This TollGate does not accept notes from that mint.'
      )
    const q = bytesToHex(payment.q)
    const again = replay(q, device)
    if (again) return again
    const branch = branchExport(mint.node)
    let index = -1
    for (let i = 0; i < mint.next + GAP && index < 0; i++)
      if (
        equalBytes(notePubkey(branch, PURPOSE.lightningAddress, i), payment.q)
      )
        index = i
    if (!mint.byKey || index < 0)
      return notice(
        400,
        'payment-error-invalid-token',
        'That key is not one of this TollGate’s.'
      )
    let info
    try {
      info = await fetchNoteInfo(net, mint.endpoint, {p: encodeCp1(payment.q)})
    } catch (err) {
      return mintFailure(err, false)
    }
    mint.next = Math.max(mint.next, index + 1)
    const steps = Math.floor(info.amountMsat / mint.priceMsat)
    // the sats are the TollGate's already: whatever they buy is granted
    if (steps < 1)
      return notice(400, 'payment-error-below-min-steps', 'This buys no step.')
    held.push({endpoint: mint.endpoint, amountMsat: info.amountMsat, index})
    return grant(q, device, steps)
  }

  /** HTTP-01's POST /: the body as is, or inside a kind-21000 payment event. */
  const pay = async (raw: string, device: string): Promise<Answer> => {
    if (options.refuse)
      return notice(400, options.refuse, 'This TollGate cannot sell right now.')
    let body = raw.trim()
    try {
      const event = JSON.parse(body)
      if (event?.kind === 21000)
        body =
          event.tags?.find((tag: string[]) => tag[0] === 'payment')?.[1] ?? ''
    } catch {
      // a plain body
    }
    return parseKeyPayment(body) ? byKey(body, device) : byNote(body, device)
  }

  /** Rotates every note held into a fresh bearer note: proof it is all ours. */
  const sweep = async (): Promise<number> => {
    let swept = 0
    for (const note of held.splice(0)) {
      const mint = mints.get(note.endpoint)!
      const k1 =
        'preimage' in note
          ? bytesToHex(note.preimage)
          : signKeySpend(
              noteSecretKey(mint.node, PURPOSE.lightningAddress, note.index),
              spendDomainOfHost(mint.host)
            )
      const info = await fetchNoteInfo(net, note.endpoint, {k1})
      const preimage = randomBytes(32)
      await burn(net, info.callback, [k1], bytesToHex(sha256(preimage)))
      held.push({
        endpoint: note.endpoint,
        amountMsat: info.amountMsat,
        preimage
      })
      swept += info.amountMsat
    }
    return swept
  }

  return {
    pubkey: bytesToHex(schnorr.getPublicKey(identity)),
    advertisement,
    pay,
    sweep,
    held: (): readonly Held[] => held,
    allotment: (device: string): number => allotments.get(device) ?? -1
  }
}

export type Gate = ReturnType<typeof createGate>

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', chunk => {
      body += chunk
      if (body.length > 1 << 20) req.destroy(new Error('too large'))
    })
    req.on('end', () => resolve(body))
    req.on('error', reject)
  })

/**
 * Origins a TollGate answers across: this machine and private networks, as
 * tollgate-module-basic-go does; never a wildcard.
 */
const LOCAL_HOST =
  /^(([a-z0-9-]+\.)*localhost|127\.[\d.]+|\[::1\]|10\.[\d.]+|192\.168\.[\d.]+|172\.(1[6-9]|2\d|3[01])\.[\d.]+)$/

const isLocalOrigin = (origin: string): boolean => {
  try {
    return LOCAL_HOST.test(new URL(origin).hostname)
  } catch {
    return false
  }
}

/** The gate behind HTTP-01, on `port` or a free one of this machine. */
export const startGate = async (
  options: GateOptions,
  port = 0
): Promise<Gate & {url: string; close(): Promise<void>}> => {
  const gate = createGate(options)
  const server = createServer(async (req, res) => {
    const device =
      (req.headers['x-test-device'] as string | undefined) ??
      req.socket.remoteAddress ??
      'unknown'
    const origin = req.headers.origin
    if (origin && isLocalOrigin(origin)) {
      res.setHeader('access-control-allow-origin', origin)
      res.setHeader('vary', 'Origin')
    }
    const send = ({status, event}: Answer) => {
      res.writeHead(status, {'content-type': 'application/json'})
      res.end(JSON.stringify(event))
    }
    if (req.method === 'OPTIONS') {
      res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS')
      res.setHeader('access-control-allow-headers', 'Content-Type')
      return res.writeHead(200).end()
    }
    if (req.url !== '/') return res.writeHead(404).end()
    if (req.method === 'GET')
      return send({status: 200, event: gate.advertisement()})
    if (req.method === 'POST')
      return send(await gate.pay(await readBody(req), device))
    res.writeHead(405).end()
  })
  await new Promise<void>(resolve => server.listen(port, '127.0.0.1', resolve))
  const {port: bound} = server.address() as AddressInfo
  return {
    ...gate,
    url: `http://127.0.0.1:${bound}/`,
    close: () => new Promise<void>(resolve => server.close(() => resolve()))
  }
}
