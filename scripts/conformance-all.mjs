/**
 * Run @napplet/conformance-cli on every built napplet and show every report.
 *
 *   node scripts/conformance-all.mjs
 *
 * A chain of `napplet-conformance a && napplet-conformance b` stops at the
 * first non-conformant build and the others are never looked at. This runs
 * all of them, prints each report as it comes and exits 1 if any failed.
 */
import {spawnSync} from 'node:child_process'
import {existsSync} from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {NAPPLET_BUILDS, repoRoot} from './napplet-builds.mjs'

const cli = fileURLToPath(
  import.meta.resolve('@napplet/conformance-cli/dist/cli.js')
)
const VERDICT = {0: 'CONFORMANT', 1: 'NON-CONFORMANT'}

const results = []
for (const {dir, script, env} of NAPPLET_BUILDS) {
  console.log(`\n=== napplet-conformance ${dir} ===`)
  if (!existsSync(path.join(repoRoot, dir, 'index.html'))) {
    console.log(`not built: run ${env ? `${env} ` : ''}npm run ${script}`)
    results.push({dir, code: 2})
    continue
  }
  const run = spawnSync(process.execPath, [cli, dir], {
    cwd: repoRoot,
    stdio: 'inherit'
  })
  results.push({dir, code: run.status ?? 2})
}

console.log('\n=== conformance summary ===')
for (const {dir, code} of results)
  console.log(`${(VERDICT[code] ?? 'ERROR').padEnd(14)}  ${dir}`)
process.exitCode = results.every(({code}) => code === 0) ? 0 : 1
