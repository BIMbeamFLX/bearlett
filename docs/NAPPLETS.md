# Bearlett Wallet and Notes

Two independent MIT-licensed NIP-5D napplets, one purpose each: **Wallet** manages
and spends bearer notes; **Notes** designs their appearance. Each has its own
entry, manifest and storage scope. Notes can optionally push a design through
the versioned Note interface while staying on its own screen. They share source
utilities for rendering and validating designs; only Wallet includes the protocol and vault.
The existing standalone application still builds with `npm run build`.

Cashu support, recovery journals and cross-protocol transfers are described in
[BEARLETT.md](BEARLETT.md). Cashu requires the optional [Kehto extension](KEHTO.md).
The LNURLcash compatibility details below remain applicable.

## Build and preview

```sh
npm ci
npm run build:napplet  # Wallet only
npm run preview:wallet # http://127.0.0.1:4186/wallet
```

In another terminal, build and preview Notes independently:

```sh
npm run build:notes    # Notes only
npm run preview:notes  # http://127.0.0.1:4187/notes
```

Each preview loads exactly one napplet in its own page, with no shared app bar or
switcher. Each command works without the other build. The local development shell
injects the official `@napplet/shim` into a `sandbox="allow-scripts"` iframe. Its CSP denies direct
network connections. It provides an in-memory test mint only; the demo notes
have no real value. Preview storage lasts until the outer page reloads.

### A collection builds once per edition

One napplet per collection is the ground rule, so the edition is a build input
rather than something the running napplet chooses. The build mode names it and
the mint address is passed in:

```sh
BEARLETT_MINT=https://tcg.nappelin.com      npm run build:collection   # 600b-e1
BEARLETT_MINT=https://your-mint.example/g   npm run build:collection -- --mode 600b-g
```

`build:collection` builds Edition One; a later `--mode` wins, so the G edition
builds as shown. There is deliberately no default mint. A napplet pointed at the
wrong one shows an empty collection and blames the wallet, and a guessed address
checked into a repository is how that happens, so the build stops instead. A
mode that is neither a known edition nor `notes` also stops the build rather
than quietly producing the sats wallet. Editions live in
`src/napplet/collection/editions.ts`.

`BEARLETT_MINT` is checked exactly as it will be compiled in, and never
normalised: https only, no credentials, query, fragment or trailing slash, and
written the way the URL parser writes it (lowercase host, no default port). The
card wallet compares a token's mint string with this one character for
character, so `https://tcg.nappelin.com/` would refuse every card the mint
issues; the build says what to write instead.

