import { execFile, spawn } from 'node:child_process'
import type { ConnectionId, TeleportPreConnect } from '../../shared/types.ts'
import {
  PreConnectError,
  type PreConnectErrorCode,
  classifyTshStatusFailure,
  summarizeTshFailure,
} from './errors.ts'
import {
  DEFAULT_TUNNEL_HOST,
  buildLoginArgs,
  buildProxyDbArgs,
  isSessionExpired,
  isValidTunnelPort,
  parseTshStatus,
  resolveTshBinary,
  tunnelTimeout,
  type TshStatus,
} from '../../shared/teleport.ts'
import {
  DEFAULT_PROBE_CONNECT_TIMEOUT_MS,
  probePort,
  waitForPort,
} from './port-probe.ts'

export type PreConnectState =
  | 'checking-tsh'
  | 'checking-login'
  | 'reauthenticating'
  | 'starting'
  | 'waiting-for-port'
  | 'ready'
  | 'lost'
  | 'failed'
  | 'stopped'

export interface PreConnectStateEvent {
  profileId: ConnectionId
  state: PreConnectState
  message: string
  code: PreConnectErrorCode | null
  generation: number
  timestamp: number
}

/** Minimal child surface the manager needs; satisfied by `ChildProcess`. */
export interface TunnelProcess {
  readonly pid?: number
  on(
    event: 'exit',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
  once(event: 'exit' | 'error', listener: () => void): unknown
  stdout: {
    on(event: 'data', listener: (chunk: unknown) => void): unknown
  } | null
  stderr: {
    on(event: 'data', listener: (chunk: unknown) => void): unknown
  } | null
  kill(signal?: NodeJS.Signals): boolean
}

export interface TeleportDeps {
  spawnTsh(
    binary: string,
    args: string[],
    env: NodeJS.ProcessEnv,
  ): TunnelProcess
  checkStatus(
    binary: string,
    env: NodeJS.ProcessEnv,
    signal: AbortSignal,
  ): Promise<TshStatus>
  /**
   * Runs `tsh login` so the certificate renews in the user's browser. Only
   * reachable from flows the user explicitly confirmed (connect, reconnect).
   */
  login(
    binary: string,
    args: string[],
    env: NodeJS.ProcessEnv,
    signal: AbortSignal,
  ): Promise<void>
  waitForPort(
    port: number,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<void>
  probePort(port: number): Promise<boolean>
  /**
   * True when a `tsh proxy db --tunnel` process for this exact port and
   * database service is already running — a leftover from a previous app run
   * or the user's own terminal. Such a listener can be adopted.
   */
  findExistingTunnel(port: number, dbService: string): Promise<boolean>
  now(): number
  healthIntervalMs: number
  healthFailureThreshold: number
  killGraceMs: number
}

interface ManagedTunnel {
  config: TeleportPreConnect
  generation: number
  state: PreConnectState
  stopping: boolean
  child: TunnelProcess | null
  termination?: Promise<void>
  abort: AbortController
  healthTimer: ReturnType<typeof setInterval> | null
  consecutiveHealthFailures: number
}

/** Internal sentinel: this attempt lost an intent/generation race and must unwind quietly. */
export class SupersededError extends Error {
  constructor() {
    super('This connection attempt was superseded by a newer connection.')
    this.name = 'SupersededError'
  }
}

function isKeepaliveEnabled(config: TeleportPreConnect): boolean {
  return config.keepalive !== false
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function killProcessTree(child: TunnelProcess, signal: NodeJS.Signals): void {
  const pid = child.pid
  if (process.platform === 'win32' || pid === undefined) {
    try {
      child.kill(signal)
    } catch {
      /* process already gone */
    }
    return
  }
  // The child is spawned detached, so its pgid equals its pid: signalling the
  // negative pid reaches tsh and any helper processes it started.
  try {
    process.kill(-pid, signal)
  } catch {
    try {
      child.kill(signal)
    } catch {
      /* process already gone */
    }
  }
}

function defaultSpawnTsh(
  binary: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): TunnelProcess {
  const child = spawn(binary, args, {
    env,
    detached: true,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return child as unknown as TunnelProcess
}

async function defaultCheckStatus(
  binary: string,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
): Promise<TshStatus> {
  return new Promise<TshStatus>((resolve, reject) => {
    execFile(
      binary,
      ['status', '--format=json'],
      { env, timeout: 15_000, windowsHide: true, signal },
      (error, stdout, stderr) => {
        if (error) {
          const code = (error as NodeJS.ErrnoException).code
          if (code === 'ENOENT') {
            reject(
              new PreConnectError(
                'TSH_NOT_FOUND',
                `Could not find "${binary}". Install tsh, or set an absolute path to it in the advanced settings.`,
              ),
            )
            return
          }
          const detail = summarizeTshFailure(stderr ?? '', stdout ?? '')
          const classified = classifyTshStatusFailure(detail)
          if (classified) {
            reject(classified)
            return
          }
          reject(
            new PreConnectError(
              'TUNNEL_FAILED',
              detail || `Could not read Teleport status: ${messageOf(error)}`,
            ),
          )
          return
        }
        try {
          resolve(parseTshStatus(stdout))
        } catch {
          reject(
            new PreConnectError(
              'TUNNEL_FAILED',
              'Could not read the Teleport status output.',
            ),
          )
        }
      },
    )
  })
}

const LOGIN_TIMEOUT_MS = 180_000

/**
 * Detects a `tsh proxy db --tunnel` command line serving the exact port and
 * database service. Such a tunnel is one of ours (this app, a previous run, or
 * the user's own terminal) and can be reused; anything else on the port is a
 * foreign listener. Windows has no `ps`; there the check resolves false and
 * the occupied-port error carries the diagnosis.
 */
async function defaultFindExistingTunnel(
  port: number,
  dbService: string,
): Promise<boolean> {
  if (process.platform === 'win32') return false
  return new Promise<boolean>((resolve) => {
    execFile(
      'ps',
      ['-Ao', 'pid=,command='],
      { timeout: 5_000 },
      (error, stdout) => {
        if (error) {
          resolve(false)
          return
        }
        const portMatch = new RegExp(
          `(?:^|\\s)(?:-p|--port)(?:[ =])?${port}\\b`,
        )
        resolve(
          String(stdout)
            .split('\n')
            .some(
              (line) =>
                line.includes('proxy db') &&
                line.includes('--tunnel') &&
                line.includes(dbService) &&
                portMatch.test(line),
            ),
        )
      },
    )
  })
}

async function defaultLogin(
  binary: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    execFile(
      binary,
      args,
      { env, timeout: LOGIN_TIMEOUT_MS, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          const detail = summarizeTshFailure(stderr ?? '', stdout ?? '')
          reject(
            new PreConnectError(
              'TSH_NOT_LOGGED_IN',
              detail ||
                `Teleport authentication did not complete: ${messageOf(error)}`,
            ),
          )
          return
        }
        resolve()
      },
    )
  })
}

export function createTeleportDeps(
  overrides: Partial<TeleportDeps> = {},
): TeleportDeps {
  return {
    spawnTsh: defaultSpawnTsh,
    checkStatus: defaultCheckStatus,
    login: defaultLogin,
    findExistingTunnel: defaultFindExistingTunnel,
    waitForPort: (port, timeoutMs, signal) =>
      waitForPort({
        host: DEFAULT_TUNNEL_HOST,
        port,
        timeoutMs,
        signal,
      }),
    probePort: (port) =>
      probePort(DEFAULT_TUNNEL_HOST, port, DEFAULT_PROBE_CONNECT_TIMEOUT_MS),
    now: () => Date.now(),
    healthIntervalMs: 10_000,
    healthFailureThreshold: 2,
    killGraceMs: 2000,
    ...overrides,
  }
}

/**
 * Owns one `tsh proxy db` process per profile. Starting is generation-guarded so
 * a superseded connect can neither kill nor leak a fresh tunnel, and readiness is
 * confirmed by polling the local port before the caller opens a Postgres pool.
 *
 * A dropped tunnel is never respawned in the background: relaunching `tsh` can
 * trigger a Teleport re-auth flow (a browser tab) without any user action. The
 * tunnel enters the `lost` state instead and only `reconnect` — called after the
 * user confirms — starts it again.
 */
export class TeleportTunnelManager {
  private readonly deps: TeleportDeps
  private readonly tunnels = new Map<ConnectionId, ManagedTunnel>()
  private readonly intents = new Map<ConnectionId, number>()
  private readonly listeners = new Set<(event: PreConnectStateEvent) => void>()
  private nextIntent = 0
  private nextGeneration = 0

