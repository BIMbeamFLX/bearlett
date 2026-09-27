// Three kinds of failure, kept apart because they mean different things
// for a bearer note: SERVICE's own {"status": "ERROR", "reason"} is a
// definitive answer (LUD-01); a transport failure leaves it unknown whether
// the request ever reached SERVICE; and a protocol failure is an answer that
// breaks the spec, which no retry and no offline fallback may paper over.

/** SERVICE answered, and said no. Nothing was burned or minted. */
export class ServiceError extends Error {
  readonly reason: string
  constructor(reason: string) {
    super(reason)
    this.name = 'ServiceError'
    this.reason = reason
  }
}

/** SERVICE answered, but not the way LUD-25 says it must: trust nothing in it. */
export class ProtocolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProtocolError'
  }
}

/** No usable answer: the request may or may not have taken effect. */
export class TransportError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TransportError'
  }
}

// Reasons LUD-25 fixes verbatim, plus the ones lnurl-mint uses for spent
// and unknown notes (retained and distinguished since lnurl/luds#307).
export const reason = {
  alreadyInUse: (r: string) => /already in use/i.test(r),
  pending: (r: string) => /^\s*pending\s*$/i.test(r),
  insufficientValue: (r: string) => /insufficient value/i.test(r),
  tooManyK1: (r: string) => /too many k1/i.test(r),
  rateLimited: (r: string) => /rate.?limit/i.test(r),
  spent: (r: string) => /already spent|\bspent\b|burned/i.test(r),
  unknown: (r: string) => /unknown note|not found|never issued/i.test(r)
}

export const isServiceReason = (
  err: unknown,
  test: (r: string) => boolean
): boolean => err instanceof ServiceError && test(err.reason)
