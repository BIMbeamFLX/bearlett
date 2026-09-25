/**
 * Each built napplet says what it is and what it needs twice: in the page,
 * as <meta name="napplet-type"> and <meta name="napplet-requires">, for a
 * shell that reads the page alone, and in .nip5a-manifest.json, as the d tag
 * and the requires tags, for a shell that reads the kind 35129 manifest.
 * This checks that every build carries both, that <meta charset> and the two
 * metas end inside the first 1024 bytes (where the HTML prescan and a shell
 * that reads only the start of the page look), and that they say the same.
 *
 *   node scripts/check-napplet-meta.mjs
 */
import {existsSync, readFileSync} from 'node:fs'
import path from 'node:path'
import {NAPPLET_BUILDS, repoRoot} from './napplet-builds.mjs'

/** The content of the one <meta> with this name, or null when absent. */
const meta = (html, name) => {
  const found = [
    ...html.matchAll(
      new RegExp(`<meta\\s+name="${name}"\\s+content="([^"]*)"`, 'gi')
    )
  ]
  if (found.length !== 1)
    throw new Error(`${found.length} <meta name="${name}"> tags, expected 1`)
  return found[0][1]
}
const sorted = list => [...list].filter(Boolean).sort().join(',')
const HEAD_TAGS = [
  '<meta charset',
  '<meta name="napplet-type"',
  '<meta name="napplet-requires"'
]
const tagValues = (manifest, name) =>
  manifest.tags.filter(tag => tag[0] === name).map(tag => tag[1])

const problems = []
for (const {dir, script, env} of NAPPLET_BUILDS) {
  const page = path.join(repoRoot, dir, 'index.html')
  const sidecar = path.join(repoRoot, dir, '.nip5a-manifest.json')
  if (!existsSync(page) || !existsSync(sidecar)) {
    problems.push(
      `${dir}: not built, run ${env ? `${env} ` : ''}npm run ${script}`
    )
    continue
  }
  try {
    const bytes = readFileSync(page)
    const html = bytes.toString('utf8')
    const start = bytes.subarray(0, 1024).toString('latin1').toLowerCase()
    for (const tag of HEAD_TAGS) {
      const at = start.indexOf(tag)
      if (at === -1 || start.indexOf('>', at) === -1)
        throw new Error(`${tag}> does not end inside the first 1024 bytes`)
    }
    const manifest = JSON.parse(readFileSync(sidecar, 'utf8'))
    const type = meta(html, 'napplet-type')
    const requires = sorted(meta(html, 'napplet-requires').split(','))
    const [d] = tagValues(manifest, 'd')
    const declared = sorted(tagValues(manifest, 'requires'))
    if (type !== d)
      throw new Error(`napplet-type "${type}" but manifest d "${d}"`)
    if (requires !== declared)
      throw new Error(
        `napplet-requires [${requires}] but manifest requires [${declared}]`
      )
    console.log(`OK  ${dir}  ${type}  [${requires}]`)
  } catch (error) {
    problems.push(`${dir}: ${error.message}`)
  }
}

for (const problem of problems) console.error(`FAIL  ${problem}`)
process.exitCode = problems.length ? 1 : 0
