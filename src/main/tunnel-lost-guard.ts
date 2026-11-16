import type { ConnectionId } from '../shared/types.ts'
import { DatabaseConnectionError } from './adapters/postgres.ts'

export type TunnelLostPrompt = (profileId: ConnectionId) => Promise<boolean>

export interface TunnelLostGuardDeps {
  isLost(profileId: ConnectionId): boolean
  reconnect(profileId: ConnectionId): Promise<void>
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Teleport tunnels are never respawned in the background: relaunching `tsh`
 * can trigger a Teleport re-auth flow (a browser tab) without any user action.
 * Before an action touches a connection whose tunnel was lost, this guard asks
 * the user once — through a native dialog installed by the shell layer — and
 * reconnects only on confirmation. Concurrent actions share one prompt and one
 * reconnect attempt instead of stacking dialogs.
 */
export class TunnelLostGuard {
  private readonly deps: TunnelLostGuardDeps
  private prompt: TunnelLostPrompt | null = null
  private pending: Promise<boolean> | null = null
  private pendingFailure: unknown = null

  constructor(deps: TunnelLostGuardDeps) {
    this.deps = deps
  }

  setPrompt(prompt: TunnelLostPrompt | null): void {
    this.prompt = prompt
  }

  /** Throws a typed, user-actionable error when the tunnel stays down. */
  async ensure(profileId: ConnectionId): Promise<void> {
    if (!this.deps.isLost(profileId)) return
    if (!this.prompt)
      throw new DatabaseConnectionError(
        'NOT_CONNECTED',
        'The Teleport tunnel was lost. Reconnect the connection to continue.',
      )
    if (!this.pending) {
      this.pendingFailure = null
      this.pending = (async () => {
        const confirmed = await this.prompt!(profileId)
        if (!confirmed) return false
        try {
          await this.deps.reconnect(profileId)
        } catch (error) {
          this.pendingFailure = error
          return false
        }
        return !this.deps.isLost(profileId)
      })().finally(() => {
        this.pending = null
      })
    }
    const reconnected = await this.pending
    if (!reconnected) {
      const failure = this.pendingFailure
      throw failure === null
        ? new DatabaseConnectionError(
            'NOT_CONNECTED',
            'The Teleport tunnel is disconnected. Reconnect it to continue.',
          )
        : failure instanceof DatabaseConnectionError
          ? failure
          : new DatabaseConnectionError(
              'NOT_CONNECTED',
              messageOf(failure) ||
                'The Teleport tunnel could not be reconnected.',
            )
    }
  }
}
