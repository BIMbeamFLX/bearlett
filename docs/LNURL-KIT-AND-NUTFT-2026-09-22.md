# LNURLcash 0.19.5, and what replacing NutFT still needs

22 September 2026. The kit change rides on `feat/lnurlcash-0.19.5`,
branched from `main` after the internal-transfer dialogs (#30).
The NutFT section is the decision from the same day. It extends
[LNURL-NFT-MINT-2026-09-20.md](LNURL-NFT-MINT-2026-09-20.md). That earlier
note was read against lnurl-mint `66c77e8` and LUD-25 `265759f`. Kit 0.19.5
does not close the gaps listed there.

## What was built

`@lnurlcash/kit` moved from 0.18.2 to 0.19.5, the release dni published on
22 September 2026 from
[lnurl-wallet](https://github.com/lnurlcash/lnurl-wallet/releases/tag/v0.19.5).
Bearlett pins that exact version and re-exports it from `src/lnurlcash.ts`.
0.19.4 and 0.19.5 only add `fetchJson`, a bounded, policy-checked JSON fetch
for addons that talk to services which do not speak the LNURLcash error
convention; `lnurlFetch` now sits on top of it. Nothing Bearlett calls
changed behaviour.

A plain hash secret on a note shows "plain secret" and an upgrade button.
Upgrade calls `upgradeNote` and replaces the secret with a seed-recoverable
pub/sig note (`ck1`). An ordinary rotate still leaves a plain secret plain.
A `cw1` script note is labelled "script". A rotate keeps that form, because
the kit treats `cw1` as an already-upgraded secret. A note whose secret lives
on the vault is not upgraded. Pub/sig notes stay in the browser.

The script is not built here, and it is not previewed. `planTimelock` is not
in the npm package. It lives in lnurl-wallet at `src/addons/timerlocker`.

Typecheck passed. The unit suite passed: 768 tests, 1 skipped. The wallet
was not clicked through in a browser.

## Sats and cards

LNURLcash can carry the sats. The note is the claim on the mint. Bearlett
already holds those notes beside Cashu. The mint keeps the Lightning until
the note is melted, and it sees each rotate.

LNURLcash cannot replace a NutFT card yet. A card is a Cashu proof of amount
1. The secret is `["nutft", "1", collection_id, asset_id, catalog_uri,
asset_binding]`, and the binding is the hash of the collection, the asset,
and the catalogue (see [HOW-TO-MINT-ASSETS.md](HOW-TO-MINT-ASSETS.md)). An
LNURL note is still a number of millisatoshis. Split and merge are still
allowed, so one note becomes two and two notes become one. Kit 0.19.5 adds
script-path notes and a timelock for sats. It does not add an asset id.

## Timelock

Ready for a sat note, on a mint that runs the `ct1` check.

dni's Timerlocker addon rotates one note into a `ct1`. The only spend path
is a `cw1`: `<time> CHECKLOCKTIMEVERIFY DROP <pubkey> CHECKSIG`, under a key
with no known secret. The spend is signed when the lock is made. Before the
mint's own clock reaches that time, the mint refuses the withdraw. After
that, whoever has the link can take it through the ordinary path. The clock
is the mint's, not a Bitcoin block. The addon refuses to lock unless the
mint was built with that check.

Bearlett can hold a `cw1` it receives. Building the lock means porting
Timerlocker and pointing it at such a mint. That lock does not name a card.

## What dni still has to ship

Internal transfer is already in his mint and in the kit. These five are the
rest. They are mint behaviour plus two fields on the lookup.

1. **An asset mint refuses melt, split, and merge.** `SUNSET_MINT` blocks
   split only. Merge still folds two notes into one. `/w/cb` still pays a
   Lightning invoice when `pr` is present. The profile is
   `MELT_ENABLED=false`, the same refusal for merge, a fixed price
   (`MIN_SENDABLE_MSAT` equal to `MAX_SENDABLE_MSAT`), and fee 0. The sats
   on the note are the price he was paid, not a balance the holder withdraws.
2. **A genesis id that survives rotate.** A rotate issues a new note id.
   His `burns` table already records the old key and the new key. The
   informational GET has to walk that chain and return the original id.
   Without that field the wallet cannot tell two transfers of one card from
   two cards.
3. **A signed catalogue.** Genesis id to the Blossom hash of the artwork,
   returned on that same GET. The wallet checks the hash before it shows
   the picture. One genesis id is minted once. The picture stays out of
   the protocol.
4. **A marker that this note is not money.** A normal `withdrawRequest`
   only has `maxWithdrawable` in millisatoshis, so every other wallet will
   offer to melt it. The response needs the stable id and the three
   refusals. A wallet that understands them hides melt, split, and merge.
   A wallet that does not gets an error from the mint.
5. **Who holds it.** `GET /nft/{genesis_id}` returns the current public key
   and how many rotates led there. The key changes on every transfer. It
   names whoever controls this note, and it becomes a person only if that
   holder also registered a username. The same fact can be a replaceable
   Nostr event. `nostr.py` already publishes zap receipts.

After those fields exist, Bearlett's collection screen is the consumer:
show the genesis id and the picture, and hide melt, split, and merge when
the note says so.
