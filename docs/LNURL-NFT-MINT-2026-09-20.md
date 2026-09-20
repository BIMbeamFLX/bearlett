# An LNURL NFT mint on dni's stack: what holds, what is missing

Checked on 20 September 2026 against the sources listed at the end. Nothing
here was run against a live mint; every claim about lnurl-mint comes from
reading `main` at `66c77e8`, every claim about the draft from `25.md` at
`265759f`, and every claim about the wallet side from `@lnurlcash/kit` 0.18.2
as now vendored into Bearlett.

## The proposal

dni's suggestion, as relayed: run an lnurl-mint that does no Lightning melt at
all; minting an NFT is a 1000 sat Lightning payment; a public page shows the
current holder's public key for each NFT; holders transfer NFTs to each other
through the mint without Lightning.

## Short answer

Feasible, and closer than it was two weeks ago. Three of the four pieces are in
the current LUD-25 draft and in lnurl-mint `main` today. The fourth, a public
holder page, needs one small endpoint the mint does not have yet, and the word
"NFT" needs one rule the mint does not enforce yet: a note that may only be
rotated, never split or merged.

| Piece                                  | Draft (`25.md` 265759f)                                                | lnurl-mint `main` 66c77e8                                                             | Bearlett after this PR                                              |
| -------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Mint against a 1000 sat payment        | Part 1 minting, `comment = cp1<pk>` under Part 2                       | `/p/cb`, `/p/{username}`; `MIN_SENDABLE_MSAT`, `MAX_SENDABLE_MSAT` fix the price      | mints `comment = cp1<pk>` when the mint accepts it, else a hash     |
| Holder is a public key                 | Part 2 ownership proofs: note id is `pk`, spend is `ck1<pk><sig>`      | `_decode_note_ref` keys a note by its `cp1` pubkey                                    | note keys derived from the seed, stored as `ck1`, scanned by pubkey |
| Transfer without Lightning             | "Internal transfer": rotate to `p1 = cp1<pk_i>` from the payee's `cx1` | PR 49; `text/xpub` in the payee's payRequest metadata; `POST /p/{username}` registers | `payInternalTransfer`, `registerUsername` exported, no UI           |
| No melt                                | Melt is plain LUD-03 and always allowed                                | No switch; `if pr is not None:` in `/w/cb` pays unconditionally                       | Melt UI exists and would show an error from such a mint             |
| Public page: current holder of NFT `n` | Not in the draft                                                       | Not present; the `burns` table holds the needed forward links                         | Not present                                                         |
| One NFT stays one note                 | Not in the draft; merge and split are unrestricted                     | `SUNSET_MINT=true` blocks split only; merge has no switch                             | Split and merge UI exists                                           |

## What each piece needs

### 1. A mint that never pays out

lnurl-mint has no melt switch. Adding one is small: a `MELT_ENABLED` setting
next to `VERIFY_ENABLED` in `config.py`, and an early rejection in `/w/cb`
whenever `pr` is present. The rest of the melt machinery (pending marks,
reconcile on boot, melt verify) is untouched because it is never reached.

Two consequences follow and should be written down before anyone mints:

- The 1000 sats are the mint's income, not a balance held for the holder. The
  note still carries `maxWithdrawable = 1000000` msat because the draft has no
  other value slot and the `cs1` certificate signs the amount. A wallet that
  does not know this mint will read it as money it can withdraw, try to melt,
  and get an error. LUD-03 backward compatibility, the draft's opening
  argument, is deliberately given up on this mint.
- `BASE_FEE_MSAT` defaults to 1000 and is deducted at mint time and again on
  every split. With splits disabled (below) the mint fee can stay at zero so
  the certificate reads a round 1000 sats.

### 2. An NFT is a note that only rotates

In LUD-25 a note is fungible value. What makes one an NFT is that its identity
survives every transfer, and that needs two things the mint does not do today:

- Reject any callback with `amount` or more than one `k1`. Split would cut an
  NFT into change; merge would fold two NFTs into one 2000 sat note. Rotate
  is the only transfer. `SUNSET_MINT` already blocks split; merge needs the
  same one-line check.
- Give the NFT a stable name. The natural one is the genesis note id: under
  Part 2 that is the `cp1` pubkey the minter paid with, under Part 1 the
  comment hash. Every rotate afterwards produces a new note id, so "NFT `n`"
  is "the outstanding descendant of genesis `n`".

Artwork is outside the draft entirely. The same answer this repository already
uses for NutFT cards applies: the mint publishes a signed catalogue mapping
genesis ids to Blossom sha256 hashes, and the wallet fetches by hash and
checks before showing. Our own NORD-01 draft binds that hash into the genesis
event instead; either works, the catalogue is less to build.

### 3. A public page with the current holder

This is the piece dni's stack does not have, and it is a small one. The `burns`
table already records every rotate as `burn_key -> h`, so the mint can walk
forward from a genesis id to the one outstanding descendant. Under Part 2 that
descendant's note id is the holder's x-only public key. One read-only endpoint,
`GET /nft/{genesis_id}`, returning `{holder: cp1<pk>, hops: n}` is enough for a
page; a `parent` column on `notes` would make the walk an index lookup instead
of a scan.

Two things the page will show that should be understood before building it:

