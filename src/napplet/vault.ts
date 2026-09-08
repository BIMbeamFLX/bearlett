import {bytesToHex, hexToBytes} from '@noble/hashes/utils.js'
import {
  encryptSecretParts,
  decryptSecretParts,
  deriveBearerAesKey,
  encryptRecord,
  decryptRecord,
  isValidStoredSecret
} from '../keys'
import type {EncryptedRecordParts, StoredSecret} from '../keys'
import type {WalletHost} from './host'
import {parseDesign} from './design'
import type {NoteDesign} from './design'

export type Note = {
  id: string
  url: string
  amount: number
  status: 'unverified' | 'ready' | 'pending' | 'spent' | 'shared'
  reason: string
  updatedAt: number
  invoice?: string
  invoiceType?: 'funding' | 'payment'
  designId?: string
}
const KEY = 'lnurlcash-napplet:key:v1'
const PREFIX = 'lnurlcash-napplet:note:'
const DESIGN_PREFIX = 'lnurlcash-napplet:design:'
type Backup = {
  type: 'lnurlcash-napplet-backup'
  version: 1
  key: StoredSecret
  notes: Record<string, EncryptedRecordParts>
  designs?: Record<string, EncryptedRecordParts>
}

/** Encrypt each note independently; acknowledge durable writes before proceeding. */
export class Vault {
  private aes: CryptoKey | null = null
  constructor(private storage: WalletHost['storage']) {}

  /** Check setup without treating malformed existing data as an empty wallet. */
  async exists(): Promise<boolean> {
    return (await this.storage.getItem(KEY)) !== null
  }

  /** Create a password-protected wallet; never overwrite an existing key. */
  async create(password: string): Promise<void> {
    if (password.length < 12) throw new Error('Use at least 12 characters.')
    if (await this.exists())
      throw new Error('A wallet already exists. Unlock it instead.')
    const root = crypto.getRandomValues(new Uint8Array(32))
    try {
      const encrypted = {
        enc: true,
        ...(await encryptSecretParts(bytesToHex(root), password))
      }
      await this.storage.setItem(KEY, JSON.stringify(encrypted))
      this.aes = await deriveBearerAesKey(root)
    } finally {
      root.fill(0)
    }
  }

  /** Unlock only with the user's password; host identity is never a wallet key. */
  async unlock(password: string): Promise<void> {
    const stored = JSON.parse((await this.storage.getItem(KEY)) ?? 'null')
    if (!isValidStoredSecret(stored) || !stored.enc)
      throw new Error('Invalid wallet key record.')
    const root = hexToBytes(await decryptSecretParts(stored, password))
    try {
      this.aes = await deriveBearerAesKey(root)
    } finally {
      root.fill(0)
    }
  }

  /** Drop the in-memory encryption key. */
  lock(): void {
    this.aes = null
  }

  /** Read every encrypted note, failing visibly on corrupt or foreign records. */
  async notes(): Promise<Note[]> {
    const aes = this.requireKey()
    const result: Note[] = []
    for (const key of (await this.storage.keys()).filter(k =>
      k.startsWith(PREFIX)
    )) {
      const raw = await this.storage.getItem(key)
      if (raw === null)
        throw new Error('A note disappeared from shell storage.')
      const note = await decryptRecord<Note>(aes, JSON.parse(raw))
      if (!validNote(note) || key !== PREFIX + note.id)
        throw new Error('Invalid encrypted note.')
      result.push(note)
    }
    return result.sort((a, b) => b.updatedAt - a.updatedAt)
  }

  /** Persist ciphertext before returning; source notes remain as history. */
  async save(note: Note): Promise<void> {
    if (!validNote(note)) throw new Error('Invalid note.')
    const record = await encryptRecord(this.requireKey(), note)
    await this.storage.setItem(PREFIX + note.id, JSON.stringify(record))
  }

  /** Keep shared artwork once, encrypted alongside the bearer records. */
  async saveDesign(id: string, design: NoteDesign): Promise<void> {
    if (!/^[a-zA-Z0-9-]{1,80}$/.test(id)) throw new Error('Invalid design ID.')
    const record = await encryptRecord(this.requireKey(), parseDesign(design))
    await this.storage.setItem(DESIGN_PREFIX + id, JSON.stringify(record))
  }

  /** Read the user's saved note designs. */
  async designs(): Promise<Record<string, NoteDesign>> {
    const result: Record<string, NoteDesign> = Object.create(null)
    for (const key of (await this.storage.keys()).filter(k =>
      k.startsWith(DESIGN_PREFIX)
    )) {
      const raw = await this.storage.getItem(key)
      result[key.slice(DESIGN_PREFIX.length)] = parseDesign(
        await decryptRecord(this.requireKey(), JSON.parse(raw!))
      )
    }
    return result
  }

