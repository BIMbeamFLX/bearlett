# Existing TCG wallet: inventory correction

Additionally checked after the user's note: `G:\Github\TCG600nap`, branch
`feature/g-mint-live`, commit `d7535057480d3a16fcb6878eba78d70c66951fc5`.
The repository was read only. Existing changes remain.

**The encrypted Blossom wallet binding already exists.** Earlier
statements that it still had to be built referred to the Bearlett checkout
and were incomplete for the overall inventory. The next step is
comparison and reuse of the existing adapter. Not a rebuild on
the basis of a supposedly missing storage solution.

## Confirmed in code

- `site/nutft-wallet.js`: NutFT wallet with private P2BK keys, token holdings,
  prepared outputs, pending operations, recoverable outgoing
  transfers, and export/restore. Supported keyset units `600B-E1` and
  `600B-G`; own `/nutft/booster` and `/nutft/trade` protocols.
- `site/nostr-wallet-sync.js:317`: NIP-44 encryption via the signer,
  compressed snapshots and limited chunk count.
- `site/nostr-wallet-sync.js:414`: large ciphertexts on
  `https://blossom.bimcvp.com`; signed upload authorisation, size/hash check
  and re-download before publishing the pointer.
- `site/nostr-wallet-sync.js:469`: small encrypted snapshots directly on
  `wss://relay.bimcvp.com`, large ones via Blossom pointers. Own event kind 37378,
  revision and signed predecessor chain; visible competing branches are
  rejected, not merged automatically.
- `site/nutft-wallet.js:854`: backup replacement compares the current state with
  the state read before network access and refuses overwrite on
  change; Web Locks protect the operation where available.
- `site/napplet.js`: NIP-44 provider via shell or external Nostr signer.

Six tests from `tests/js/wallet-sync.test.mjs` were run again and
passed, including large Blossom snapshots, new device, fork and
a differing non-empty target wallet. Signer/crypto, relay, Blossom and parts of
the wallet adapter are simulated. That is evidence of the tested
coordination logic. It is not a new live/Android/NIP-44 interop proof.

```powershell
node --test G:/Github/TCG600nap/tests/js/wallet-sync.test.mjs
```

Raw log in the Bearlett working directory:
`outputs/feasibility-2026-09-09/tcg-wallet-sync.log`.

## Consequence for V1

The existing TCG storage/sync solution is the concrete starting point for
a Bearlett adapter. Hashtree and Envelope are possible extra
functions. They are not prerequisites for storing encrypted backups
on Blossom at all.

The protocol cores remain distinct in substance: NutFT cards with CardBinding
and P2BK are not the same assets as Bearlett's unbound Cashu sats or
LNURLcash. Reuse means first versioned interfaces and
complete Bearlett journals in the snapshot. Not a blind merge of both
wallet states, and not replacement of the prescribed first-party NutFT mint.

Still to assess:

- The local NutFT wallet stores private keys and tokens as JSON in
  localStorage. Encrypted remote snapshots already exist.
  Protected local custody is a separate property.
- Fork detection does not prevent simultaneous spend on two devices.
  The explicitly chosen device handover with one writer remains necessary.
- There is one hard-configured relay and Blossom server. Mirroring is
  not implemented. Full history is limited to 500 events
  and then refuses sync rather than guessing a head.
- The six sync tests do not replace a check of all wallet operations,
  failed storage accesses, or real signer/device handovers.

## Confirmed scope decision

**Granola belongs to V2.** Granola HTLC markets and the
XMR/USDT swaps requested on top of them are taken out of V1. Their existence is
not a release criterion and not an infrastructure prerequisite for V1.

V1 concentrates on the existing wallets, safe LNURLcash/Cashu
operations, recovery and explicit device handover. The original
Bearlett fault report F00–F04 remains valid for its checked code. It must not
be transferred unchecked onto the separate NutFT wallet.