**Account wallets are behind a build flag, and the flag is off.** The alpha
build never opens an account wallet and never offers a move: a valid seed in
the lease opens the device's own wallet exactly as no seed does, and nothing
sealed is written. A malformed seed still fails closed with the fixed sentence
in [The account seed](#the-account-seed), in both builds. Account wallets, their
restore and the move are built only with `BEARLETT_ACCOUNT_WALLETS=1`, into a
directory of their own beside the alpha build, never over it:

```sh
BEARLETT_MINT=https://tcg.nappelin.com                               npm run build:collection  # dist-collection-600b-e1
BEARLETT_MINT=https://tcg.nappelin.com BEARLETT_ACCOUNT_WALLETS=1    npm run build:collection  # dist-collection-600b-e1-accounts
```

Unset, empty and `0` mean off, `1` means on, and any other value stops the
build (`src/napplet/collection/editions.ts`). Only the browser tests open the
account build.

The preview host serves both builds, in the same kind of sandboxed srcdoc frame
a shell uses, with the reference NutFT service and a fixture mint answered
inside the page, so nothing reaches a network and no real cards exist:

```sh
npm run preview:collection   # http://127.0.0.1:4188/collection, and /collection-accounts
```

In that page, `collectionMint.issue(address)` makes a card for an address,
`deliverNapplet('napplet:collection/receive', {token})` hands one over, and
`reloadNapplet({seed})` reopens the frame with a seed from the service's hook.

Without the NutFT capability nothing of the collection works, by design: the
lease request is never answered, the collection waits for the shell's usual
minute and then says the shell did not answer its mint capability. No wallet is
opened, so there is no address, no receiving and no cards. A shell that answers
the lease but refuses mint requests opens the wallet and then shows the refusal,
with a way to try again; no cards are shown and nothing can be redeemed.

Each production output is self-contained:

| Output                                  | Manifest d-tag                 | Capabilities                 |
| --------------------------------------- | ------------------------------ | ---------------------------- |
| `dist-napplet/index.html`               | `bearlett-wallet`              | `storage`, `resource`, `inc` |
| `dist-notes/index.html`                 | `bearlett-notes`               | `storage`, `inc`             |
| `dist-collection-<edition>/index.html`  | `bearlett-collection-<edition>` | `storage`, `resource`, `inc`, and `nutft` (not declared) |
| `dist-collection-<edition>-accounts/index.html` | `bearlett-collection-<edition>` | as above; account wallets on, for tests only |

A collection needs the shell's `nutft` capability as much as `storage`, but the
manifest cannot say so: the official plugin keeps only registered NAP domains in
`requires` and drops any other name without a warning, as it does for the sats
wallet's `cashu`. A shell has to know a collection by its d-tag or its
`collection` archetype until `nutft` is a registered domain.

Each directory includes `.nip5a-manifest.json`, generated by the official
plugin with kind **35129**, per-file hashes, aggregate hash, requirements and
archetype tags. The manifests are unsigned build templates. Sign and install
each artifact independently using your chosen shell's normal publishing flow. This repository
does not embed a publisher key or automatically publish to Nostr.

A host pins the collection by the hash of its artifact, so the bytes must not
depend on where it was built. `.gitattributes` checks every text file out with
LF line endings, Windows included, and CI uploads `dist-collection-600b-e1/`,
`index.html` with its `.nip5a-manifest.json`, as the workflow artifact
`bearlett-collection-600b-e1`. Nothing is published from CI.

The shell must inject `window.napplet` **before** app code. Wallet data lives in
the shell's storage scope, so export a backup before changing builds or shells.
Hosts should reuse one wallet window per storage scope: NAP-STORAGE provides no
cross-window transactions or compare-and-swap. The reference preview enforces
one iframe per preview page; simultaneous wallet instances are not supported.

To try the push interface locally, build both, stop the dedicated previews, and
run `npm run preview:napplet`. Open `http://127.0.0.1:4186/wallet` and
`http://127.0.0.1:4186/notes` in **two separate tabs**. This development host routes
between those pages on the same origin; neither page loads the other's app code.
The recipient Wallet tab must be open for this local simulation. Production
shells own handler discovery and any background startup. There is no route
switcher or app selection by URL hash. `build:designer` remains a build alias.

### The collection checks the mint's supply ledger

Scarcity is a claim about the mint's books, so the napplet does not take
`/nutft/state` at its word. The mint signs its figures on a timer: one Nostr
event per snapshot, kind 7610, with the catalogue key the wallet already
trusts, each snapshot naming the one before it. The napplet fetches it through
the `supply` operation and verifies it in `src/napplet/collection/supply.ts`: signatures, sequence, that no count ever
grows, that packs sold never shrink, and that printed − remaining equals sold
× issued per pack.

The figures are cards **issued**, not cards allocated. A mint that takes
committed purchases reserves a pack before anyone claims it and puts it back
if nobody does, so its own counts rise and fall; the mint gives those
reservations back before signing, which is what makes "no count ever grows" a
sound thing to insist on here. Its draw commitment follows allocation and is
not part of a snapshot, so nothing in this file checks it. The last snapshot seen is remembered in the shell's
storage, so a mint that rewrites a snapshot a holder has already seen is
caught on the next open.

The mint serves a page, not the whole chain, because a snapshot carries one
count per printed card and the chain outgrows any single response. Reading it
takes one request in the ordinary case: the newest page, with the remembered
snapshot somewhere on it. After an absence longer than a page it takes a
second, asking for the remembered snapshot by its sequence number, and the
figures kept beside it bridge whatever gap is left. Two requests, whatever the
size of the gap.

A chain that fails any check shows its reason and no issued counts. The cards
themselves are unaffected: they are proofs, the ledger is a claim. The event
format is specified in the mint repository, `docs/nutft-supply-ledger.md`.

### The collection runs without Web Locks

A napplet runs in a `sandbox="allow-scripts"` frame with an opaque origin, and
Chromium refuses `navigator.locks.request` there with a SecurityError. The card
library serialises through Web Locks when they exist, so its first operation
failed before storage was even read. Before the library loads,
`prepareCollectionGlobals` shadows `navigator.locks` with an own property set
to `undefined`, and nothing else on `navigator`; the library then uses its own
in-window queue. Keeping one collection to one window is the shell's lease,
`nutft.acquire`, not a lock in the frame, and the collection adds no lock of
its own. `tests/napplet/collection.spec.ts` checks in a real browser that such
a frame refuses the Locks API and that the collection opens anyway.

**A shell holds a lock of its own origin for as long as a lease is held.** Every
tab of a shell writes the same storage, so a lease kept in one tab's memory lets
a second tab open the same collection and write its wallet too. The reference
`createNutftService` takes a Web Lock named `bearlett:nutft-lease:<scope>` from
`navigator.locks` when it grants a lease, where the host has Web Locks, and
gives it back when the window closes or its seed is refused; a window in
another tab hears *This collection is already open in another window.* A shell
whose host has no Web Locks, or that does not use the reference service, has to
hold an equivalent lock itself.

### Receiving a card

A card arrives as a Cashu token, locked to the address it was handed to. **A
sender needs the collection's address first**: **Receive** shows it with a copy
button, beside a field for a `cashuA` or `cashuB` token. **Redeem** imports the
token into the wallet on screen, with the edition's mint named exactly as the
card library requires, and the inventory is published again after the refresh
(`src/napplet/collection/receive.ts`, `session.ts`). The paste help says, word
for word:

> A card bought on tcg.nappelin.com is locked to that site's wallet: send it to your collection's address in the wallet there first, then paste the token into the collection.

Everything that can be refused without a mint is refused before one is asked:

| The token                                   | What the holder reads                                                        |
| ------------------------------------------- | ---------------------------------------------------------------------------- |
| is not a token                              | This is not a card token. A card token starts with cashuA or cashuB.         |
| names another mint                          | This card belongs to a different mint.                                       |
| names another collection on this mint       | This card belongs to a different collection.                                 |
| holds sats, or proofs that are not cards    | This token does not hold cards from this collection.                         |
| is locked to another key                    | This card is locked to another address. Ask the sender to hand it over to this collection's address, shown above. |

A token that spells this mint with a trailing slash names the same mint: it is
compared the way `nutftMintUrl` writes a mint, and written out again under the
edition's spelling, proofs untouched, because the card library compares mint
strings exactly.

After that the mint decides: a spent card, a card already held, a card the
catalogue does not know, and an unreachable mint each get a sentence of their
own. **The token stays in the field** until the card is in, or until a refusal
no second try can change (not a token, another mint or collection, not a card,
locked to another key, already held, spent). After any other refusal the same
token is still there for *Redeem* to try again, and closing the sheet with a
token in the field asks first: *Keep it* or *Clear and close*. A token is never
put in a URL, the history, the console or an error: every refusal is a fixed
sentence, because a decoding error can quote the bytes it choked on.

**A received card is confirmed only once a restore could find it.** A card the
sender made sits on the sender's random outputs, which no restore from this
wallet's seed can find, so an imported card is re-issued to the wallet's own
deterministic outputs straight away. Its secret is written to the wallet's
re-issue list before the import, and it leaves that list only once the mint says
the sender's proof is spent. Until then every refresh tries the re-issue again,
and an account wallet says how many cards are not yet restorable from the
account. If the answer to a re-issue is lost, the card library files the card
among the sent transfers when it finishes the trade later, and the collection
takes it back in instead of leaving it there.

While a move of this device's cards is unfinished, the device's wallet receives
nothing: *Cards on this device are still being moved to an account, so nothing
can be received here until that move has finished.*

### Handed-over cards stay until they are passed on

Each handed-over token is the only thing that can ever claim its card. The card
library stores every one from the moment the mint re-binds the card, and the
collection shows that stored list, not a list kept in memory: after a handover,
after a handover that stopped partway, and on every open, until the holder says
the tokens were passed on. Closing the sheet forgets nothing.

Under an account, the list holds the handovers of the account's wallet and of
the device wallet its cards came from, so a card handed over from the device
wallet before a move is still listed, and passed on, after the switch. A device
wallet whose only content is a handover still in flight is opened and that
transfer finished before the collection decides what to show.

Never listed, and refused by *They were passed on*: a token locked to one of the
holder's own wallets or to the account's key, which is a move's token or a
card on its way home and no handover. While a move of this device's cards is
unfinished, nothing is listed or cleared and the device wallet hands nothing
over: a move toward another account cannot be told apart from a handover there.

### The account seed

FLX decided on 15 September 2026 that the collection wallet's seed is derived by
the Nappelin shell from the account key and handed to the napplet, so the
account's key image restores the cards. The contract is one optional field in
the lease. Everything in this section past checking the seed applies to the
build with `BEARLETT_ACCOUNT_WALLETS=1` only; the alpha build checks a seed and
then opens the device wallet.

```ts
// nutft.acquire, answered only to the frame that asked and holds the lease
{type: 'nutft.acquire.result', id, ok: true, result: undefined}          // no seed: random wallet
{type: 'nutft.acquire.result', id, ok: true, result: {seed: '<64 hex>'}} // 32 bytes of BIP39 entropy
{type: 'nutft.acquire.result', id, ok: false, error: '<fixed sentence>'}
```

- `seed` is 32 bytes of BIP39 entropy as exactly 64 lowercase hex characters.
  Never a mnemonic.
- Absent (`result` undefined or null, no `seed`, or `seed: undefined`) keeps
  today's behaviour: the collection generates its own random mnemonic.
- Present but anything else, whether empty, `null`, a number, 63 or 65
  characters, uppercase or non-hex, fails closed. It is never trimmed, padded,
  lower-cased, hashed into shape or replaced by a default. The acquire is
  refused, no wallet starts, and the holder reads: *This collection could not be
  opened safely. Close it and try again.* A `result` that is not an object, such
  as a bare seed string, is refused the same way.
- The seed, its mnemonic, the fingerprint input and any token never reach the
  console, an error or a storage key.

The reference service takes the seed from a hook:

```ts
createNutftService({
  scope,   // (windowId) => the lease scope, exactly as the host derives seeds from it
  allowed,
  seed: (windowId, scope) => string | undefined | Promise<string | undefined>
})
```

The hook is asked only for the window that holds the lease, after the lease is
taken, so a second window hears that the collection is open elsewhere and the
hook never runs for it. Its value goes into that window's acquire result and
nowhere else. `undefined` means no seed. Anything else, a rejected promise
included, refuses the acquire with the fixed sentence above, gives back a lease
this acquire took, and never echoes the value or the hook's error.

The lease reader (`readNutftLease`) takes exactly `undefined`, `null`, or a
plain object whose only own key is `seed`. A `Uint8Array`, a `String` object, a
`Map`, `{seedHex}`, `{mnemonic}`, `{lease: {seed}}`, a seed inherited through the
prototype, or a `seed` beside any other key is refused with the fixed sentence,
never read as "no seed".

**The host derives a seed per collection.** Each collection of one account
gets a seed of its own from the host, so Edition One and the G edition never
share a key or an address. The Nappelin shell's derivation, pinned with test
vectors in nappelin pull request 103 (PLAN.md, step 5), is

```text
seed = lowercase hex of HMAC-SHA256(key = the 32-byte account secret key,
                                    message = UTF-8("nappelin:nutft:" + scope))
```

where `scope` is the collection's app id exactly as the host scopes the lease.
The vectors, for the account secret key
`0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20`:

| `scope`              | `seed`                                                             |
| -------------------- | ------------------------------------------------------------------ |
| `collection-600b-e1` | `5ac043b3d85fb8b50ef62a914a11595b2e2333cabada9160caf054f4d4faaeed` |
| `collection-600b-g`  | `b1e69e9b78999f8fcbd4271779eebea321a466e627f41ad7a77149fe0cb7c1ea` |

A shell using the reference service must return that very string from
`scope(windowId)`: it is the argument the seed hook receives, and any other
spelling of it derives another seed, and so another wallet. The collection adds
no derivation of its own; `src/napplet/collection/host-seed.contract.test.ts`
hands both vectors to the collection through the lease and checks that each
passes the fail-closed check and that the two collections get different
fingerprints, different addresses and sealed states neither seed can open for
the other. Only a build with account wallets uses them; the alpha build checks
the seed and opens the device wallet.

In the napplet (`src/host/nutft-shim.ts`, `src/napplet/collection/seed.ts`,
`session.ts`), the seed becomes a 24-word mnemonic in memory only, with
`entropyToMnemonic`. The account's wallet state is written before the card
library ever sees its storage key, with the key the library itself derives
(`m/129373'/10'/0'/0'/0`) and NUT-13 counters left to the mint, so the library
never gets the chance to generate a random key there.

**One wallet per seed.** A second Nappelin account on the same browser brings a
different seed, and gets a wallet of its own:

| Storage key                                   | Holds                                                                   |
| --------------------------------------------- | ----------------------------------------------------------------------- |
| `bearlett:nutft:<edition>`                    | The device's random-mnemonic wallet, where every earlier card still is  |
| `bearlett:nutft:<edition>:<fingerprint>`      | One account's wallet, sealed                                            |
| `bearlett:nutft:<edition>:<fingerprint>:restore` | Where a restore lands before its cards join the wallet, sealed       |
| `bearlett:nutft:<edition>:migration`          | A move of the random wallet's cards: `{v, to: <fingerprint>, box}`, or `{v, to, finished: true}` once it is done |
| `600b:nutft-catalogs-v1`, `inventory`, `inventory:wallet` | Public catalogue cache, the counts-only inventory, and the wallet it was counted from |

The fingerprint is the first 16 hex characters of
`sha256("bearlett:nutft:fingerprint:" + seed)`. Each wallet state records
`seedSource: 'random' | 'host'`; a state without it predates the field and was
random. An account wallet whose key is not the one its seed derives is refused,
not repaired. Besides the card library's own fields, a wallet state may carry
`reissue`, the secrets still waiting for their re-issue, and an account wallet
`movedFrom`, the public key of the device wallet its cards were moved from.

**Sealed at rest.** The card library keeps the mnemonic, the private key and
every card token in one JSON state, and a shell stores what a napplet gives it.
An account wallet is sealed with AES-256-GCM, the cipher the sats wallet uses,
under a key derived from the seed with HKDF-SHA256 and its own label, never the
seed itself, and bound to its storage key, so a sealed wallet copied elsewhere
does not open and another account cannot open it (`sealed.ts`). The journal of a
move is sealed the same way; only its target fingerprint is in the clear.

**Residual risk.** The random-mnemonic wallet has no outside secret to derive a
key from, and the collection has no password, so it is stored as the card
library writes it: mnemonic, private key and tokens readable by anything that
can read the shell's storage for this napplet. Moving its cards to the account
is the way out; the collection does not invent a password prompt. The card
library's `exportBackup` is plain text too, and the collection does not offer it.

**Rollback is not detected.** Whatever can write the shell's storage for this
napplet can put back an older sealed state of the same wallet, and it opens:
the seal proves who wrote a state, not that it is the latest. A monotonic write
counter would not change that, because its high-water mark would have to live in
the same storage, in the clear, where the same writer rolls it back too. What a
rollback can do is bounded by the mint. It cannot spend a card twice or make
one, since only the mint spends a proof. It can hide cards taken in since the
older state, and every confirmed card sits on the account's own outputs, where a
restore from the seed on any device finds it again. It can reopen a finished
move, which then finds its steps done. It can lower NUT-13 counters, so a later
re-issue asks for an output the mint already signed and is refused; that card
waits in the re-issue list and is reported as not yet restorable.

### Restoring an account's cards

When a seed is present and this device has no wallet for it, the collection
restores the account's cards from the mint with NUT-09, from the seed alone. The
screen shows how many card slots the mint has been asked about so far, then
*Restored N cards from the mint.*, or that there was nothing to restore. It
never shows a word of the mnemonic.

A restore runs into a sealed slot of its own, empty at first, and its cards then
join the account wallet beside whatever the wallet already holds: counters only
ever move forward, and a card already held is not added twice. So the account
wallet receives and hands over while its restore still waits, and a restore
never overwrites a card that arrived meanwhile.

A mint that asks the collection to wait is waited for. Every read the mint does
not change anything with (`info`, `keys`, `checkstate`, `restore` and the
catalogue reads) is asked again after a 429 or 503 or a lost answer: after the
wait the mint names, or a backoff that doubles from half a second, never more
than twenty seconds at a time and at most four times in all
(`src/napplet/collection/transport.ts`). A restore that still stops says *Restoring
your cards is waiting for the mint. It continues by itself, and nothing is lost
in between.* and runs again by itself after fifteen seconds, doubling up to
five minutes, without blocking anything else. Until the card library
checkpoints a restore per batch, which is upstream work, a restore that runs
again starts from its first slot.

A card is restorable once it sits on the account's own deterministic outputs.
Importing a card re-issues it to them, which is why a card received on one
device comes back on another.

### Moving a device's cards to the account

A device that used the collection before account seeds has its cards in the
random wallet, where the account's key image cannot restore them. When a seed
arrives and that wallet still holds unspent cards, the collection keeps it on
screen, switches nothing, and shows **Move your cards to your account** with one
button (`migration.ts`). Pressing it:

1. restores the account wallet first, so its counters come from the mint;
2. counts the device wallet's cards from a snapshot the mint answered in full: a
   snapshot holding a card the mint was not asked about stops the move before a
   journal is written, and nothing is switched or published from it;
3. writes a journal of every card, sealed for the account, before any trade, and
   journals each step before the mint is asked to do it;
4. trades each card from the device wallet to the account wallet's address. The
   traded card is recognised by its lock, never by where it sits in a list: a
   one-card token in the device wallet's sent transfers, locked to the
   account's key, with the step's card binding, that no other step has claimed;
5. takes that token into the account wallet and re-issues the card to the
   account's own outputs. Only *token is already in this wallet* is passed over;
   any other refusal stops the move. A step is **confirmed on its own**, once the
   mint says the traded proof is spent, which only the account's re-issue does;
6. takes in any move token no step knows about, left by an earlier stop;
7. forgets from the device wallet's sent transfers only tokens it has checked are
   locked to the account's key, records in the account wallet which device
   wallet the cards came from, marks the move finished, and only then switches
   the screen to the account wallet.

A card is given up as gone only when it left the device wallet another way: no
token of it is locked to the account, and the device wallet no longer holds it
or the mint says it is spent. A move that stops, because the window closed, an
answer was lost or the mint was unreachable, resumes from what the journal, the
device wallet's pending trade and its sent transfers say. A step that is not yet
confirmed stops the move with *Some cards are not yet confirmed under your
account, so nothing was switched. Try again.*, and the next try picks up that
step. A second press while a move runs joins it. Every stop is one fixed
sentence, never a token.

While a move is unfinished, the device wallet on screen neither receives, hands
over nor lists or clears handovers, and says so: *Cards on this device are being
moved to an account. Nothing here can be handed over or cleared until that move
has finished.*

After a finished move the account's wallet stays on screen. If the same device
wallet holds cards again, the account offers to move those too; a device wallet
that is not the one the cards came from is never offered, listed or moved from.

Only a random wallet is ever moved, and only to the account whose seed is
present. One account's cards are never moved to another: a move toward another
account is left exactly as it is, the current account gets a wallet of its own,
and the holder is told to open the collection from that account to finish it.

### What the Hangar has to provide

- `nutft.acquire` with the lease and the optional `seed`, exactly as above, and
  `nutft.request` with the operations in `src/host/nutft-contract.ts`.
- A lock of the shell's own origin held for as long as a lease is held, so a
  second tab cannot open the same collection; see
  [The collection runs without Web Locks](#the-collection-runs-without-web-locks).
  The collection adds no lock in its frame.
- NAP-STORAGE `storage.get`, `storage.set` and `storage.remove` for this
  napplet's scope. Without `remove`, a stale inventory is emptied rather than
  removed.
- Nothing for receiving in the alpha: cards are pasted. No build declares
  `napplet:collection/receive`, so no host is asked to route one there; see
  [Collection receive intent](#collection-receive-intent).

### Known limits

- **Two devices on one account seed** derive the same NUT-13 output for their next
  copy of a card, and the mint signs it only once. The card library fixes this
  upstream by asking `/v1/restore` before a self re-issue; until it is vendored
  again, the mint refuses the second device's re-issue, and that card waits in
  the re-issue list until a later try goes through at the next counter. Account
  wallets only, so unreachable in the alpha build. Even with that fix, two
  devices buying boosters at the same counter can still collide, because the
  probe covers only moves to the wallet's own key.
- **A trade the mint committed but a gateway answered with a JSON error** drops
  the card library's pending outputs in the vendored copy, and with them the
  card. The library keeps them upstream (only a 4xx other than 429 ends a
  pending operation); until it is vendored again, a handover interrupted that way
  in the alpha build can lose its card. The mint's referee must not answer a
  committed trade with a JSON 4xx either.
- **A restore that runs again starts from its first slot**, and one refused
  re-issue can open a gap of counters the vendored restore stops at. Both are
  fixed upstream (checkpoint per batch, a scan of at least 2N + 100 slots).
  Account wallets only.
- **A card handed to the device wallet's address after a move** is refused
  under the account as locked to another address. Opening the collection
  without an account receives it into the device wallet, and the account then
  offers to move it.

## Wallet use

1. Save the generated BIP39 recovery phrase and create a wallet with a password
   of at least 12 characters. A restored seed uses the original webwallet's
   storage-root and LUD-25 cash derivation. Scan each previously used mint in
   **More wallet tools → Seed recovery** before generating fresh notes there.
   Keep encrypted backups as well: the seed does not recreate artwork or labels.
2. Receive an LNURLcash URL or bech32 LNURL. Confirmation first persists the note,
   then rotates its secret. A ready note has been checked with its mint.
3. Select notes to check, rotate, split or combine. Combining requires the same
   mint endpoint. Split and merge values are rechecked because mint fees can
   change the actual output amount.
4. Paste a fixed-amount BOLT11 invoice, or request one from a Lightning address.
   Select notes and use **Prepare payment & fees** to split off change or
   combine notes from one mint. Review the result and confirm payment. Accepted
   melts remain **pending** until their exact invoice and payment preimage verify.
   Verification polls every five seconds while unlocked and online when the mint
   provides a verify URL. Without one, confirm the outcome in the receiving
   wallet. A missing note alone never proves settlement.
5. To mint, enter an HTTPS mint URL or Lightning address and an amount. Pay the
   generated invoice externally, then check the reserved note. This uses the
   current LUD-25 hash commitment through the mandatory LUD-12 comment.
6. Hand over a note to reveal its bearer URL and QR. It is marked shared before
   revealing the secret and excluded from the available balance.

The napplet has its own password-encrypted wallet and does not read browser
storage or Nostr identity keys. It imports and exports the original
`lnurlwallet-backup` format, including old linking-key backups. Imported notes
need a live check; device mirrors are reported separately and require the device.
Importing a foreign seed preserves its cash root as an additional recovery key.
Counters for the same seed only advance. **Reset password with my seed** proves
the phrase against authenticated encrypted metadata before changing the password.
Wallets created by the earlier random-key napplet still need their backup password.

The original-format export covers bearer records and cash recovery keys; use the
full napplet backup for artwork, pending invoices, preferences and history. Full
imports retain payment quarantine and merge history. Existing preferences and
issuer pins take precedence. Imported issuer keys require matching live evidence;
changed live keys remain staged until explicitly reviewed. Imported device state
is retained as encrypted import metadata, never automatically replayed against
hardware; reconnect the original device and reconcile its inventory.

### Function coverage against the original webwallet

| Function                                                        | Napplet implementation                                                                                                                                           |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Receive, claim links, rotate, split, combine, handover          | Supported; HTTPS, LNURL, LNURLw and webwallet claim-link handover                                                                                                |
| BOLT11 and Lightning-address payments                           | Supported with exact-value preparation and retained change                                                                                                       |
| Mint and transfer between mints                                 | Supported; source and destination remain stored during uncertain outcomes                                                                                        |
| Seed and legacy preimage recovery                               | Per-mint scan with 20 unused indices; interruptions stop the scan without declaring gaps                                                                         |
| Backups and password recovery                                   | Original and napplet formats; seed-authenticated password reset for seed-created wallets                                                                         |
| Signing keys and offline badges                                 | Live pin confirmation, explicit rekey review, cryptographic note signature checks                                                                                |
| Labels, activity and inactive notes                             | Encrypted local labels/history; archive retains the recovery record instead of deleting it                                                                       |
| Preferences                                                     | Offline transport enforcement; 0/1/5/15/30-minute lock; sort/group; optional EUR/GBP/USD estimate                                                                |
| USB / Bluetooth physical vault                                  | Optional NAP-SERIAL / NAP-BLE adapters reuse the original device command protocol                                                                                |
| Device custody                                                  | Identity review; scoped encrypted commit queue; inventory, rotate/split/combine, bound mint receipts, payments, transfer, custody migration, handover and rename |
| Camera and NFC                                                  | Use the normal webwallet, as agreed; a future scanner can stage `napplet:wallet/receive`                                                                         |
| Device firmware tools, OTA, raw console, destructive wipe/prune | Keep in the webwallet/device tooling; not exposed by this wallet UI                                                                                              |

Optional `fs`, `serial` and `ble` surfaces must be injected and authorized by the
host. They are not hard manifest requirements: a wallet remains useful without
files or physical hardware. NAP-FS saves/opens explicitly chosen JSON files;
otherwise the wallet offers text export and a local file picker. The reference
preview intentionally exposes no hardware. USB/BLE tests use simulated sessions;
**real device, live mint and deployed-shell verification remain required before
calling this a production-ready hardware wallet**. Hardware requires firmware
that proves an identity; a changed identity needs explicit holder review before
its own pending queue can drain. Never approve a device you did not intend to use.

A separate scanner napplet would need its shell to grant camera/NFC or accept
input from the normal web page. Another iframe alone does not add those rights.
The receive intent provides the integration point without changing either
Wallet's or Notes' single purpose.

Every source and preallocated replacement remains encrypted in storage.
New output secrets are acknowledged by shell storage **before** a mutation
request can burn an old note. Ambiguous outcomes are retained for manual checks,
with no automatic mutation retry. Source records are retained as history.
Backups include pending outputs and artwork. Failed storage writes stop the
operation; errors are not silently converted to an empty or ephemeral wallet.

Network requests go through NAP-RESOURCE, use HTTPS, and add a fresh
`_lnurlwallet` nonce to avoid URL-keyed resource caching. Mint callbacks must
remain on the selected issuer's HTTPS origin. The host sees the request URLs,
including bearer secrets when redeemed; use a trusted shell with appropriate
resource policy and no sensitive URL logging. Mints must tolerate an unknown
query parameter.

### The napplet never invokes a Nostr signer

That is stated as a rule elsewhere and enforced here. The collection napplet
seals `nostr` on its own global to a non-configurable `undefined` before any
wallet code runs (`src/napplet/collection/no-signer.ts`), so an extension that
injects into the frame after it loads finds the slot already taken. Where the
seal cannot be applied, the napplet refuses to start rather than run beside a
reachable signer.

Sealing is needed because the NutFT card library reads a signer at the moment it
signs, not when it is imported. Its `nip98Header` helper takes `root.nostr` and
signs a kind-27235 event with whatever it finds. Two paths lead there, a refused
booster quote and a refused POST, and both are reached only when a mint answers
`early access`.

What this costs is exact: **a napplet cannot buy from a gated mint.** Reading the
catalogue, verifying holdings, receiving a card, handing one over, backing up and
proving possession are all anonymous at the mint and are unaffected. Buying is
the shop's job, and a shop is a web page. If in-napplet buying from a gated mint
is ever wanted, the route is the shell's signer, not this one, and it needs three
decisions first: an authorization path in the NutFT capability, kind 27235 in the
wallet's own grant, and acceptance that the mint learns the login key.

## Archetypes and intents

The official registry inspected on 2026-09-08 has **no wallet or bearer-designer
archetype**. These are local, unregistered contract proposals, not approved
NAAT standards. They follow the current stable queryless convention model.

| Role              | Convention                     | Payload                                 | Effect                               |
| ----------------- | ------------------------------ | --------------------------------------- | ------------------------------------ |
| `collection`      | `napplet:collection/open`      | absent or `{}`                          | Show one collection                  |
| `collection`      | `napplet:collection/inventory` | `nutft/inventory` or a request for one  | Announce the cards held              |
| `collection`      | `napplet:collection/receive`   | `{token: string}`                       | Line a card up for the holder to redeem (not declared by any build) |
| `wallet`          | `napplet:wallet/open`          | absent or `{}`                          | Show wallet                          |
| `wallet`          | `napplet:wallet/receive`       | `{note: string}`                        | Stage receive review                 |
| `wallet`          | `napplet:wallet/pay`           | `{invoice: string}`                     | Stage payment review                 |
| `wallet`          | `napplet:wallet/design`        | `NoteDesignMessage`                     | Stage design import review           |
| `bearer-designer` | `napplet:bearer-designer/open` | absent, `{}`, or `{design: NoteDesign}` | Open Notes; review an optional draft |

```ts
if (window.napplet?.intent) {
  const available = await window.napplet.intent.available('wallet')
  if (available.available) {
    const result = await window.napplet.intent.open(
      'wallet',
      {invoice},
      {
        convention: 'napplet:wallet/pay',
        behavior: {focus: true, reuse: true}
      }
    )
    // ok/handled mean dispatch, never payment success.
    if (!result.ok || !result.handled) showError(result.error)
  }
}
```

The wallet registers exact INC topics synchronously at startup. The shell owns
cold-start delivery: wait for the target subscription, then deliver to the
resolved target with runtime-attested `sender`. No bootstrap payload is placed in
URLs, browser history, storage or broad INC broadcasts. A new request cannot
replace an existing review or an in-progress operation. Locked wallets hold at
most one pending review in memory. Malformed and oversized inputs are rejected.

NAP-INTENT itself does not define a handler-side receive API. This implementation
uses its documented convention delivery via INC. A shell using another
cold-start delivery mechanism needs to adapt that mechanism to these topics.

### Collection receive intent

Receiving is by paste for the alpha: **no build declares
`napplet:collection/receive`** in its manifest, so no host is asked to route a
card to the collection. A host routes a card there by that convention, the INC
topic, and not by an action name, and a sender still needs the collection's
address first, because a card is locked to the key it was handed to. Another
napplet, a game handing a player a card for instance, delivers it like this:

```ts
await window.napplet.intent.open(
  'collection',
  {token: 'cashuB…'},
  {convention: 'napplet:collection/receive', behavior: {focus: true, reuse: true}}
)
```

The collection still listens on the topic, behind the holder's confirmation.
The payload is `{token: string}`, given the same offline checks as a pasted
token; one that fails them is dropped without a word, since a sender cannot see
the collection's screen and the holder did not ask for it. A card that passes
waits in a line of at most sixteen, each token once. The oldest is put in the
Receive field only while the holder is doing nothing it could get in the way
of: nothing running, no card or handover sheet open, no move holding the
wallet, and no token already in the field. It is never redeemed until the
holder presses **Redeem**, and the next one follows only after that. `ok` and
`handled` from the shell mean the card was delivered, never that it was
redeemed. `tests/napplet/collection.spec.ts` checks that the collection opens,
restores and publishes its inventory with no receive message at all.

### Collection inventory intent

A game that wants to know which cards a holder owns must not be handed the
proofs: a proof is the card. What a collection napplet tells anyone else is
therefore a count per asset id, `nutft/inventory` v1, and nothing more:

```json
{
  "v": 1,
  "kind": "nutft/inventory",
  "edition": "600b-e1",
  "collection_id": "600B-E1",
  "catalog_uri": "https://mint.example/e1/nutft/catalog",
  "mint": "https://mint.example/e1",
  "at": 1757800000,
  "cards": [
    {"asset_id": "E1-001", "count": 2},
    {"asset_id": "E1-042", "count": 1}
  ]
}
```

Every field is required and no other field is allowed, on the payload or on a
card. `edition`, `collection_id` and `asset_id` match
`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`, the host's own reading, so a payload the
collection builds is never one the host drops; `mint` is an https URL and
`catalog_uri` is an https URL or `""`, both without credentials and at most 2048
characters; `count` is a positive integer, so a card that is not held is not
listed; `cards` is sorted by `asset_id` in code-unit order, holds no repeats and
at most 4096 entries; `at` is unix seconds. `src/napplet/collection/inventory.ts`
builds the payload from the wallet's snapshot and reads it back with the same
strictness, and the build runs its own output through that reader.

**When it is emitted.** After every successful `refresh()` of the collection:
on open, after a handover, after receiving a card, after a move to the account,
after a retry. The payload is stored only once it has been built and read back,
and a build or write that fails removes the stored inventory, or empties it
where a shell cannot remove a key, so the host never answers with counts the
collection could not confirm.

**Whose counts they are.** An inventory belongs to the wallet it was counted
from. Before the payload, the collection writes that wallet's storage key under
`inventory:wallet`, a record of its own the host does not need to read. The
stored inventory is taken back, both keys, whenever that could stop being true:
when the collection opens, perhaps for another account on the same browser, when
a refresh fails, and when the wallet on screen changes after a move. Counts from
a snapshot of a wallet that is no longer on screen are never published, a
snapshot holding cards the mint was not asked about publishes nothing, and a
request is answered only for the wallet on screen.

Each time, the payload is written to the shell's
storage under the key `inventory`, so a host can answer
`intent.invoke({archetype: 'collection', convention: 'napplet:collection/inventory'})`
from storage while the collection is closed, and emitted on the INC topic
`napplet:collection/inventory` so an open napplet hears it at once. The
collection also listens on that topic: a payload
`{"v": 1, "kind": "nutft/inventory-request", "edition": "600b-e1"}` naming its
own edition is answered by emitting the current inventory again. Any other
payload on the topic, including the collection's own announcements and a
request for another edition, is ignored. The edition is compiled in; a request
cannot choose one.

**What is never included.** Proofs, secrets, the curve point `Y`, the holder's
address, pubkeys of any kind, and mint states. The counts are taken from the
`nutft` tag the mint signed into each proof, not from the catalogue entry it
resolved to. A payload that carries anything beyond the fields above is
refused by the reader, not trimmed.

## Notes

Open Notes directly from its own installed napplet or its dedicated preview URL.
Its only job is designing notes. **Send to Wallet** sends data in the background;
it never switches the view or embeds a wallet. Notes can receive its own design intent from any shell-resolved
caller, but a supplied draft is staged for review before replacing the canvas.

Notes supports a local PNG/JPEG/WebP upload, four palettes, custom ink and
paper colors, a heading, a subtitle and a live denomination preview. Images are
decoded and resized in the browser, then saved within the designer's shell
storage. There is no external upload service. SVGs and remote image URLs are
rejected. The designer never receives a note URL, k1 or spendable QR.

```ts
type NoteDesign = {
  title: string // 1..48 characters
  subtitle: string // at most 100 characters
  ink: string // #rrggbb
  paper: string // #rrggbb
  image?: string // bounded data:image/png|jpeg|webp;base64,...
}
```

**Export design** saves the draft in Notes' own storage and presents its JSON.
Copy and save it for reuse. Wallet's optional **Import design** accepts this JSON
without starting Notes. Select specific assets first to apply it to those, or
set the collection's default with no selection. The preview amount is never part of the
export: Wallet supplies the real stored amount and issuer. Artwork is encrypted
once and referenced by notes; rotations/splits keep the design.

### Note interface v1

```ts
type NoteDesignMessage = {
  kind: 'lnurlcash/note-design'
  version: 1
  design: NoteDesign
}

await window.napplet.intent.open('wallet', message, {
  convention: 'napplet:wallet/design',
  behavior: {focus: false, reuse: true}
})
```

Notes checks availability of a Wallet handler advertising this convention; it
does not depend on a hardcoded wallet ID. **Send to Wallet** preserves the draft,
validates and strips any extra fields, then sends the appearance-only envelope.
No denomination, mint endpoint, invoice or bearer secret enters this interface.
NAP-INTENT is optional: a host without it can still export the design JSON.

Wallet validates the kind, version and bounded design before staging a preview.
While locked, it keeps the request in memory until unlock. **Apply received
design** stores the artwork encrypted and applies it to the current selection,
or to the collection default. Dismiss performs no writes. Delivery never funds
or spends a note. The shell's `ok`/`handled` result confirms dispatch, not import;
a busy Wallet or an existing pending review requires a retry after review.

## Verification

```sh
npm run tsc
npm test
npm run build
npm run build:napplet
npm run build:notes
BEARLETT_MINT=https://tcg.nappelin.com npm run build:collection
BEARLETT_MINT=https://tcg.nappelin.com BEARLETT_ACCOUNT_WALLETS=1 npm run build:collection
npx playwright install chromium
npm run test:napplet:browser
```

Unit tests cover encryption, wrong passwords, backup import, interruption
recovery, write failures, foreign callbacks, duplicate selections, exact-value
payments, invalid intents, image validation, versioned note messages,
unavailable handlers, failed dispatch and resource-only networking.
Browser tests cover an actual opaque-origin iframe, the official injected shim,
explicit receive approval, asset cards, independent design upload/export and
intent review, JSON import, reload/unlock persistence and narrow screens, using
a mock mint. They assert one iframe per page and no unsolicited cross-app calls.
Push tests exercise two separate tabs, disabled focus transfer, locked-wallet
delivery, unchanged storage until approval, and a missing receiver. They do not
constitute verification against a live mint or a deployed Kehto instance.

The collection's tests load the vendored card library for real, in a fresh
realm per open, against `src/napplet/collection/fixture.ts`: a NutFT mint with
real blind signatures, DLEQ proofs, a signed catalogue, NUT-09 restore and
idempotent trades, and faults that strike before or after the mint commits.
They cover the seed contract on both sides of the boundary, one wallet per
account, sealing, restore on a new device and under a rate limit, receiving and
re-issuing, the move to the account including every way it can stop, and that
nothing on those paths writes to the console. The `*.regression.test.ts` files
are the proofs from the reviews of pull request 23, kept as tests; the ones only
the card library can make pass are skipped with the upstream branch named.
`tests/napplet/collection.spec.ts` runs both built collections in a sandboxed
frame in Chromium. None of it is verification against the live mint.

## Sources

- [Napplet core concepts](https://napplet.run/docs/guide/concepts.html)
- [NAP domains](https://napplet.run/docs/naps/)
- [NIP-5D overview](https://napplet.run/docs/guide/nip-5d.html)
- [NAP-INTENT](https://github.com/napplet/naps/blob/master/naps/NAP-INTENT.md)
- [Archetype registry](https://github.com/napplet/naps/blob/master/ARCHETYPES.md)
- [Official Vite plugin](https://napplet.run/docs/packages/vite-plugin.html)

The protocol is experimental. Recheck these contracts when upgrading the pinned
Napplet packages.
