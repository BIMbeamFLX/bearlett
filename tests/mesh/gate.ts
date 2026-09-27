// The reference TollGate on node B's loopback, taking notes of the mint that
// lives on node B's mesh address, and publishing its branch there so it can
// be paid by key; proxy.py puts it on that address, port 2121 (HTTP-01).
//
//   node tests/mesh/gate.ts <npub of node B>
import {startGate} from '../tollgate/gate.ts'

const gate = await startGate(
  {
    mints: [
      {
        withdrawUrl: `http://${process.argv[2]}.fips/w`,
        priceMsat: 1000,
        byKey: true
      }
    ]
  },
  2121
)
console.log(`reference TollGate on ${gate.url} as ${gate.pubkey}`)
