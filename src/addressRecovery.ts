import {
  cashAddressBranch,
  cashAddressSecretAtIndex,
  ck1ForSecretKey
} from './cashSecrets'
import {
  resolveMintInput,
  fetchPayRequest,
  fromLud17,
  serverOf,
  noteK1,
  withNewK1,
  scanForAddressNotes
} from './lnurlcash'
import {RECOVERY_GAP_LIMIT} from './recovery'
import {msatToSats} from './helpers'
import {markAddressScanned} from './addressRegistry'
import type {Bearer, ActivityKind} from './storage'
import type {NewBearer} from './WalletContext'

// LUD-25 Part 2 counterpart to recovery.ts's scanMintForNotes - same
// shape, same dedup convention (existing bearers checked by serverOf+
// noteK1), but scans a REGISTERED address's own watch-only branch
// (cashSecrets.ts's cashAddressBranch) through the public-key lookup the
// kit's scanForAddressNotes does, resuming from a per-address floor
// instead of always starting at 0. Every note this finds gets its ck1
// signed on the spot (ck1ForSecretKey) - the scan itself never redeems
// anything, it only proves this wallet CAN.

export type AddressScanOutcome = {
  server: string
  username: string
  recovered: NewBearer[]
  // highest index this scan actually found a note at - null when nothing
  // was found this pass
  highestIndex: number | null
  // resume floor for the NEXT incremental "check notes" pass: the higher
  // of whatever floor the caller passed in (never regresses below what
  // was already checked), this scan's own highest found index + 1, and
  // SERVICE's own advertised next-index hint (LUD-25 Part 2's text/xpub
  // metadata). Always present, even on an error, so a caller can feed it
  // straight back into addressRegistry.ts's markAddressScanned
  nextScanIndex: number
  error?: string
}

export const scanRegisteredAddress = async (
  server: string,
  username: string,
  existing: Bearer[] = [],
  opts: {startIndex?: number} = {}
): Promise<AddressScanOutcome> => {
  const startFloor = opts.startIndex ?? 0
  const failed = (error: string): AddressScanOutcome => ({
    server,
    username,
    recovered: [],
    highestIndex: null,
    nextScanIndex: startFloor,
    error
  })
  const branch = cashAddressBranch(server)
  if (!branch) {
    return failed(
      'No seed-derived key is loaded for this wallet - restore or re-enter your seed first.'
    )
  }

  let host: string
  try {
    host = new URL(server).host
  } catch {
    return failed('Not a valid mint address.')
  }
  const payUrl = resolveMintInput(`${username}@${host}`)
  if (!payUrl) return failed('Not a recognizable mint address.')

  let withdrawUrl: string
  let startIndex = startFloor
  try {
    const info = await fetchPayRequest(payUrl)
    if (!info.withdrawLink) {
      return failed('This mint does not advertise LNURLcash minting.')
    }
    withdrawUrl = fromLud17(info.withdrawLink)
    // SERVICE's own best-known next-unused index (if it advertised one) -
    // only ever raises the floor, never lowers it below what this device
    // already confirmed for itself
    startIndex = Math.max(startFloor, info.internalTransfer?.startIndex ?? 0)
  } catch (err) {
    return failed((err as Error).message)
  }

  const recovered: NewBearer[] = []
  let highestIndex: number | null = null
  try {
    const results = await scanForAddressNotes(withdrawUrl, branch, {
      gapLimit: RECOVERY_GAP_LIMIT,
      startIndex,
      onFound: result => {
        highestIndex = result.index
      }
    })
    for (const result of results) {
      const secretKey = cashAddressSecretAtIndex(server, result.index)
      // the cash root can only disappear mid-scan if the wallet locked
      // while it was running - skip rather than crash; a re-scan once
      // unlocked picks this index right back up
      if (!secretKey) continue
      const ck1 = ck1ForSecretKey(secretKey)
      // attach the already-disclosed certificate immediately rather than
      // requiring a separate rotate afterward just to obtain one
      const url = withNewK1(
        withdrawUrl,
        ck1,
        result.info.maxWithdrawable,
        result.info.sig
      )
      const alreadyHeld = existing.some(
        b => serverOf(b.url) === serverOf(url) && noteK1(b.url) === ck1
      )
      if (!alreadyHeld) {
        recovered.push({
          url,
          callback: result.info.callback,
          amount: result.info.maxWithdrawable,
          verified: true,
          mintPubkey: result.info.mintPubkey
        })
      }
    }
  } catch (err) {
    return {
      server,
      username,
      recovered,
      highestIndex,
      nextScanIndex: Math.max(startIndex, (highestIndex ?? -1) + 1),
      error: (err as Error).message
    }
  }

  return {
    server,
    username,
    recovered,
    highestIndex,
    nextScanIndex: Math.max(startIndex, (highestIndex ?? -1) + 1)
  }
}

export type AddressScanWalletOps = {
  addBearer: (note: NewBearer) => Promise<unknown>
  logActivity: (kind: ActivityKind, message: string, label?: string) => void
}

// runs scanRegisteredAddress and actually claims anything it finds into
// the wallet (addBearer + activity log) - the one piece every caller
// (AddressDialog's "check notes"/"full rescan", AddressAutoScanner's
// periodic tick) needs identically. Always records how far this pass got
// (markAddressScanned) so the NEXT incremental pass resumes past it,
// regardless of whether this one found anything.
export const runAddressScan = async (
  server: string,
  username: string,
  existing: Bearer[],
  wallet: AddressScanWalletOps,
  opts: {startIndex?: number} = {}
): Promise<AddressScanOutcome> => {
  const result = await scanRegisteredAddress(server, username, existing, opts)
  for (const note of result.recovered) {
    await wallet.addBearer(note)
    wallet.logActivity(
      'recovered',
      `Received ${msatToSats(note.amount)} sats at ${username}@${serverOf(server)}.`
    )
  }
  markAddressScanned(server, username, result.nextScanIndex)
  return result
}
