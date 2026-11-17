import assert from 'node:assert/strict'
import test from 'node:test'
import type { PostgresProfile } from '../../shared/types.ts'
import type { PreConnectStateEvent } from '../preconnect/teleport-manager.ts'
import { PostgresAdapter, testTunnelKey } from './postgres-adapter.ts'

class FakeTunnels {
  starts: Array<{
    id: string
    options?: { reauthenticate?: boolean }
  }> = []
  stops: Array<{ id: string; generation?: number }> = []
  lost: Set<string> = new Set()
  reconnects: string[] = []
  stateListeners = new Set<(event: PreConnectStateEvent) => void>()

  emitState(event: {
    profileId: string
    state: 'lost' | 'ready' | 'starting'
    message: string
  }): void {
    for (const listener of this.stateListeners)
      listener({
        profileId: event.profileId,
        state: event.state,
        message: event.message,
        code: null,
        generation: 1,
        timestamp: 0,
      })
  }

  onStateChanged(listener: (event: PreConnectStateEvent) => void): () => void {
    this.stateListeners.add(listener)
    return () => this.stateListeners.delete(listener)
  }

  async start(
    id: string,
    _config?: unknown,
    options?: { reauthenticate?: boolean },
  ): Promise<number> {
    this.starts.push({ id, options })
    this.lost.delete(id)
    return 42
  }

  async stop(id: string, generation?: number): Promise<void> {
    this.stops.push({ id, generation })
    this.lost.delete(id)
  }

  async stopAll(): Promise<void> {}

  state(id: string): 'lost' | undefined {
    return this.lost.has(id) ? 'lost' : undefined
  }

  async reconnect(id: string): Promise<void> {
    this.reconnects.push(id)
    this.lost.delete(id)
  }
}

function profile(overrides: Partial<PostgresProfile> = {}): PostgresProfile {
  return {
    kind: 'postgres',
    version: 2,
    id: 'p1',
    name: 'Test',
    // Loopback + a closed port so the Postgres attempt fails immediately.
    host: '127.0.0.1',
    port: 1,
    database: 'example_db',
    user: 'reader',
    password: '',
    tlsMode: 'disable',
    readonly: true,
    preConnect: {
      mode: 'teleport',
      dbService: 'example-postgres',
      tunnelPort: 1,
    },
    ...overrides,
  }
}

test('test uses a throwaway tunnel key so a live connection is untouched', async () => {
  const tunnels = new FakeTunnels()
  const adapter = new PostgresAdapter(tunnels)
  await adapter.test(profile())

  assert.equal(testTunnelKey('p1'), 'p1::test')
  assert.deepEqual(
    tunnels.starts.map((start) => start.id),
    ['p1::test'],
  )
  assert.deepEqual(tunnels.stops, [{ id: 'p1::test', generation: 42 }])
  assert.ok(
    !tunnels.starts.some((start) => start.id === 'p1') &&
      !tunnels.stops.some((stop) => stop.id === 'p1'),
    'the live profile key must never be started or stopped',
  )
})

test('connecting opts into re-authentication; testing does not', async () => {
  const tunnels = new FakeTunnels()
  const adapter = new PostgresAdapter(tunnels)

  await adapter.test(profile())
  assert.equal(tunnels.starts[0]?.options?.reauthenticate, undefined)

  await adapter.connect(profile())
  assert.equal(tunnels.starts[1]?.id, 'p1')
  assert.equal(tunnels.starts[1]?.options?.reauthenticate, true)
})

test('test without a tunnel never touches the tunnel manager', async () => {
  const tunnels = new FakeTunnels()
  const adapter = new PostgresAdapter(tunnels)
  await adapter.test(profile({ preConnect: undefined }))

  assert.equal(tunnels.starts.length, 0)
  assert.equal(tunnels.stops.length, 0)
})

test('tunnelLost and reconnectTunnel delegate to the manager state', async () => {
  const tunnels = new FakeTunnels()
  const adapter = new PostgresAdapter(tunnels)

  assert.equal(adapter.tunnelLost('p1'), false)
  tunnels.lost.add('p1')
  assert.equal(adapter.tunnelLost('p1'), true)

  await adapter.reconnectTunnel('p1')
  assert.deepEqual(tunnels.reconnects, ['p1'])
  assert.equal(adapter.tunnelLost('p1'), false)
})

test('tunnel state events surface only loss and readiness to the UI', async () => {
  const tunnels = new FakeTunnels()
  const adapter = new PostgresAdapter(tunnels)
  const seen: Array<{ profileId: string; state: 'lost' | 'ready' }> = []
  adapter.onTunnelStateChanged((event) => seen.push(event))

  tunnels.emitState({
    profileId: 'p1',
    state: 'starting',
    message: 'starting tunnel',
  })
  tunnels.emitState({
    profileId: 'p1',
    state: 'lost',
    message: 'The Teleport tunnel stopped.',
  })
  tunnels.emitState({
    profileId: 'p1',
    state: 'ready',
    message: 'Teleport tunnel ready.',
  })

  assert.deepEqual(seen, [
    { profileId: 'p1', state: 'lost', message: 'The Teleport tunnel stopped.' },
    { profileId: 'p1', state: 'ready', message: 'Teleport tunnel ready.' },
  ])
})
