import { readFile, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

// The tunnel layer (src/main/preconnect and src/main/tunnel-lost-guard.ts)
// sits below the data-source facade. It may depend on node builtins, npm
// packages, its own folder, and src/shared. Anything else, above all
// src/main/adapters and src/main/db.ts, points the wrong way.

const repositoryRoot = process.cwd()
const mainRoot = path.join(repositoryRoot, 'src/main')
const sharedRoot = path.join(repositoryRoot, 'src/shared')
const preconnectRoot = path.join(mainRoot, 'preconnect')

const importerRoots = [
  preconnectRoot,
  path.join(mainRoot, 'tunnel-lost-guard.ts'),
]
const allowedRoots = [preconnectRoot, sharedRoot]

const sourceExtensions = new Set(['.ts'])
const specifierPattern =
  /(?:\bfrom\s*|\bimport\s*|\bimport\(\s*)['"]([^'"]+)['"]/g

export function violationsForFile(source, importerFile, allowedRoots) {
  const violations = []

  for (const match of source.matchAll(specifierPattern)) {
    const specifier = match[1]
    if (!specifier.startsWith('.')) continue // node builtin or package
    const target = path.resolve(path.dirname(importerFile), specifier)
    const allowed = allowedRoots.some((root) => isWithin(root, target))
    if (allowed) continue
    violations.push({
      line: lineOf(source, match.index),
      specifier,
      target: path.relative(repositoryRoot, target),
    })
  }

  return violations
}

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate)
  return (
    relative === '' ||
    (!relative.startsWith('..' + path.sep) &&
      relative !== '..' &&
      !path.isAbsolute(relative))
  )
}

function lineOf(source, index) {
  let line = 1
  for (let cursor = 0; cursor < index; cursor += 1)
    if (source[cursor] === '\n') line += 1
  return line
}

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...(await sourceFiles(absolute)))
    else if (entry.isFile() && sourceExtensions.has(path.extname(entry.name)))
      files.push(absolute)
  }
  return files
}

async function main() {
  const violations = []
  for (const importerRoot of importerRoots) {
    const rootInfo = await stat(importerRoot)
    const files = rootInfo.isFile()
      ? [importerRoot]
      : await sourceFiles(importerRoot)
    for (const file of files) {
      const source = await readFile(file, 'utf8')
      for (const violation of violationsForFile(source, file, allowedRoots))
        violations.push({
          file: path.relative(repositoryRoot, file),
          ...violation,
        })
    }
  }

  if (!violations.length) {
    console.log(
      'Tunnel-layer imports stay within preconnect, shared, and node builtins.',
    )
    return
  }

  for (const violation of violations)
    console.log(
      `${violation.file}:${violation.line} imports "${violation.specifier}" (resolves outside the tunnel layer: ${violation.target})`,
    )
  console.error(
    `\nFound ${violations.length} forbidden import${violations.length === 1 ? '' : 's'}.`,
  )
  console.error(
    'src/main/preconnect and src/main/tunnel-lost-guard.ts may only import node builtins, npm packages, their own folder, and src/shared.',
  )
  process.exit(1)
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) await main()
