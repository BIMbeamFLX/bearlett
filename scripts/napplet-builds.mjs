import path from 'node:path'
import {fileURLToPath} from 'node:url'

/** The repository root, whatever the current directory is. */
export const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
)

/** The napplet builds CI checks: the output directory and how to make it. */
export const NAPPLET_BUILDS = [{dir: 'dist-napplet', script: 'build:napplet'}]
