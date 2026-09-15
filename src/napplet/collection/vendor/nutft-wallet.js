(function (root) {
  "use strict";

  /* A page may point the wallet at its own storage slot (NUTFT_STORE), pin the
     editions it accepts (NUTFT_UNITS, an array of unit names), and hand it an
     asynchronous store (NUTFT_STORAGE, see the storage port below). All three
     are read once, before this file runs; unset means the 600B defaults. */
  const STORE = (typeof root.NUTFT_STORE === "string" && root.NUTFT_STORE) || "600b:nutft-wallet";
  const CATALOG_CACHE = "600b:nutft-catalogs-v1";
  const CATALOG_CACHE_VERSION = 1;
  const CATALOG_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
  /* The libraries are this site's own files, never a CDN import: a module
     fetched live from a third party can hand a wallet that holds bearer cards
     any code it likes. scripts/build-wallet-vendor.mjs builds them from pinned
     npm versions and tests/js/vendor.test.mjs checks their hashes. A dynamic
     import in a classic script resolves against the script's own URL, so these
     are found beside nutft-wallet.js whichever page loads it. */
  const CASHU_URL = "./vendor/cashu-ts.js";
  const BIP39_URL = "./vendor/scure-bip39.js";
  const ENGLISH_URL = "./vendor/scure-bip39-english.js";
  const BIP32_URL = "./vendor/scure-bip32.js";
  let cashuPromise;
  let walletCryptoPromise;
  const seedCache = new Map();
  let memory = null;
  let queue = Promise.resolve();

  /* THE STORAGE PORT.
   *
   * A page has localStorage, which is synchronous and cannot report a refusal
   * after the fact. A napplet has none of that: its store belongs to the shell,
   * every call is asynchronous, and a write is not done until the shell says so.
   * A wallet that treats an unacknowledged write as finished can burn a card
   * against a write that never landed, so both shapes go through this one
   * object and every mutation below awaits it.
   *
   * A shell injects NUTFT_STORAGE before this file runs. Without it the port
   * wraps localStorage, so the pages keep behaving exactly as they did. */
  const store = (() => {
    const injected = root.NUTFT_STORAGE;
    if (injected && typeof injected.getItem === "function" && typeof injected.setItem === "function") {
      return injected;
    }
    return {
      getItem: async (key) => root.localStorage.getItem(key),
      setItem: async (key, value) => { root.localStorage.setItem(key, value); },
    };
  })();

  const cashu = () => (cashuPromise ||= root.__cashu ? Promise.resolve(root.__cashu) : import(CASHU_URL));
  const walletCrypto = () => (walletCryptoPromise ||= root.__walletCrypto
    ? Promise.resolve(root.__walletCrypto)
    : Promise.all([import(BIP39_URL), import(ENGLISH_URL), import(BIP32_URL)]).then(([bip39, english, bip32]) => ({ ...bip39, wordlist: english.wordlist, HDKey: bip32.HDKey })));
  const hex = (bytes) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  const bytes = (value) => Uint8Array.from(value.match(/.{2}/g).map((part) => parseInt(part, 16)));
  const canonical = (value) => {
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
    return JSON.stringify(value);
  };
  const digest = async (value) => hex(new Uint8Array(await root.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))));
  const reference = (tag) => ({ collection_id: tag[1], asset_id: tag[2], catalog_uri: tag[3] });
  const binding = async (tag) => digest(`Cashu_NutFT_v1${canonical(reference(tag))}`);
  const validState = (state) => state && typeof state === "object" && typeof state.privateKey === "string" && typeof state.pubkey === "string" && (state.seedPhrase == null || typeof state.seedPhrase === "string") && (state.counters == null || (typeof state.counters === "object" && !Array.isArray(state.counters))) && Array.isArray(state.tokens) && state.tokens.every((token) => typeof token === "string") && (state.pending == null || typeof state.pending === "object")
    && (state.unmoved == null || (Array.isArray(state.unmoved) && state.unmoved.every((entry) => entry && typeof entry.mint === "string" && typeof entry.secret === "string")));

  /* ALWAYS re-read storage. The cache used to be returned outright, so this
   * function could not see a write made by another TAB — and every decision
   * about `pending` is made from what it returns.
   *
   * The loss that made this urgent: the shop opens a booster pending in one
   * tab; the wallet, opened earlier, still holds a cached state with no pending;
   * a send there passes the "is a transfer already running" guard, and its
   * await write() then overwrites the booster pending with the trade's. For a PAID
   * booster that destroys the outputs, so the sats are gone with nothing left to
   * claim — precisely the loss the comment in submitPending warns about, reached
   * by a route it never considered. The site actively moves players between
   * shop.html and wallet.html, so two open tabs is the normal case, not an edge.
   *
   * `memory` stays as the parse target and as the fallback for a shell with no
   * storage at all, where it is the only place a wallet can live. Re-parsing a
   * few kilobytes per call is not a cost worth a correctness hole. */
  async function read() {
    let saved = null;
    try { saved = await store.getItem(STORE); }
    catch { return memory || (memory = { privateKey: "", pubkey: "", seedPhrase: "", counters: {}, tokens: [], outgoing: [] }); }
    if (saved === null && memory) return memory;
    if (!saved) return (memory = { privateKey: "", pubkey: "", seedPhrase: "", counters: {}, tokens: [], outgoing: [] });
    try { memory = JSON.parse(saved); }
    catch { throw new Error("Wallet storage is corrupted. Preserve 600b:nutft-wallet before making changes."); }
    if (!validState(memory)) {
      memory = null;
      throw new Error("Wallet storage has an invalid shape. Preserve 600b:nutft-wallet before making changes.");
    }
    return memory;
  }

  /* memory advances only after the store has acknowledged the write. A refused
     write therefore leaves both the store and this wallet on the old state. */
  async function write(state) {
    await store.setItem(STORE, JSON.stringify(state));
    memory = state;
  }

  /* Transfers this wallet has sent and not yet marked delivered. Newest first.
     Read-only copies: a caller mutating the array must not be able to drop a
     token that is still the only claim on a card. */
  async function outgoing() {
    const state = await read();
    return (Array.isArray(state.outgoing) ? state.outgoing : []).map((entry) => ({ ...entry }));
  }

  /* Forget one, once it is known to be in the recipient's hands. Deliberately
     explicit and deliberately not automatic: this wallet cannot observe whether
     the other side claimed it, so only a person can say so. */
  async function forgetOutgoing(token) {
    const state = await read();
    const kept = (Array.isArray(state.outgoing) ? state.outgoing : []).filter((entry) => entry.token !== token);
    await write({ ...state, outgoing: kept });
    return kept.length;
  }

  function locked(work) {
    if (root.navigator?.locks) return root.navigator.locks.request(STORE, work);
    const result = queue.then(work, work);
    queue = result.catch(() => {});
    return result;
  }

  async function identity(c) {
    const state = await read();
    if (!state.privateKey) {
      const wc = await walletCrypto();
      const seedPhrase = wc.generateMnemonic(wc.wordlist, 128);
      const privateKey = wc.HDKey.fromMasterSeed(wc.mnemonicToSeedSync(seedPhrase)).derive("m/129373'/10'/0'/0'/0").privateKey;
      const next = { ...state, seedPhrase, counters: {}, privateKey: hex(privateKey), pubkey: hex(c.getPubKeyFromPrivKey(privateKey)) };
      await write(next);
      return next;
    }
    return state;
  }

  async function getKeyset(mintUrl, c) {
    const [infoResponse, response] = await Promise.all([fetch(`${mintUrl}/v1/info`), fetch(`${mintUrl}/v1/keys`)]);
    if (!infoResponse.ok) throw new Error(`mint capabilities unavailable (${infoResponse.status})`);
    if (!response.ok) throw new Error(`mint keys unavailable (${response.status})`);
    const info = await infoResponse.json();
    const capability = info.nuts && info.nuts[31];
    if (!capability || capability.supported !== true || !capability.versions?.includes(1) || capability.output_openings !== true || capability.p2bk !== true || capability.dleq !== true || typeof capability.catalog_issuer !== "string") {
      throw new Error("mint does not advertise the required NUT-31/P2BK/DLEQ capabilities");
    }
    if (!info.nuts?.[9]?.supported) throw new Error("mint does not advertise NUT-09 restore support");
    const data = await response.json();
    const keyset = data.keysets && data.keysets.find((entry) => entry.active !== false);
    /* A NutFT keyset has exactly one amount, 1: a card is one proof. Its unit
       name is the collection id, so the wallet no longer carries a list of
       editions it has heard of. A page that wants to pin editions sets
       NUTFT_UNITS before loading this file. */
    const allowed = Array.isArray(root.NUTFT_UNITS) && root.NUTFT_UNITS.length ? root.NUTFT_UNITS : null;
    const amounts = keyset && keyset.keys && typeof keyset.keys === "object" ? Object.keys(keyset.keys) : [];
    if (!keyset || typeof keyset.unit !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(keyset.unit)
        || amounts.length !== 1 || amounts[0] !== "1") {
      throw new Error("mint does not advertise a NutFT keyset (one unit, amount 1)");
    }
    if (allowed && !allowed.includes(keyset.unit)) {
      throw new Error(`mint unit ${keyset.unit} is not one this page accepts (${allowed.join(", ")})`);
    }
    /* The catalog by hash. The mint's own /blossom path comes first, then the
       mirrors it advertises; each candidate is checked against the hash
       before it is parsed (see fetchCatalog). */
    const blobSha = /^[0-9a-f]{64}$/.test(capability.catalog_blob_sha256 || "") ? capability.catalog_blob_sha256 : "";
    const blobUrls = blobSha && Array.isArray(capability.catalog_blob_urls)
      ? capability.catalog_blob_urls.filter((entry) => typeof entry === "string" && /^https?:\/\//.test(entry)).slice(0, 8)
      : [];
    return {
      id: keyset.id,
      keys: keyset.keys,
      unit: keyset.unit,
      catalogIssuer: capability.catalog_issuer,
      purchaseMode: capability.purchase_mode === true,
      catalogUri: typeof capability.catalog_uri === "string" && (capability.catalog_uri.startsWith("https://") || capability.catalog_uri.startsWith("http://")) ? capability.catalog_uri : "",
      catalogDigest: /^[0-9a-f]{64}$/.test(capability.catalog_sha256 || "")
        ? capability.catalog_sha256
        : "",
      catalogBlob: blobSha ? { sha256: blobSha, urls: [`${mintUrl}/blossom/${blobSha}`, ...blobUrls] } : null,
    };
  }

  /* cashu-ts 4.7.2 base64-encodes a token in 32 KiB chunks and joins the
     chunk strings, so any token above that size carries "=" padding in its
     middle and no longer decodes; a 60-card deck is such a token. Serialize
     once in binary and encode the whole payload in one go instead. */
  function encodeToken(c, value) {
    if (typeof root.btoa !== "function" || typeof c.getEncodedTokenBinary !== "function") return c.getEncodedToken(value);
    const bytes = c.getEncodedTokenBinary(value).slice(5); // drops the "crawB" binary prefix
    let binary = "";
    for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
    return `cashuB${root.btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
  }

  /* The mint's catalog for deterministic outputs: by hash first and shared
     with the collection cache when the mint advertises its catalog URI,
     otherwise straight from the mint, verified against the keyset either way. */
  async function getCatalog(mintUrl, c, keyset) {
    if (keyset.catalogUri) return catalogFor(keyset.catalogUri, c, keyset, new Map());
    const response = await fetch(`${mintUrl}/nutft/catalog`);
    if (!response.ok) throw new Error(`catalog unavailable (${response.status})`);
    const catalog = await response.json();
    return verifyCatalog(catalog.catalog_uri, catalog, c, keyset);
  }

  const opening = (output) => ({
    secret: new TextDecoder().decode(output.secret),
    blinding_factor: output.blindingFactor.toString(16).padStart(64, "0"),
    p2pk_e: output.ephemeralE,
  });
  const savedOutput = (output) => ({ id: output.blindedMessage.id, B_: output.blindedMessage.B_, ...opening(output) });
  const restoreOutput = (saved, c) => new c.OutputData(
    { amount: c.Amount.from(1), id: saved.id, B_: saved.B_ },
    BigInt(`0x${saved.blinding_factor}`),
    new TextEncoder().encode(saved.secret),
    saved.p2pk_e,
  );
  const requestOutput = (saved) => ({ amount: 1, id: saved.id, B_: saved.B_, nutft: { secret: saved.secret, blinding_factor: saved.blinding_factor, p2pk_e: saved.p2pk_e } });
  const counterKey = (mintUrl, keysetId) => `${mintUrl}|${keysetId}`;
  const SECP256K1_N = BigInt("0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141");

  async function seedContext(seedPhrase) {
    if (!seedCache.has(seedPhrase)) {
      const wc = await walletCrypto();
      const seed = wc.mnemonicToSeedSync(seedPhrase);
      seedCache.set(seedPhrase, {
        seed,
        hmacKey: root.crypto.subtle.importKey("raw", seed, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]),
      });
    }
    const context = seedCache.get(seedPhrase);
    return { seed: context.seed, hmacKey: await context.hmacKey };
  }

  async function deterministicOutput(card, state, c, keyset, counter) {
    const { seed, hmacKey } = await seedContext(state.seedPhrase);
    const derived = c.deriveSecretAndBlindingFactor(seed, keyset.id, counter);
    const eDigest = new Uint8Array(await root.crypto.subtle.sign("HMAC", hmacKey, new TextEncoder().encode(`600B_NutFT_P2BK_E_v1${keyset.id}${counter}`)));
    const e = BigInt(`0x${hex(eDigest)}`) % SECP256K1_N;
    if (!e) throw new Error("derived invalid P2BK key");
    const { blinded, Ehex } = c.deriveP2BKBlindedPubkeys([state.pubkey], bytes(e.toString(16).padStart(64, "0")));
    const secret = JSON.stringify(["P2PK", {
      nonce: hex(derived.secret),
      data: blinded[0],
      tags: [["nutft", "1", card.collection_id, card.asset_id, card.catalog_uri, card.asset_binding]],
    }]);
    const encoded = new TextEncoder().encode(secret);
    const r = BigInt(`0x${hex(derived.blindingFactor)}`);
    const B_ = c.blindMessage(encoded, r).B_.toHex(true);
    return new c.OutputData({ amount: c.Amount.from(1), id: keyset.id, B_ }, r, encoded, Ehex);
  }

  const RECOVERY_UNFINISHED = "finish recovering this wallet from its phrase first";

  /* A pending record that holds none of the phrase's counter slots: a booster
     claim still waiting for the receipt that names its cards, or a transfer to
     somebody else's key. A half-finished recovery can resume around one. */
  const holdsNoSlots = (pending) => !pending
    || (pending.type === "booster" && !(pending.outputs || []).length)
    || (pending.type === "trade" && !pending.toSelf);

  async function outputsFor(cards, mintUrl, state, c, keyset) {
    if (!state.seedPhrase) {
      return { outputs: cards.map((card) => c.OutputData.createSingleP2PKData({
        pubkey: state.pubkey,
        blindKeys: true,
        additionalTags: [["nutft", "1", card.collection_id, card.asset_id, card.catalog_uri, card.asset_binding]],
      }, 1, keyset.id)), counters: state.counters || {} };
    }
    /* Slots beyond a half-finished recovery's checkpoint may already hold this
       phrase's cards, so nothing may reserve slots until the recovery ends. */
    if (state.restoring) throw new Error(RECOVERY_UNFINISHED);
    const catalog = await getCatalog(mintUrl, c, keyset);
    const key = counterKey(mintUrl, keyset.id);
    const counters = { ...(state.counters || {}) };
    let counter = Number(counters[key] || 0);
    const outputs = [];
    for (const card of cards) {
      const index = catalog.assets.findIndex((asset) => asset.asset_id === card.asset_id);
      if (index < 0) throw new Error(`catalog has no asset ${card.asset_id}`);
      counter += (index - (counter % catalog.assets.length) + catalog.assets.length) % catalog.assets.length;
      outputs.push({ card, counter });
      counter += 1;
    }
    counters[key] = counter;
    return { outputs: await Promise.all(outputs.map((item) => deterministicOutput(item.card, state, c, keyset, item.counter))), counters };
  }

  /* THE SLOTS AN OPERATION RESERVES. outputsFor moves the counter past every
     slot it uses, and the pending is written with that counter, so those slots
     are spoken for until the mint answers. Remembering where the counter stood
     is what lets a refusal hand them back. */
  const reservation = (state, mintUrl, keyset, counters) => {
    const key = counterKey(mintUrl, keyset.id);
    const before = Number((state.counters || {})[key] || 0);
    return Number(counters[key] || 0) === before ? null : { key, before };
  };

  /* A REFUSED OPERATION GIVES ITS SLOTS BACK. A recovery phrase finds cards by
     walking the counter, and a restore stops after a long enough run of slots
     the mint never signed. Slots kept by an operation the mint turned down open
     exactly such a run in front of every later card, so those cards could not
     be restored. The one refusal that keeps the slots is "output was already
     signed": that slot really is taken, by another device holding this phrase,
     so the counter stays past it. */
  const countersAfterRefusal = (state, pending, detail) => {
    const reserved = pending.reserved;
    if (!reserved || /output was already signed/i.test(detail)) return state.counters;
    return { ...(state.counters || {}), [reserved.key]: reserved.before };
  };

  /* An import whose cards arrived but could not all be moved under this
     wallet's recovery phrase. The cards are in the wallet either way. */
  const notMoved = (error, imported) => Object.assign(
    new Error(`not yet moved under this wallet's recovery phrase: ${error.message}`),
    { imported, transient: Boolean(error.transient) },
  );

  async function finishPending(state, pending, response, c, keyset) {
    if (pending.type === "booster") {
      const outputs = pending.outputs.map((saved) => restoreOutput(saved, c));
      const proofs = outputs.map((output, index) => output.toProof({ ...response.signatures[index], amount: c.Amount.from(1) }, keyset));
      for (let i = 0; i < proofs.length; i += 1) {
        const tag = c.getTag(proofs[i].secret, "nutft");
        if (!tag || tag.length !== 5 || tag[0] !== "1" || tag[2] !== response.cards[i].asset_id || tag[4] !== response.cards[i].asset_binding || await binding(tag) !== tag[4] || !c.hasValidDleq(proofs[i], keyset, { require: true }) || proofs[i].amount.toString() !== "1" || !proofs[i].p2pk_e) {
          throw new Error(`wallet rejected issued proof ${i + 1}`);
        }
      }
      const token = encodeToken(c, { mint: pending.mintUrl, unit: response.unit, proofs });
      await write({ ...state, tokens: [...state.tokens, token], pending: null });
      return { ...response, token, proofs };
    }
    const all = readableProofs(state, keyset, c);
    const index = all.findIndex((proof) => proof.secret === pending.input_secret);
    if (index < 0) throw new Error("pending transfer input is no longer in this wallet");
    const output = restoreOutput(pending.outputs[0], c);
    const proof = output.toProof({ ...response.signature, amount: c.Amount.from(1) }, keyset);
    const oldTag = c.getTag(all[index].secret, "nutft");
    const newTag = c.getTag(proof.secret, "nutft");
    if (!newTag || newTag[4] !== oldTag[4] || !proof.p2pk_e || !c.hasValidDleq(proof, keyset, { require: true })) throw new Error("wallet rejected replacement proof");
    const remaining = all.filter((_, itemIndex) => itemIndex !== index);
    /* CARRY THE UNREADABLE TOKENS THROUGH. This line rebuilds the whole token
       list out of the proofs it could read, so anything it could not read would
       be dropped on the floor by a write it never mentioned. That did not
       matter while an unreadable token threw; it matters now that one is
       tolerated, because those tokens are the only record a person has of cards
       bought from a mint this one cannot open. Losing them silently, during a
       trade of an unrelated card, would be the worst kind of data loss: quiet,
       and triggered by something that looked unrelated. */
    const { opaque } = splitTokens(state, keyset, c);
    const rebuilt = remaining.length
      ? [encodeToken(c, { mint: pending.mintUrl, unit: response.unit, proofs: remaining })]
      : [];
    const token = encodeToken(c, { mint: pending.mintUrl, unit: response.unit, proofs: [proof] });
    if (pending.toSelf) {
      /* A card moved under this wallet's own recovery phrase stays in this
         wallet. It is not a hand-off, whichever call happens to finish it, and
         it is no longer a card the phrase cannot find. */
      await write({
        ...state, tokens: [...rebuilt, token, ...opaque], pending: null,
        ...(state.unmoved ? { unmoved: state.unmoved.filter((entry) => entry.secret !== pending.input_secret) } : {}),
      });
      return { ...response, token, proof };
    }
    /* PERSIST THE OUTGOING TOKEN. It is the only thing that can ever claim this
       card: the sender no longer holds it, the recipient does not have it yet,
       and it is locked to a key only the recipient has. Returning it and writing
       nothing meant the single copy lived in whatever variable the caller kept —
       so a reload, a closed tab or a crash between the trade and the hand-off
       destroyed the card outright. Nobody could claim it, ever. That is not a
       hypothetical: it happened to a card during development.
       Kept until the sender says it was delivered. They are a few hundred bytes
       each, and an undelivered transfer nobody can find is the worse trade. */
    const outgoing = [
      { token, asset_id: response.asset_id || null, at: new Date().toISOString() },
      ...(Array.isArray(state.outgoing) ? state.outgoing : []),
    ];
    await write({ ...state, tokens: [...rebuilt, ...opaque], outgoing, pending: null });
    return { ...response, token, proof };
  }

  /* "not settled yet" is not a rejection, it is a wait. Treating it as one was
     dangerous: the pending outputs were discarded, and a buyer who then paid had
     nothing left to claim with — their sats gone and no way to ask again. */
  const AWAITING_PAYMENT = /not settled yet|is still sealed|not mined yet|cannot confirm payment right now|cannot read the chain right now/i;

  /* The verdicts that end a claim somebody paid for. Anything else -- an answer
     this wallet does not recognise -- keeps the claim and its payment hash, since
     without them a paid invoice can never be collected by this wallet again. */
  const CLAIM_IS_OVER = /purchase expired|already claimed|already been claimed|stale booster quote|does not take committed purchases|unknown payment_hash|unknown purchase_id|quoted for a different pack|already taken its allocation/i;

  async function submitPending(state, c, keyset) {
    let pending = state.pending;
    if (pending.type === "booster" && !pending.outputs.length && pending.body.purchase_id) {
      const response = await postSigned(`${pending.mintUrl}/nutft/purchase`, {
        purchase_id: pending.body.purchase_id, pack_id: pending.body.pack_id, state: pending.body.state,
        ...(pending.body.payment_hash ? { payment_hash: pending.body.payment_hash } : {}),
      });
      if (!response.ok) {
        const detail = response.detail || `purchase unavailable (${response.status})`;
        if (AWAITING_PAYMENT.test(detail)) {
          const wait = new Error(detail);
          wait.awaitingPayment = true;
          throw wait;
        }
        /* Nothing was committed on a stale quote; anything else may have been,
           so the pending record stays for a retry under the same purchase_id. */
        if (/stale booster quote/i.test(detail)) await write({ ...state, pending: null });
        throw new Error(detail);
      }
      const receipt = await response.json();
      if (receipt.status === "sealed" || !Array.isArray(receipt.cards)) {
        const wait = new Error(receipt.note || "the pack is still sealed");
        wait.awaitingPayment = true;
        throw wait;
      }
      if (receipt.purchase_id !== pending.body.purchase_id || receipt.status !== "purchased") throw new Error("invalid purchase receipt");
      const prepared = await outputsFor(receipt.cards, pending.mintUrl, state, c, keyset);
      const outputs = prepared.outputs.map(savedOutput);
      const reserved = reservation(state, pending.mintUrl, keyset, prepared.counters);
      pending = { ...pending, outputs, reserved, body: { ...pending.body, pack_id: receipt.pack_id, state: receipt.state, outputs: outputs.map(requestOutput) } };
      state = { ...state, counters: prepared.counters, pending };
      await write(state);
    }
    if (pending.type === "booster" && !pending.outputs.length && pending.body.payment_hash) {
      const response = await mintFetch(`${pending.mintUrl}/nutft/reveal?payment_hash=${encodeURIComponent(pending.body.payment_hash)}`);
      if (!response.ok) throw new Error(`sealed booster unavailable (${response.status})`);
      const opened = await response.json();
      if (!Array.isArray(opened.cards)) {
        const wait = new Error(opened.note || "the booster is still sealed");
        wait.awaitingPayment = true;
        throw wait;
      }
      const prepared = await outputsFor(opened.cards, pending.mintUrl, state, c, keyset);
      const outputs = prepared.outputs.map(savedOutput);
      const reserved = reservation(state, pending.mintUrl, keyset, prepared.counters);
      pending = { ...pending, outputs, reserved, body: { ...pending.body, pack_id: opened.pack_id, state: opened.state, outputs: outputs.map(requestOutput) } };
      state = { ...state, counters: prepared.counters, pending };
      await write(state);
    }
    const path = pending.type === "booster" ? "/nutft/booster" : "/nutft/trade";
    /* Signed only if the mint refuses without one, and retried BEFORE the
       pending is discarded below — an early-access refusal must never cost a
       buyer their outputs, least of all on a mint they have already paid. */
    const response = await postSigned(`${pending.mintUrl}${path}`, pending.body);
    if (!response.ok) {
      const detail = response.detail || `mint refused ${pending.type} (${response.status})`;
      if (AWAITING_PAYMENT.test(detail)) {
        /* Keep the pending exactly as it is. The same outputs must be resubmitted
           once the invoice settles, and the idempotency key makes that safe. */
        const wait = new Error(detail);
        wait.awaitingPayment = true;
        throw wait;
      }
      /* A committed purchase or a paid invoice still owns its cards: only a
         final verdict from the mint drops that pending record. A free booster or
         a transfer the mint refused never happened, so it is dropped. */
      const paidFor = Boolean(pending.body.purchase_id || pending.body.payment_hash);
      if (!paidFor || CLAIM_IS_OVER.test(detail)) {
        await write({ ...state, counters: countersAfterRefusal(state, pending, detail), pending: null });
      }
      throw new Error(detail);
    }
    return finishPending(state, pending, await response.json(), c, keyset);
  }

  async function recoverPending() {
    const state = await read();
    if (!state.pending) return null;
    const c = await cashu();
    return submitPending(state, c, await getKeyset(state.pending.mintUrl, c));
  }

  /* Resubmit until the mint stops saying "not yet". The mint is the authority on
     settlement, so there is nothing else to ask and no state to guess at. */
  async function awaitSettlement(state, c, keyset, opts) {
    const deadline = Date.now() + Number(opts.timeoutMs || 900_000);
    let delay = 1500;
    for (;;) {
      try {
        return await submitPending(state, c, keyset);
      } catch (error) {
        /* A busy mint is waited out exactly like an unpaid invoice: the pending
           is untouched, and the next poll sends the same request again. */
        if (!error.awaitingPayment && !error.transient) throw error;
        if (Date.now() > deadline) {
          /* The pending survives on purpose: the invoice may still settle, and
             recoverPending() can finish the sale later. */
          if (error.transient) {
            throw new Error(
              `${error.message} — the booster is still pending; reopen the shop to finish it`,
            );
          }
          throw new Error("the invoice was not paid in time — reopen the shop to finish this booster");
        }
        if (typeof opts.onWaiting === "function") opts.onWaiting();
        const wait = error.transient
          ? Math.min(BUSY_WAIT_CAP_MS, Math.max(delay, error.retryAfterMs || 0))
          : delay;
        await new Promise((done) => setTimeout(done, wait));
        delay = Math.min(delay * 1.4, 8000);
      }
    }
  }

  /* NIP-98: prove to the mint that we hold a key it will recognise.
   *
   * Only used when the mint refuses an anonymous request — see requestQuote.
   * Signing every purchase would pop the extension on every booster and hand
   * the mint an identity it does not need for an open sale. Early access is the
   * one case where the mint genuinely has to know who is asking. */
  async function nip98Header(url, method) {
    const signer = root.nostr;
    if (!signer || typeof signer.signEvent !== "function") return null;
    const unsigned = {
      kind: 27235,
      created_at: Math.floor(Date.now() / 1000),
      content: "",
      tags: [["u", url], ["method", method]],
    };
    const signed = await signer.signEvent(unsigned);
    if (!signed || !signed.sig) return null;
    /* THE PAGE MUST NOT SAY "signed out" WHILE ACTING AS YOU.
     *
     * The signer is read straight off the extension, deliberately — that is what
     * NIP-98 needs. But the site keeps its own idea of who is signed in under
     * 600b:pubkey, and the two came apart: after a sign-out the nav chip read
     * "Sign in with Nostr", the shop offered to sign you in, and pressing Buy
     * still completed a purchase under the extension's key. Nothing silent
     * happened — the extension asks — but the page claimed one thing and did
     * another, and on a one-per-key mint that spends somebody's allocation
     * under a name the page never showed.
     *
     * So the key that just signed is adopted. Whoever bought is now who the
     * page says bought. Wrapped because storage can refuse in private mode, and
     * a purchase must not fail over a display detail. */
    try {
      if (/^[0-9a-f]{64}$/i.test(signed.pubkey || "")) {
        await store.setItem("600b:pubkey", signed.pubkey);
      }
    } catch (error) { /* private mode: the sale still stands */ }
    /* btoa is byte-wise; a non-ASCII byte anywhere in the event would throw.
       Encode as UTF-8 first so the header survives any content the signer adds. */
    const bytes = new TextEncoder().encode(JSON.stringify(signed));
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return `Nostr ${root.btoa(binary)}`;
  }

  /* Ask for a quote anonymously, and only reach for the signer if the mint says
     this is an early-access sale. The mint's own words are carried through on
     failure: "this key is not on the list yet" tells a buyer what to do, where
     a bare 403 tells them nothing. */
  async function requestQuote(mintUrl) {
    const target = new URL(`${mintUrl}/nutft/quote`, root.location ? root.location.href : undefined).href;
    const read = async (response) => {
      if (response.ok) return { quote: await response.json() };
      let reason = `booster quote unavailable (${response.status})`;
      try {
        const body = await response.json();
        if (body && body.error) reason = body.error;
      } catch { /* not JSON: keep the status line */ }
      return { reason };
    };

    let attempt = await read(await fetch(target));
    if (attempt.quote) return attempt.quote;

    if (/early access/i.test(attempt.reason)) {
      let header = null;
      let declined = false;
      try { header = await nip98Header(target, "GET"); } catch { declined = true; }
      if (!header) throw new Error(earlyAccessAdvice(attempt.reason, declined));
      attempt = await read(await fetch(target, { headers: { Authorization: header } }));
      if (attempt.quote) return attempt.quote;
    }
    throw new Error(attempt.reason);
  }

  /* NOT NOW IS NOT NO. Only a 4xx other than 429 is the mint's verdict on a
     request. A 429 (the referee's rate limit), any 5xx whatever its body, or no
     answer at all says nothing about whether the mint acted: a proxy can answer
     504 {"error": ...} after the mint has already committed a trade. None of
     them may reach refusal() below, the road on which a pending claim or
     transfer gets discarded. mintFetch throws this instead, every caller keeps
     what it holds, and the same request is sent again later, which the mint
     either carries out or answers by replaying what it already committed. */
  const isVerdict = (status) => status >= 400 && status < 500 && status !== 429;
  const BUSY_WAIT_CAP_MS = 30_000;
  const BUSY_ATTEMPTS = 8;

  function busyMint(message, retryAfterMs) {
    const error = new Error(message);
    error.transient = true;
    error.retryAfterMs = retryAfterMs;
    return error;
  }

  async function mintFetch(url, init) {
    let response;
    try { response = await fetch(url, init); }
    catch (error) { throw busyMint(`the mint could not be reached (${error.message})`, null); }
    if (response.ok || isVerdict(response.status)) return response;
    const header = response.headers && response.headers.get("retry-after");
    const seconds = header ? Number(header) : NaN;
    const message = response.status === 429
      ? "the mint is busy (429)"
      : `the mint could not answer (${response.status})`;
    throw busyMint(message, Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : null);
  }

  /* Restore and checkstate change nothing on the mint, so a busy answer is
     asked again: never sooner than retry-after, never more than 30 s at a time,
     and at most BUSY_ATTEMPTS times, so a mint that stays down ends a recovery
     with an error rather than a page that waits forever. Each wait goes to
     opts.onWaiting, the same status path a booster purchase reports through. */
  async function patientFetch(url, init, opts) {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await mintFetch(url, init);
      } catch (error) {
        if (!error.transient || attempt >= BUSY_ATTEMPTS) throw error;
        const backoff = 1000 * 2 ** (attempt - 1);
        const waitMs = Math.min(BUSY_WAIT_CAP_MS, Math.max(backoff, error.retryAfterMs || 0));
        if (typeof opts.onWaiting === "function") {
          opts.onWaiting({ attempt, waitMs, reason: error.message });
        }
        await new Promise((done) => setTimeout(done, waitMs));
      }
    }
  }

  /* Whether the mint already holds a signature for this output. Restore answers
     for exactly the outputs it has signed, and changes nothing. */
  async function slotSigned(mintUrl, output) {
    const { id, B_ } = output.blindedMessage;
    const response = await patientFetch(`${mintUrl}/v1/restore`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ outputs: [{ amount: 1, id, B_ }] }),
    }, {});
    if (!response.ok) throw new Error(`the mint could not check this card's slot (${response.status})`);
    const restored = await response.json();
    return Array.isArray(restored.outputs) && restored.outputs.some((item) => item.B_ === B_);
  }

  /* Read the mint's own refusal out of a failed response -- or THROW, because
     anything that is not the mint refusing must not be treated as one.
   *
   * submitPending discards the pending on a refusal, since a refusal means
   * those outputs will never be signed. A proxy's HTML 502, a captive-portal
   * page or a truncated body is NOT a refusal: the mint may well have accepted,
   * and on a trade the input proof is already spent, so the outputs have to
   * survive for a retry under the same idempotency key.
   *
   * Found twice independently -- once here, once in review -- which is the best
   * evidence a bug of this shape gets. */
  async function refusal(response) {
    let body;
    try { body = await response.json(); }
    catch {
      /* A proxy's HTML 502 is not the mint refusing the request. Keep the
         pending bearer outputs so the same idempotent request can be retried. */
      throw new Error(`mint gateway returned a non-JSON error (${response.status}); request preserved for retry`);
    }
    if (!body || typeof body.error !== "string" || !body.error) {
      throw new Error(`mint returned an invalid error response (${response.status}); request preserved for retry`);
    }
    return body.error;
  }

  /* POST a body, and if the mint answers "early access", sign a NIP-98 proof
     and send it once more. The mint's own words are carried through: they tell a
     buyer whether to install an extension, switch keys, or simply wait. */
  async function postSigned(target, body) {
    const url = new URL(target, root.location ? root.location.href : undefined).href;
    const send = (header) => mintFetch(url, {
      method: "POST",
      headers: header
        ? { "content-type": "application/json", Authorization: header }
        : { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    const first = await send(null);
    if (first.ok) return first;
    const detail = await refusal(first);
    if (!/early access/i.test(detail)) return { ok: false, status: first.status, detail };

    let header = null;
    let declined = false;
    try { header = await nip98Header(url, "POST"); } catch { declined = true; }
    if (!header) {
      return { ok: false, status: first.status, detail: earlyAccessAdvice(detail, declined) };
    }
    const second = await send(header);
    if (second.ok) return second;
    return { ok: false, status: second.status, detail: await refusal(second) };
  }

  /* Telling someone to install what they already have is worse than saying
     nothing, so a declined prompt gets its own sentence. */
  const earlyAccessAdvice = (detail, declined) => {
    if (/any nostr key|no allowlist/i.test(detail)) {
      const action = declined
        ? "your NIP-07 signer did not sign the request"
        : "add or unlock a NIP-07 signer (Alby or nos2x), then press Buy again";
      return `early access: ${action}. Any nostr key works here — there is no allowlist. `
        + "Checkout stopped before Lightning; no invoice was created.";
    }
    if (declined) {
      return "early access: your nostr extension did not sign the request — the signature is "
        + "what proves your key is on the list, so the sale cannot go ahead without it";
    }
    return /sign the request/i.test(detail)
      ? "early access: this sale is open to a few keys first — install a nostr extension "
        + "and sign in with a key that is on the list"
      : detail;
  };

  async function buyBoosterUnlocked(mintUrl, opts = {}) {
    const c = await cashu();
    let state = await identity(c);
    /* REFUSED BEFORE ANYTHING EXISTS. A purchase needs counter slots for its
       cards, and a half-finished recovery cannot hand any out. Checked here,
       before a quote, an invoice or a pending record: refusing only when the
       receipt arrives left a purchase committed at the mint and a claim this
       wallet could neither finish nor get past. */
    if (state.restoring) throw new Error(RECOVERY_UNFINISHED);
    if (state.pending) {
      const keysetForPending = await getKeyset(state.pending.mintUrl, c);
      return awaitSettlement(state, c, keysetForPending, opts);
    }
    const keyset = await getKeyset(mintUrl, c);
    const quote = await requestQuote(mintUrl);
    const prepared = Array.isArray(quote.cards) ? await outputsFor(quote.cards, mintUrl, state, c, keyset) : { outputs: [], counters: state.counters || {} };
    const saved = prepared.outputs.map(savedOutput);
    /* Purchase mode: the quote withholds the cards, so the wallet commits with
       its own purchase_id first (see submitPending) and builds the outputs from
       the receipt. The same id is the claim's idempotency key. */
    const purchaseId = quote.purchase_required ? hex(root.crypto.getRandomValues(new Uint8Array(32))) : null;
    const reserved = reservation(state, mintUrl, keyset, prepared.counters);
    const pending = { type: "booster", mintUrl, outputs: saved, reserved, body: {
      idempotency_key: purchaseId || root.crypto.randomUUID(),
      ...(purchaseId ? { purchase_id: purchaseId } : {}),
      pack_id: quote.pack_id,
      state: quote.state,
      /* Absent on a free mint, required on a paid one. Carried inside the
         pending so a resumed sale claims the invoice it was quoted against. */
      payment_hash: quote.payment_hash,
      outputs: saved.map(requestOutput),
    } };
    state = { ...state, counters: prepared.counters, pending };
    await write(state);
    /* A paid mint hands back an invoice the buyer settles in their own wallet.
       Show it, then wait — nothing here ever touches their credentials. */
    if (quote.paid && quote.payment_request && typeof opts.onInvoice === "function") {
      opts.onInvoice({
        paymentRequest: quote.payment_request,
        paymentHash: quote.payment_hash,
        priceMsat: quote.price_msat,
        testMint: Boolean(quote.test_mint),
      });
    }
    return awaitSettlement(state, c, keyset, opts);
  }

  const buyBooster = (mintUrl, opts) => locked(() => buyBoosterUnlocked(mintUrl, opts || {}));

  /* Decode PER TOKEN, and survive one that cannot be decoded.
   *
   * This used to be a bare flatMap over getDecodedToken, so a single token this
   * mint cannot read threw and took the WHOLE wallet with it. That is not a
   * rare state: a token minted before a mint's keyset rotated, or one bought
   * from a different mint entirely — staging, say — can never decode against
   * this keyset, ever. One of those made snapshot() throw, which blanked the
   * wallet page, permanently dropped the Stack Builder out of OG mode, and made
   * every trade impossible. The only escape was clearing storage, which throws
   * away every good card along with the bad one.
   *
   * A card this mint cannot read is not the same as a card that does not exist.
   * The unreadable ones are counted and handed back so the page can say how
   * many there are and where they probably came from, instead of a wallet full
   * of cards silently reporting nothing at all. */
  async function claimBoosterUnlocked(mintUrl, paymentHash, opts = {}) {
    const c = await cashu();
    let state = await identity(c);
    if (state.restoring) throw new Error(RECOVERY_UNFINISHED);
    if (state.pending) {
      if (state.pending.body.payment_hash !== paymentHash) throw new Error("finish the pending wallet operation before claiming another booster");
      return awaitSettlement(state, c, await getKeyset(state.pending.mintUrl, c), opts);
    }
    const keyset = await getKeyset(mintUrl, c);
    const pending = { type: "booster", mintUrl, outputs: [], body: {
      idempotency_key: root.crypto.randomUUID(), pack_id: null, state: null,
      payment_hash: paymentHash, outputs: [],
    } };
    state = { ...state, pending };
    await write(state);
    return awaitSettlement(state, c, keyset, opts);
  }

  const claimBooster = (mintUrl, paymentHash, opts) => locked(() => claimBoosterUnlocked(mintUrl, paymentHash, opts || {}));

  async function decodeTokens(mintUrl) {
    const c = await cashu();
    const state = await read();
    const keyset = await getKeyset(mintUrl, c);
    const list = [];
    const unreadable = [];
    for (const token of state.tokens) {
      try {
        list.push(...c.getDecodedToken(token, [keyset.id]).proofs);
      } catch (error) {
        unreadable.push({ token, error: error && error.message ? error.message : String(error) });
      }
    }
    return { proofs: list, unreadable };
  }

  async function proofs(mintUrl) {
    return (await decodeTokens(mintUrl)).proofs;
  }

  /* The synchronous half of the same rule, for the paths that already hold a
     state and a keyset.
   *
   * Every one of these asks "what does this wallet hold", and every one of them
   * used its own bare flatMap. Fixing only decodeTokens left the TRADE path
   * still throwing on a dead token — which is the worst place for it, because a
   * trade is the operation a person reaches for to move a card OUT of a wallet
   * they cannot otherwise use. It was found by trying a trade with one dead
   * token in storage, not by reading the code. */
  function splitTokens(state, keyset, c) {
    const proofs = [];
    const opaque = [];
    for (const token of state.tokens) {
      try { proofs.push(...c.getDecodedToken(token, [keyset.id]).proofs); }
      catch { opaque.push(token); }
    }
    return { proofs, opaque };
  }

  const readableProofs = (state, keyset, c) => splitTokens(state, keyset, c).proofs;

  /* Catalogs are public, signed and immutable for an edition. Keeping them next
   * to the wallet avoids downloading hundreds of card records on every visit.
   * A cached catalog is never trusted because it came from localStorage: its
   * signature is checked again against the issuer advertised by the live mint.
   * Bearer proofs and proof states are deliberately not copied into this cache. */
  async function readCatalogCache() {
    try {
      const parsed = JSON.parse((await store.getItem(CATALOG_CACHE)) || "null");
      if (parsed?.version === CATALOG_CACHE_VERSION && parsed.catalogs
          && typeof parsed.catalogs === "object" && !Array.isArray(parsed.catalogs)) {
        return parsed;
      }
    } catch { /* a cache is disposable; the bearer wallet above is not */ }
    return { version: CATALOG_CACHE_VERSION, catalogs: {} };
  }

  async function storeCatalog(catalogUri, catalog) {
    try {
      const cache = await readCatalogCache();
      cache.catalogs[catalogUri] = { cachedAt: Date.now(), catalog };
      await store.setItem(CATALOG_CACHE, JSON.stringify(cache));
    } catch { /* private mode or a full quota only makes the next load cold */ }
  }

  async function verifyCatalog(catalogUri, catalog, c, keyset) {
    const { issuer_pubkey: issuer, signature, ...payload } = catalog || {};
    const digestHex = await digest(canonical(payload));
    if (!catalog || catalog.collection_id !== keyset.unit || catalog.catalog_uri !== catalogUri
        || issuer !== keyset.catalogIssuer || !signature
        || (keyset.catalogDigest && keyset.catalogDigest !== digestHex)
        || !c.schnorrVerifyDigest(signature, digestHex, issuer)) {
      throw new Error("catalog signature or collection validation failed");
    }
    return catalog;
  }

  async function digestBytes(bytes) {
    const hash = new Uint8Array(await root.crypto.subtle.digest("SHA-256", bytes));
    return Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  /* The catalog is a content-addressed blob first and a URL second. When the
     mint advertises the blob hash, the wallet tries the mint's own /blossom
     path and the advertised mirrors, and accepts bytes only if they hash to
     the advertised value; verifyCatalog still checks the signature after.
     A missing or tampered blob falls back to the catalog URL from the tag. */
  async function fetchCatalog(catalogUri, keyset) {
    const blob = keyset.catalogBlob;
    if (blob) {
      for (const url of blob.urls) {
        try {
          const response = await fetch(url);
          if (!response.ok) continue;
          const bytes = new Uint8Array(await response.arrayBuffer());
          if (await digestBytes(bytes) !== blob.sha256) continue;
          return JSON.parse(new TextDecoder().decode(bytes));
        } catch { /* the next mirror, then the catalog URL */ }
      }
    }
    const response = await fetch(catalogUri);
    if (!response.ok) throw new Error(`catalog unavailable (${response.status})`);
    return response.json();
  }

  async function catalogFor(catalogUri, c, keyset, catalogs) {
    let catalog = catalogs.get(catalogUri);
    if (catalog) return catalog;
    const cached = (await readCatalogCache()).catalogs[catalogUri];
    if (cached && Number.isFinite(cached.cachedAt)
        && cached.cachedAt + CATALOG_CACHE_MAX_AGE_MS > Date.now()) {
      try {
        catalog = await verifyCatalog(catalogUri, cached.catalog, c, keyset);
      } catch { catalog = null; }
    }
    if (!catalog) {
      catalog = await verifyCatalog(catalogUri, await fetchCatalog(catalogUri, keyset), c, keyset);
      await storeCatalog(catalogUri, catalog);
    }
    catalogs.set(catalogUri, catalog);
    return catalog;
  }

  async function inspectProofStatic(proof, c, keyset, catalogs) {
    const parsed = JSON.parse(proof.secret);
    const tags = parsed?.[1]?.tags?.filter((tag) => Array.isArray(tag) && tag[0] === "nutft") || [];
    const tag = tags[0] && tags[0].slice(1);
    if (JSON.stringify(parsed) !== proof.secret || tags.length !== 1 || !tag || tag.length !== 5 || tag[0] !== "1" || proof.id !== keyset.id || proof.amount.toString() !== "1" || !proof.p2pk_e || !c.hasValidDleq(proof, keyset, { require: true }) || await binding(tag) !== tag[4]) throw new Error("invalid NutFT proof");
    const catalog = await catalogFor(tag[3], c, keyset, catalogs);
    const asset = catalog.assets.find((card) => card.asset_id === tag[2]);
    if (!asset || asset.asset_binding !== tag[4]) throw new Error(`catalog has no verified asset ${tag[2]}`);
    return {
      proof,
      tag,
      asset,
      Y: c.hashToCurve(new TextEncoder().encode(proof.secret)).toHex(true),
    };
  }

  async function withProofStates(mintUrl, items) {
    if (!items.length) return [];
    const checked = [];
    /* The mint deliberately caps one request at 256 curve points. A large E1
     * collection still loads in batches instead of regressing to one request per
     * card once it grows past that line. */
    for (let offset = 0; offset < items.length; offset += 256) {
      const batch = items.slice(offset, offset + 256);
      const response = await fetch(`${mintUrl}/v1/checkstate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ Ys: batch.map((item) => item.Y) }),
      });
      if (!response.ok) throw new Error(`proof state unavailable (${response.status})`);
      const payload = await response.json();
      if (!Array.isArray(payload.states) || payload.states.length !== batch.length) {
        throw new Error("proof state response has the wrong length");
      }
      checked.push(...batch.map((item, index) => {
        const answer = payload.states[index];
        if (!answer || answer.Y !== item.Y || !["UNSPENT", "SPENT"].includes(answer.state)) {
          throw new Error("proof state response does not match the request");
        }
        const { Y, ...owned } = item;
        return { ...owned, state: answer.state };
      }));
    }
    return checked;
  }

  async function inspectProof(mintUrl, proof, c, keyset, catalogs) {
    const item = await inspectProofStatic(proof, c, keyset, catalogs);
    return (await withProofStates(mintUrl, [item]))[0];
  }

  async function snapshot(mintUrl) {
    /* A pending the mint refuses must not hide the cards that are fine. This ran
       uncaught, so one stuck transfer threw before a single proof was inspected
       and the whole collection vanished behind an error — the same shape as the
       unreadable-token bug, one level up. The recovery is still attempted, and
       the page has its own route to retry it. */
    try { await locked(recoverPending); } catch { /* reported by recoverPending's own caller */ }
    try { await locked(() => retryMovesUnlocked([mintUrl])); } catch { /* still listed in `unrestorable` */ }
    return snapshotReadOnly(mintUrl);
  }

  /* The held cards the recovery phrase cannot find yet, from the stored list.
     Keyed by mint as well as secret, since the list spans editions. */
  const unrestorableIn = (walletState, owned) => {
    const listed = new Set((walletState.unmoved || []).map((entry) => `${entry.mint}\n${entry.secret}`));
    return owned.filter((item) => listed.has(`${item.mintUrl}\n${item.proof.secret}`));
  };

  /* COUNTING ONLY READS. snapshot() and snapshotMany() finish an unfinished
     booster or transfer before they count, which is right for the wallet page
     and wrong for anything that only wants a number: a count taken in one tab
     could send, retry or rewrite a pending record that another tab began a
     moment earlier. These read the wallet once, ask the mint about its proofs,
     and never touch a pending record. A card whose transfer is unfinished
     counts as spent until the wallet page finishes it. */
  async function snapshotReadOnly(mintUrl) {
    const c = await cashu();
    const walletState = await read();
    const keyset = await getKeyset(mintUrl, c);
    const catalogs = new Map();
    const owned = [];
    const spent = [];
    const invalid = [];
    const { proofs: readable, unreadable } = await decodeTokens(mintUrl);
    const candidates = [];
    for (const proof of readable) {
      try {
        const item = await inspectProofStatic(proof, c, keyset, catalogs);
        if (!c.maybeDeriveP2BKPrivateKeys(walletState.privateKey, proof).length) throw new Error("proof is not addressed to this wallet");
        candidates.push(item);
      } catch (error) {
        invalid.push({ proof, error: error.message });
      }
    }
    try {
      for (const item of await withProofStates(mintUrl, candidates)) {
        (item.state === "SPENT" ? spent : owned).push(item);
      }
    } catch (error) {
      for (const item of candidates) invalid.push({ proof: item.proof, error: error.message });
    }
    /* `unreadable` is deliberately its own bucket and not folded into
       `invalid`: an invalid proof is one this mint HAS an opinion about and
       rejects, while an unreadable token is one it cannot even open. A page
       that conflates them tells a buyer their card is bad when the truth is
       that they are looking at the wrong mint. */
    /* `unrestorable`: owned cards not yet moved under the recovery phrase. The
       wallet keeps trying on every refresh; until then only a backup file or
       this device holds them. */
    const unrestorable = unrestorableIn(walletState, owned.map((item) => ({ ...item, mintUrl })));
    return { catalog: catalogs.values().next().value || null, owned, spent, invalid, unreadable, unrestorable };
  }

  /* One browser wallet may hold E1 boosters and G starter sets at the same
   * time. A token that one mint cannot decode is not unreadable until every
   * supported mint has had a chance: otherwise every valid G set appears as a
   * dead foreign token on the E1 wallet page (and vice versa). */
  async function snapshotMany(mintUrls) {
    try { await locked(recoverPending); } catch { /* the recovery panel owns this error */ }
    try {
      await locked(() => retryMovesUnlocked([...new Set((mintUrls || []).map(String))]));
    } catch { /* still listed in `unrestorable` */ }
    return snapshotManyReadOnly(mintUrls);
  }

  async function snapshotManyReadOnly(mintUrls) {
    const c = await cashu();
    const walletState = await read();
    const descriptors = [];
    const unavailable = [];
    const uniqueMints = [...new Set((mintUrls || []).map(String))];
    const discovered = await Promise.all(uniqueMints.map(async (mintUrl) => {
      try { return { mintUrl, keyset: await getKeyset(mintUrl, c) }; }
      catch (error) { return { mintUrl, error: error.message }; }
    }));
    for (const descriptor of discovered) {
      if (descriptor.keyset) descriptors.push(descriptor);
      else unavailable.push({ mintUrl: descriptor.mintUrl, error: descriptor.error });
    }
    if (!descriptors.length) throw new Error("no NutFT mint is reachable");

    const catalogs = new Map();
    const owned = [];
    const spent = [];
    const invalid = [];
    const unreadable = [];
    const candidates = new Map(descriptors.map((descriptor) => [descriptor.mintUrl, []]));
    for (const token of walletState.tokens) {
      let match = null;
      let decoded = null;
      let lastError = null;
      for (const descriptor of descriptors) {
        try {
          const candidate = c.getDecodedToken(token, [descriptor.keyset.id]);
          if (candidate.mint !== descriptor.mintUrl || candidate.unit !== descriptor.keyset.unit) continue;
          match = descriptor;
          decoded = candidate;
          break;
        } catch (error) { lastError = error; }
      }
      if (!match) {
        unreadable.push({
          token,
          error: lastError && lastError.message ? lastError.message : "no supported mint recognises this token",
        });
        continue;
      }
      for (const proof of decoded.proofs) {
        try {
          const item = await inspectProofStatic(proof, c, match.keyset, catalogs);
          if (!c.maybeDeriveP2BKPrivateKeys(walletState.privateKey, proof).length) {
            throw new Error("proof is not addressed to this wallet");
          }
          candidates.get(match.mintUrl).push(item);
        } catch (error) {
          invalid.push({ proof, mintUrl: match.mintUrl, error: error.message });
        }
      }
    }
    await Promise.all(descriptors.map(async (descriptor) => {
      const pending = candidates.get(descriptor.mintUrl);
      try {
        for (const item of await withProofStates(descriptor.mintUrl, pending)) {
          const withMint = { ...item, mintUrl: descriptor.mintUrl, unit: descriptor.keyset.unit };
          (item.state === "SPENT" ? spent : owned).push(withMint);
        }
      } catch (error) {
        for (const item of pending) {
          invalid.push({ proof: item.proof, mintUrl: descriptor.mintUrl, error: error.message });
        }
      }
    }));
    const unrestorable = unrestorableIn(walletState, owned);
    return { catalogs: [...catalogs.values()], owned, spent, invalid, unreadable, unavailable, unrestorable };
  }

  async function tradeProofUnlocked(mintUrl, secret, recipientPubkey) {
    const c = await cashu();
    let state = await identity(c);
    /* REFUSE, do not silently finish something else. This used to call
       submitPending and hand back THAT token — so asking to send card X while an
       older transfer was unfinished completed the older trade and returned a
       token for card Y. The caller had every reason to believe it had just sent
       X. Finishing a pending is a deliberate act with its own entry point. */
    if (state.pending) {
      throw new Error("finish the transfer already in progress before starting another");
    }
    const keyset = await getKeyset(mintUrl, c);
    const all = readableProofs(state, keyset, c);
    const index = all.findIndex((proof) => proof.secret === secret);
    if (index < 0) throw new Error("card is not in this wallet");
    const oldProof = all[index];
    const keys = c.maybeDeriveP2BKPrivateKeys(state.privateKey, oldProof);
    if (!keys.length) throw new Error("wallet cannot derive the P2BK spending key");
    const signed = c.signP2PKProof(oldProof, keys[0]);
    const tag = c.getTag(oldProof.secret, "nutft");
    if (typeof recipientPubkey !== "string") throw new Error("recipient P2BK public key is required");
    c.pointFromHex(recipientPubkey);
    let output;
    let counters = state.counters || {};
    /* Moving a card under this wallet's own recovery phrase, as an import does. */
    const toSelf = Boolean(state.seedPhrase && recipientPubkey === state.pubkey);
    let reserved = null;
    if (toSelf) {
      const card = { collection_id: tag[1], asset_id: tag[2], catalog_uri: tag[3], asset_binding: tag[4] };
      let prepared = await outputsFor([card], mintUrl, state, c, keyset);
      /* ANOTHER DEVICE MAY HOLD THIS PHRASE. Counters live in one browser, so a
         laptop and a phone on the same phrase derive the same output for their
         next copy of a card, and the mint signs it only once: the second device
         was refused, and its card stayed where the phrase cannot find it. So ask
         first. A slot the mint has already signed belongs to the other device;
         step to this card's next slot, and on past every one already taken. */
      for (let taken = 0; await slotSigned(mintUrl, prepared.outputs[0]); taken += 1) {
        if (taken >= 64) throw new Error("every nearby slot for this card is already signed");
        prepared = await outputsFor([card], mintUrl, { ...state, counters: prepared.counters }, c, keyset);
      }
      [output] = prepared.outputs;
      counters = prepared.counters;
      reserved = reservation(state, mintUrl, keyset, counters);
    } else {
      output = c.OutputData.createSingleP2PKData({
        pubkey: recipientPubkey,
        blindKeys: true,
        additionalTags: [["nutft", ...tag]],
      }, 1, keyset.id);
    }
    const saved = savedOutput(output);
    const pending = { type: "trade", mintUrl, input_secret: oldProof.secret, outputs: [saved], ...(toSelf ? { toSelf, reserved } : {}), body: { idempotency_key: root.crypto.randomUUID(), inputs: c.serializeProofs([signed]), outputs: [requestOutput(saved)] } };
    state = { ...state, counters, pending };
    await write(state);
    return submitPending(state, c, keyset);
  }

  const tradeProof = (mintUrl, secret, recipientPubkey) => locked(() => tradeProofUnlocked(mintUrl, secret, recipientPubkey));

  /* A possession certificate: prove to a table or a tournament that this
     wallet holds specific unspent cards, without spending them. Each proof is
     authorized with the P2BK key it is locked to; the mint answers with a
     certificate signed by the catalog key. Nothing leaves the wallet but the
     proofs' public parts and the signatures. */
  async function provePossessionUnlocked(mintUrl, secrets, player, room) {
    const c = await cashu();
    const state = await identity(c);
    if (!Array.isArray(secrets) || !secrets.length || secrets.length > 64 || new Set(secrets).size !== secrets.length) {
      throw new Error("choose 1 to 64 distinct owned cards");
    }
    const all = await proofs(mintUrl);
    const inputs = secrets.map((secret) => {
      const proof = all.find((candidate) => candidate.secret === secret);
      if (!proof) throw new Error("card is not in this wallet");
      return proof;
    });
    const authorizations = inputs.map((proof) => {
      const keys = c.maybeDeriveP2BKPrivateKeys(state.privateKey, proof);
      if (!keys.length) throw new Error("card is not addressed to this wallet");
      return c.schnorrSignMessage(canonical({ domain: "NutFT-play-v1", player, room, secret: proof.secret }), keys[0]);
    });
    const response = await fetch(`${mintUrl}/nutft/possession`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ player, room, inputs: c.serializeProofs(inputs), authorizations }),
    });
    if (!response.ok) throw new Error(await refusal(response));
    return response.json();
  }
  const provePossession = (mintUrl, secrets, player, room) => locked(() => provePossessionUnlocked(mintUrl, secrets, player, room));

  async function destinationUnlocked() {
    const c = await cashu();
    return (await identity(c)).pubkey;
  }

  const destination = () => locked(destinationUnlocked);

  async function importTokenUnlocked(mintUrl, token) {
    const c = await cashu();
    let state = await identity(c);
    /* Refused whole, before the token is stored: a card accepted now could not
       be moved under the phrase until the recovery ends, and a token stored and
       then reported as refused is a card nobody knows the wallet holds. */
    if (state.restoring) throw new Error(RECOVERY_UNFINISHED);
    if (state.pending) await submitPending(state, c, await getKeyset(state.pending.mintUrl, c));
    state = await read();
    const keyset = await getKeyset(mintUrl, c);
    const decoded = c.getDecodedToken(token, [keyset.id]);
    if (decoded.mint !== mintUrl || decoded.unit !== keyset.unit || !decoded.proofs.length) {
      throw new Error("token mint, unit, or proofs are invalid");
    }
    /* The token being imported above may still throw — a caller pasting a
       broken token deserves to hear so. But the wallet it is landing in must
       not: a dead token already in storage cannot be allowed to block an
       import, or a person is stuck with it forever. */
    const existing = new Set(readableProofs(state, keyset, c).map((proof) => proof.secret));
    const incoming = new Set();
    const catalogs = new Map();
    for (const proof of decoded.proofs) {
      if (existing.has(proof.secret)) throw new Error("token is already in this wallet");
      if (incoming.has(proof.secret)) throw new Error("token contains a duplicate proof");
      incoming.add(proof.secret);
      const item = await inspectProof(mintUrl, proof, c, keyset, catalogs);
      if (item.state !== "UNSPENT" || !c.maybeDeriveP2BKPrivateKeys(state.privateKey, proof).length) throw new Error("token is spent or not addressed to this wallet");
    }
    /* Received proofs were made by the sender, so their random output material
       cannot be recovered from this wallet's NUT-13 seed. The token and the list
       of its cards still to be moved under the phrase are stored in one write;
       each card is then reissued to our own destination, and leaves the list
       only when that trade is done. The normal pending/outgoing records cover a
       lost response after the mint spends it. */
    const arriving = state.seedPhrase
      ? decoded.proofs.map((proof) => ({ mint: mintUrl, secret: proof.secret }))
      : [];
    await write({
      ...state, tokens: [...state.tokens, token],
      ...(arriving.length ? { unmoved: [...(state.unmoved || []), ...arriving] } : {}),
    });
    /* SAY SO. This loop used to break silently, so an import reported every card
       as received while the one that failed stayed under the sender's secret,
       where this wallet's recovery phrase can never find it. The cards are in
       the wallet either way; the caller hears which is not under the phrase yet,
       and every refresh tries again. */
    const failure = await moveUnderPhrase(arriving, state.pubkey);
    if (failure) throw notMoved(failure, decoded.proofs.length);
    return decoded.proofs.length;
  }

  /* MOVE CARDS UNDER THE PHRASE, one trade to this wallet's own key each.
     "output was already signed" means another device on the phrase took the
     slot between the probe and the trade; the counter now stands past it, so the
     card is tried again at once on a fresh slot. A card no longer held, or
     already spent, leaves the list. A busy mint, an unfinished recovery or a
     transfer in progress ends the round with the card still listed, and so does
     any other refusal, after the rest have had their turn. Returns the first
     failure, or null. */
  async function moveUnderPhrase(entries, pubkey) {
    let failure = null;
    for (const entry of entries) {
      for (let attempt = 1; ; attempt += 1) {
        try {
          await tradeProofUnlocked(entry.mint, entry.secret, pubkey);
          break;
        } catch (error) {
          if (/card is not in this wallet|already spent/i.test(error.message)) {
            const current = await read();
            await write({ ...current, unmoved: (current.unmoved || []).filter((item) => item.secret !== entry.secret) });
            break;
          }
          if (/output was already signed/i.test(error.message) && attempt < 3) continue;
          failure = failure || error;
          if (error.transient || error.message === RECOVERY_UNFINISHED || /transfer already in progress/.test(error.message)) {
            return failure;
          }
          break;
        }
      }
    }
    return failure;
  }

  /* Every refresh gives the cards not yet under the phrase another try. */
  async function retryMovesUnlocked(mintUrls) {
    const state = await read();
    if (!state.seedPhrase || state.restoring || state.pending) return;
    const entries = (state.unmoved || []).filter((entry) => !mintUrls || mintUrls.includes(entry.mint));
    if (entries.length) await moveUnderPhrase(entries, state.pubkey);
  }

  const importToken = (mintUrl, token) => locked(() => importTokenUnlocked(mintUrl, token));

  async function recoveryPhraseUnlocked() {
    const c = await cashu();
    const phrase = (await identity(c)).seedPhrase;
    if (!phrase) throw new Error("this wallet predates recovery phrases; keep using its backup file");
    return phrase;
  }

  const recoveryPhrase = () => locked(recoveryPhraseUnlocked);

  async function restoreSeedUnlocked(mintUrl, phrase, opts = {}) {
    const current = await read();
    const wc = await walletCrypto();
    const seedPhrase = String(phrase || "").trim().toLowerCase().replace(/\s+/g, " ");
    if (!wc.validateMnemonic(seedPhrase, wc.wordlist)) throw new Error("recovery phrase is not a valid 12-word BIP39 phrase");
    const c = await cashu();
    const keyset = await getKeyset(mintUrl, c);
    const key = counterKey(mintUrl, keyset.id);
    /* PICK UP WHERE THE LAST ATTEMPT STOPPED. Recovery writes its progress after
       every batch, so an attempt cut off by a mint that stays busy or a closed
       tab is resumed from its checkpoint: never restarted from slot 0, and never
       refused as a wallet that already holds the cards it found. */
    /* A claim left waiting for its receipt does not stop a resume: it holds no
       slots, and it can only be finished once the scan has shown which slots the
       phrase already filled. Finishing it first would hand out slots blind. */
    const resuming = Boolean(current.restoring && current.restoring.key === key
      && current.seedPhrase === seedPhrase && holdsNoSlots(current.pending));
    /* SEARCHING FURTHER. A wallet from before refused operations handed their
       slots back can hold an unsigned run longer than the normal window, and a
       recovery stops there with cards still beyond it. A deep scan (a larger
       gapSlots) on a wallet already holding this phrase continues from the
       wallet's own counter rather than from slot 0, keeps every card it holds,
       and adds only cards it does not. */
    const deeper = !resuming && Number(opts.gapSlots) > 0 && !current.restoring
      && current.seedPhrase === seedPhrase && holdsNoSlots(current.pending);
    if (!resuming && !deeper && (current.tokens.length || current.pending || (current.outgoing || []).length)) {
      throw new Error("recovery requires an empty wallet so bearer assets are not overwritten");
    }
    let state = current;
    if (deeper) {
      const from = Math.floor(Number((current.counters || {})[key] || 0) / 100) * 100;
      state = { ...current, restoring: { key, next: from, empty: 0, found: 0 } };
      await write(state);
    } else if (!resuming) {
      const seed = wc.mnemonicToSeedSync(seedPhrase);
      const privateKey = wc.HDKey.fromMasterSeed(seed).derive("m/129373'/10'/0'/0'/0").privateKey;
      state = {
        privateKey: hex(privateKey), pubkey: hex(c.getPubKeyFromPrivKey(privateKey)), seedPhrase,
        counters: { [key]: 0 }, tokens: [], outgoing: [], pending: null,
        restoring: { key, next: 0, empty: 0 },
      };
      await write(state);
    }
    const catalog = await getCatalog(mintUrl, c, keyset);
    let counter = state.restoring.next;
    let emptyBatches = state.restoring.empty;
    /* HOW FAR PAST THE LAST CARD TO LOOK. Slot c holds only the card at catalog
       index c mod N, so two cards taken one after the other lie at most N slots
       apart. A slot reserved and never signed between them -- left by a wallet
       from before refused operations gave their slots back -- pushes the next
       card up to 2N slots on, and batch edges cost up to one more batch. So the
       scan stops only after at least 2N + 100 slots in a row came back unsigned;
       stopping after three hundred lost every card beyond such a gap. A deep scan
       asks for more (opts.gapSlots), and the checkpoint remembers it, so a deep
       scan that is resumed without asking again stays deep. */
    const gapSlots = Math.max(2 * catalog.assets.length + 100, Number(opts.gapSlots) || 0,
      Number(state.restoring.gapSlots) || 0);
    const gapBatches = Math.ceil(gapSlots / 100);
    const held = new Set(readableProofs(state, keyset, c).map((proof) => proof.secret));

    while (emptyBatches < gapBatches) {
      const candidates = await Promise.all(Array.from({ length: 100 }, (_, i) => {
        const at = counter + i;
        return deterministicOutput(catalog.assets[at % catalog.assets.length], state, c, keyset, at);
      }));
      const response = await patientFetch(`${mintUrl}/v1/restore`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ outputs: candidates.map((output) => ({
          amount: 1, id: output.blindedMessage.id, B_: output.blindedMessage.B_,
        })) }),
      }, opts);
      if (!response.ok) throw new Error(`signature restore failed (${response.status})`);
      const restored = await response.json();
      if (!Array.isArray(restored.outputs) || !Array.isArray(restored.signatures) || restored.outputs.length !== restored.signatures.length) {
        throw new Error("mint returned an invalid NUT-09 restore response");
      }
      const signatures = new Map(restored.outputs.map((output, index) => [output.B_, restored.signatures[index]]));
      const batch = [];
      const found = [];
      let lastSigned = -1;
      for (let i = 0; i < candidates.length; i += 1) {
        const signature = signatures.get(candidates[i].blindedMessage.B_);
        if (!signature) continue;
        lastSigned = counter + i;
        const proof = candidates[i].toProof({ ...signature, amount: c.Amount.from(signature.amount) }, keyset);
        if (!proof.p2pk_e || !c.hasValidDleq(proof, keyset, { require: true }) || !c.maybeDeriveP2BKPrivateKeys(state.privateKey, proof).length) {
          throw new Error("mint returned an invalid restored NutFT proof");
        }
        batch.push(proof);
      }
      if (batch.length) {
        const Ys = batch.map((proof) => c.hashToCurve(new TextEncoder().encode(proof.secret)).toHex(true));
        const checked = await patientFetch(`${mintUrl}/v1/checkstate`, {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ Ys }),
        }, opts);
        if (!checked.ok) throw new Error(`restored proof state unavailable (${checked.status})`);
        const states = (await checked.json()).states;
        batch.forEach((proof, index) => {
          if (states[index]?.state === "UNSPENT" && !held.has(proof.secret)) {
            held.add(proof.secret);
            found.push(proof);
          }
        });
        emptyBatches = 0;
      } else {
        emptyBatches += 1;
      }
      counter += 100;
      /* CHECKPOINT: the cards this batch found, the counter past its last signed
         slot (never moved back: a deep scan starts below it), and where the next
         batch starts, before anything else is asked. */
      const known = Number(state.counters[key] || 0);
      state = {
        ...state,
        tokens: found.length
          ? [...state.tokens, encodeToken(c, { mint: mintUrl, unit: keyset.unit, proofs: found })]
          : state.tokens,
        counters: { ...state.counters, [key]: Math.max(known, lastSigned + 1) },
        restoring: {
          key, next: counter, empty: emptyBatches, gapSlots,
          found: (state.restoring.found || 0) + found.length,
        },
      };
      await write(state);
    }

    /* Finished. The tokens stay exactly as the batches appended them. Folding
       them into one token rebuilt the whole list from this edition's readable
       proofs and dropped every token this keyset cannot read -- a G card stored
       beside an E1 recovery was lost when the recovery finished. */
    const finished = { ...state };
    delete finished.restoring;
    await write(finished);
    return state.restoring.found || 0;
  }

  const restoreSeed = (mintUrl, phrase, opts) => locked(
    () => restoreSeedUnlocked(mintUrl, phrase, opts || {}),
  );

  async function exportBackup() {
    const state = await read();
    return JSON.stringify({ format: "600b-nutft-wallet-v1", wallet: state }, null, 2);
  }

  function backupFrom(text) {
    let backup;
    try { backup = JSON.parse(text); }
    catch { throw new Error("wallet backup is not valid JSON"); }
    if (backup?.format !== "600b-nutft-wallet-v1" || !validState(backup.wallet)) {
      throw new Error("wallet backup has an invalid format");
    }
    return backup.wallet;
  }

  async function restoreBackupUnlocked(text) {
    const wallet = backupFrom(text);
    const current = await read();
    if (current.tokens.length || current.pending) {
      throw new Error("restore requires an empty wallet so existing bearer assets are not overwritten");
    }
    await write(wallet);
    return wallet.tokens.length;
  }

  const restoreBackup = (text) => locked(() => restoreBackupUnlocked(text));

  /* cashu-sync's snapshot rule is REPLACE AFTER HEAD CHECK, never merge. A merge can
   * resurrect a stale spent token or combine two different pending operations.
   * The caller hands us the exact state it inspected before its network round
   * trip; the lock makes this a compare-and-swap against localStorage too, so a
   * purchase completed in another tab cannot be overwritten by a remote head.
   * A generated-but-empty mobile wallet may adopt the remote P2BK key. A
   * non-empty wallet under a different key is preserved and refused. */
  async function replaceBackupUnlocked(text, expectedText) {
    const remote = backupFrom(text);
    const expected = backupFrom(expectedText);
    const current = await read();
    if (canonical(current) !== canonical(expected)) {
      throw new Error(
        "this wallet changed in another tab while sync was running; nothing was overwritten",
      );
    }
    const currentHasData = current.tokens.length || current.pending
      || (Array.isArray(current.outgoing) && current.outgoing.length);
    const sameKey = current.privateKey === remote.privateKey && current.pubkey === remote.pubkey;
    if (currentHasData && !sameKey) {
      throw new Error(
        "this device and the sync head hold two different non-empty wallets; download both backups instead of overwriting either one",
      );
    }
    await write(remote);
    return remote.tokens.length;
  }

  const replaceBackup = (text, expectedText) => locked(
    () => replaceBackupUnlocked(text, expectedText),
  );

  root.NutFTWallet = {
    buyBooster, claimBooster, snapshot, snapshotMany, snapshotReadOnly, snapshotManyReadOnly,
    tradeProof, importToken,
    destination, recoverPending, outgoing, forgetOutgoing, exportBackup,
    restoreBackup, replaceBackup, recoveryPhrase, restoreSeed, provePossession, read, cashu, hex, bytes,
    /* The window a deep scan asks for: restoreSeed(mint, phrase, { gapSlots: DEEP_SCAN_SLOTS }). */
    DEEP_SCAN_SLOTS: 25_000,
  };
  root.NutFTWallet.encodeToken = encodeToken;})(globalThis);
