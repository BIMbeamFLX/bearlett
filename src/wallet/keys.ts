// The wallet's keys for every mint: LUD-25's branch per SERVICE, the note
// keys on it and their spends. Nothing here is ever stored; it is all
// re-derived from the seed.
//
// Two names for one mint, as the reference wallet has them (conformance
// part2.json, "spendDomain"): the branch is derived from the host exactly as
// the mint's URL gives it, port included, while signatures bind the
// lowercase hostname, never a port (The canonical spend transaction). For a
// mint on the default port the two are the same string.
import {HDKey} from '@scure/bip32'
import {bytesToHex} from '../spec/bytes.ts'
import {
  branchExport,
  branchNode,
  cashRoot,
  notePubkey,
  noteSecretKey,
  signAddressProof,
  type AddressAction,
  type Purpose
} from '../spec/derivation.ts'
import {encodeCp1, encodeCx1, type BranchExport} from '../spec/encoding.ts'
import {
  leafNote,
  signKeySpend,
  timelockLeaf,
  timelockSpend
} from '../spec/notes.ts'

export type KeyRef = {purpose: Purpose; index: number}

/** A mint's host as its URL gives it, lowercased, port included. */
export const hostOf = (url: string): string => new URL(url).host.toLowerCase()

/** The hostname a spend's signature binds, from a host. */
export const spendDomainOfHost = (host: string): string =>
  new URL(`https://${host}`).hostname.toLowerCase()

export class KeyRing {
  private readonly root: HDKey
  private readonly branches = new Map<string, HDKey>()

  constructor(seed: Uint8Array) {
    this.root = cashRoot(HDKey.fromMasterSeed(seed))
  }

  private branch(host: string): HDKey {
    let node = this.branches.get(host)
    if (!node) {
      node = branchNode(this.root, host)
      this.branches.set(host, node)
    }
    return node
  }

  /** The branch node itself, for the one-time import in legacy.ts only. */
  legacyBranch(host: string): HDKey {
    return this.branch(host)
  }

  /** P and chain code: the watch-only export, cx1 on the wire. */
  export(host: string): BranchExport {
    return branchExport(this.branch(host))
  }

  cx1(host: string): string {
    return encodeCx1(this.export(host))
  }

  /** The note key's Q, hex. */
  q(host: string, key: KeyRef): string {
    return bytesToHex(notePubkey(this.export(host), key.purpose, key.index))
  }

  cp1(host: string, key: KeyRef): string {
    return encodeCp1(notePubkey(this.export(host), key.purpose, key.index))
  }

  secretKey(host: string, key: KeyRef): Uint8Array {
    return noteSecretKey(this.branch(host), key.purpose, key.index)
  }

  /** Q of this key locked behind a CLTV leaf until `locktime`. */
  timelockQ(host: string, key: KeyRef, locktime: number): string {
    const pubkey = notePubkey(this.export(host), key.purpose, key.index)
    return bytesToHex(leafNote(timelockLeaf(pubkey, locktime)).q)
  }

  /** The cw1 that opens it once `locktime` has passed. */
  timelockSpend(host: string, key: KeyRef, locktime: number): string {
    return timelockSpend(
      this.secretKey(host, key),
      locktime,
      spendDomainOfHost(host)
    )
  }

  /** The note's ck1: deterministic, so it never needs storing. */
  spend(host: string, key: KeyRef): string {
    return signKeySpend(this.secretKey(host, key), spendDomainOfHost(host))
  }

  /** The registration proof names the mint's hostname, as the mint checks it. */
  addressProof(host: string, action: AddressAction, username: string): string {
    return bytesToHex(
      signAddressProof(
        this.branch(host),
        action,
        spendDomainOfHost(host),
        username
      )
    )
  }
}
