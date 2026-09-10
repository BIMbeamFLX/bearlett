/**
 * Card faces, fetched through the Resource NAP and checked before they are
 * shown.
 *
 * The catalogue states each face by hash and then lists mirrors that ought to
 * serve it. Those are two different claims. The hash is signed as part of the
 * catalogue; a mirror is just a host that answered. So the bytes are hashed
 * here and compared before anything reaches the screen, and a mirror that
 * returns the wrong image is treated as a miss rather than as an image.
 *
 * Without that check a mirror could put any picture on any card, and the whole
 * point of a content-addressed face is that it cannot.
 */

export type FaceRef = {
  sha256: string
  mime: string
  bytes: number
  urls: readonly string[]
}

export type FaceSource = {
  /** The collection's routed fetch. It already refuses unlisted origins. */
  fetch: typeof fetch
  /** Bytes a single face may occupy. Faces are artwork, not archives. */
  maxBytes?: number
}

export class FaceUnavailable extends Error {
  constructor(
    readonly sha256: string,
    readonly attempts: readonly string[]
  ) {
    super('No mirror served this card face with the hash the catalogue signs.')
    this.name = 'FaceUnavailable'
  }
}

const DEFAULT_MAX_BYTES = 3 * 1024 * 1024
const HEX = /^[0-9a-f]{64}$/

const hexOf = (buffer: ArrayBuffer): string =>
  Array.from(new Uint8Array(buffer), byte =>
    byte.toString(16).padStart(2, '0')
  ).join('')

/** Hash bytes with the algorithm the catalogue names. */
export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  return hexOf(await crypto.subtle.digest('SHA-256', bytes))
}

/**
 * Fetch one face and return it only if the bytes hash to what was asked for.
 *
 * Mirrors are tried in the order the catalogue lists them, and a mirror that
 * fails for any reason, refused, unreachable, oversized or simply wrong, is
 * passed over rather than reported. What the caller learns is that the face is
 * unavailable, not which host misbehaved, because every one of them is
 * replaceable and none of them is trusted.
 */
export async function loadFace(
  face: FaceRef,
  source: FaceSource
): Promise<Blob> {
  if (!HEX.test(face.sha256)) throw new FaceUnavailable(face.sha256, [])
  const maxBytes = source.maxBytes ?? DEFAULT_MAX_BYTES
  const attempts: string[] = []

  for (const url of face.urls) {
    attempts.push(url)
    try {
      const response = await source.fetch(url)
      if (!response.ok) continue
      const bytes = await response.arrayBuffer()
      if (bytes.byteLength > maxBytes) continue
      if ((await sha256Hex(bytes)) !== face.sha256) continue
      /* The catalogue's mime type, not the mirror's content-type header: the
         hash is what was verified, and the type travels with it. */
      return new Blob([bytes], {type: face.mime || 'application/octet-stream'})
    } catch {
      continue
    }
  }
  throw new FaceUnavailable(face.sha256, attempts)
}

/**
 * A per-collection face cache.
 *
 * Keyed by hash, which is the only correct key: two cards with the same face
 * share one fetch, and a face never changes under its key. Object URLs are
 * revoked on dispose, because a napplet that leaks them holds the whole
 * collection's artwork in memory for as long as the frame lives.
 */
export function createFaceCache(source: FaceSource) {
  const urls = new Map<string, string>()
  const inFlight = new Map<string, Promise<string>>()
  let disposed = false

  const load = async (face: FaceRef): Promise<string> => {
    const blob = await loadFace(face, source)
    if (disposed) throw new FaceUnavailable(face.sha256, [])
    const url = URL.createObjectURL(blob)
    urls.set(face.sha256, url)
    return url
  }

  return {
    /** Resolves to an object URL that is safe to put in an `img` element. */
    async get(face: FaceRef): Promise<string> {
      if (disposed) throw new FaceUnavailable(face.sha256, [])
      const ready = urls.get(face.sha256)
      if (ready) return ready
      const running = inFlight.get(face.sha256)
      if (running) return running
      const started = load(face).finally(() => inFlight.delete(face.sha256))
      inFlight.set(face.sha256, started)
      return started
    },
    /** How many distinct faces are held. Used by the tests and the diagnostics. */
    get size() {
      return urls.size
    },
    dispose() {
      disposed = true
      for (const url of urls.values()) URL.revokeObjectURL(url)
      urls.clear()
      inFlight.clear()
    }
  }
}
