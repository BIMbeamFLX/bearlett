# Avatar recovery is separate from wallet restoration

Bearlett accepts the proposed convention `napplet:wallet/recovery-v1` under the
`wallet` archetype, action `open`. The manifest advertises this contract.

```json
{
  "version": 1,
  "guildId": "600b",
  "memberId": "founder-dni",
  "caseId": "case-123"
}
```

All fields are required; unknown fields and unsupported versions are rejected.
IDs are 1–128 ASCII letters/digits/underscore/hyphen. The payload is a navigation
reference, not a verified recovery receipt. No keys, seeds, passwords, backups,
approval flags or bearer notes are accepted through this convention.

While locked, Bearlett explains that avatar recovery does not unlock the wallet.
After normal unlock, the user reviews the request and can open the existing
Backup tab. This performs no storage writes, network calls, rekey, seed replacement,
restore or payment. Busy/pending requests retain the existing request-review guard.
The user still needs the existing wallet password, recovery phrase or accessible
backup, and performs restoration through the existing wallet workflow.

The guild owns its identity decision. Bearlett deliberately does not use a guild
vote or host identity to decrypt wallet data. A lost backup encryption key cannot
be recreated by a Nostr-key replacement. A future host must preserve/access the
correct wallet storage scope explicitly; changing login must not silently replace
the vault or imply old bearer copies have been revoked.

Sender implementation and recovery policy are in the 600.wtf repository:
`napplets/host/recovery.mjs`, `napplets/src/recovery.ts` and
`docs/recovery-implementation.md`. The source identity and wallet remain separate.

Validation: parser/receiver unit tests; desktop/mobile sandbox tests cover locked
delivery, explicit review, unchanged encrypted storage and zero resource requests.
The cross-repository runner in 600.wtf mounts both real UI bundles and uses actual
Schnorr signatures/SQLite with disposable test keys. Production Nappelin transport,
signer integration and external recovery publications remain outside this change.
