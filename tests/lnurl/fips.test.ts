// LNURL over FIPS (fips.network): a mint reached as `<npub>.fips` over the
// mesh, with plain http like an onion service. Not in LUD-01 yet; proposed.
import {describe, expect, it} from 'vitest'
import {
  fromLud17,
  lightningAddressUrl,
  parseNoteLink,
  toLnurlw
} from '../../src/lnurl/links.ts'
import {isAllowedServiceUrl} from '../../src/lnurl/net.ts'
import {spendDomain} from '../../src/spec/spend.ts'
import {hostOf, spendDomainOfHost} from '../../src/wallet/keys.ts'

// a well-formed npub (the one in NIP-19's own examples), as a FIPS name
const NPUB = 'npub10elfcs4fr0l0r8af98jlmgdh9c8tcxjvz9qkw038js35mp4dma8qzvjptg'
const MINT = `${NPUB}.fips`

describe('FIPS names', () => {
  it('admits plain http to a .fips name, as to an onion service', () => {
    expect(isAllowedServiceUrl(`http://${MINT}/w`)).toBe(true)
    expect(isAllowedServiceUrl(`https://${MINT}/w`)).toBe(true)
  })

  it('does not admit plain http to a bare ULA address', () => {
    expect(isAllowedServiceUrl('http://[fd12:3456:789a::1]/w')).toBe(false)
  })

  it('maps LUD-17 links to http, and back', () => {
    expect(fromLud17(`lnurlw://${MINT}/w?k1=${'a'.repeat(64)}`)).toBe(
      `http://${MINT}/w?k1=${'a'.repeat(64)}`
    )
    expect(toLnurlw(`http://${MINT}/w`)).toBe(`lnurlw://${MINT}/w`)
  })

  it('resolves a Lightning Address at a FIPS mint', () => {
    expect(lightningAddressUrl(`alice@${MINT}`)).toBe(
      `http://${MINT}/.well-known/lnurlp/alice`
    )
  })

  it('reads a note link over the mesh and binds its spends to the .fips name', () => {
    const link = parseNoteLink(`lnurlw://${MINT}/w?k1=${'b'.repeat(64)}`)!
    expect(link.endpoint).toBe(`http://${MINT}/w`)
    expect(spendDomain(link.endpoint)).toBe(MINT)
    expect(spendDomainOfHost(hostOf(link.endpoint))).toBe(MINT)
  })
})