  constructor(deps: Partial<TeleportDeps> = {}) {
    this.deps = createTeleportDeps(deps)
  }

  onStateChanged(listener: (event: PreConnectStateEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  state(profileId: ConnectionId): PreConnectState | undefined {
    return this.tunnels.get(profileId)?.state
  }

  isReady(profileId: ConnectionId): boolean {
    return this.tunnels.get(profileId)?.state === 'ready'
  }

  /**
   * Starts (or restarts) a tunnel and resolves to its generation once it is
   * accepting connections. The caller passes that generation back to `stop` so a
   * superseded attempt cannot close a newer tunnel that shares the profile id.
   *
   * `reauthenticate` marks a user-initiated flow: when the Teleport certificate
   * is missing or expired, the manager runs `tsh login`, which renews it in the
   * user's browser. Keepalive never reaches here with that intent.
   */
  async start(
    profileId: ConnectionId,
    config: TeleportPreConnect,
    options: { reauthenticate?: boolean } = {},
  ): Promise<number> {
    const intent = ++this.nextIntent
    this.intents.set(profileId, intent)
    await this.stop(profileId)
    // stop() cleared any prior intent; reclaim ownership for this attempt.
    this.intents.set(profileId, intent)

    this.validate(config)
    const managed = this.newManagedTunnel(config)
    this.tunnels.set(profileId, managed)
    this.setState(
      managed,
      profileId,
      'checking-tsh',
      'Preparing Teleport tunnel…',
    )

    try {
      await this.openTunnel(managed, profileId, intent, options)
    } catch (error) {
      if (error instanceof SupersededError) throw error
      await this.fail(managed, profileId, error)
      throw error
    }
    return managed.generation
  }

  /**
   * Restores a tunnel that entered the `lost` state, keeping its generation so
   * a caller holding the original one can still stop the restored tunnel. A
   * failed reconnect keeps the tunnel lost (with the failure surfaced in the
   * state event) so the user can retry. Reconnecting is always user-confirmed,
   * so it may renew the certificate through `tsh login`.
   */
  async reconnect(profileId: ConnectionId): Promise<void> {
    const managed = this.tunnels.get(profileId)
    if (!managed || managed.state !== 'lost') return
    const intent = ++this.nextIntent
    this.intents.set(profileId, intent)
    try {
      await this.openTunnel(managed, profileId, intent, {
        reauthenticate: true,
      })
    } catch (error) {
      if (error instanceof SupersededError) throw error
      await this.terminate(managed)
      if (managed.stopping || this.tunnels.get(profileId) !== managed)
        throw error
      this.setState(
        managed,
        profileId,
        'lost',
        messageOf(error),
        error instanceof PreConnectError ? error.code : null,
      )
      throw error
    }
  }

  private async openTunnel(
    managed: ManagedTunnel,
    profileId: ConnectionId,
    intent: number,
    options: { reauthenticate?: boolean },
  ): Promise<void> {
    try {
      // A dropped tunnel is often an expired certificate; re-checking login
      // turns a cryptic failure into an actionable message.
      await this.verifyLogin(managed, profileId, intent)
      await this.launch(managed, profileId, intent)
    } catch (error) {
      const canReauthenticate =
        options.reauthenticate === true &&
        error instanceof PreConnectError &&
        error.code === 'TSH_NOT_LOGGED_IN'
      if (!canReauthenticate) throw error
      // The user asked for this tunnel, so renew the certificate openly in
      // their browser instead of telling them to run `tsh login` themselves.
      await this.reauthenticate(managed, profileId, intent)
      await this.verifyLogin(managed, profileId, intent)
      await this.launch(managed, profileId, intent)
    }
  }

  private async reauthenticate(
    managed: ManagedTunnel,
    profileId: ConnectionId,
    intent: number,
  ): Promise<void> {
    this.ensureCurrent(profileId, managed, intent)
    this.setState(
      managed,
      profileId,
      'reauthenticating',
      'Opening Teleport authentication in your browser…',
    )
    await this.deps.login(
      resolveTshBinary(managed.config),
      buildLoginArgs(managed.config),
      this.env(),
      managed.abort.signal,
    )
    this.ensureCurrent(profileId, managed, intent)
  }

  private newManagedTunnel(config: TeleportPreConnect): ManagedTunnel {
    return {
      config,
      generation: ++this.nextGeneration,
      state: 'checking-tsh',
      stopping: false,
      child: null,
      abort: new AbortController(),
      healthTimer: null,
      consecutiveHealthFailures: 0,
    }
  }

  /**
   * Test seam: records a `lost` tunnel for `profileId` without running `tsh`,
   * so higher-level tests can exercise loss handling end to end.
   */
  markLostForTest(profileId: ConnectionId, config: TeleportPreConnect): void {
    const managed = this.newManagedTunnel(config)
    this.tunnels.set(profileId, managed)
    this.setState(
      managed,
      profileId,
      'lost',
      'The Teleport tunnel stopped. (test seam)',
    )
  }

  async stop(profileId: ConnectionId, generation?: number): Promise<void> {
    const current = this.tunnels.get(profileId)
    if (generation !== undefined && current?.generation !== generation) {
      // A newer tunnel (or none) owns the id; leave it untouched.
      return
    }
    this.intents.delete(profileId)
    if (!current) return
    current.stopping = true
    current.abort.abort()
    this.stopHealth(current)
    await this.terminate(current)
    if (this.tunnels.get(profileId) === current) this.tunnels.delete(profileId)
    this.setState(current, profileId, 'stopped', 'Teleport tunnel closed.')
  }

  async stopAll(): Promise<void> {
    await Promise.allSettled(
      [...this.tunnels.keys()].map((profileId) => this.stop(profileId)),
    )
  }

  private validate(config: TeleportPreConnect): void {
    if (!config || config.mode !== 'teleport')
      throw new PreConnectError(
        'INVALID_CONFIG',
        'The Teleport pre-connect configuration is invalid.',
      )
    if (!config.dbService?.trim())
      throw new PreConnectError(
        'INVALID_CONFIG',
        'A Teleport database service name is required.',
      )
    if (!isValidTunnelPort(config.tunnelPort))
      throw new PreConnectError(
        'INVALID_CONFIG',
        'The tunnel port must be a whole number between 1 and 65535.',
      )
  }

  private env(): NodeJS.ProcessEnv {
    return { ...process.env }
  }

  private current(
    profileId: ConnectionId,
    managed: ManagedTunnel,
    intent: number,
  ): boolean {
    return (
      this.intents.get(profileId) === intent &&
      this.tunnels.get(profileId)?.generation === managed.generation &&
      !managed.stopping
    )
  }

  private ensureCurrent(
    profileId: ConnectionId,
    managed: ManagedTunnel,
    intent: number,
  ): void {
    if (!this.current(profileId, managed, intent)) throw new SupersededError()
  }

  private async verifyLogin(
    managed: ManagedTunnel,
    profileId: ConnectionId,
    intent: number,
  ): Promise<void> {
    const binary = resolveTshBinary(managed.config)
    this.setState(
      managed,
      profileId,
      'checking-login',
      'Checking Teleport login…',
    )
    const status = await this.deps.checkStatus(
      binary,
      this.env(),
      managed.abort.signal,
    )
    this.ensureCurrent(profileId, managed, intent)
    if (!status.loggedIn) {
      throw new PreConnectError(
        'TSH_NOT_LOGGED_IN',
        'No active Teleport session was found. Run "tsh login", then try again.',
      )
    }
    if (isSessionExpired(status.validUntil, this.deps.now())) {
      throw new PreConnectError(
        'TSH_NOT_LOGGED_IN',
        'Your Teleport session has expired. Run "tsh login", then try again.',
      )
    }
  }

  private async launch(
    managed: ManagedTunnel,
    profileId: ConnectionId,
    intent: number,
  ): Promise<void> {
    this.setState(managed, profileId, 'starting', 'Starting Teleport tunnel…')
    const port = managed.config.tunnelPort

    // A previous app run can leave a detached `tsh proxy db` listening on this
    // port (it survives even a hard app exit). When the leftover serves the
    // same database service, adopt it instead of fighting over the port; an
    // unknown listener is refused outright.
    if (
      await this.deps.findExistingTunnel(port, managed.config.dbService.trim())
    ) {
      this.setState(
        managed,
        profileId,
        'ready',
        `Reusing the tunnel already listening on ${DEFAULT_TUNNEL_HOST}:${port}.`,
      )
      if (isKeepaliveEnabled(managed.config))
        this.startHealth(managed, profileId, intent)
      return
    }
    if (await this.deps.probePort(port)) {
      throw new PreConnectError(
        'TUNNEL_FAILED',
        `Port ${port} is already in use by another process. Close it (or pick a different tunnel port) and reconnect.`,
      )
    }

    const child = this.deps.spawnTsh(
      resolveTshBinary(managed.config),
      buildProxyDbArgs(managed.config),
      this.env(),
    )
    managed.child = child

    const output = { stderr: '', stdout: '' }
    child.stderr?.on('data', (chunk) => {
      output.stderr = (output.stderr + String(chunk)).slice(-4000)
    })
    child.stdout?.on('data', (chunk) => {
      output.stdout = (output.stdout + String(chunk)).slice(-4000)
    })

    let exitedResolve!: () => void
    let childExited = false
    const exitDeferred = new Promise<void>((resolve) => {
      exitedResolve = resolve
    })
    child.on('error', (error) => {
      output.stderr = `${output.stderr}\n${error.message}`.trim()
      childExited = true
      exitedResolve()
    })
    child.on('exit', () => {
      childExited = true
      exitedResolve()
    })

    this.setState(
      managed,
      profileId,
      'waiting-for-port',
      `Waiting for the tunnel on ${DEFAULT_TUNNEL_HOST}:${managed.config.tunnelPort}…`,
    )
    let portReady = false
    try {
      await Promise.race([
        this.deps
          .waitForPort(
            port,
            tunnelTimeout(managed.config),
            managed.abort.signal,
          )
          .then(() => {
            portReady = true
          }),
        exitDeferred.then(() => {
          if (portReady) return
          const detail = summarizeTshFailure(output.stderr, output.stdout)
          throw new PreConnectError(
            'TUNNEL_FAILED',
            `The Teleport tunnel exited before opening ${DEFAULT_TUNNEL_HOST}:${port}.${
              detail ? ` ${detail}` : ''
            }`,
          )
        }),
      ])
    } catch (error) {
      // Keep ownership until bounded TERM/KILL cleanup completes, including a
      // readiness timeout against a helper which ignores SIGTERM.
      await this.terminate(managed)
      throw error
    }

    // A listener on the port is not proof our child is alive: readiness may
    // have been satisfied by a leftover tunnel from a previous app run. If the
    // child already exited, the listener belongs to someone else.
    if (childExited) {
      const detail = summarizeTshFailure(output.stderr, output.stdout)
      await this.terminate(managed)
      throw new PreConnectError(
        'TUNNEL_FAILED',
        `The Teleport tunnel exited immediately, likely because port ${port} is already in use.${
          detail ? ` ${detail}` : ''
        }`,
      )
    }

    if (!this.current(profileId, managed, intent)) {
      await this.terminate(managed)
      throw new SupersededError()
    }

    managed.consecutiveHealthFailures = 0
    this.setState(
      managed,
      profileId,
      'ready',
      `Teleport tunnel ready on ${DEFAULT_TUNNEL_HOST}:${port}.`,
    )

    exitDeferred.then(() =>
      this.handleUnexpectedExit(managed, profileId, intent, output),
    )
    if (isKeepaliveEnabled(managed.config))
      this.startHealth(managed, profileId, intent)
  }

  private handleUnexpectedExit(
    managed: ManagedTunnel,
    profileId: ConnectionId,
    intent: number,
    output: { stderr: string; stdout: string },
  ): void {
    if (!this.current(profileId, managed, intent)) return
    if (managed.state === 'lost') return
    this.stopHealth(managed)
    managed.child = null
    const detail = summarizeTshFailure(output.stderr, output.stdout)
    if (!isKeepaliveEnabled(managed.config)) {
      void this.fail(
        managed,
        profileId,
        new PreConnectError(
          'TUNNEL_FAILED',
          detail
            ? `The Teleport tunnel stopped. ${detail}`
            : 'The Teleport tunnel stopped.',
        ),
      )
      return
    }
    // Keepalive only detects the drop; respawning `tsh` could open a browser
    // for re-auth without the user asking for it. Wait for an explicit
    // reconnect instead.
    this.setState(
      managed,
      profileId,
      'lost',
      detail
        ? `The Teleport tunnel stopped. ${detail}`
        : 'The Teleport tunnel stopped.',
    )
  }

  private startHealth(
    managed: ManagedTunnel,
    profileId: ConnectionId,
    intent: number,
  ): void {
    this.stopHealth(managed)
    managed.healthTimer = setInterval(() => {
      void this.checkHealth(managed, profileId, intent)
    }, this.deps.healthIntervalMs)
    managed.healthTimer.unref?.()
  }

  private stopHealth(managed: ManagedTunnel): void {
    if (managed.healthTimer) {
      clearInterval(managed.healthTimer)
      managed.healthTimer = null
    }
  }

  private async checkHealth(
    managed: ManagedTunnel,
    profileId: ConnectionId,
    intent: number,
  ): Promise<void> {
    if (!this.current(profileId, managed, intent)) return
    if (managed.state !== 'ready') return
    const ok = await this.deps.probePort(managed.config.tunnelPort)
    if (!this.current(profileId, managed, intent)) return
    if (ok) {
      managed.consecutiveHealthFailures = 0
      return
    }
    managed.consecutiveHealthFailures += 1
    if (managed.consecutiveHealthFailures < this.deps.healthFailureThreshold)
      return
    this.stopHealth(managed)
    // Mark lost before killing so the child's own exit handler is inert.
    this.setState(
      managed,
      profileId,
      'lost',
      'The Teleport tunnel stopped responding.',
    )
    await this.terminate(managed)
  }

  private async fail(
    managed: ManagedTunnel,
    profileId: ConnectionId,
    error: unknown,
  ): Promise<void> {
    this.stopHealth(managed)
    await this.terminate(managed)
    if (managed.stopping || this.tunnels.get(profileId) !== managed) return
    this.tunnels.delete(profileId)
    const code = error instanceof PreConnectError ? error.code : null
    this.setState(managed, profileId, 'failed', messageOf(error), code)
  }

  private terminate(managed: ManagedTunnel): Promise<void> {
    if (managed.termination) return managed.termination
    const child = managed.child
    if (!child) return Promise.resolve()
    // Publish the shared cleanup before signaling: stop/stopAll must join an
    // existing readiness/health/stop cleanup through escalation and child exit.
    const termination = Promise.resolve()
      .then(async () => {
        const exited = this.waitForExit(child, this.deps.killGraceMs)
        const reaped = this.waitForExit(child, this.deps.killGraceMs * 2)
        killProcessTree(child, 'SIGTERM')
        await exited
        killProcessTree(child, 'SIGKILL')
        await reaped
      })
      .finally(() => {
        if (managed.child === child) managed.child = null
        if (managed.termination === termination) managed.termination = undefined
      })
    managed.termination = termination
    return termination
  }

  private waitForExit(child: TunnelProcess, ms: number): Promise<void> {
    return new Promise((resolve) => {
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        resolve()
      }
      try {
        child.once('exit', finish)
        child.once('error', finish)
      } catch {
        finish()
        return
      }
      const timer = setTimeout(finish, ms)
      timer.unref?.()
    })
  }

  private setState(
    managed: ManagedTunnel,
    profileId: ConnectionId,
    state: PreConnectState,
    message: string,
    code: PreConnectErrorCode | null = null,
  ): void {
    managed.state = state
    const event: PreConnectStateEvent = {
      profileId,
      state,
      message,
      code,
      generation: managed.generation,
      timestamp: this.deps.now(),
    }
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch {
        /* a broken listener must not interrupt the tunnel lifecycle */
      }
    }
  }
}
