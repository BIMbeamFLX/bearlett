import {describe, expect, it, vi, beforeEach, afterEach} from 'vitest'
import {FaceUnavailable, createFaceCache, loadFace, sha256Hex} from './faces'
import type {FaceRef} from './faces'

const bytesOf = (text: string) => new TextEncoder().encode(text)

const faceFor = async (
  text: string,
  urls: readonly string[]
): Promise<FaceRef> => {
  const data = bytesOf(text)
  return {
    sha256: await sha256Hex(
      data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
    ),
    mime: 'image/webp',
    bytes: data.byteLength,
    urls
  }
}

const serving = (map: Record<string, string | number>) =>
  vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    const answer = map[url]
    if (answer === undefined) throw new Error('refused by the router')
    if (typeof answer === 'number') return new Response(null, {status: answer})
    return new Response(bytesOf(answer), {status: 200})
  }) as unknown as typeof fetch

describe('loadFace', () => {
  it('returns the image when the bytes hash to what the catalogue signs', async () => {
    const face = await faceFor('artwork', ['https://a.example/1.webp'])
    const blob = await loadFace(face, {
      fetch: serving({'https://a.example/1.webp': 'artwork'})
    })
    expect(await blob.text()).toBe('artwork')
    expect(blob.type).toBe('image/webp')
  })

  it('refuses a mirror that serves a different picture', async () => {
    const face = await faceFor('artwork', ['https://evil.example/1.webp'])
    await expect(
      loadFace(face, {
        fetch: serving({'https://evil.example/1.webp': 'not the card'})
      })
    ).rejects.toThrow(FaceUnavailable)
  })

  it('moves to the next mirror instead of giving up on the first miss', async () => {
    const face = await faceFor('artwork', [
      'https://gone.example/1.webp',
      'https://wrong.example/1.webp',
      'https://good.example/1.webp'
    ])
    const fetcher = serving({
      'https://gone.example/1.webp': 404,
      'https://wrong.example/1.webp': 'tampered',
      'https://good.example/1.webp': 'artwork'
    })
    const blob = await loadFace(face, {fetch: fetcher})
    expect(await blob.text()).toBe('artwork')
    expect(fetcher).toHaveBeenCalledTimes(3)
  })

  it('treats a refused origin as a miss, not as a crash', async () => {
    const face = await faceFor('artwork', [
      'https://blocked.example/1.webp',
      'https://good.example/1.webp'
    ])
    const blob = await loadFace(face, {
      fetch: serving({'https://good.example/1.webp': 'artwork'})
    })
    expect(await blob.text()).toBe('artwork')
  })

  it('does not name the mirror that misbehaved', async () => {
    const face = await faceFor('artwork', ['https://evil.example/1.webp'])
    await expect(
      loadFace(face, {fetch: serving({'https://evil.example/1.webp': 'x'})})
    ).rejects.toThrow(/No mirror served this card face/)
  })

  it('stops an oversized face before hashing it', async () => {
    const face = await faceFor('artwork', ['https://a.example/1.webp'])
    await expect(
      loadFace(face, {
        fetch: serving({'https://a.example/1.webp': 'artwork'}),
        maxBytes: 2
      })
    ).rejects.toThrow(FaceUnavailable)
  })

  it('refuses a catalogue entry whose hash is not a hash', async () => {
    for (const sha256 of ['', 'nothex', 'A'.repeat(64), 'a'.repeat(63)])
      await expect(
        loadFace(
          {sha256, mime: 'image/webp', bytes: 1, urls: ['https://a.example/1']},
          {fetch: serving({'https://a.example/1': 'x'})}
        )
      ).rejects.toThrow(FaceUnavailable)
  })

  it('reports a face with no mirrors at all', async () => {
    const face = await faceFor('artwork', [])
    await expect(loadFace(face, {fetch: serving({})})).rejects.toThrow(
      FaceUnavailable
    )
  })
})

describe('createFaceCache', () => {
  const created: string[] = []
  const revoked: string[] = []

  beforeEach(() => {
    created.length = 0
    revoked.length = 0
    let next = 0
    globalThis.URL.createObjectURL = vi.fn(() => {
      const url = `blob:face-${next++}`
      created.push(url)
      return url
    })
    globalThis.URL.revokeObjectURL = vi.fn((url: string) => {
      revoked.push(url)
    })
  })

  afterEach(() => {
    delete (globalThis.URL as {createObjectURL?: unknown}).createObjectURL
    delete (globalThis.URL as {revokeObjectURL?: unknown}).revokeObjectURL
  })

  it('fetches one face once, however many cards share it', async () => {
    const face = await faceFor('artwork', ['https://a.example/1.webp'])
    const fetcher = serving({'https://a.example/1.webp': 'artwork'})
    const cache = createFaceCache({fetch: fetcher})

    const [first, second] = await Promise.all([
      cache.get(face),
      cache.get(face)
    ])
    expect(first).toBe(second)
    const third = await cache.get(face)
    expect(third).toBe(first)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(cache.size).toBe(1)
  })

  it('does not cache a failure, so a flaky mirror can still recover', async () => {
    const face = await faceFor('artwork', ['https://a.example/1.webp'])
    let attempt = 0
    const fetcher = vi.fn(async () => {
      attempt += 1
      return attempt === 1
        ? new Response(null, {status: 503})
        : new Response(bytesOf('artwork'), {status: 200})
    }) as unknown as typeof fetch
    const cache = createFaceCache({fetch: fetcher})

    await expect(cache.get(face)).rejects.toThrow(FaceUnavailable)
    await expect(cache.get(face)).resolves.toMatch(/^blob:/)
  })

  it('revokes every object URL it made when the collection closes', async () => {
    const one = await faceFor('one', ['https://a.example/1.webp'])
    const two = await faceFor('two', ['https://a.example/2.webp'])
    const cache = createFaceCache({
      fetch: serving({
        'https://a.example/1.webp': 'one',
        'https://a.example/2.webp': 'two'
      })
    })
    await cache.get(one)
    await cache.get(two)
    expect(cache.size).toBe(2)

    cache.dispose()
    expect(revoked.sort()).toEqual(created.sort())
    expect(cache.size).toBe(0)
    await expect(cache.get(one)).rejects.toThrow(FaceUnavailable)
  })
})
