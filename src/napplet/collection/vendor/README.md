# Vendored: the NutFT card wallet

`nutft-wallet.js` is a **byte-identical copy** of `site/nutft-wallet.js` from the
600B Timelock TCG repository. Do not edit it here. Everything this napplet needs
to change is injected around it, and the reasons are in
[NUTFT-LIBRARY-WIRING-2026-09-10.md](../../../../docs/NUTFT-LIBRARY-WIRING-2026-09-10.md).

|          |                                                                            |
| -------- | -------------------------------------------------------------------------- |
| Upstream | `site/nutft-wallet.js`, `BIMbeamFLX/600BillionTimelockTCG`                 |
| Commit   | `0d05c73041bf5ce89894a6425c3f3cef167990a7`, the merge of PR 73 into `main` |
| SHA-256  | `fe1ee584e280afcbcd023fb00c0ab9e3ac15c77a22211992ed8cc456b2ecf6ce`         |
| Lines    | 1539                                                                       |
| Licence  | MIT, see [LICENSE](LICENSE)                                                |

Keeping it byte-identical is the point, so the provenance lives here rather than
in a header inside the file. Re-syncing is then a plain copy, and `sha256sum`
says whether this file has drifted, which no amount of local commentary could.
`bootstrap.test.ts` asserts the hash, so drift fails the suite rather than being
discovered later.

## What the collection supplies

The library imports cashu-ts and the scure libraries from `./vendor/*.js` beside
itself when a page has not handed them over. A napplet has no such files and no
network, so `prepareCollectionGlobals` sets `__cashu` and `__walletCrypto` before
the library loads, and those imports never run. The build leaves them in place
untouched.
