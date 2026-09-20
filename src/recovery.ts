import {
  cashSecretAtIndex,
  cashAddressBranch,
  cashAddressSecretAtIndex,
  ck1ForSecretKey
} from './cashSecrets'
import {
  resolveMintInput,
  fetchPayRequest,
  fetchNoteInfo,
  buildNoteUrl,
  withNewK1,
  serverOf,
  noteK1,
  scanForAddressNotes,
  NoteSpentError,
  NoteUnknownError
} from './lnurlcash'
import type {Bearer} from './storage'

// LUD-25 "Seed-recoverable note secrets" recovery: cashSecrets.ts derives
// every note secret this wallet ever mints/rotates/splits/merges
// deterministically from the seed plus a small per-SERVICE index, on two
// ladders - Part 1 hex preimages (cashSecretAtIndex) and Part 2 note keys
// on the domain branch (cashAddressSecretAtIndex) - specifically so a
// lost/reinstalled wallet can reconstruct them from nothing but the seed
// phrase and a list of mints to try. This module is that reconstruction:
// for a given mint it walks both ladders, probing each index with the
// ordinary informational GET (by hash for Part 1, by `?p=cp1<pk_i>` for
// Part 2), exactly as 25.md's own recovery paragraph describes: "WALLET
// stops scanning a given SERVICE after some gap limit of consecutive
// unknown indices, the same convention HD wallets already use for address
// recovery." There is no way to discover *which* mints to scan from the
// seed alone (a domain name isn't recoverable from an HMAC over it) - the
// holder has to supply that list themselves (Setup.tsx's restore flow).
//
// Only ever finds notes whose secret was actually seed-derived to begin
// with - nothing here recovers a note minted while unlocked without a cash
// root loaded (falls back to plain randomness, see lnurlcash.ts's
// generateNoteSecret) or one accepted from a third party.

// same order of magnitude as the common BIP44 gap limit for address
// recovery this mirrors - large enough that a few skipped/failed mints
// along the way don't cut a real scan short, small enough that an empty
// mint doesn't hang the holder's restore for hundreds of requests
export const RECOVERY_GAP_LIMIT = 20

export type RecoveredNote = {
  url: string
  callback: string
  amount: number
  verified: true
  mintPubkey?: string
}

export type MintScanResult = {
  server: string
  recovered: RecoveredNote[]
  // highest Part 1 index this scan confirmed was ever used (live or spent) -
  // null when nothing was ever found. The caller should bump this domain's
  // stored next-index counter (cashSecrets.ts's mergeCashSecretIndices)
  // past it, so a note this wallet mints here next never reuses an index a
  // past incarnation already consumed.
  highestUsedIndex: number | null
  // the same for the Part 2 ladder (mergeCashAddressSecretIndices)
  highestUsedAddressIndex: number | null
  // set when the scan stopped on something other than hitting the gap
  // limit (an unresolvable address, no LNURLcash support, a request
  // failure) - recovered and the indices still reflect whatever was
  // confirmed before that happened
  error?: string
}

// scans one mint (a public-mint entry, a Lightning Address, a bech32 LNURL,
// or a bare domain - anything resolveMintInput already accepts) for
// recoverable notes. Sequential, one index at a time: this wallet has no
// batched informational-GET endpoint, and probing a mint's outstanding
// notes is exactly the kind of thing that shouldn't be parallelized against
// a service that didn't ask for a burst of requests. onProgress, when
// given, is called with each index right before it's probed, so a caller
// can show live scanning progress. existing (the wallet's current bearers,
// same shape as receive.ts's own dedup) is checked so an index still held
// under this wallet's own record for it isn't handed back to the caller as
// "recovered" a second time - it still counts toward the highest used
// index exactly as if it had been, since the index really was used.
export const scanMintForNotes = async (
  input: string,
  onProgress?: (index: number) => void,
  existing: Bearer[] = []
): Promise<MintScanResult> => {
  const payUrl = resolveMintInput(input)
  if (!payUrl) {
    return {
      server: input.trim(),
      recovered: [],
      highestUsedIndex: null,
      highestUsedAddressIndex: null,
      error: 'Not a recognizable mint address or LNURL.'
    }
  }
  const server = serverOf(payUrl)
  const result: MintScanResult = {
    server,
    recovered: [],
    highestUsedIndex: null,
    highestUsedAddressIndex: null
  }

  let withdrawLink: string
  try {
    const info = await fetchPayRequest(payUrl)
    if (!info.withdrawLink) {
      return {
        ...result,
        error: 'This mint does not advertise LNURLcash minting.'
      }
    }
    withdrawLink = info.withdrawLink
  } catch (err) {
    return {...result, error: (err as Error).message}
  }

  const alreadyHeld = (k1: string): boolean =>
    existing.some(b => serverOf(b.url) === server && noteK1(b.url) === k1)

  // Part 1 ladder: hex preimages, looked up by hash
  let consecutiveUnknown = 0
  let index = 0
  while (consecutiveUnknown < RECOVERY_GAP_LIMIT) {
    const secret = cashSecretAtIndex(server, index)
    if (!secret) {
      return {
        ...result,
        error:
          'No seed-derived key is loaded for this wallet - restore your seed again first.'
      }
    }
    onProgress?.(index)
    try {
      const note = await fetchNoteInfo(buildNoteUrl(withdrawLink, secret))
      result.highestUsedIndex = index
      consecutiveUnknown = 0
      if (!alreadyHeld(secret)) {
        result.recovered.push({
          url: buildNoteUrl(withdrawLink, secret, note.maxWithdrawable),
          callback: note.callback,
          amount: note.maxWithdrawable,
          verified: true,
          mintPubkey: note.mintPubkey
        })
      }
    } catch (err) {
      if (err instanceof NoteSpentError) {
        // proves this index was used at some point, even though there's
        // nothing left to recover from it - doesn't count toward the gap
        result.highestUsedIndex = index
        consecutiveUnknown = 0
      } else if (err instanceof NoteUnknownError) {
        consecutiveUnknown++
      } else {
        // a transport failure or anything else unclassified is no evidence
        // either way (see the kit's classifyNoteError) - stop rather than
        // guess, so a network blip can't silently truncate the scan via
        // the gap counter or get miscounted as a real gap
        return {...result, error: (err as Error).message}
      }
    }
    index++
  }

  // Part 2 ladder: note keys on the domain branch, looked up by public key.
  // The kit walks the gap limit itself; onSpent keeps the highest used
  // index honest for an index that was consumed but has nothing left.
  const branch = cashAddressBranch(server)
  if (!branch) {
    return {
      ...result,
      error:
        'No seed-derived key is loaded for this wallet - restore your seed again first.'
    }
  }
  try {
    await scanForAddressNotes(withdrawLink, branch, {
      gapLimit: RECOVERY_GAP_LIMIT,
      onProgress,
      onSpent: i => {
        result.highestUsedAddressIndex = i
      },
      onFound: found => {
        result.highestUsedAddressIndex = found.index
        const secretKey = cashAddressSecretAtIndex(server, found.index)
        if (!secretKey) return
        const ck1 = ck1ForSecretKey(secretKey)
        if (alreadyHeld(ck1)) return
        result.recovered.push({
          url: withNewK1(
            buildNoteUrl(withdrawLink, ck1),
            ck1,
            found.info.maxWithdrawable,
            found.info.sig
          ),
          callback: found.info.callback,
          amount: found.info.maxWithdrawable,
          verified: true,
          mintPubkey: found.info.mintPubkey
        })
      }
    })
  } catch (err) {
    return {...result, error: (err as Error).message}
  }

  return result
}
