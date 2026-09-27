// Bearlett's wallet core on FIPS node A, paying with LNURLcash notes at a
// mint that exists only on the mesh, as http://<npub of node B>.fips, and
// paying a TollGate there, at http://<npub of node B>.fips:2121.
//
//   node tests/mesh/wallet.ts <npub of node B>
import {Wallet} from '../../src/wallet/wallet.ts'
import {memoryStore} from '../../src/wallet/store.ts'
import {newMnemonic} from '../../src/wallet/vault.ts'
import {fetchNet, fetchTollGate} from '../../src/platform/web.ts'
import {parseNoteLink} from '../../src/lnurl/links.ts'
import {decodeSpend} from '../../src/spec/notes.ts'
import {parseAdvertisement} from '../../src/tollgate/tollgate.ts'
import {choicesFor, payTollGate} from '../../src/tollgate/customer.ts'

const MINT = `${process.argv[2]}.fips`
const PAY = `http://${MINT}/.well-known/lnurlp/mint`
let failed = 0
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  (${detail})` : ''}`)
}
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const pay = async (verify: string): Promise<boolean> => {
  const hash = new URL(verify).pathname.split('/').pop()
  const answer = await fetch(`http://${MINT}/_test/settle?payment_hash=${hash}`)
  return (await answer.json()).settled
}
const wallet = (words = newMnemonic()) =>
  Wallet.create({net: fetchNet, store: memoryStore()}, words, '')

try {
  const words = newMnemonic()
  const alice = await wallet(words)
  const mint = await alice.addMint(PAY)
  check(
    'the mint is added over the mesh',
    mint.domain === MINT,
    mint.withdrawLink
  )

  const op = await alice.requestMint(MINT, 50_000)
  check('an invoice over the mesh', op.pr.startsWith('lnbc'))
  check('paid through the mesh', await pay(op.verify!))
  check(
    'credited, less the fee',
    (await alice.settleMint(op)) && alice.balanceMsat() === 49_000
  )

  const sent = await alice.send(MINT, 10_000)
  const link = alice.noteLink(sent.q)
  check(
    'a bearer link on the .fips mint',
    link.startsWith(`lnurlw://${MINT}/w?k1=`)
  )

  const bob = await wallet()
  const parsed = parseNoteLink(link)!
  await bob.trustMintOf(parsed.endpoint)
  await bob.receive(parsed)
  check('received and rotated over the mesh', bob.balanceMsat() === 10_000)

  const own = alice.notes({role: 'own', status: 'live'})[0]
  check(
    'own notes spend by key path',
    decodeSpend((alice as any).spendOf(own))?.kind === 'key'
  )

  await alice.pay(MINT, 'lnbc50n1' + 'q'.repeat(52))
  await sleep(200)
  await alice.settle()
  check(
    'an invoice paid (split, then melt)',
    alice.balanceMsat() === 32_000,
    `${alice.balanceMsat()} msat`
  )

  const restored = await wallet(words)
  await restored.addMint(PAY)
  await restored.recover(MINT)
  check(
    'recovered from the words over the mesh',
    restored.balanceMsat() === alice.balanceMsat()
  )

  // ---- a TollGate on the mesh, taking notes of the mesh mint ----
  const GATE = `http://${MINT}:2121/`
  const ad = parseAdvertisement(await fetchTollGate.get(GATE))
  check(
    'the TollGate advertises the mesh mint, and its key there',
    ad.offers[0]?.mint === `http://${MINT}/w` && Boolean(ad.offers[0]?.cpub)
  )
  const carol = await wallet()
  await carol.addMint(PAY)
  const topUp = await carol.requestMint(MINT, 20_000)
  await pay(topUp.verify!)
  await carol.settleMint(topUp)
  const [choice] = choicesFor(ad, carol)
  const byKey = await payTollGate(carol, fetchTollGate, GATE, ad, choice, 3)
  check(
    'paid the TollGate by key over the mesh',
    byKey.payment.via === 'key' && byKey.session.allotment === 3 * 60_000,
    byKey.payment.body
  )
  // behind a portal: the TollGate answers, the mint does not
  await carol.setOffline(true)
  const whole = await payTollGate(carol, fetchTollGate, GATE, ad, choice, 2)
  check(
    'paid it with a whole note while the mint was out of reach',
    whole.payment.via === 'whole note' &&
      whole.payment.amountMsat === 15_000 &&
      whole.session.allotment === (3 + 15) * 60_000,
    `${whole.session.allotment} ms in all`
  )
  await carol.setOffline(false)
  await carol.settle()
  check(
    'the TollGate rotated the note it was handed',
    carol.snapshot.notes[whole.payment.q]?.status === 'spent'
  )
} catch (err) {
  failed++
  console.log('ERROR', err)
}
console.log(failed ? `\n${failed} FAILED` : '\nmesh run passed')
process.exit(failed ? 1 : 0)
