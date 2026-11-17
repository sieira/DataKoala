import assert from 'node:assert/strict'
import test from 'node:test'
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
    failure: (message) => new Error(message),
  })
  return { guard, lost, reconnects }
}

test('requireTunnel passes through when the tunnel is not lost', async () => {
  const { guard } = harness()
  guard.setPrompt(async () => {
    throw new Error('the prompt must not be shown')
  })
  await guard.requireTunnel('p1')
})

test('requireTunnel without an installed prompt fails with an actionable error', async () => {
  const { guard, lost } = harness()
  lost.add('p1')
  guard.setPrompt(null)
  await assert.rejects(
    guard.requireTunnel('p1'),
    /Reconnect the connection to continue/,
  )
})

test('requireTunnel prompts once, reconnects on confirmation, and the action proceeds', async () => {
  const { guard, lost, reconnects } = harness()
  lost.add('p1')
  let prompts = 0
  guard.setPrompt(async (id) => {
    prompts += 1
    assert.equal(id, 'p1')
    return true
  })

  // Concurrent actions on the same connection share one prompt and one
  // reconnect attempt.
  await Promise.all([guard.requireTunnel('p1'), guard.requireTunnel('p1')])
  assert.equal(prompts, 1)
  assert.deepEqual(reconnects, ['p1'])
  assert.equal(lost.has('p1'), false)

  await guard.requireTunnel('p1')
  assert.equal(prompts, 1)
})

test('a second lost connection queues its own dialog instead of joining the first', async () => {
  const { guard, lost, reconnects } = harness()
  lost.add('a')
  lost.add('b')
  const prompts: string[] = []
  guard.setPrompt(async (id) => {
    prompts.push(id)
    return true
  })

  const first = guard.requireTunnel('a')
  const second = guard.requireTunnel('b')
  await Promise.all([first, second])

  assert.deepEqual(prompts, ['a', 'b'])
  assert.deepEqual(reconnects, ['a', 'b'])
  assert.equal(lost.has('a'), false)
  assert.equal(lost.has('b'), false)
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
    guard.requireTunnel('p1'),
    /The Teleport tunnel is disconnected/,
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
    failure: (message) => new Error(message),
  })
  guardThatCannotReconnect.setPrompt(async () => true)
  await assert.rejects(
    guardThatCannotReconnect.requireTunnel('p1'),
    /tsh login/,
  )
})

test('a reconnect that leaves the tunnel lost keeps the action blocked', async () => {
  // The reconnect ran but did not restore the tunnel.
  const guard = new TunnelLostGuard({
    isLost: () => true,
    reconnect: async () => {},
    failure: (message) => new Error(message),
  })
  guard.setPrompt(async () => true)
  await assert.rejects(
    guard.requireTunnel('p1'),
    /The Teleport tunnel is disconnected/,
  )
})

test('a rejected prompt fails the action with a typed error carrying the reason', async () => {
  const reconnects: string[] = []
  const guard = new TunnelLostGuard({
    isLost: () => true,
    reconnect: async (id) => {
      reconnects.push(id)
    },
    failure: (message) => new Error(message),
  })
  guard.setPrompt(async () => {
    throw new Error('the dialog window was destroyed')
  })
  await assert.rejects(
    guard.requireTunnel('p1'),
    /the dialog window was destroyed/,
  )
  assert.deepEqual(reconnects, [])
})
