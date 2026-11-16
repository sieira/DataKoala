import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseConnectionError } from './adapters/postgres.ts'
import { TunnelLostGuard } from './tunnel-lost-guard.ts'

interface Harness {
  guard: TunnelLostGuard
  lost: Set<string>
  reconnects: string[]
}

function harness(): Harness {
  const lost = new Set<string>()
  const reconnects: string[] = []
  const guard = new TunnelLostGuard({
    isLost: (id) => lost.has(id),
    reconnect: async (id) => {
      reconnects.push(id)
      lost.delete(id)
    },
  })
  return { guard, lost, reconnects }
}

test('ensure passes through when the tunnel is not lost', async () => {
  const { guard } = harness()
  guard.setPrompt(async () => {
    throw new Error('the prompt must not be shown')
  })
  await guard.ensure('p1')
})

test('ensure without an installed prompt fails with an actionable error', async () => {
  const { guard, lost } = harness()
  lost.add('p1')
  guard.setPrompt(null)
  await assert.rejects(
    guard.ensure('p1'),
    (error: unknown) =>
      error instanceof DatabaseConnectionError &&
      error.code === 'NOT_CONNECTED' &&
      /Reconnect the connection/.test(error.message),
  )
})

test('ensure prompts once, reconnects on confirmation, and the action proceeds', async () => {
  const { guard, lost, reconnects } = harness()
  lost.add('p1')
  let prompts = 0
  guard.setPrompt(async (id) => {
    prompts += 1
    assert.equal(id, 'p1')
    return true
  })

  // Concurrent actions share one dialog and one reconnect attempt.
  await Promise.all([guard.ensure('p1'), guard.ensure('p1')])
  assert.equal(prompts, 1)
  assert.deepEqual(reconnects, ['p1'])
  assert.equal(lost.has('p1'), false)

  await guard.ensure('p1')
  assert.equal(prompts, 1)
})

test('cancelling the prompt fails the action without reconnecting', async () => {
  const { guard, lost, reconnects } = harness()
  lost.add('p1')
  let prompts = 0
  guard.setPrompt(async () => {
    prompts += 1
    return false
  })
  await assert.rejects(
    guard.ensure('p1'),
    (error: unknown) =>
      error instanceof DatabaseConnectionError &&
      error.code === 'NOT_CONNECTED' &&
      /disconnected/.test(error.message),
  )
  assert.equal(prompts, 1)
  assert.deepEqual(reconnects, [])
})

test('a failed reconnect keeps the action blocked and surfaces the reason', async () => {
  const { lost } = harness()
  lost.add('p1')
  const guardThatCannotReconnect = new TunnelLostGuard({
    isLost: () => lost.has('p1'),
    reconnect: async () => {
      throw new Error(
        'Your Teleport session has expired. Run "tsh login", then try again.',
      )
    },
  })
  guardThatCannotReconnect.setPrompt(async () => true)
  await assert.rejects(
    guardThatCannotReconnect.ensure('p1'),
    (error: unknown) =>
      error instanceof DatabaseConnectionError &&
      error.code === 'NOT_CONNECTED' &&
      /tsh login/.test(error.message),
  )
})

test('a reconnect that leaves the tunnel lost keeps the action blocked', async () => {
  // The reconnect ran but did not restore the tunnel.
  const guard = new TunnelLostGuard({
    isLost: () => true,
    reconnect: async () => {},
  })
  guard.setPrompt(async () => true)
  await assert.rejects(
    guard.ensure('p1'),
    (error: unknown) =>
      error instanceof DatabaseConnectionError &&
      /disconnected/.test(error.message),
  )
})
