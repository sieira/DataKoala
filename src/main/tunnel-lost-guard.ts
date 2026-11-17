import type { ConnectionId } from '../shared/types.ts'

export type TunnelLostPrompt = (profileId: ConnectionId) => Promise<boolean>

export interface TunnelLostGuardDeps {
  isLost(profileId: ConnectionId): boolean
  reconnect(profileId: ConnectionId): Promise<void>
  /** Builds the typed error an action fails with when the tunnel stays down. */
  failure(message: string): Error
}

interface PendingPrompt {
  profileId: ConnectionId
  done: Promise<boolean>
  failure: unknown
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Teleport tunnels are never respawned in the background: relaunching `tsh`
 * can trigger a Teleport re-auth flow (a browser tab) without any user action.
 * Before an action touches a connection whose tunnel was lost, this guard asks
 * the user once, through a prompt installed by the shell layer, and reconnects
 * only on confirmation.
 */
export class TunnelLostGuard {
  private readonly deps: TunnelLostGuardDeps
  private prompt: TunnelLostPrompt | null = null
  private pending: PendingPrompt | null = null

  constructor(deps: TunnelLostGuardDeps) {
    this.deps = deps
  }

  setPrompt(prompt: TunnelLostPrompt | null): void {
    this.prompt = prompt
  }

  /** Throws a typed, user-actionable error when the tunnel stays down. */
  async requireTunnel(profileId: ConnectionId): Promise<void> {
    if (!this.deps.isLost(profileId)) return
    if (!this.prompt)
      throw this.deps.failure(
        'The Teleport tunnel was lost. Reconnect the connection to continue.',
      )
    // One dialog at a time, even across different connections: an action on a
    // second lost connection waits for the open dialog, then raises its own
    // instead of inheriting the first connection's answer.
    for (;;) {
      const pending = this.pending
      if (!pending || pending.profileId === profileId) break
      await pending.done
    }
    let record = this.pending
    if (!record || record.profileId !== profileId) {
      record = this.beginPrompt(profileId)
      this.pending = record
    }
    const reconnected = await record.done
    if (!reconnected) {
      const failure = record.failure
      throw this.deps.failure(
        failure === null
          ? 'The Teleport tunnel is disconnected. Reconnect it to continue.'
          : messageOf(failure) ||
              'The Teleport tunnel could not be reconnected.',
      )
    }
  }

  private beginPrompt(profileId: ConnectionId): PendingPrompt {
    const record: PendingPrompt = {
      profileId,
      failure: null,
      done: undefined as unknown as Promise<boolean>,
    }
    record.done = (async () => {
      try {
        const confirmed = await this.prompt?.(profileId)
        if (!confirmed) return false
        await this.deps.reconnect(profileId)
      } catch (error) {
        record.failure = error
        return false
      }
      return !this.deps.isLost(profileId)
    })().finally(() => {
      if (this.pending === record) this.pending = null
    })
    return record
  }
}
