# Bearlett

**LNURLcash and Cashu bearer notes, together in one wallet.** Two independent,
MIT-licensed napplets: **Bearlett Wallet** holds and spends sats; **Bearlett Notes**
designs their appearance. Each has its own artifact, manifest and storage.

Development preview for review, not an audited release. Camera/NFC remain
functions of the original webwallet.

![LNURLcash and Cashu in Bearlett Wallet](docs/screenshots/wallet-desktop.png)

## Features

- Receive LNURLcash links, `cashuA` and `cashuB` tokens. Review legacy multi-mint
  tokens separately. Cashu receipts rotate proofs into your ownership.
- Display value, protocol, mint and status as banknotes. Split, combine, rotate
  and hand over notes. Revealing a spendable token reserves its value first.
- Fund and pay over Lightning with a fee preview. Transfer sats between
  LNURLcash and Cashu mints, retaining payment, issuance and change journals.
- Use one recovery phrase with separate protocol derivations. Encrypted backups
  contain proofs, counters, quotes, open transfers and designs.
- Design notes with uploaded images, colors and text in **Bearlett Notes**;
  push appearance-only designs to Wallet through `wallet/design`.

V1 supports **unbound Cashu sats over BOLT11**. Locked tokens, other units,
BOLT12, on-chain Cashu payments and Cashu hardware custody are outside this version.

## Build and install

Node.js 24 and npm:

```sh
npm ci
npm run build:napplet
npm run build:notes
```

| Napplet | Artifact                  | Manifest                            |
| ------- | ------------------------- | ----------------------------------- |
| Wallet  | `dist-napplet/index.html` | `dist-napplet/.nip5a-manifest.json` |
| Notes   | `dist-notes/index.html`   | `dist-notes/.nip5a-manifest.json`   |

Install each artifact independently using your shell's signing/install flow.
The generated NIP-5A manifests are unsigned templates; no publishing key is
embedded. Wallet exposes `wallet/open`, `wallet/receive`, `wallet/pay` and
`wallet/design`. The archetype and Cashu capability are project-specific extensions.

LNURLcash requires `storage`, `resource` and `inc`. Cashu additionally requires
the optional **Bearlett `cashu` host capability**, including its storage-scope
writer lease. Stock shells without it retain LNURLcash functionality.
See [Kehto integration](docs/KEHTO.md) and the [napplet guide](docs/NAPPLETS.md).

```sh
npm run preview:napplet
# Wallet: http://127.0.0.1:4186/wallet
# Notes:  http://127.0.0.1:4186/notes
```

Use separate tabs. The development host uses test mints and volatile session
storage. Its notes have no monetary value. It is not a production host.

## Verification

```sh
npm test
npm run tsc
npm run format:check
npm run test:napplet:browser
```

Crypto-backed fault tests exercise lost replies before/after mutations, paid-melt
recovery, input fees, deterministic restore, spent outputs and interrupted backup
imports. Browser tests cover both napplets on desktop/mobile. The
[real integration test](tests/integration/README.md) uses official LNURLmint,
Nutshell and two LND nodes on an isolated Bitcoin regtest network.

Read [recovery details](docs/BEARLETT.md) when reviewing changes involving funds.
Ambiguous payments remain reserved until reconciled; timeouts do not authorize
a second payment.

## Origins and license

Based on [dni's LNURLwallet](https://github.com/lnurlcash/lnurl-wallet) and our
independent Wallet/Notes napplet work. Original history is retained; imported
baseline: `e0fbf00453ea0736c8ec484f8bcea002b1229b0c`. Original documentation is
preserved in [UPSTREAM-LNURLWALLET.md](docs/UPSTREAM-LNURLWALLET.md).
The original webwallet source remains for compatibility/regression testing;
Bearlett's installable products are the two napplets.

[MIT license](LICENSE). Protocols: [LUD-25](https://github.com/lnurl/luds/blob/lnurlcash/25.md)
and [Cashu NUTs](https://github.com/cashubtc/nuts). Cashu uses `@cashu/cashu-ts` **4.10.1**.
