import {HDKey, HARDENED_OFFSET} from '@scure/bip32'
import {bytesToHex} from '@noble/hashes/utils.js'
import {
  deriveDomainBranchNode,
  deriveNoteSecretKey,
  encodeCk1,
  signNoteOwnership,
  type Cx1
} from '@lnurlcash/kit'
import {lud05PathSuffix} from './keys'

// LUD-25 seed-recoverable note secrets: deterministic secrets for the notes
// this wallet mints/rotates/splits/merges, derived from the seed instead of
// drawn at random, so a lost/reinstalled wallet can reconstruct them from
// nothing but the seed phrase plus a small, non-secret per-SERVICE index -
// no per-note secret ever needs backing up on its own.
// https://github.com/lnurl/luds/blob/lnurlcash/25.md
//
// Two ladders hang off the same root, one per part of the draft:
//
// Part 1 (this wallet's own convention, the draft defines no derivation):
//   cashHashingKey = derive(cashRoot, 0)
//   domainMaterial = hmacSha256(cashHashingKey, full SERVICE domain)
//   (d1, d2, d3, d4) = first 16 bytes of domainMaterial as 4 uint32
//   secret_i       = derive(cashRoot, d1/d2/d3/d4/i')       hardened, hex preimage
//
// Part 2 (the draft's own "Seed & derivation", byte for byte, implemented
// in @lnurlcash/kit and pinned to the spec vectors in lud25Vectors.test.ts):
//   p, chaincode   = derive(cashRoot, d1/d2/d3/d4)          the domain branch
//   sk_i, pk_i     = taproot-style tweak of that branch by i  non-hardened
//   secret_i       = ck1<pk_i><sig>                          the note's bearer secret
//
// The two ladders never share an index or a key: Part 1 children are
// hardened under the branch node, Part 2 children are tweaks of the branch
// point itself. `cashRoot` here is already the wallet's own m/139' node (see
// keys.ts's deriveLud25CashRootNode) - the spec's `masterKey` with the fixed
// `m/139'` prefix already applied.

// the decrypted cash root node, held in memory only for as long as the
// wallet is unlocked - set by WalletContext (activate/lock/forgetWallet),
// read by the generators below. A module-level plain variable, not a Solid
// signal: nothing here needs to trigger a re-render, and lnurlcash.ts
// (which reads it) is plain protocol code, not a component.
let cashRoot: HDKey | null = null

export const setCashRoot = (node: HDKey | null): void => {
  cashRoot = node
}

export const hasCashRoot = (): boolean => cashRoot !== null

// per-SERVICE "next index to use" counters - not secret (an index reveals
// nothing without the cash root key itself), so plain localStorage, same
// as trustedMints.ts. One key per ladder. `Object.create(null)` sidesteps
// prototype-pollution entirely rather than filtering key names one at a
// time: a malformed or crafted backup (see the merge functions below) can
// populate this object with arbitrary string keys without ever touching
// Object.prototype.
const STORAGE_KEY = 'lnurlcash_cash_indices'
const ADDRESS_STORAGE_KEY = 'lnurlcash_cash_address_indices'
type Indices = Record<string, number>

const readIndices = (key: string): Indices => {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return Object.create(null)
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null)
      return Object.create(null)
    const indices: Indices = Object.create(null)
    for (const [domain, value] of Object.entries(parsed)) {
      if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
        indices[domain] = value
      }
    }
    return indices
  } catch {
    return Object.create(null)
  }
}

const writeIndices = (key: string, indices: Indices): void => {
  localStorage.setItem(key, JSON.stringify(indices))
}

export const readCashSecretIndices = (): Indices => readIndices(STORAGE_KEY)

export const clearCashSecretIndices = (): void => {
  localStorage.removeItem(STORAGE_KEY)
}

export const readCashAddressSecretIndices = (): Indices =>
  readIndices(ADDRESS_STORAGE_KEY)

