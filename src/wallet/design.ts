// A note design from the Hangar's Note Designer: how a handed-out note
// looks, nothing about what it is worth. The contract is the one the
// Hangar checks before it queues a design (nappelin
// apps/hangar/src/vendor/bearlett/design.ts), so both read it the same.

export type NoteDesign = {
  title: string
  subtitle: string
  ink: string
  paper: string
  /** a PNG, JPEG or WebP data URL */
  image?: string
}

/** The topic a design arrives on, over the shell's INC. */
export const DESIGN_TOPIC = 'napplet:wallet/design'

const COLOR = /^#[0-9a-f]{6}$/i
const IMAGE = /^data:image\/(png|jpeg|webp);base64,[a-zA-Z0-9+/=]+$/

/** Bounded text, hex colors and a local raster image, or an error. */
export const parseDesign = (value: unknown): NoteDesign => {
  const d = value as Record<string, unknown>
  if (!d || typeof d !== 'object' || Array.isArray(d))
    throw new Error('Invalid note design.')
  if (
    typeof d.title !== 'string' ||
    !d.title.trim() ||
    d.title.length > 48 ||
    typeof d.subtitle !== 'string' ||
    d.subtitle.length > 100 ||
    typeof d.ink !== 'string' ||
    !COLOR.test(d.ink) ||
    typeof d.paper !== 'string' ||
    !COLOR.test(d.paper) ||
    (d.image !== undefined &&
      (typeof d.image !== 'string' ||
        d.image.length > 180000 ||
        !IMAGE.test(d.image)))
  )
    throw new Error(
      'Use short text, hex colors and a PNG, JPEG or WebP image under 130 KB.'
    )
  return {
    title: d.title,
    subtitle: d.subtitle,
    ink: d.ink,
    paper: d.paper,
    ...(d.image === undefined ? {} : {image: d.image as string})
  }
}

/** `{kind: 'lnurlcash/note-design', version: 1, design}`, as the designer sends it. */
export const parseDesignMessage = (payload: unknown): NoteDesign => {
  const value = payload as Record<string, unknown>
  if (
    !value ||
    typeof value !== 'object' ||
    value.kind !== 'lnurlcash/note-design' ||
    value.version !== 1
  )
    throw new Error('Not a note design this wallet reads.')
  return parseDesign(value.design)
}
