# Bearlett marketing review: what a stranger believes

22 September 2026. Read of the public face of `G:\Github\bearlett`: `README.md`,

Status: the installed name, the landing heading, and the footer repository
are Bearlett on `feat/session-bar`. The collection preview host is back in
the README. The Hangar shots are still concept art. The sentences below are
the review that change was written against.
`index.html`, the landing page, the napplet titles, and the screenshots the
README leads with. Paired with `docs/reviews/2026-09-22-code-ux.md`, which
holds the code-level defects. This note is about the promise.

The product worth selling is specific: bearer notes you can see, and trading
cards you hold yourself, each in its own small app, with the mint's signature
as the provenance. That sentence is already in the README and it is the right
one. Almost everything around it teaches a different product.

## Who this is for

One person, on a phone, who wants a 600B card in their hand and a way to pay
a friend in sats. They will give you one screen to explain it. They will not
learn LUD-25, NUT-31, `cashuB`, or "napplet" to get there.

Write to that person. Keep the protocol names for the technical half of the
README, where they already are and where they belong.

## The first five seconds are someone else's product

Opening the repo the way a visitor opens it (`index.html`, `npm run dev`,
the PWA) shows:

- Tab title and iOS name: **LNURLwallet** (`index.html` lines 20–21).
- First heading: **Your LNURLcash wallet** (`src/pages/Hero.tsx` line 24).
- First paragraph: a static page, local storage, `k1` is the asset.
- Six feature tiles: LUD-25, AES-GCM, mints, melt/split/combine, backup,
  hardware vault. No cards. No Bearlett. No picture of a card.
- Footer: **LNURLwallet**, website `lnurlcash.com`, GitHub
  `lnurlcash/lnurl-wallet` (`src/components/Footer.tsx` lines 47–64).

The manifest agrees with the old name and disagrees with itself:
`vite.config.ts` lines 78–80 set `name` and `short_name` to LNURLwallet and
`description` to the Bearlett package blurb.

A stranger who installs this tells their friends they installed LNURLwallet.
A stranger who needs help files the issue on dni's repository. Both outcomes
are what the page asks them to do.

The napplet entry points are closer, and still shy of the game:

- `napplet/index.html` description: "An encrypted LNURLcash wallet for Nostr
  applet shells." Cashu is missing. Cards are missing. "Nostr applet shells"
  is an audience of developers.
- `napplet/collection.html` description is the best line in the product:
  "One trading card collection, held as bearer assets in a Nostr applet
  shell." Lead with the collection. Lose "Nostr applet shell" on anything a
  player reads.

### Replace the front door with this

One screen, in this order:

1. The name **Bearlett**, and one line: bearer cards and bearer notes, held
   on this device.
2. A real card from Edition One, large, and one banknote beside it.
3. Two actions: **Open my collection** and **Open my wallet**.
4. One trust line: the art is checked against its hash before it is shown,
   and a payment is written down before it is sent.
5. Help and source point at this repository.

The LNURLcash web wallet can stay available as a compatibility build. It
should introduce itself as that, on a second URL, and it should stop wearing
the only install name.

## The README sells the Hangar. The shipping app is a grid.

The first screenshots under "Design preview" (`README.md` around lines
43–59) are the Hangar: pointer tilt, card back, a scrubbable reveal of five
cards, a Pay overview. The paragraph above them says the collection ships and
the rest is a prototype with demo balances. That disclaimer is easy to miss
under four images.

What actually ships in `src/napplet/collection/`:

- A grid, rarest first, with search, tier, type, and a duplicates toggle.
- A flip to a back made of ids, hashes, and a mint state word.
- Receive and hand-over as pasted text.
- No pack, no reveal timeline, no tilt, no separate Pay napplets.

The Hangar file (`docs/prototype/bearlett-hangar.html`) is also off-brand
relative to the rules in `docs/UI-DESIGN-2026-09-09.md`: it loads fonts from
Google, and its system stack names Roboto (lines 3 and 17). The design brief
bans Roboto. A napplet cannot load those fonts at all. Screenshots of this
file are concept art. Label them concept art in the filename and the
caption, or take them out of the default read.

Screenshot rule from here: every image in the README is a capture of a
current build, with a one-line caption that says which command produced it.
Concept frames live in `docs/prototype/` and are linked once, as the target,
not as the product.

The target is still the right target. Ship order, if the goal is the best
session rather than the most napplets:

1. Card arrives from a purchase without a paste.
2. Reveal is the card, full size, once.
3. The set shows owned and missing.
4. Hand-over is a QR of a named card.
5. Pay stays the quiet sats wallet, per mint, with a QR.

The twelve-napplet catalogue in the design brief can wait. A player never
asked for twelve apps. They asked for a card and a way to give it to someone.

## Three visual languages, described as one

The README (around lines 89–96) says Wallet and Notes wear the Nappelin
Hypershell, "the same register as the 600B Timelock TCG." The code wears
three:

| Surface | What it looks like | Evidence |
| --- | --- | --- |
| Sats napplet and Notes | Iron, brass, Josefin Sans, IBM Plex Mono | `src/napplet/style.css` lines 1–16 and 107–120 |
| Collection | Near-black, ember, violet, system fonts including Arial Narrow | `src/napplet/collection/collection.css` lines 1–30 |
| Web wallet | The upstream LNURLwallet chrome | `src/pages/Hero.tsx`, `src/styles/` |
| Hangar prototype | Brass shell, ember cards, cream paper pay, Anton, and a serif | `docs/prototype/bearlett-hangar.html` lines 4–17 |

