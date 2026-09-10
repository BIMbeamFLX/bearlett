/**
 * Narrow declarations for the Node built-ins the collection tests use.
 *
 * `@types/node` is deliberately not a dependency here. Adding it would put
 * `process`, `Buffer` and the rest into the ambient scope of every file under
 * `src/`, and this is a browser wallet: a stray `Buffer.from` in wallet code
 * would then type-check and fail only at runtime. Declaring the four modules by
 * specifier keeps the global scope exactly as it is.
 *
 * Only the members the tests actually call are declared. Anything else is a
 * compile error, which is the intended behaviour rather than a gap.
 */

declare module 'node:vm' {
  export function createContext(
    sandbox: Record<string, unknown>
  ): Record<string, unknown>
  export function runInContext(
    code: string,
    context: Record<string, unknown>,
    options?: {filename?: string}
  ): unknown
  const vm: {
    createContext: typeof createContext
    runInContext: typeof runInContext
  }
  export default vm
}

declare module 'node:fs' {
  export function readFileSync(path: string): Uint8Array
  export function readFileSync(path: string, encoding: 'utf8'): string
}

declare module 'node:url' {
  export function fileURLToPath(url: URL | string): string
}

declare module 'node:crypto' {
  export function createHash(algorithm: string): {
    update(data: Uint8Array | string): {digest(encoding: 'hex'): string}
  }
}
