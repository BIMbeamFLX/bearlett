import {execFileSync} from 'node:child_process'
import {resolve} from 'node:path'
import {fileURLToPath} from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const file = root + '/tests/integration/compose.yaml'
const linuxFile = file
  .replaceAll('\\', '/')
  .replace(/^([A-Z]):/i, (_, d) => '/mnt/' + d.toLowerCase())
/** Invoke only this project's isolated compose stack, without shell interpolation. */
export function docker(...args) {
  const command = process.platform === 'win32' ? 'wsl' : 'docker'
  const prefix =
    process.platform === 'win32' ? ['-d', 'Ubuntu', '--', 'docker'] : []
  return execFileSync(command, [...prefix, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim()
}
export const compose = (...args) =>
  docker(
    'compose',
    '-f',
    process.platform === 'win32' ? linuxFile : file,
    ...args
  )
export const lightning = (node, ...args) =>
  JSON.parse(compose('exec', '-T', node, 'lncli', '--network=regtest', ...args))
const bitcoin = (...args) =>
  compose(
    'exec',
    '-T',
    'bitcoin',
    'bitcoin-cli',
    '-regtest',
    '-rpcuser=bearlett',
    '-rpcpassword=regtest-only',
    ...args
  )
const wait = async fn => {
  for (let i = 0; i < 60; i++) {
    try {
      if (fn()) return
    } catch {}
    await new Promise(r => setTimeout(r, 1000))
  }
  throw new Error('Regtest startup did not become ready within 60 seconds.')
}
export async function bootstrap() {
  console.log('Starting isolated Bitcoin and Lightning regtest nodes.')
  compose('up', '-d', 'bitcoin', 'alice', 'bob')
  await wait(() => bitcoin('getblockchaininfo'))
  try {
    bitcoin('createwallet', 'bearlett')
  } catch {}
  try {
    bitcoin('loadwallet', 'bearlett')
  } catch {}
  const address = bitcoin('getnewaddress')
  if (Number(bitcoin('getblockcount')) < 101)
    bitcoin('generatetoaddress', '101', address)
  await wait(
    () =>
      lightning('alice', 'getinfo').synced_to_chain &&
      lightning('bob', 'getinfo').synced_to_chain
  )
  const peer = lightning('bob', 'getinfo').identity_pubkey
  try {
    lightning('alice', 'connect', '--perm', peer + '@bob:9735')
  } catch {}
  if (!lightning('alice', 'listchannels').channels.length) {
    const destination = lightning('alice', 'newaddress', 'p2wkh').address
    bitcoin('sendtoaddress', destination, '1')
    bitcoin('generatetoaddress', '6', address)
    await wait(
      () => Number(lightning('alice', 'walletbalance').confirmed_balance) > 0
    )
    lightning(
      'alice',
      'openchannel',
      '--node_key=' + peer,
      '--local_amt=1000000',
      '--push_amt=500000',
      '--sat_per_vbyte=1'
    )
    bitcoin('generatetoaddress', '6', address)
    await wait(() =>
      lightning('alice', 'listchannels').channels.some(c => c.active)
    )
  }
  await wait(
    () =>
      lightning('alice', 'listchannels').channels.some(c => c.active) &&
      lightning('bob', 'listchannels').channels.some(c => c.active)
  )
  compose('up', '-d', 'cashu', 'lnurl')
  console.log(
    'Regtest channel ready; both mints started on localhost:43338 and localhost:48111.'
  )
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await bootstrap()
