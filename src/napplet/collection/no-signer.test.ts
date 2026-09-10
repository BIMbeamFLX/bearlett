import {describe, expect, it, vi} from 'vitest'
import {
  SignerNotSealed,
  gatedSaleMessage,
  isGatedSaleRefusal,
  sealSigner,
  signerReachable
} from './no-signer'

/**
 * The card wallet's own lookup, copied from `nip98Header` in
 * `site/nutft-wallet.js`. It is reproduced rather than imported because that
 * library lives in the mint's repository, and the point of these tests is that
 * the seal defeats this exact shape whether or not the library changes.
 */
const libraryLookup = (root: Record<string, unknown>) => {
  const signer = root.nostr as {signEvent?: unknown} | undefined
  if (!signer || typeof signer.signEvent !== 'function') return null
  return signer
}

const aSigner = () => ({signEvent: vi.fn(), getPublicKey: vi.fn()})

describe('sealSigner', () => {
  it('leaves the library with no signer to find', () => {
    const scope: Record<string, unknown> = {}
    sealSigner(scope)
    expect(libraryLookup(scope)).toBeNull()
    expect(signerReachable(scope)).toBe(false)
  })

  it('stops a signer injected after the frame has loaded', () => {
    const scope: Record<string, unknown> = {}
    sealSigner(scope)
    /* An extension injecting late. Strict-mode code throws here; sloppy-mode
       code does not, and either way the property must not change. */
    expect(() => {
      scope.nostr = aSigner()
    }).toThrow(TypeError)
    expect(libraryLookup(scope)).toBeNull()
  })

  it('removes a signer that was already there', () => {
    const scope: Record<string, unknown> = {nostr: aSigner()}
    expect(libraryLookup(scope)).not.toBeNull()
    sealSigner(scope)
    expect(libraryLookup(scope)).toBeNull()
  })

  it('is safe to call twice', () => {
    const scope: Record<string, unknown> = {}
    sealSigner(scope)
    expect(() => sealSigner(scope)).not.toThrow()
    expect(libraryLookup(scope)).toBeNull()
  })

  it('fails closed when a signer cannot be redefined', () => {
    const scope: Record<string, unknown> = {}
    Object.defineProperty(scope, 'nostr', {
      value: aSigner(),
      configurable: false,
      writable: false
    })
    expect(() => sealSigner(scope)).toThrow(SignerNotSealed)
    /* And a getter that hands one out is refused for the same reason. */
    const lazy: Record<string, unknown> = {}
    Object.defineProperty(lazy, 'nostr', {
      get: aSigner,
      configurable: false
    })
    expect(() => sealSigner(lazy)).toThrow(SignerNotSealed)
  })

  it('does not leave the property enumerable', () => {
    const scope: Record<string, unknown> = {}
    sealSigner(scope)
    expect(Object.keys(scope)).toEqual([])
    expect('nostr' in scope).toBe(true)
  })
})

describe('the message a gated mint gets instead', () => {
  it('does not repeat the library advice to install an extension', () => {
    const message = gatedSaleMessage()
    expect(message).not.toMatch(/extension|Alby|nos2x|NIP-07/i)
    expect(message).toMatch(/shop/i)
  })

  it('recognises the mint refusal that leads to the signer', () => {
    expect(
      isGatedSaleRefusal('early access: this sale is open to a few keys')
    ).toBe(true)
    expect(isGatedSaleRefusal('Early access: any nostr key works here')).toBe(
      true
    )
    expect(isGatedSaleRefusal('booster quote unavailable (503)')).toBe(false)
    expect(isGatedSaleRefusal(undefined)).toBe(false)
    expect(isGatedSaleRefusal({detail: 'early access'})).toBe(false)
  })
})