- The key shown is a per-note key, `pk_i` from the holder's per-mint branch,
  not the holder's Nostr identity. It changes on every transfer. It is a name
  for "whoever controls this note now", and it only becomes a person if that
  holder registered a username and npub with the mint (`POST /p/{username}`
  with `?npub=`, NIP-05 served from `/.well-known/nostr.json`). That is the
  same opt-in NORD-01 describes as "a receiver may disclose an npub".
- The mint can also publish the same fact as a Nostr event. `nostr.py` already
  signs and publishes kind 9735 zap receipts with a configured key and relays;
  a replaceable event per genesis id with the current holder is the same
  code path. That makes the "page" verifiable by anyone with a relay rather
  than trusted from the mint's HTML.

### 4. Transfers through the mint

Already specified and implemented. The payee registers a `cx1` under a
username with a Schnorr proof signed by `sk_0` over
`sha256("LNURLcash:register:" || domain || ":" || username)`. The payee's
payRequest then carries `["text/xpub", "cx1<...>:<i>"]`. The payer derives
`pk_i` from it and rotates the note with `p1 = cp1<pk_i>`; the mint rejects an
index already in use with `already in use` and the payer retries at `i + 1`.
The payee finds the note by re-deriving `pk_0, pk_1, ...` and asking
`?p=cp1<pk_i>`. No Lightning, and a plain rotate is free under the draft's fee
rule.

The reference wallet shipped the matching UI in PRs 144, 160 and 170 ("send
to pubkey"). The kit exports `payInternalTransfer`, `registerUsername` and
`scanForAddressNotes`; Bearlett has them as of this PR but no dialogs around
them.

## What Bearlett would still need

In order, each its own PR:

1. **Part 2 note keys in the seed.** Done on 20 September, same day
   (`src/cashSecrets.ts`, `requestMintInvoice` in `src/lnurlcash.ts`): note
   keys come from the draft's domain branch under the wallet's `m/139'` root,
   mint and cross-mint transfer prefer `comment = cp1<pk>` with a silent
   Part 1 fallback, rotates of a `ck1` note stay pubkey-bound, and the seed
   scan walks both ladders. The hardware vault and the napplet's host vault
   still hold hex preimages only.
2. **Username registration and recovery scan** (upstream `addressRegistry.ts`,
   `addressRecovery.ts`).
3. **Internal transfer and send-to-pubkey dialogs.**
4. **A collection surface for non-melting notes**: one napplet per the design
   brief, showing genesis id, artwork by hash, current holder and hops, with
   split, merge and melt hidden for notes from a mint that refuses them.

## How this sits next to NutFT

This is NORD-01 with Part 2 keys and without the public event trail, and the
comparison recorded on 10 September still decides where each belongs:

| Property                         | LNURL NFT (this proposal)                 | NutFT card                          |
| -------------------------------- | ----------------------------------------- | ----------------------------------- |
| Mint can link mint to holder     | yes, that is the point of the holder page | no, the signature is blind          |
| Anyone can count the supply      | yes, from the mint or its events          | only as the signed catalogue states |
| Carries redeemable sats          | no, by configuration                      | no, by construction                 |
| Offline check                    | `cs1` certificate over amount and `pk`    | DLEQ against the mint keyset        |
| Transfer without the mint online | no, a rotate needs the mint               | no, a swap needs the mint           |

Where the visible holder is the product, this rail is right and NutFT cannot do
it. Where the collection must stay unenumerable, NutFT stays. Both share the
Blossom hash convention for artwork, so one collection napplet can show both.

## Recommendation

Build it as a configuration profile of lnurl-mint rather than a fork:
`MELT_ENABLED=false`, split and merge refused, `MIN_SENDABLE_MSAT =
MAX_SENDABLE_MSAT = 1000000`, `BASE_FEE_MSAT=0`, plus the `/nft/{genesis_id}`
endpoint and an optional Nostr publication. That is a change dni can take
upstream as three small PRs, and it keeps our sats mint (section I of the
infrastructure TODO) and this NFT mint on the same software with the same
operating practice. It holds no money, so it can be the second mint we run
before the sats one, after the NutFT mint.

Nothing in this document is deployed, and running a public mint needs its own
explicit go-ahead, as before.

## Sources

| Source                                                             | Revision                            | What was read                                                                                |
| ------------------------------------------------------------------ | ----------------------------------- | -------------------------------------------------------------------------------------------- |
| [LUD-25](https://github.com/lnurl/luds/blob/265759f/25.md)         | `265759f`, 18 September 2026        | Whole draft including Part 2 and the four test vectors                                       |
| [lnurl-mint](https://github.com/lnurlcash/lnurl-mint/tree/66c77e8) | `66c77e8`, 18 September 2026        | `config.py` settings, `router.py` callback dispatch and melt path, `db.py` tables, `nostr.py` |
| [lnurl-wallet](https://github.com/lnurlcash/lnurl-wallet/tree/461050e) | `461050e`, 18 September 2026     | `src/lnurlcash.ts` adapter, `src/lib` (the kit), PR list 136 to 172                          |
| [@lnurlcash/kit](https://www.npmjs.com/package/@lnurlcash/kit)     | 0.18.2, published 18 September 2026 | Type declarations and bundled source, installed into Bearlett                                |
| dni's proposal                                                     | relayed verbally, 20 September 2026 | The four points at the top; wording is ours                                                  |
