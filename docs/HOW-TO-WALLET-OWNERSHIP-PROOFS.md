# How to implement wallet-side ownership proofs

Part 1 of LNURLcash registers a note under `hex(sha256(secret))` and spends it by revealing `secret`. This section keeps the same mint, rotate, split, merge and melt callbacks. It changes only the commitment: `WALLET` holds a secp256k1 private key `sk`, publishes `pk = sk·G`, and never sends `sk` to `SERVICE`.

Wire forms, the exact `pk`/`sig` alphabet, and the digest passed to `ecrecover` live in **Encoding**. This note is the procedure that uses those forms.

## Substitution

| Part 1 slot | Ownership-proof slot | Who sees it |
| --- | --- | --- |
| `comment = hex(sha256(secret))` | `comment = cp1<pk>` | `SERVICE` at mint |
| rotate/split/merge `h` / `h2` | `p1` / `p2` = `cp1<pk_new>` | `SERVICE` at mutation |
| spendable `k1` (the preimage) | `k1 = ck1<sig>` | `SERVICE` at redeem; anyone who holds the note |

`cp1<pk>` is a public identity. `ck1<sig>` is the bearer string. `sig` is not a fresh challenge: Encoding defines one standing signature per note, reused until that note is burned.

`SERVICE` does not store `sk`. It stores whatever Encoding uses as the lookup key. On redeem it runs `ecrecover(digest, sig)`, takes the recovered public key's x-coordinate, and looks that up in the outstanding-notes table it already keeps for ordinary `k1` values.

## Detect the mode

Classify each `k1` by prefix, then stop:

- no `cp1` / `ck1` prefix → Part 1: hex preimage, self-authorizing by revelation
- `cp1…` → identity of an ownership-proof note (mint comment, `p1`/`p2`, informational lookup)
- `ck1…` → spend proof for such a note (callback only)

A `cp1` note does not spend when its public id is presented. A Part 1 note still does.

## Mint

1. Generate `sk` (seed-derived if the wallet already derives Part 1 secrets; otherwise a new 32-byte scalar). Compute `pk`.
2. Pay the mint `payRequest` with `comment = cp1<pk>`. Do not send a hash of `sk`.
3. On settlement, `SERVICE` credits the note as `k1 = cp1<pk>` — the comment string itself, not a hash of it.
4. Keep `sk`. Encode the circulating note with the Encoding form of `ck1<sig>` (the spendable secret) plus the usual withdraw URL, amount and, if present, mint `sig`.

`commentAllowed: 64` is sized for a 32-byte hash. `cp1<pk>` is longer. A mint that has not raised `commentAllowed` to the Encoding length must reject the invoice before it is issued, same as a missing Part 1 comment.

Informational GET may use `k1=cp1<pk>`. That names the note without being a spend.

## Rotate, split, merge

Treat `p1` (and `p2` on a split) exactly as Part 1 treats `h` (and `h2`): they are output commitments, required on every callback that has no `pr`.

For each output, generate a new `sk_new`, and put `cp1<pk_new>` in `p1` / `p2`. `SERVICE` registers the new notes under those public ids and never sees `sk_new`.

Inputs on that same request are the notes being burned. Each input is either a Part 1 hex `k1` or a `ck1<sig>` that recovers to an outstanding `cp1` note. `SERVICE` accepts both kinds in one request. Order does not matter: every `ck1<sig>` recovers to its own note. There is no pairing of signatures to positions.

Replay rules from Part 1 still apply: the same inputs, `p1`/`p2` and `amount` must return the original success body, not "already spent".

## Redeem (melt, or any callback that burns an input)

Submit `k1=ck1<sig>` on the callback. Do not send `sk`. Do not compute a new signature per HTTP attempt; retries must present the same `ck1` string so `SERVICE` can treat them as replay.

`SERVICE`:

1. If the value is plain hex, run Part 1.
2. If it is `ck1<sig>`, recover the signer, take the x-coordinate, look up that note.
3. Missing, spent, or pending → the same errors as Part 1.
4. A `cp1` id in a callback spend slot is not a valid burn (it never revealed ownership). Reject it.

A melt still pays `pr` asynchronously. `OK` is not settlement. Pending marks and LUD-21 `verify` are unchanged.

## Mixed merges

One merge may list Part 1 preimages and `ck1` proofs together. `SERVICE` walks the list, classifies each entry, and fails the whole request if any entry is invalid. Outputs of that merge are new `cp1` notes if this wallet is minting under ownership proofs, or Part 1 hashes if it is not. The two output styles must not be silently mixed in `p1`/`p2`: each output is one commitment.

## Wallet storage

Persist `sk` (or the seed index that derives it) and the Encoding `ck1` string. After restore, scan as in Part 1, but informational probes use `cp1<pk>` (or Encoding's lookup form), not a raw scalar. A seed scan that only tries hex preimages will miss every ownership-proof note.

## What this does not buy

`ck1<sig>` in a URL is still a bearer secret. Copies spend. Offline mint signatures still prove issuance, not that the note is unspent. `SERVICE` still must not log `ck1` bodies any more than it logs Part 1 preimages.

The gain is narrower: `SERVICE` can register and later recognize a note without ever being given `sk`, and a merge does not need a side table that maps signatures to slots.
