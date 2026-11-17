import assert from 'node:assert/strict'
import test from 'node:test'
import type { TeleportPreConnect } from '../shared/types.ts'
import { __tunnelTesting } from './adapters/postgres-adapter.ts'
import {
  DatabaseConnectionError,
  refreshMetadata,
  runQuery,
  setTunnelLostPrompt,
} from './db.ts'

const config: TeleportPreConnect = {
  mode: 'teleport',
  dbService: 'example-postgres',
  tunnelPort: 5433,
}

test('runQuery prompts on a lost tunnel and fails with a typed error on cancel', async () => {
  const manager = __tunnelTesting.sharedTunnels
  let prompts = 0
  setTunnelLostPrompt(async () => {
    prompts += 1
    return false
  })
  manager.markLostForTest('wiring-a', config)
  try {
    await assert.rejects(
      runQuery('wiring-a', 'select 1'),
      (error: unknown) =>
        error instanceof DatabaseConnectionError &&
        error.code === 'NOT_CONNECTED' &&
        /disconnected/.test(error.message),
    )
    assert.equal(prompts, 1)
  } finally {
    await manager.stopAll()
    setTunnelLostPrompt(null)
  }
})

test('refreshMetadata goes through the same guard, and connected actions never prompt', async () => {
  const manager = __tunnelTesting.sharedTunnels
  let prompts = 0
  setTunnelLostPrompt(async () => {
    prompts += 1
    return false
  })
  manager.markLostForTest('wiring-b', config)
  try {
    await assert.rejects(
      refreshMetadata('wiring-b'),
      (error: unknown) =>
        error instanceof DatabaseConnectionError &&
        error.code === 'NOT_CONNECTED',
    )
    assert.equal(prompts, 1)

    // An unknown, never-connected profile has no lost tunnel: the guard passes
    // through without prompting and the action fails as not connected.
    await assert.rejects(
      refreshMetadata('wiring-unknown'),
      (error: unknown) => error instanceof DatabaseConnectionError,
    )
    assert.equal(prompts, 1)
  } finally {
    await manager.stopAll()
    setTunnelLostPrompt(null)
  }
})
