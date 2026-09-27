// The conformance mock mint on node B's loopback, with its test hooks;
// proxy.py puts it on node B's mesh address.
import {createMockMint} from 'lnurlcash-conformance/mock-mint'

const mint = await createMockMint({
  port: 3338,
  testHooks: true,
  baseFeeMsat: 1000
})
console.log(`mock mint on ${mint.url}`)
