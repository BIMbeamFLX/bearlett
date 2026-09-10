# Bearer tokens on Blossom with Hashtree and Envelope

Addendum to the [architecture](ARCHITECTURE-2026-09-09.md), 9 September 2026.
Requested: store the bearer tokens themselves in
encrypted Blossom blobs, with Envelope as access. Recommendation and
source check. Not yet an implemented or tested storage binding.
The decision was recorded in the SQLite audit file before this document.

**Inventory correction:** The TCG wallet named later by the user already has
an encrypted Blossom binding. The following new work concerns
Hashtree/Envelope and the Bearlett integration. Do not reinvent the storage
adapter. See [checked existing state](TCG-WALLET-2026-09-09.md).

## Assessment

**Yes, encrypted tokens can be stored this way.** Blossom is a
plausible store for immutable encrypted objects. Hashtree can
organise several tokens, metadata and artwork under a verifiable root.
Envelope can open the matching wallet with an import/restore pointer.
None of these components replaces the local transaction store, the
wallet journal, or check and rotation at the mint.

Blossom stores arbitrary bytes under their SHA-256 hash. It does not
necessarily encrypt them itself. The specifically linked Hashtree draft is
unencrypted by default and offers two optional encryption suites.
For bearer tokens we would require encryption as mandatory.

## Sources actually read

The Gitworkshop pages were read in full in the browser after the
HTTP fetch returned only the empty SPA shell. Displayed commit:
`ad5c1af0dd84749c97a6dd95332527dc586806bc`, branch `hashtree`.

- [README](https://gitworkshop.dev/hzrd149.com/git.shakespeare.diy/blossom/tree/hashtree/implementations/hashtree/README.md):
  experimental client-side protocol, expressly not an official BUD;
  manifest trees, optional encryption, experimental `htree`/`nhash`
  identifiers and Nostr kind 30064.
- [Encryption](https://gitworkshop.dev/hzrd149.com/git.shakespeare.diy/blossom/tree/hashtree/implementations/hashtree/hashtree-encryption.md):
  `chk-v1` derives the key from plaintext and enables deduplication;
  `rnd-v1` uses a random key and nonce. Both use AES-GCM.
  The 33-byte keys contain a version/suite byte. Such a key
  is itself a bearer secret and must not be sent to Blossom.
- [References](https://gitworkshop.dev/hzrd149.com/git.shakespeare.diy/blossom/tree/hashtree/implementations/hashtree/hashtree-references.md):
  immutable roots via `nhash`, mutable roots via kind 30064.
  `owner-private` encrypts the root key with NIP-44 to the own Nostr key.
  `link-private` distributes access via a secret link. An encrypted
  `public` root, by contrast, publishes the key: unsuitable for wallet privacy.
  Events still reveal author, tree name, time and root hash.
- [Envelope](https://github.com/brenorb/envelope/tree/7d7ff1cf509f39ffe159c1cee7c93ba8ba042fd5):
  Remote HEAD rechecked, unchanged. `src/fragment.js` supports open
  and password-encrypted launch fragments; state at most 4,096 bytes,
  entire fragment at most 8,192 characters. `scripts/build-paja-runtime.mjs`
  resolves `blossom:sha256:<hash>` via a Blossom server. That is not a
  Hashtree resolver, upload/vault service, or wallet restore protocol.

The Hashtree texts deliberately define revised formats relative to the
original PRs 104–107. Compatibility with an arbitrary existing
Hashtree library or mmalmi's current client is therefore not demonstrated.
The implementation linked there was not tested in this addendum.

## Proposed split

| Purpose                      | Shape                                                                                                                                                      |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Private wallet backup        | Encrypted tokens **plus** complete counters, prepared outputs and journals; private root, access via own wallet Nostr key                                  |
| Hand over a single note      | Separate encrypted package for this transfer only; own key and immutable root; never share access to the entire wallet backup                              |
| Envelope link/QR             | Starts a verified wallet with a defined receive/restore pointer. The wallet checks the job and requests unlock/confirmation.                               |
| Local active state           | Still an atomic store and exactly one writer; Blossom serves remote storage and transfer                                                                   |

For secret wallet data, `rnd-v1` is the preferred candidate: no
content-deterministic ciphertexts and less equality information
than CHK. Metadata and parent manifests that carry keys must also be
encrypted. An encrypted child with an open key in the public
parent manifest is not private. Hash, suite and key mapping must be bound by
the authenticated root/backup commit.

The storage flow is: commit locally consistently, upload encrypted objects,
read all required objects back from storage and check them, then
publish the complete root. A root must not count as a successful
backup while required children are missing. Two independent stores
and a file backup raise availability. Retention/quotas must be checked.
For small backups a single encrypted Blossom blob
can first be simpler than a complete tree.

Kind 30064 with `owner-private` is a concrete alternative to the previously
proposed NIP-78 backup container. Final choice remains dependent on the
interop spike. There must not be two competing sources for the
latest wallet state. Even a validly signed Hashtree root provides
no distributed writer lock. On a new device it does not guarantee that
a relay is not withholding newer roots. Explicit device handover remains.

## Distinguish bearer handover from custody

A recipient with blob access and key can spend the contained unbound
token. If the key sits in the handed-over link, **the
link itself** is a banknote. Whoever has a copy can race for redemption.
Store, copy and delete on Blossom do not prove a change of ownership.

Receive therefore with mint check and rotation into new secrets known only to
the recipient. Cashu via the corresponding swap, LNURLcash via rotation. An
unchanged read copy is not yet securely accepted funds. One-time
redemption is enforced at the mint. Not by one-time download or blob deletion.

Envelope currently decrypts its optional `nwe1` fragment in the opener and
forwards the state by intent. For our host trust boundary it should
carry only a non-spendable pointer. Decryption in the trusted
wallet context. A transfer intentionally designed as a bearer link needs
separate, explicit handling of that secret. Do not copy vault keys
or tokens into analysis logs, public root tags or HTTP gateway URLs.

## Limited next proof

1. Check the chosen client version against exactly this Hashtree edition and its
   vectors, especially `rnd-v1`, private roots and `nhash` format.
2. Encrypt a synthetic token package locally, store it on two isolated
   Blossom test servers, and read it back with a fresh wallet.
3. Wrong key, tampered child, missing blob, old root,
   server failure and upload abort must be detected.
4. Envelope starts the checked receive contract with a pointer. Test mint
   rotates the token. Second redemption of the same handover fails at the mint.
5. Backup also contains pending journal/counters. Process kill, restore and
   device handover pass without a double payment.

This addendum contains no uploads, no real tokens and no change
to the wallet core. The previously reproduced F00–F04 remain to be fixed. A new
remote store does not remove these local faults.
