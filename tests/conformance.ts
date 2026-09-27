// The language-neutral LUD-25 vectors from lnurlcash-conformance, pinned in
// package.json (0.14.0 carries the unified taproot model and the purposes of
// lnurl/luds 50d740a; it is the content of lnurlcash-conformance PR 33).
import {readFileSync} from 'node:fs'
import {createRequire} from 'node:module'

const require = createRequire(import.meta.url)

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const vectors = (name: string): any =>
  JSON.parse(
    readFileSync(
      require.resolve(`lnurlcash-conformance/vectors/${name}.json`),
      'utf8'
    )
  )
