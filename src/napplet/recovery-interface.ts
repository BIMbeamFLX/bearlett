// SPDX-License-Identifier: MIT
export const RECOVERY_CONVENTION = 'napplet:wallet/recovery-v1'
export type RecoveryContext = {
  version: 1
  guildId: string
  memberId: string
  caseId: string
}

/** Navigation reference only: never a receipt, wallet key, or authorization to restore. */
export function parseRecoveryContext(value: unknown): RecoveryContext {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid recovery context.')
  const data = value as Record<string, unknown>
  if (
    Object.keys(data).sort().join(',') !== 'caseId,guildId,memberId,version' ||
    data.version !== 1 ||
    !['guildId', 'memberId', 'caseId'].every(
      key =>
        typeof data[key] === 'string' &&
        /^[a-zA-Z0-9_-]{1,128}$/.test(data[key] as string)
    )
  )
    throw new Error(
      'Invalid recovery reference. No keys or backup data are accepted.'
    )
  return {
    version: 1,
    guildId: data.guildId as string,
    memberId: data.memberId as string,
    caseId: data.caseId as string
  }
}