export const clearCashAddressSecretIndices = (): void => {
  localStorage.removeItem(ADDRESS_STORAGE_KEY)
}

// the domain-bound branch both ladders hang off - null whenever no cash
// root is loaded (locked, or a wallet that hasn't re-entered its seed since
// this feature shipped). This is the kit's deriveDomainBranchNode, kept
// here in its expanded form so the Part 1 path stays readable next to it.
const domainNode = (
  domain: string,
  root: HDKey | null = cashRoot
): HDKey | null => {
  if (!root) return null
  const hashingNode = root.deriveChild(0)
  if (!hashingNode.privateKey) return null
  const suffix = lud05PathSuffix(hashingNode.privateKey, domain)
  let node = root
  for (const index of suffix) node = node.deriveChild(index)
  return node
}

// ---------------------------------------------------------------------------
// Part 1: hardened hex preimages

// pure - no counter side effect, so this doubles as the primitive the
// recovery scan probes index by index (LUD-25's gap-limit convention)
// without disturbing this device's own next-index bookkeeping below
export const cashSecretAtIndex = (
  domain: string,
  index: number
): string | null => {
  const node = domainNode(domain)?.deriveChild(index + HARDENED_OFFSET)
  return node?.privateKey ? bytesToHex(node.privateKey) : null
}

/** Derive the same LUD-25 secret without global state or browser storage. */
export const cashSecretFromRoot = (
  root: HDKey,
  domain: string,
  index: number
): string => {
  if (!Number.isSafeInteger(index) || index < 0 || index >= HARDENED_OFFSET)
    throw new Error('Invalid cash index.')
  const key = domainNode(domain, root)?.deriveChild(
    index + HARDENED_OFFSET
  ).privateKey
  if (!key) throw new Error('Cannot derive cash secret.')
  return bytesToHex(key)
}

export const nextCashSecretIndex = (domain: string): number =>
  readIndices(STORAGE_KEY)[domain] ?? 0

// claims the next index for `domain`, persists the advance, and returns the
// secret at it - null whenever no cash root is loaded, in which case the
// index is never consumed (nothing was generated to consume it for)
export const nextCashSecret = (domain: string): string | null => {
  const i = nextCashSecretIndex(domain)
  const secret = cashSecretAtIndex(domain, i)
  if (secret === null) return null
  const indices = readIndices(STORAGE_KEY)
  indices[domain] = i + 1
  writeIndices(STORAGE_KEY, indices)
  return secret
}

// Mint and cross-mint transfer quotes become payable promises to create a
// specific output. Their secret must survive a reload before an invoice is
// shown, so those paths may not use generateNoteSecret's in-memory random
// fallback. The derived index is persisted by nextCashSecret before this
// returns and can be scanned again from the wallet seed during recovery.
export const requireRecoverableCashSecret = (domain: string): string => {
  const secret = nextCashSecret(domain)
  if (secret === null) {
    throw new Error(
      'This wallet cannot safely create a mint invoice until its seed-derived cash key is unlocked. Restore or re-enter the wallet seed first.'
    )
  }
  return secret
}

// ---------------------------------------------------------------------------
// Part 2: pubkey-bound notes on the domain branch

const addressDomainNode = (domain: string): HDKey | null =>
  cashRoot ? deriveDomainBranchNode(cashRoot, domain) : null

// the watch-only branch this domain's cx1 export names - what a mint is
// handed to auto-mint on a registered username, and what the recovery scan
// enumerates. `pubkeyXOnly` drops the HDKey publicKey's leading 02/03 byte:
// a plain x-coordinate is exactly BIP-340's x-only encoding; the kit's
// deriveNoteSecretKey corrects for the branch point's parity itself.
export const cashAddressBranch = (domain: string): Cx1 | null => {
  const node = addressDomainNode(domain)
  const publicKey = node?.publicKey
  const chainCode = node?.chainCode
  if (!publicKey || !chainCode) return null
  return {pubkeyXOnly: publicKey.slice(1), chainCode}
}

