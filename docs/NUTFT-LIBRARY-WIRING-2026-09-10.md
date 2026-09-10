# Wiring the NutFT card library into a collection napplet

Inventory taken on 10 September 2026, before any code is vendored. It records
what the library needs from its host, which of those needs a napplet cannot
meet by default, and what was checked rather than assumed.

## 1. What is being wired

`site/nutft-wallet.js` from the 600B Timelock TCG repository. It is the wallet
that holds NutFT cards: Cashu proofs of amount 1, bound to a collection and an
asset by a P2BK key. One file, no build step, no imports at rest.

The measurements below are from branch `feature/nutft-async-storage`, which is
the tip of the stack of open pull requests 30 through 33 and the only branch
that carries the storage port. Line numbers move between branches, so each
reference names a function as well.

Licence: MIT, `Copyright (c) 2026 600Billion contributors`. Same authorship as
this repository, so vendoring is permitted. The notice travels with the file.

## 2. What the library reads off the global

The library is an IIFE invoked with `globalThis`, so every dependency below is
a property of the napplet's own global object. Twelve names, and each one is
either satisfied by the sandbox or has to be injected before the file runs.

| Global | Uses | Where it comes from in a napplet |
| --- | --- | --- |
| `crypto` | 8 | native, `crypto.subtle` is available in the sandbox |
| `location` | 4 | native, used only to resolve a relative mint URL |
| `btoa` | 3 | native |
| `NUTFT_UNITS` | 3 | **inject**: the unit names this collection accepts |
| `navigator` | 2 | native, only `navigator.locks` and only if present |
| `localStorage` | 2 | **replaced**: reached only by the storage port's fallback |
| `__walletCrypto` | 2 | **inject**: BIP-39 and BIP-32, see section 3 |
| `__cashu` | 2 | **inject**: cashu-ts, see section 3 |
| `NutFTWallet` | 2 | the library's own export, written on load |
| `NUTFT_STORE` | 2 | **inject**: storage key, namespaced per collection |
| `nostr` | 1 | **sealed**, see section 5 |
| `NUTFT_STORAGE` | 1 | **inject**: the host storage port |

Five injections, one seal. Nothing else has to change in the file.

`navigator.locks` deserves a note. A sandboxed frame with an opaque origin may
not have the Web Locks API at all, and the library expects that: `locked()`
falls back to an in-process promise queue when `navigator.locks` is missing.
That fallback is single-window only, which is correct here, because the host
service already refuses to open one collection in two windows at once.

Storage covers two keys, not one. The wallet state lives under `NUTFT_STORE`
and the catalogue cache under `600b:nutft-catalogs-v1`, and both go through the
same injected port. Only the port's own fallback touches `localStorage`.

## 3. The blocker: four remote imports

The library loads its cryptography lazily, from a CDN:

```
https://esm.sh/@cashu/cashu-ts@4.7.2?bundle
https://esm.sh/@scure/bip39@2.3.0?bundle
https://esm.sh/@scure/bip39@2.3.0/wordlists/english.js?bundle
https://esm.sh/@scure/bip32@2.3.0?bundle
```

A napplet runs under `default-src 'none'; connect-src 'none'`. All four are
blocked, with no error the library can see. So `__cashu` and `__walletCrypto`
are not an optimisation that avoids a round trip. **Without both, the wallet
cannot start.** Every path that touches a proof calls one of them.

Bearlett already bundles the same libraries at higher versions, which raises a
compatibility question rather than answering it. It was checked, not assumed.
The library reaches for twenty-three symbols in total:

| Module | Wanted | Bearlett has | Present |
| --- | --- | --- | --- |
| cashu-ts | 18 symbols | 4.10.1, library targets 4.7.2 | 18 of 18 |
| `@scure/bip39` + `bip32` | 5 symbols | 2.4.x, library targets 2.3.0 | 5 of 5 |

The English wordlist resolves to 2048 words, and `src/keys.ts:6` already
imports it by the same specifier, so the merged object the library expects
(`{...bip39, wordlist, HDKey}`) can be built from what is here.

Presence is not behaviour. Nothing above proves that the eighteen cashu-ts
functions behave in 4.10.1 as they did in 4.7.2, and the wallet's own test
suite is the place to establish that, not this inventory.

## 4. Where this leaves the transport

Network access is already solved and needs nothing from this section. The
library talks to its mint with plain `fetch`, and the collection napplet
replaces that global with the router in `src/napplet/collection/transport.ts`:
mint paths become named capability operations, allow-listed Blossom mirrors
become byte fetches, and everything else is refused before it reaches a host.

## 5. The signer, and an adapter that already exists

The card library reads `root.nostr` inside `nip98Header` and signs a kind-27235
event with whatever it finds. Bearlett seals that global, so the path is never
entered; `src/napplet/collection/no-signer.ts` carries the reasoning and the
cost.

What the inventory adds is that the TCG site had already solved this for its
own pages, and the wallet is one of the modules that missed it.
`site/napplet.js` publishes an adapter as `E1Napplet`, whose `signEvent` tries
the shell first and only then falls back to a browser extension. That is
exactly the right shape: inside a shell the shell signs, and as a plain website
the extension does. Three site modules reach past that adapter straight to the
signer, and the card wallet is the only one of the three that holds money.

This is an observation about the upstream repository, not a task for this one.
It matters here for one reason: if in-napplet buying from a gated mint is ever
wanted, the route already exists upstream and does not require undoing the
seal. It requires the three decisions named in the seal's own documentation.

## 6. What is settled and what is not

Settled, with evidence above: the five injections, the storage port covering
both keys, the lock fallback, the four blocked imports, the symbol presence.

Not settled, and none of it blocked on anything external:

- Whether cashu-ts 4.10.1 behaves as 4.7.2 for these eighteen functions.
- Whether the library is vendored as one file or split. Vendoring whole keeps
  the upstream diff readable and the licence notice intact, and is the default
  unless splitting buys something specific.
- The `NUTFT_STORE` namespace per collection. One napplet per collection means
  one key per collection, so the mint URL or the collection id has to appear in
  it, and the choice is a migration decision once cards exist.
