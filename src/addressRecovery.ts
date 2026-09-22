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
  scanForAddressNotes,
  resolveScanStartIndex,
  deriveNotePubkey,
  encodeCp1,
  fetchNoteInfoByPubkey,
  classifyNoteError,
  NoteSpentError,
  NoteUnknownError,
  ServiceError,
  type AddressScanResult,
  type Cx1
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
//
// Where a pass starts follows the reference wallet (lnurl-wallet #188 and
// #189). The mint's text/xpub hint names the next index it will hand out,
// and it advances when an invoice is created, not when it settles, so it
// can point past a note nobody has recovered yet. A device's own floor can
// be wrong too: invoices settle out of order, so an index checked while it
// was still unpaid can hold a note later. Hence two rules. The hint is
// ignored at floor 0 and may only raise a floor this device already
// confirmed (the kit's resolveScanStartIndex). And every pass re-checks
// the gap-limit window just below its start (checkBehindWindow below).

// ---- the window behind the start ----
//
// lnurl-wallet #189 gives the kit's scanForAddressNotes a `checkBehind`
// option: before the forward walk, probe up to gapLimit indices directly
// below startIndex, down to 0, without the forward walk's early stop on a
// run of unknowns. No kit release carries it yet (0.19.7 is the newest),
// so this is the same window, probed the same way, until one does; then
// the forward call passes `checkBehind: true` and this function goes.
const RATE_LIMIT_BACKOFF_MS = 2_000

// the kit's own test for a mint asking the scan to slow down: an ordinary
// {"status":"ERROR"} answer, which LUD-25 says must not count as unknown
const isRateLimited = (err: unknown): boolean =>
  err instanceof ServiceError && /rate.?limit/i.test(err.reason)

export const checkBehindWindow = async (
  withdrawUrl: string,
  branch: Cx1,
  startIndex: number,
  gapLimit: number,
  onFound: (result: AddressScanResult) => void,
  backoffMs: number = RATE_LIMIT_BACKOFF_MS
): Promise<AddressScanResult[]> => {
  const found: AddressScanResult[] = []
  const floor = Math.max(0, startIndex - gapLimit)
  for (let index = startIndex - 1; index >= floor; index--) {
    const cp1 = encodeCp1(
      deriveNotePubkey(branch.pubkeyXOnly, branch.chainCode, index)
    )
    for (;;) {
      try {
        const info = await fetchNoteInfoByPubkey(withdrawUrl, cp1)
        const result: AddressScanResult = {index, cp1, info}
        found.push(result)
        onFound(result)
      } catch (err) {
        if (isRateLimited(err)) {
          await new Promise(resolve => setTimeout(resolve, backoffMs))
          continue // same index again
        }
        // never minted, or minted and already spent: nothing to recover.
        // Anything else is no evidence either way and stops the pass, so a
        // transport blip can't pass for an empty window.
        if (
          !(err instanceof NoteUnknownError) &&
          !(err instanceof NoteSpentError)
        ) {
          throw classifyNoteError(err as Error)
        }
      }
      break
    }
  }
  return found
}

export type AddressScanOutcome = {
  server: string
  username: string
  recovered: NewBearer[]
  // highest index this scan actually found a note at - null when nothing
  // was found this pass
  highestIndex: number | null
  // where this pass's forward walk started, after resolveScanStartIndex
  // weighed the caller's floor against the mint's hint; the window
  // checkBehindWindow re-checks sits just below it. For display only.
  checkedFrom: number
  // the mint's advertised next-unused index at this pass (LUD-25 Part 2's
  // text/xpub metadata), or null when it advertised none or the pass never
  // got that far. For display only: never trusted on its own.
  serviceHint: number | null
  // resume floor for the NEXT incremental "check notes" pass: the higher of
  // where this pass started and its highest found index + 1. The window
  // below the start is re-checked on every pass anyway, so a note that
  // settles below this floor later is still found. Always present, even on
  // an error, so a caller can feed it straight back into
  // addressRegistry.ts's markAddressScanned
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
    checkedFrom: startFloor,
    serviceHint: null,
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
  let serviceHint: number | null = null
  try {
    const info = await fetchPayRequest(payUrl)
    if (!info.withdrawLink) {
      return failed('This mint does not advertise LNURLcash minting.')
    }
    withdrawUrl = fromLud17(info.withdrawLink)
    serviceHint = info.internalTransfer?.startIndex ?? null
    startIndex = resolveScanStartIndex(startFloor, serviceHint ?? undefined)
  } catch (err) {
    return failed((err as Error).message)
  }

  const recovered: NewBearer[] = []
  let highestIndex: number | null = null
  // the window and the forward walk may report in any order
  const noteFound = (result: AddressScanResult): void => {
    highestIndex = Math.max(highestIndex ?? -1, result.index)
  }
  try {
    const behind = await checkBehindWindow(
      withdrawUrl,
      branch,
      startIndex,
      RECOVERY_GAP_LIMIT,
      noteFound
    )
    const ahead = await scanForAddressNotes(withdrawUrl, branch, {
      gapLimit: RECOVERY_GAP_LIMIT,
      startIndex,
      onFound: noteFound
    })
    for (const result of [...behind, ...ahead]) {
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
      checkedFrom: startIndex,
      serviceHint,
      nextScanIndex: Math.max(startIndex, (highestIndex ?? -1) + 1),
      error: (err as Error).message
    }
  }

  return {
    server,
    username,
    recovered,
    highestIndex,
    checkedFrom: startIndex,
    serviceHint,
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
