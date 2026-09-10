# Vendored: the NutFT card wallet

`nutft-wallet.js` is a **byte-identical copy** of `site/nutft-wallet.js` from the
600B Timelock TCG repository. Do not edit it here. Everything this napplet needs
to change is injected around it, and the reasons are in
[NUTFT-LIBRARY-WIRING-2026-09-10.md](../../../../docs/NUTFT-LIBRARY-WIRING-2026-09-10.md).

| | |
| --- | --- |
| Upstream | `site/nutft-wallet.js`, 600B Timelock TCG |
| Branch | `feature/nutft-async-storage` |
| Commit | `f72a817fcf67c42852273eef857a3de58103c4b6` |
| SHA-256 | `5e73a4426b04ddecf03f9c671ec771fd1a4eb5350136624035756c1f16272572` |
| Lines | 1226 |
| Licence | MIT, see [LICENSE](LICENSE) |

Keeping it byte-identical is the point. Re-syncing is then a plain copy, and
`sha256sum` says whether this file has drifted, which no amount of local
commentary could. `bootstrap.test.ts` asserts the hash, so drift fails the suite
rather than being discovered later.

## This pins an unmerged branch

`feature/nutft-async-storage` is the tip of open pull requests 30 through 33 in
that repository, and it is the only branch carrying the asynchronous storage
port. Without that port the wallet writes straight to `localStorage`, which a
napplet does not have in any useful sense, so no earlier commit can be used.

If those pull requests change during review, this copy has to be re-taken and the
table above updated. That is a real dependency and it is written down rather than
implied.
