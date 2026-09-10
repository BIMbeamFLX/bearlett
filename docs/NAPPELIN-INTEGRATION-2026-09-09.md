# Nappelin: shared access to the wallet

Status: 9 September 2026. Code check, architecture proposal and local tests. Not
a rewrite or live release. Nappelin commit: `1b2f2c8ca84e779aa51c31ce2d274341aca50c68`.

## Result

The existing Nappelin identity is suitable as shared access. The ephemeral
guest identity is not suitable as recoverable access to money.

**Correction of 10 September 2026.** This report said Hangar passed only
signatures through and that NIP-44 was still missing. That is no longer true on
branch `feat/hangar-marmot-spike`. Both signer paths now carry NIP-44, and the
identity surface exposes it:

- `apps/hangar/src/identity/extension.ts:14-15` reads `nip44.encrypt` and
  `nip44.decrypt` off the NIP-07 provider and attaches them at `:40-42`, but only
  when both are functions.
- `apps/hangar/src/identity/bunker.ts:124-134` does the same for a NIP-46 signer
  through `nip44Encrypt` and `nip44Decrypt`, attached at `:198-204`.
- `apps/hangar/src/identity/types.ts:13` carries `readonly nip44?: Nip44Crypto`
  with `encrypt` and `decrypt`.

The field is optional on purpose, and that is what a wallet has to respect. A
signer without those functions produces an identity with no `nip44` at all, and
`apps/hangar/src/identity/worker.ts:16` builds the guest identity as
`{pubkey, kind: 'guest'}` with none either. A guest therefore cannot decrypt, so
it cannot open a wallet backup. That is the structural version of "guest is not
access to money": it does not depend on Bearlett remembering the rule.

## What the code actually does

| Building block | Finding |
|---|---|
| Hangar guest | `keyholder.ts` creates a random Nostr key in the worker. No secret export. No durable guest recovery path. |
| Figure / stone | `object-code.ts` creates locator and password with 128 bits of randomness each. The code addresses a locker. It is not yet complete account provisioning. `keyholder.ts` loads the encrypted secret and decrypts locally. |
| Locker | `locker-core.ts` implements the keys.justworks contract with NIP-49 and scrypt logN=16. It accepts this cost parameter explicitly. |
| Browser signer | `extension.ts` delegates public key and signatures, controls account changes and signature replies. On `feat/hangar-marmot-spike` it also passes NIP-44 through (`:14-15`, `:40-42`); the row's earlier claim to the contrary is corrected above. |
| Public identity interface | `types.ts` contains `pubkey`, `kind`, `signEvent`, `dispose`, and since `feat/hangar-marmot-spike` an optional `nip44` with `encrypt` and `decrypt` (`types.ts:5-15`). |
| Operator identities | `services/agent-api/scripts/mint-identity.mjs` creates platform/agent keys with NIP-49 logN=20. These are not player wallet keys and not directly compatible figure/stone locker blobs. Script not executed. |
| TCG wallet | Separate P2BK spend key and existing wallet snapshot. `nostr-wallet-sync.js` encrypts via `identity.nip44`, uses Nostr and Blossom for large snapshots. |
| Hangar network | `host.ts` currently runs a storage relay for napplets. It is not a persistent Nostr backup service. |

NIP-49 protects the private login key with a passphrase. NIP-44 here protects
wallet backup data via the signer. These functions do not replace each other.
The older email/Shamir concept in `docs/KEY-DESIGN.md` is not evidence of an
implemented player recovery flow.

## Recommended connection for V1

1. **Recoverable Nappelin identity as access.** Use a supported signer or a
   provisioned figure/stone. Convert guest to recoverable access before durable
   money use. Do not silently create a new key.
2. **Keep money keys separate.** Existing TCG P2BK keys and wallet secrets remain
   independent secrets in the protected wallet state. Do not replace them with
   the Nostr login key. A shared login does not mean one key for every task.
3. **Add a host-side backup service.** Provide NIP-44 internally in the local
   worker or via a suitable external signer. Napplets receive tightly limited
   wallet/backup operations. No private key is exported into the iframe. Map the
   existing TCG adapter onto the current Hangar/Kehto contract.
4. **Connect transport.** Configure a persistent relay and allowed Blossom
   upload/download in the host. First encrypt the complete snapshot locally, read
   the upload back and check the hash, then publish the signed reference. In this
   flow Blossom already stores encrypted data. The storage location alone does
   not create encryption.
5. **Execute device handover explicitly.** Clear pending payments, persist the
   last confirmed state, lock the old device, restore the new device and
   reconcile mint state. The existing Web Locks mutex does not coordinate other
   devices. A copied bearer token remains spendable. Durable revocation of old
   copies needs a checked reissue/rekey procedure at the mint. A Nostr mark
   alone does not enforce that.
6. **Android uses the same contract.** Host-side key custody and protected local
   storage, the same snapshot and identity rules. Specifically test lifecycle
   locks on app switch and return from the external signer.

Existing TCG backups can be opened only with their previous decryption access.
On change of Nappelin identity, an explicit migration with the old access is
required. Key, account or session changes must also invalidate in-flight
encryption replies. A timeout must never automatically create an empty
replacement wallet.

## Missing / still to prove

- Account and session binding for NIP-44. The capability itself now exists on
  both signer paths (see the correction above); what is unproven is that a
  returning answer is bound to the request, the active wallet and the selected
  signer account, and that a key or account change invalidates answers in
  flight.
- Compatibility adapter between existing TCG backup and current Hangar;
  persistent relay/Blossom service with permissions.
- Complete figure/stone provisioning and recovery on a second device against the
  intended locker. The checked unlock code alone does not prove its production
  readiness.
- Protected local wallet storage: the TCG backup encrypts the remote snapshot;
  the existing local wallet state still contains secrets in localStorage.
- Checked device handover and crash-recovery flow; protection against stale
  snapshots and still-spendable token copies.
- Real interoperability trial with Nappelin signer, TCG snapshot, relay, Blossom
  and subsequent restore on a second device.

Envelope/Hashtree are not a solution for these identity and writer gaps. Their
extra binding is not a prerequisite for the existing encrypted snapshot
procedure. Granola/Monero/USDT remains V2.

## Reproduced tests and limits

```sh
# From the Nappelin Hangar checkout
node --test apps/hangar/test/identity.test.mjs apps/hangar/test/locker.test.mjs apps/hangar/test/login-lifecycle.test.mjs
```

Result: **27 passed, 0 failed**. Contains real local cryptography and locker
test vectors. Locker requests and browser lifecycle are simulated. Additionally
**6 TCG wallet sync tests passed**, with simulated signer/relay/Blossom. That is
not a live end-to-end proof of the connection.

## Primary code evidence

In the Nappelin repository:

- `apps/hangar/src/identity/{types,keyholder,object-code,locker-core,extension,worker,worker-client,slot}.ts`
- `apps/hangar/src/{host,login}.ts`
- `services/agent-api/scripts/mint-identity.mjs`

In the TCG wallet repository:

- `site/{napplet,nostr-wallet-sync,nutft-wallet}.js`

Infographic: `nappelin-wallet-v1-infographic-2026-09-09.png`, produced with the
built-in ImageGen tool. Prompt: `nappelin-wallet-v1-infographic-prompt.txt`. The
graphic is an architecture sketch. The original SVGs in the Nappelin repository
remain the canonical logo assets.
