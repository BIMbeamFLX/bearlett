// The wallet's keys for every mint: LUD-25's branch per SERVICE domain, the
// note keys on it and their spends. Nothing here is ever stored; it is all
// re-derived from the seed.
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

export class KeyRing {
  private readonly root: HDKey
  private readonly branches = new Map<string, HDKey>()

  constructor(seed: Uint8Array) {
    this.root = cashRoot(HDKey.fromMasterSeed(seed))
  }

  private branch(domain: string): HDKey {
    let node = this.branches.get(domain)
    if (!node) {
      node = branchNode(this.root, domain)
      this.branches.set(domain, node)
    }
    return node
  }

  /** The branch node itself, for the one-time import in legacy.ts only. */
  legacyBranch(domain: string): HDKey {
    return this.branch(domain)
  }

  /** P and chain code: the watch-only export, cx1 on the wire. */
  export(domain: string): BranchExport {
    return branchExport(this.branch(domain))
  }

  cx1(domain: string): string {
    return encodeCx1(this.export(domain))
  }

  /** The note key's Q, hex. */
  q(domain: string, key: KeyRef): string {
    return bytesToHex(notePubkey(this.export(domain), key.purpose, key.index))
  }

  cp1(domain: string, key: KeyRef): string {
    return encodeCp1(notePubkey(this.export(domain), key.purpose, key.index))
  }

  secretKey(domain: string, key: KeyRef): Uint8Array {
    return noteSecretKey(this.branch(domain), key.purpose, key.index)
  }

  /** Q of this key locked behind a CLTV leaf until `locktime`. */
  timelockQ(domain: string, key: KeyRef, locktime: number): string {
    const pubkey = notePubkey(this.export(domain), key.purpose, key.index)
    return bytesToHex(leafNote(timelockLeaf(pubkey, locktime)).q)
  }

  /** The cw1 that opens it once `locktime` has passed. */
  timelockSpend(domain: string, key: KeyRef, locktime: number): string {
    return timelockSpend(this.secretKey(domain, key), locktime, domain)
  }

  /** The note's ck1: deterministic, so it never needs storing. */
  spend(domain: string, key: KeyRef): string {
    return signKeySpend(this.secretKey(domain, key), domain)
  }

  addressProof(
    domain: string,
    action: AddressAction,
    username: string
  ): string {
    return bytesToHex(
      signAddressProof(this.branch(domain), action, domain, username)
    )
  }
}
