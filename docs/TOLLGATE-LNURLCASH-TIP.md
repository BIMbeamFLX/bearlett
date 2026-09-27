# TIP draft: LNURLcash payments

Draft for the TollGate protocol (OpenTollGate/TollGate), next to TIP-02
(Cashu payments), written 27 September 2026 against TollGate `0c242a1`,
tollgate-module-basic-go `main` of the same day and LUD-25 `50d740a`. Not
proposed yet. Bearlett implements the customer side
([src/tollgate/](../src/tollgate/)); its tests run a reference TollGate
([tests/tollgate/gate.ts](../tests/tollgate/gate.ts)) against an adversarial
mock mint.

---

## TollGate Discovery

A TollGate that accepts LNURLcash notes (LUD-25) advertises its pricing in
the TIP-01 `kind=10021` event with the following tags.

```json
{
    "kind": 10021,
    "tags": [
        // <TIP-01 tags>
        ["price_per_step", "lnurlcash", "<price>", "<unit>", "<withdraw_url>", "<min_steps>"],
        ["lnurlcash_cpub", "<withdraw_url>", "<cx1>:<i>"]
    ]
}
```

- `price_per_step` (one or more), as in TIP-02:
  - `<bearer_asset_type>` always `lnurlcash`.
  - `<price>` for one `step_size`, a whole number; `<unit>` is `sat` or
    `msat` (LNURLcash notes are worth whole msat).
  - `<withdraw_url>` the accepted mint's LUD-25 withdraw endpoint (its
    payRequest's `withdrawLink`), e.g. `https://mint.example/w` or
    `http://<npub>.fips/w`. A note is at this mint when its link, resolved
    per LUD-17 and without its query, equals this URL.
  - `<min_steps>` as in TIP-02.
- `lnurlcash_cpub` (optional, one per mint): the TollGate's own watch-only
  branch at that mint (LUD-25 Seed & derivation) and its next unused index
  on purpose 2, exactly as LUD-25's `text/cpub` metadata carries them. It
  lets a customer pay without sending a bearer secret (Payment by key).

## Payment

Over HTTP-01 (`POST /`) the body is one of the two forms below, as is or
as the `payment` tag of a `kind=21000` event, just as a Cashu token travels.

### By note

The body is a LUD-25 note link, in any form LUD-25 allows:

```
lnurlw://mint.example/w?k1=<spend>&c=<cs1>
```

This works for a customer behind the captive portal, with no route to the
mint: a wallet signs a key-path note's spend (`ck1`) offline, or hands over a
bearer note it made earlier. Such a note is handed over whole, and the
TollGate grants all it is worth, as TIP-02 does for a token. A wallet that
can reach the mint first splits off a note of the exact price.

The TollGate:

1. MUST refuse a note whose withdraw URL is not advertised, with notice code
   `payment-error-mint-not-accepted`.
2. MUST look the note up with its `k1` (LUD-25 Redeeming: the mint verifies
   the spend in full) and take `maxWithdrawable` as its value `v`. A note
   worth less than `min_steps` steps (at least one) is refused before
   anything is spent, with notice code `payment-error-below-min-steps`: the
   customer keeps it.
3. MUST rotate it at once into a note only the TollGate can spend (a
   `callback?k1=<spend>&p1=<cp1 or hex h>` of its own), and grant nothing
   before the mint answers `{"status": "OK"}`: until then anyone who saw the
   note can race it. A spent note gets notice code
   `payment-error-token-spent`.
4. MUST keep its `p1` for the note until the rotation is answered. Without
   an answer it replies with notice code `payment-outcome-unknown`; when the
   customer sends the same note again, it first looks `p1` up (`?p=`): if
   `p1` exists the rotation landed, else it sends the identical rotation
   again, which LUD-25 answers as a replay (Retrying a mutation). Either
   way the note is paid once.
5. Grants `floor(v / price)` steps.

Nothing but sha256 and HTTP is needed for this: the customer's spend passes
through as is, and the TollGate's new note can be a fresh 32-byte preimage
`x`, named as `p1=hex(sha256(x))` (LUD-25 Short forms).

> **Over open Wi-Fi a note is a bearer secret in cleartext.** Anyone
> listening can race the TollGate for it, exactly as for a Cashu token.
> Customers SHOULD pay by key where they can, and hand over small notes.
> A wallet takes a refused note back at once.

### By key

If the TollGate advertises `lnurlcash_cpub` for a mint the customer holds
notes at, and the customer can reach that mint (over another link, a FIPS
mesh, or a walled garden the TollGate opens to its accepted mints), the
customer derives the TollGate's key `pk_i` on purpose 2 from the `cx1`,
starting at the hinted `i`, and moves the exact price there with an ordinary
LUD-25 rotate or split naming `cp1<pk_i>` as `p1` (LUD-25 Internal
transfer; on `already in use` it tries `i+1`). No bearer secret is sent.
The body is then:

```
cp1<pk_i>@<withdraw_url>
```

The TollGate:

1. MUST check that `pk_i` is on its own advertised branch (it derives
   indices up to its hint plus a gap) and move its hint past it.
2. MUST look the note up with `?p=cp1<pk_i>` and take `maxWithdrawable` as
   its value `v`; the note is the TollGate's already, so nothing is rotated.
3. Grants `floor(v / price)` steps, even below `min_steps`: the sats are
   its own already, so wallets MUST pay at least `min_steps` steps.

The sats are safe from anyone listening, but the session is not: whoever
sends the body first, from any device, gets it. The body can be copied off
the air, or guessed by watching the mint for the next hinted key.

### Sessions and replays

A TollGate records the note that paid each session (its `Q` for a note,
`pk_i` for a key). The same body again from the device it was granted to
gets the same session (the customer's answer may have been lost); from any
other device it gets notice code `payment-error-token-spent`.

Notice codes, as tollgate-module-basic-go uses them where they exist:

| Code                              | When                                            |
| --------------------------------- | ----------------------------------------------- |
| `payment-error-mint-not-accepted` | the note's mint is not advertised               |
| `payment-error-invalid-token`     | not a payment, an unknown note, a foreign key   |
| `payment-error-below-min-steps`   | the note buys less than the minimum (new)       |
| `payment-error-token-spent`       | the note is spent, or paid another device's session |
| `payment-error-mint-unreachable`  | the lookup got no answer                        |
| `payment-outcome-unknown`         | the rotation got no answer yet: send it again   |

## Notes

- The customer's change never involves the TollGate: a wallet splits off
  the exact amount first, or hands over a whole note.
- The TollGate sweeps its notes as it likes: merge, then melt to its
  operator's Lightning Address, or keep them.
- A mint's timelocks and other script notes need no support here: the mint
  verifies every spend.
- Browsers: a web wallet on a public origin cannot reach a TollGate's
  plain-http API (mixed content, and the TollGate echoes CORS origins only
  for local ones). Such a wallet shows the body for the portal's payment
  field instead.

## Open questions

- **Change offline.** A customer behind the portal could name the amount
  and a change key of its own (`cp1` on its purpose 1): the TollGate would
  split instead of rotate, and the change land on the customer's key. That
  makes offline payments exact, at the price of one more parameter.
- **Encrypting the body** to the TollGate's key (NIP-44) would close the
  open-Wi-Fi race for every bearer asset, Cashu included. It belongs in
  HTTP-01, not here.
- **A TIP number**, and whether `tips` should list it.
