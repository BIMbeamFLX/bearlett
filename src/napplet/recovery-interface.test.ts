// SPDX-License-Identifier: MIT
import {expect, it} from 'vitest'
import {parseRecoveryContext, RECOVERY_CONVENTION} from './recovery-interface'
import {parseWalletIntent, WALLET_CONVENTIONS} from './intents'

it('accepts a bounded reference as navigation without implying wallet authority', () => {
  const context = {
    version: 1,
    guildId: '600b',
    memberId: 'founder-dni',
    caseId: 'case-1'
  }
  expect(WALLET_CONVENTIONS).toContain(RECOVERY_CONVENTION)
  expect(parseWalletIntent(RECOVERY_CONVENTION, context, 'guild')).toEqual({
    action: 'recovery',
    context,
    sender: 'guild'
  })
})
it('rejects private material, URLs, unsupported versions and overlong references', () => {
  const valid = {version: 1, guildId: '600b', memberId: 'm1', caseId: 'c1'}
  for (const value of [
    null,
    [],
    {...valid, version: 2},
    {...valid, seed: 'secret'},
    {...valid, approved: true},
    {...valid, caseId: 'https://untrusted.test'},
    {...valid, memberId: 'x'.repeat(129)}
  ])
    expect(() => parseRecoveryContext(value)).toThrow()
})