Two families are a decision the design brief already made: cards in the
600B register, money in a quieter register. Say that. "The same register"
is how a careful reader loses trust in the rest of the page.

Until the collection bundles a real display face, headlines fall through to
whatever the phone has. Josefin is already in the repo for the wallet. The
collection should use the face the brand already chose, or Anton if the card
family keeps its own display face. Pick one and put it in the artifact.
System fonts are a placeholder that shipped.

## Sentences that teach the wrong lesson

Use these replacements on the player-facing screens. The current strings are
accurate to the machinery and wrong for the person.

| Where | Current | Say this instead |
| --- | --- | --- |
| README, plain words | "No account, no name on a list" | "No exchange account. Whoever holds the card or the note holds it." The word "account" is already on the collection move sheet for the shell identity (`main.tsx` around lines 786–794), and only on the accounts build. One word cannot mean both. |
| Sats headline | One summed sat number, then "balances stay separate by mint" | The mint name and the amount you can spend there. |
| Empty wallet | "mint one by paying a Lightning invoice" plus a Receive button | "Add sats from Lightning" and "Receive a note." |
| Receive placeholder | `lnurlw://… · LNURL1… · cashuA… · cashuB…` | "Paste a note or a card token." Detect the format in code, which you already do for Cashu. |
| Spent status | "not outstanding" | "Spent." |
| Collection home | "Supply attested … snapshot N …" | Keep "Packs issued" in the counter. Put the attestation date on the card back. |
| Card back | Binding, face hash, raw mint state | "Checked against the mint." The hash opens if they ask. |
| Missing art | "no face" | "Artwork unavailable." |
| Empty filter | "Clear the filters" with no such control | A Clear button, and the sentence can stay. |
| Hand-over formats | HTTPS, LNURL, LNURLw, webwallet claim | One link, one QR. The other three go under "Other ways to share." |
| Design on the wallet | "Design JSON" | Remove it from this screen. Notes already sends a design for review. |
| Collection paste help | Buy on the site, send from that site's wallet, paste here | "Bought a pack? It shows up here." The code path for that is the P0 item in the code note. Until it exists, do not advertise packs and this collection as one product. |
| Settings aside | "Use the webwallet for camera scanning and NFC." | Either the wallet scans, or the sentence names the app they must open, in Bearlett's words, with a reason. |

## Claims to correct before anyone quotes the README

These are documentation defects. They read as product claims.

1. **Collection preview.** The README (around lines 148–150) says there is
   no development host for a collection, because the dev host has no `nutft`
   capability. `package.json` has `preview:collection`. `docs/NAPPLETS.md`
   documents `http://127.0.0.1:4188/collection`. `scripts/napplet-host.mjs`
   serves the collection in a sandboxed frame with an in-page fixture mint
   (the comment above `collectionPreview`, and the route around lines
   157–245). Update the README to those commands. A contributor who trusts
   the README will skip the only way to see the game.
2. **Test count.** "509 passing, 1 skipped, 10 Sep 2026" is a log line with
   a date. It is now twelve days old and this review did not re-run the
   suite. Delete the number from the README or replace it with the command
   `npm test` and a date you just produced.
3. **BOLT12 pictures.** The README is honest that BOLT12 is not wired. The
   Hangar Pay shots still sit in the first scroll. If a shot shows a control
   the build does not have, it is concept art, and the caption has to say so
   in the same size as the image.
4. **Hardware.** The landing page offers a hardware vault. The README puts
   Cashu hardware custody outside V1. Say which notes a paired device can
   hold today, on both pages, in the same words.
5. **Artifact size.** The README's "~337 kB" collection figure was not
   re-measured here. Re-measure on the next README edit or drop the number.

## Voice

The collection's own error rewriter (`readable` in `main.tsx`) is the voice
to copy: short, names the object the person is looking at ("cards", not
"wallet"), and tells them where to go. The landing page and the wallet empty
state are still speaking protocol.

Rules that match the brand you already wrote down:

- One product name on every player surface. Bearlett.
- Brass for money, ember for cards. Say so. Do not call them the same register.
- One green thing means checked, live, or on. The collection currently spends
  green on the supply line, the success notice, and the word "checked" at
  the same time (`collection.css` `.supply`, `.notice--good`, `.checked`).
- Square corners, no shadow, short motion. The collection already follows
  this. The Hangar's pulsing live-dot does not need to come with it.
- Never ask a player to type JSON, a hash, or a token scheme name.

## What "best session" means, so marketing and code aim at the same thing

A new person can do all of this on a phone, in one sitting, without a
desktop and without reading a NUT:

1. Install or open Bearlett and see the name Bearlett.
2. Receive a card they bought or were given, and watch that card, not a
   status sentence.
3. See how much of the set they hold.
4. Hand one named card to a friend with a QR.
5. Add sats and pay a Lightning invoice without losing the invoice when
   they switch apps.
6. Lock the wallet by leaving it, then unlock onto the same task.

Anything in the README that is not on that path is a lab note. Keep the lab
notes. Move them below the first screen.