  /** Export ciphertext and the password-wrapped key, including pending outputs. */
  async backup(): Promise<string> {
    const key = JSON.parse((await this.storage.getItem(KEY)) ?? 'null')
    if (!isValidStoredSecret(key) || !key.enc)
      throw new Error('Invalid wallet key.')
    const notes: Backup['notes'] = {}
    const designs: NonNullable<Backup['designs']> = {}
    for (const name of (await this.storage.keys()).filter(k =>
      k.startsWith(PREFIX)
    )) {
      notes[name.slice(PREFIX.length)] = JSON.parse(
        (await this.storage.getItem(name))!
      )
    }
    for (const name of (await this.storage.keys()).filter(k =>
      k.startsWith(DESIGN_PREFIX)
    )) {
      designs[name.slice(DESIGN_PREFIX.length)] = JSON.parse(
        (await this.storage.getItem(name))!
      )
    }
    return JSON.stringify(
      {type: 'lnurlcash-napplet-backup', version: 1, key, notes, designs},
      null,
      2
    )
  }

  /** Import into an unlocked wallet, re-encrypting and deduplicating bearer secrets. */
  async restore(text: string, password: string): Promise<number> {
    if (text.length > 2_000_000) throw new Error('Backup exceeds 2 MB.')
    const backup = JSON.parse(text) as Backup
    if (
      backup.type !== 'lnurlcash-napplet-backup' ||
      backup.version !== 1 ||
      !isValidStoredSecret(backup.key) ||
      !backup.key.enc ||
      !backup.notes ||
      typeof backup.notes !== 'object' ||
      Array.isArray(backup.notes) ||
      Object.keys(backup.notes).length > 1000
    )
      throw new Error('Invalid napplet backup.')
    const root = hexToBytes(await decryptSecretParts(backup.key, password))
    let aes: CryptoKey
    try {
      aes = await deriveBearerAesKey(root)
    } finally {
      root.fill(0)
    }
    // Authenticate and validate the whole file before the first write.
    const incoming = await Promise.all(
      Object.values(backup.notes).map(parts => decryptRecord<Note>(aes, parts))
    )
    if (!incoming.every(validNote)) throw new Error('Invalid note in backup.')
    if (
      backup.designs &&
      (typeof backup.designs !== 'object' ||
        Array.isArray(backup.designs) ||
        Object.keys(backup.designs).length > 100)
    )
      throw new Error('Invalid backup designs.')
    const designs = await Promise.all(
      Object.entries(backup.designs ?? {}).map(
        async ([id, parts]) =>
          [id, parseDesign(await decryptRecord(aes, parts))] as const
      )
    )
    const designIds = new Map<string, string>()
    for (const [id, design] of designs) {
      const newId = crypto.randomUUID()
      await this.saveDesign(newId, design)
      designIds.set(id, newId)
    }
    const existing = await this.notes()
    const known = new Set(existing.map(note => noteIdentity(note)))
    let added = 0
    for (const note of incoming) {
      const identity = noteIdentity(note)
      if (known.has(identity)) continue
      // Old ready copies must be checked online again, never silently trusted.
      await this.save({
        ...note,
        id: crypto.randomUUID(),
        designId: designIds.get(note.designId ?? 'default'),
        status: ['spent', 'shared'].includes(note.status)
          ? note.status
          : 'unverified',
        reason: 'Restored backup; check online before using.',
        updatedAt: Date.now()
      })
      known.add(identity)
      added++
    }
    return added
  }

  private requireKey(): CryptoKey {
    if (!this.aes) throw new Error('Unlock the wallet first.')
    return this.aes
  }
}

const noteIdentity = (note: Note): string => {
  const url = new URL(note.url)
  return `${url.origin}${url.pathname}:${url.searchParams.get('k1')}`
}

const validNote = (value: Note): boolean => {
  if (
    !value ||
    typeof value.id !== 'string' ||
    !/^[a-zA-Z0-9-]{1,80}$/.test(value.id) ||
    typeof value.url !== 'string' ||
    value.url.length > 16000 ||
    !Number.isSafeInteger(value.amount) ||
    value.amount < 0 ||
    !Number.isSafeInteger(value.updatedAt) ||
    typeof value.reason !== 'string' ||
    (value.designId !== undefined &&
      !/^[a-zA-Z0-9-]{1,80}$/.test(value.designId)) ||
    !['unverified', 'ready', 'pending', 'spent', 'shared'].includes(
      value.status
    ) ||
    (value.invoice !== undefined &&
      (typeof value.invoice !== 'string' || value.invoice.length > 16000))
  )
    return false
  try {
    const url = new URL(value.url)
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !!url.searchParams.get('k1')
    )
  } catch {
    return false
  }
}
