# Bearlett

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Status: development preview](https://img.shields.io/badge/status-development%20preview-orange)

**An LNURLcash wallet, built from the spec.** Bearlett holds and moves
[LUD-25](https://github.com/lnurl/luds/blob/lnurlcash/25.md) notes: bearer
notes anyone can redeem with a plain LNURL wallet, notes on your own keys
that your 12 words restore, and notes locked until a time. It runs as a web
app and as a napplet docked in the Nappelin Hangar, from one code base.

Bearlett implements LUD-25 as drafted at `lnurl/luds`, branch `lnurlcash`,
commit `50d740a` (25 September 2026). The protocol code under `src/spec` is
written from that text, not from another implementation, and reproduces the
draft's test vectors 1-5 byte for byte.

> **Custody.** An LNURLcash mint holds the sats behind every note it issues.
> Only use mints you trust to pay out. A timelock is the mint keeping its
> word by its own clock, not a trustless lock.

## What it does

- **Mint** a note over Lightning: the note is a fresh key of your own,
  named in the invoice comment as `cp1<Q>`; the mint credits it once paid.
- **Receive** a note link, check it offline (spend and certificate), then
  rotate it into a key only you hold.
- **Hand out** a note as a link or QR code (a bearer preimage), and take it
  back until the recipient rotates it.
- **Pay** a BOLT-11 invoice, a Lightning Address or an LNURL-pay link. When
  the payee sits at the same mint and publishes `text/cpub`, it goes as an
  internal transfer, without Lightning.
- **Send to a note key** someone gives you as a `cp1`.
- **Lock** sats until a time (`<pk> CHECKSIGVERIFY <T> CHECKLOCKTIMEVERIFY`).
- **Recover** everything held on your own keys from the 12 words, per mint,
  across the three derivation purposes (wallet, change, Lightning Address).
- **Register a Lightning Address** at an lnurl-mint (web app only: the
  Hangar lets napplets read from mints, not post to them).
- **Import** notes made by the Bearlett before the rebuild (September 2026).
- **Pay a TollGate** for network access (web app only), per a draft TIP in
  [docs/TOLLGATE-LNURLCASH-TIP.md](docs/TOLLGATE-LNURLCASH-TIP.md): the
  exact price onto the TollGate's own key while the mint is in reach, and
  a whole note signed offline behind its captive portal.

## How it is built

| Layer | Path | What it is |
| --- | --- | --- |
| Spec core | `src/spec` | LUD-25 itself: encodings (`cp1 ck1 cw1 cs1 cx1`), taproot leaves and output keys, the canonical spend transaction and its sighash, notes and spends, certificates, the purpose-split derivation, and a small BIP-342 evaluator for offline checks. No I/O. |
| LNURL | `src/lnurl` | payRequests (LUD-06/12/16/21), the withdraw endpoint and its callback (LUD-03 as LUD-25 extends it), links and inputs. The network is a port. |
| Wallet | `src/wallet` | The flows, a journal of every mint call that changes state, the sealed seed and bookkeeping, the key ring. |
| TollGate | `src/tollgate` | The draft TIP's customer side: the TollGate's signed advertisement (a Nostr event), its offers, what paying will do, and delivering a payment over HTTP-01. |
| Platform | `src/platform` | Ports: `fetch` and `localStorage` for the web app; the shell's NAP-RESOURCE and storage for the napplet. |
| UI | `src/ui` | One Solid app for both homes, in the Nappelin Hypershell chrome, repainted by NAP-THEME. |

Keys are never stored: every note on your own keys is re-derived from the
seed. The seed phrase is sealed with your passphrase; the bookkeeping is
sealed with a key derived from the seed. Every burn is written down before
it is sent, so a lost answer is asked again (LUD-25 answers a retried burn
as a replay), and a mint or melt is settled by looking its note up.

## Development

```bash
npm ci
npm run dev             # web app on localhost
npm run build           # web app into dist/
npm run build:napplet   # one-file napplet + NIP-5A manifest into dist-napplet/
npm run check:napplets  # page metas agree with the manifest
npm run test:conformance
npm run tsc
npm run format:check
```

The napplet declares `resource`, `storage` and `theme`. It passes
`@napplet/conformance-cli` (boot, forbidden globals, degradation without
domains).

What was checked while building, and what is still open, is recorded in
[docs/REBUILD-2026-09-27.md](docs/REBUILD-2026-09-27.md).

## License

MIT. Bearlett started from dni's
[lnurl-wallet](https://github.com/lnurlcash/lnurl-wallet); since the rebuild
it shares the protocol, not the code.