// this note's own key on the address branch - an actual secp256k1 scalar.
// Pure, no counter side effect, so the recovery scan can probe index by
// index: a note here may arrive unsolicited (a mint auto-minting on a
// registered username picks the index, not this wallet), so there is
// nothing to claim ahead of time, only ever a range to check.
export const cashAddressSecretAtIndex = (
  domain: string,
  index: number
): Uint8Array | null => {
  const node = addressDomainNode(domain)
  if (!node?.privateKey || !node.chainCode) return null
  return deriveNoteSecretKey(node.privateKey, node.chainCode, index)
}

// the bearer secret for a note key: ck1<pk><sig>, the one signature per key
// the draft reuses everywhere (redeem, display, offline check). Deterministic
// (all-zero aux_rand in the kit), so a recovery scan lands on the same
// string the note was minted under.
export const ck1ForSecretKey = (secretKey: Uint8Array): string => {
  const {pubkeyXOnly, signature} = signNoteOwnership(secretKey)
  return encodeCk1(pubkeyXOnly, signature)
}

export const nextCashAddressSecretIndex = (domain: string): number =>
  readIndices(ADDRESS_STORAGE_KEY)[domain] ?? 0

// claims the next Part 2 index for `domain`, persists the advance, and
// returns the note's ck1 bearer secret - null whenever no cash root is
// loaded. Unrelated to a registered username's mint-auto-derived notes on
// the same branch: the mint's own next-index skips past any index already
// outstanding or burned, so there is nothing to coordinate here.
export const nextCashAddressSecret = (domain: string): string | null => {
  const i = nextCashAddressSecretIndex(domain)
  const secretKey = cashAddressSecretAtIndex(domain, i)
  if (secretKey === null) return null
  const indices = readIndices(ADDRESS_STORAGE_KEY)
  indices[domain] = i + 1
  writeIndices(ADDRESS_STORAGE_KEY, indices)
  return ck1ForSecretKey(secretKey)
}

// Part 2 counterpart of requireRecoverableCashSecret: a mint or transfer
// quote's pubkey-bound output, persisted by index before the invoice is
// shown and scannable again from the seed.
export const requireRecoverableCashAddressSecret = (domain: string): string => {
  const secret = nextCashAddressSecret(domain)
  if (secret === null) {
    throw new Error(
      'This wallet cannot safely create a mint invoice until its seed-derived cash key is unlocked. Restore or re-enter the wallet seed first.'
    )
  }
  return secret
}

// ---------------------------------------------------------------------------
// Backup merge, both ladders

// merges a backup's per-SERVICE counters in - never decreases one (that
// would risk re-deriving and reusing an index this device, or the backup's
// own device, already generated a secret at), and simply ignores anything
// malformed rather than throwing: a corrupt or crafted backup must not be
// able to jam this wallet's future note generation, only at worst leave a
// domain's counter lower than it could be (harmless - the next generated
// secret just costs one extra derivation, never a collision)
const mergeIndicesInto = (key: string, incoming: unknown): void => {
  if (typeof incoming !== 'object' || incoming === null) return
  const current = readIndices(key)
  let changed = false
  for (const [domain, value] of Object.entries(incoming)) {
    if (
      typeof domain !== 'string' ||
      domain.length === 0 ||
      domain.length > 500 ||
      typeof value !== 'number' ||
      !Number.isInteger(value) ||
      value < 0 ||
      value > 1_000_000
    ) {
      continue
    }
    if ((current[domain] ?? 0) < value) {
      current[domain] = value
      changed = true
    }
  }
  if (changed) writeIndices(key, current)
}

export const mergeCashSecretIndices = (incoming: unknown): void =>
  mergeIndicesInto(STORAGE_KEY, incoming)

export const mergeCashAddressSecretIndices = (incoming: unknown): void =>
  mergeIndicesInto(ADDRESS_STORAGE_KEY, incoming)
