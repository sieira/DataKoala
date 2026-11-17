import assert from 'node:assert/strict'
import test from 'node:test'
import path from 'node:path'
import { violationsForFile } from './lint-main-imports.mjs'

const mainRoot = path.resolve('src/main')
const preconnectRoot = path.join(mainRoot, 'preconnect')
const sharedRoot = path.resolve('src/shared')
const allowedRoots = [preconnectRoot, sharedRoot]
const managerFile = path.join(preconnectRoot, 'teleport-manager.ts')
const guardFile = path.join(mainRoot, 'tunnel-lost-guard.ts')

test('tunnel-layer files may import node builtins, their own folder, and shared', () => {
  const source = [
    "import { spawn } from 'node:child_process'",
    "import { TeleportTunnelManager } from './teleport-manager.ts'",
    "import type { ConnectionId } from '../../shared/types.ts'",
    "import { probePort } from './port-probe.ts'",
  ].join('\n')

  assert.deepEqual(violationsForFile(source, managerFile, allowedRoots), [])
})

test('an import from the adapters layer is a violation with a line number', () => {
  const source = [
    "import type { ConnectionId } from '../../shared/types.ts'",
    "import { DatabaseConnectionError } from '../adapters/postgres.ts'",
    "import { something } from '../db.ts'",
  ].join('\n')

  assert.deepEqual(
    violationsForFile(source, managerFile, allowedRoots).map(
      ({ line, specifier }) => ({ line, specifier }),
    ),
    [
      { line: 2, specifier: '../adapters/postgres.ts' },
      { line: 3, specifier: '../db.ts' },
    ],
  )
})

test('the guard may not import from adapters either, including dynamic imports', () => {
  const source = [
    "import type { ConnectionId } from '../shared/types.ts'",
    "const error = await import('./adapters/postgres.ts')",
  ].join('\n')

  assert.equal(violationsForFile(source, guardFile, allowedRoots).length, 1)
})

test('imports outside the tunnel layer are untouched by the rule', () => {
  const source =
    "import { PostgresAdapter } from './adapters/postgres-adapter.ts'"
  const facadeFile = path.join(mainRoot, 'db.ts')

  // The rule only applies to files under the importer roots, which the caller
  // selects; a facade file passed in with the tunnel roots is still checked.
  const violations = violationsForFile(source, facadeFile, allowedRoots)
  assert.equal(violations.length, 1)

  // The same import inside an allowed root resolves within it.
  const adapterFile = path.join(mainRoot, 'adapters', 'postgres-adapter.ts')
  const adapterRoot = path.join(mainRoot, 'adapters')
  assert.deepEqual(
    violationsForFile(source, adapterFile, [adapterRoot, sharedRoot]),
    [],
  )
})

test('path traversal is resolved before the boundary check', () => {
  const source = "import { x } from '../preconnect/../adapters/postgres.ts'"
  const violations = violationsForFile(
    source,
    path.join(preconnectRoot, 'example.ts'),
    allowedRoots,
  )
  assert.equal(violations.length, 1)
  assert.equal(
    violations[0].target,
    path.join('src', 'main', 'adapters', 'postgres.ts'),
  )
})
