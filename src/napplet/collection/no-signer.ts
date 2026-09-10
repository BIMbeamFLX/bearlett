/**
 * A collection napplet must not reach a Nostr signer directly. The rule is
 * "no `window.nostr` in a napplet; the signer only through the shell", and the
 * card wallet library does reach for it: `nip98Header` reads `root.nostr` off
 * the global and signs a kind-27235 event with whatever it finds.
 *
 * Two call sites lead there, and both share one trigger. The booster quote
 * retries a refused GET with a signature, and `postSigned` retries a refused
 * POST the same way. Neither is entered unless the mint answers "early access",
 * which only a gated mint does.
 *
 * Everything a collection napplet does sits beside that trigger: reading the
 * catalogue, verifying holdings, receiving a card, handing one over, backing up
 * and proving possession are all anonymous at the mint. Buying belongs to the
 * shop, which is a web page, not a napplet.
 *
 * So the capability given up is buying from a gated mint inside a napplet. If
 * that is ever wanted, the answer is not to undo this: it is to route the
 * signature through the shell's identity NAP, which needs an authorization path
 * in the NutFT capability, kind 27235 in the wallet's own grant, and a
 * deliberate decision that the mint may learn the login key. All three are
 * decisions, not code.
 */

/** What `window.nostr` looks like to the code that would use it. */
type MaybeSigner = {signEvent?: unknown} | undefined

export class SignerNotSealed extends Error {
  constructor() {
    super(
      'A Nostr signer is held open in this window and cannot be closed. ' +
        'This collection will not run beside it.'
    )
    this.name = 'SignerNotSealed'
  }
}

/**
 * Seal `nostr` to `undefined` on the given global, before any wallet code runs.
 *
 * Absence at load is not enough on its own. An extension can inject into a
 * frame after it loads, and the library reads the property when it signs rather
 * than when it is imported, so a late injection would still be found. A
 * non-configurable, non-writable `undefined` closes that window: the later
 * injection fails instead of landing.
 *
 * Fails closed. If something already installed a signer that cannot be
 * redefined, the rule cannot be made true here, and a napplet that cannot keep
 * it should refuse to start rather than break it quietly.
 */
export function sealSigner(
  scope: Record<string, unknown> = globalThis as never
): void {
  const current = Reflect.getOwnPropertyDescriptor(scope, 'nostr')
  if (current && !current.configurable) {
    /* Already sealed by an earlier call is the one benign case. */
    if (!current.get && current.value === undefined) return
    throw new SignerNotSealed()
  }
  try {
    Object.defineProperty(scope, 'nostr', {
      value: undefined,
      writable: false,
      configurable: false,
      enumerable: false
    })
  } catch {
    throw new SignerNotSealed()
  }
}

/**
 * Whether a signer is reachable, by the same test the library itself applies.
 * The entry point asserts against this instead of trusting that the seal held.
 */
export function signerReachable(
  scope: Record<string, unknown> = globalThis as never
): boolean {
  const signer = scope.nostr as MaybeSigner
  return Boolean(signer && typeof signer.signEvent === 'function')
}

/**
 * What to show when a mint asks for a signature this napplet will not give.
 *
 * The library's own advice tells the buyer to install a Nostr extension and
 * press Buy again. Inside a napplet that is exactly the wrong instruction: an
 * extension would not be used even if it were installed, so following it leads
 * nowhere.
 */
export function gatedSaleMessage(): string {
  return (
    'This mint sells to signed buyers only, and a collection napplet never ' +
    'signs with your login key. Buy in the shop, then receive the cards here.'
  )
}

/** Recognise the mint's refusal without depending on its exact wording. */
export function isGatedSaleRefusal(detail: unknown): boolean {
  return typeof detail === 'string' && /early access/i.test(detail)
}
