# Development validation

Run on Windows with Node 24 on 2026-09-09. This is a review build, not a funds
security audit or a claim of compatibility with every mint/shell.

| Check                                                   | Result                                                 |
| ------------------------------------------------------- | ------------------------------------------------------ |
| Bearlett `npm test`                                     | 353 passed, 1 existing opt-in integration test skipped |
| TypeScript and Prettier                                 | Passed                                                 |
| Original webwallet and both napplet production builds   | Passed                                                 |
| Playwright desktop/mobile                               | 12 passed                                              |
| Real two-protocol Lightning regtest                     | Passed                                                 |
| Affected Kehto packages and Paja logs                   | 1103 passed in 65 files                                |
| Kehto ACL, firewall, runtime, services and shell builds | Passed, including declarations                         |
| npm dependency audit                                    | 0 reported vulnerabilities                             |

The real test uses Bitcoin 29.0, LND 0.19.3-beta, Nutshell 0.20.3 and
LNURLmint `bd21f6119ee70297c127531e139d517453c26587`. It exercises both transfer
directions, mint fees, change, a deliberately lost melt response and full-backup
recovery without a second melt. See [the reproducible setup](../tests/integration/README.md).
Only regtest funds were used.

The Kehto patch targets `a7e0d12f6a6bd4c6d8f90a2b884febf7a2e08bfd` and contains
commit `14a14155`. It includes real runtime permission/source-binding tests and
injected namespace tests. Browser tests use the development host, not a deployed
Kehto permission interface. Host-specific mint approval and trusted storage-scope
callbacks still need wiring by the integrating shell.

## Review and release work remaining

- Independent review of proof accounting, recovery, host permissions and journals.
- Expand the fault matrix to every interruption point in both transfer directions
  and additional mint implementations; the current tests sample the critical paths.
- Add the complete official Cashu token/keyset/signature/derivation vector corpus;
  current coverage combines cashu-ts validation, crypto-backed fixtures and real mints.
- Exercise the integrated Kehto host on physical mobile devices. Playwright mobile
  viewport coverage is not a physical-device test.
- Define UX for orphan preparation quotes, expired transfers and mints that never
  resolve an ambiguous payment. Such funds stay reserved; no automatic second payment.

Vite reports an existing configuration-loader migration warning and the original
webwallet's large bundle warning. They do not fail builds. Recovery limitations
and full-backup requirements are documented in [BEARLETT.md](BEARLETT.md).

A broader Kehto monorepo run was not green: 1756 tests passed, 9 failed and four
suites failed to load. Failures include CRLF-sensitive source assertions, package
alignment expectations, script loader errors and an unbuilt Paja CLI entry. The
affected-package command above passes; the entire monorepo is not certified here.
