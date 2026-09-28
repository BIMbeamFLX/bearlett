# LNURLcash cards (draft v0)

Trading cards as LNURLcash notes, for the 600B Timelock TCG. Written
28 September 2026 against LUD-25 `50d740a` and dni's seals addon
(`lnurlcash/lnurl-wallet` `src/addons/seals/seals.ts` at `b728b1b`).
Bearlett implements the holder's side ([src/cards](../src/cards)) and the
card mint's rules ([src/cards/ledger.ts](../src/cards/ledger.ts)); the TCG
server runs them as its card mint.

## Why a card mint vouches

A seal alone cannot make a card unique. The spend signature never commits
to the outputs, and a note can be minted or rotated onto any `cp1`, so
whoever knows a state can put a note of their own onto a made-up next
state: the chain checks out, the mint's `cs1` is genuine and `?p=` says it
is live. An owner can also fork a card with a merge and a split, and a
genesis carries no issuer signature. seals.ts itself lists the missing
per-transition mint certification as a gap.

So the card mint signs every genesis and every move, and refuses every
other burn of a card note. A holder checks the signatures offline.

## The card

A card is a LUD-25 script-path note worth 1000 msat. Its single leaf under
NUMS H is dni's seal leaf over the state `S`:

```
OP_SHA256 <sha256(S)> OP_EQUALVERIFY <owner> OP_CHECKSIG      witness: [sig, S]
S = "LNURLcash/seal/state/v0" || assetId(32) || u16 len || name
    || u16 len || description || u32 index || owner(32) || prev(32)
```

- `name` is the card's id in its collection, e.g. `E1-042`.
- `description` is `<collection_id>#<serial>`, e.g. `600B-E1#17`.
- `assetId = tagged_hash("LNURLcash/card/asset/v0", issuer || u16 len ||
  name || u16 len || description)`: one id per issuer, card and serial.
- `index` is 0 at genesis and one more on every move; `prev` is
  `sha256(S)` of the state before, zero at genesis.
- `S` is one witness item, and Bitcoin Core refuses items over 520 bytes,
  so `name` and `description` share 393 bytes.

## Signatures

The issuer key is the collection's catalog key (BIP-340, x-only). Both
signatures use it with `aux_rand` zero, so a repeated request gets the same
bytes. `domain` is the card mint's spend domain (LUD-25: its hostname,
lowercase).

```
genesis = sign(tagged_hash("LNURLcash/card/genesis/v0", sha256(S_0) || domain))
receipt = sign(tagged_hash("LNURLcash/card/move/v0", sha256(S_i) || sha256(S_i+1) || domain))
```

## Consignment

What a holder keeps and shows, as JSON:

```json
{"v": 0, "mint": "<withdraw URL>", "issuer": "<x-only hex>",
 "states": ["<hex S_0>", "...", "<hex S_n>"],
 "genesis": "<sig hex>", "receipts": ["<sig S_0 to S_1>", "..."]}
```

Offline, a card is genuine when the issuer is the one the holder trusts,
`S_0` has index 0, zero `prev` and the `assetId` above, every state follows
the one before (same id, name and description, index plus one, `prev`
chained, owner a valid key), the genesis signature and every receipt verify
at the mint's domain, and `S_n` locks to `Q_n`. Online, `?p=cp1<Q_n>` at
the mint says whether it is still live.

## The card mint

A LUD-25 SERVICE whose notes are all cards.

- **Informational GET**, as LUD-25: `?p=cp1<Q>` or `?k1=<cw1>` of a live card
  answers the `withdrawRequest` with `maxWithdrawable` 1000 and a `cs1`.
- **Move**: `callback?k1=<cw1 of S_n>&p1=cp1<Q_n+1>&state=<hex S_n+1>`. The
  mint checks that the spend opens the live card `Q_n`, that `S_n+1` follows
  `S_n` and that it locks to `p1`, then answers
  `{"status": "OK", "c": "<cs1 of Q_n+1>", "receipt": "<hex>"}`. The same
  request again gets the same answer (LUD-25, Retrying a mutation).
- Every other burn of a card note is refused with `"Cards move only by
  transition."`: a split, a merge, a melt, a move without `state`.
- **Lookup**: `GET <lookup>?owner=<x-only hex>` answers
  `{"cards": [<consignment>, ...]}` for the live cards that key holds.
- **Discovery**: `GET /.well-known/lnurlcash-cards` answers
  `{"v": 0, "issuer", "withdraw", "lookup", "packs": [...]}`, where a pack
  names its `lnurlp` (a LUD-06 payRequest), `edition`, `collection_id` and
  `catalog_uri`.
- **Buying a pack**: pay the pack's payRequest with the comment
  `cp1<owner>`; once paid, the mint issues the pack's cards to that key.

## The holder

Owner keys are the holder's LUD-25 keys at the card mint's host, purpose 0,
so the 12 words recover every card: a wallet asks the lookup for each key
until a gap of unused ones. A move reveals the current state and the owner
key to the mint; a fresh key per pack and per received card keeps a holder's
cards apart.

## Open

- Whether transition certification belongs in LUD-25 itself, as a generic
  mint receipt, or stays a card mint's extension (asked of dni).
- A card mint signs with its issuer key online.
- Timelocked cards need a state-and-time template.
