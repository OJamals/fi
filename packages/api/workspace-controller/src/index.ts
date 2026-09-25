/** Host Workspace Remote owner: explicit commands and reconnect-safe state. */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { Remote, RemoteError, remoteErrorOf, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { WorkspaceId, type SessionActivity, type Workspace } from '@deepseek-ai/dsh-workspace'
import { WorkspaceCommands } from './commands.ts'
import { DirectoryPickerController } from './directory-picker.ts'
import { WorkspaceFeed, workspaceView } from './feed.ts'
import { defaultWorkspaceDirectory, validateDocumentsDirectory } from './default-directory.ts'
import { ManagedWorktreeConfigSchema, ManagedWorktrees, type ManagedWorktreeConfig } from './managed-worktrees.ts'
import type {
  WorkspaceArchiveSessionRequest,
  WorkspaceArchiveValue,
  WorkspaceCreateRequest,
  WorkspaceCreateValue,
  WorkspaceDeleteRequest,
  WorkspaceDeleteValue,
  WorkspaceFollowFrame,
  WorkspaceInsertBeforeRequest,
  WorkspaceInsertSessionBeforeRequest,
  WorkspaceManagedRequest,
  WorkspaceManagedValue,
  WorkspaceOrderValue,
  WorkspacePinSessionRequest,
  WorkspacePinValue,
  WorkspaceRenameRequest,
  WorkspaceUnarchiveSessionRequest,
  WorkspaceUnpinSessionRequest,
  WorkspaceValue,
} from './types.ts'

export type * from './types.ts'
export { DirectoryPickerController } from './directory-picker.ts'
export { ManagedWorktrees, type ManagedWorktree, type ManagedWorktreeConfig } from './managed-worktrees.ts'

/** First-use directory policy for the Host account. */
export interface Config {
  /** Override the system Documents directory with a fully qualified path. */
  documentsDirectory?: string
  /** Maximum duration of the operating system's Documents lookup. */
  documentsLookupTimeoutMs?: number
  /**
   * Enables application-managed isolated Git worktrees for Workspaces. Absent, `createIsolated`,
   * `inspectManaged`, and `removeManaged` all reject with `workspace/managed-unavailable`.
   */
  managedWorktrees?: ManagedWorktreeConfig
}

/** Directory policy after schema defaults have been applied. */
type ResolvedConfig = Config & { documentsLookupTimeoutMs: number }

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host Workspace business API and Remote namespace owner. */
    workspaceController: WorkspaceController
  }
}

/** Host service backing the generated `ctx.remote.workspace` namespace. */
export class WorkspaceController extends TypertRemoteService {
  static inject = ['typert', 'workspaceRegistry']

  // `managedWorktrees` is deliberately not part of this schema: every schemastery `z.object()`
  // resolves an absent value against an implicit `{}` default rather than staying absent, which
  // would throw on `managedWorktreeDirectory`'s required field for every composition that does
  // not configure this feature. `ManagedWorktreeConfigSchema` in managed-worktrees.ts validates
  // the block on its own, called only when the constructor's raw config actually supplies it.
  static Config: z<Config, ResolvedConfig> = z.object({
    documentsDirectory: z.string(),
    documentsLookupTimeoutMs: z.natural().min(1).default(10_000),
  })

  private readonly config: ResolvedConfig
  private readonly commands: WorkspaceCommands
  private readonly feed: WorkspaceFeed
  private managed: ManagedWorktrees | undefined

  /**
   * @param ctx - Host context containing the Workspace registry.
   * @param config - first-use directory policy and optional managed-worktree policy.
   */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'workspaceController', { namespace: 'workspace' })
    this.config = WorkspaceController.Config(config)
    if (this.config.documentsDirectory !== undefined) validateDocumentsDirectory(this.config.documentsDirectory)
    this.commands = new WorkspaceCommands(ctx)
    this.feed = new WorkspaceFeed(ctx)
    // This package is the Loader entry for both Remote owners it hosts: the
    // directory-picking seam is abstract and never an entry itself. The child
    // stays pending until a picking backend is composed, so a host without one
    // registers no picking namespace instead of answering an unservable verb.
    ctx.plugin(DirectoryPickerController)
    // Managed worktrees need a local FS and subprocess execution world; a
    // composition without either leaves the feature unavailable rather than
    // failing the whole controller to load.
    if (config.managedWorktrees !== undefined) {
      const worktrees = ManagedWorktreeConfigSchema(config.managedWorktrees)
      ctx.inject(['fs', 'subprocess'], (scoped) => {
        this.managed = new ManagedWorktrees(scoped, worktrees)
        scoped.effect(() => () => { this.managed = undefined })
      })
    }
  }

  /**
   * Create or idempotently resolve one Workspace over an existing directory.
   * @param request - directory path to register.
   * @returns the Workspace and whether this call created it.
   */
  @Remote('create')
  create(request: WorkspaceCreateRequest): Promise<WorkspaceCreateValue> {
    return this.commands.create(request)
  }

  /**
   * Create a registered Workspace isolated from the source checkout: a
   * fresh local Git worktree on a new branch from the source's committed
   * HEAD. Uncommitted, staged, ignored, and untracked source files are not
   * copied. The new checkout is registered as an ordinary Workspace, so
   * Session cwd, tools, and Git inspection retain their existing authority.
   * @param request - source Workspace identity.
   * @returns the newly registered checkout.
   * @throws `workspace/managed-unavailable` when no managed-worktree directory is configured,
   * `workspace/not-found` when the source Workspace is unknown, or `workspace/isolation-invalid`
   * when the source is not a local repository root with a committed HEAD.
   */
  @Remote('createIsolated')
  async createIsolated(request: WorkspaceManagedRequest): Promise<WorkspaceCreateValue> {
    const managed = this.requireManaged()
    const workspace = this.requireWorkspace(request.workspaceId)
    let record
    try {
      record = await managed.create(workspace.path)
    } catch (error) {
      if (remoteErrorOf(error) !== undefined) throw error
      throw new RemoteError(
        'workspace/isolation-invalid',
        `Workspace "${request.workspaceId}" cannot be isolated: ${errorMessage(error)}`,
        { workspaceId: request.workspaceId },
        { cause: error },
      )
    }
    return this.commands.create({ path: record.path })
  }

  /**
   * Report whether a Workspace is an application-managed worktree and, when
   * it is, the source it isolates from and its branch.
   * @param request - registered Workspace identity.
   * @returns managed-worktree facts, or `{ kind: 'ordinary' }` for a Workspace
   * that is not application-managed, including when no managed-worktree
   * directory is configured.
   */
  @Remote('inspectManaged')
  async inspectManaged(request: WorkspaceManagedRequest): Promise<WorkspaceManagedValue> {
    if (this.managed === undefined) return { kind: 'ordinary' }
    const workspace = this.requireWorkspace(request.workspaceId)
    const record = await this.managed.get(workspace.path)
    return record === undefined
      ? { kind: 'ordinary' }
      : { kind: 'managed', source: record.source, branch: record.branch }
  }

  /**
   * Remove a clean, merged managed checkout and its Workspace registration
   * while retaining its branch and Session logs; Sessions whose cwd was this
   * checkout cannot continue. Refuses while any of the Workspace's Sessions
   * has running work, or while the checkout has uncommitted, untracked, or
   * ignored changes, or commits not yet merged into its source.
   * @param request - managed Workspace identity.
   * @returns registry deletion confirmation.
   * @throws `workspace/managed-unavailable`, `workspace/not-managed`,
   * `workspace/worktree-active`, or `workspace/worktree-dirty`.
   */
  @Remote('removeManaged')
  async removeManaged(request: WorkspaceManagedRequest): Promise<WorkspaceDeleteValue> {
    const managed = this.requireManaged()
    const workspace = this.requireWorkspace(request.workspaceId)
    const record = await managed.get(workspace.path)
    if (record === undefined) {
      throw new RemoteError(
        'workspace/not-managed',
        `Workspace "${request.workspaceId}" is not an application-managed worktree`,
        { workspaceId: request.workspaceId },
      )
    }
    const activity = await this.activeSessionActivity(workspace)
    if (activity.length > 0) {
      throw new RemoteError(
        'workspace/worktree-active',
        `Workspace "${request.workspaceId}" still has running work`,
        { workspaceId: request.workspaceId, activity },
      )
    }
    try {
      await managed.remove(record)
    } catch (error) {
      if (remoteErrorOf(error) !== undefined) throw error
      throw new RemoteError(
        'workspace/worktree-dirty',
        `Workspace "${request.workspaceId}" could not be removed: ${errorMessage(error)}`,
        { workspaceId: request.workspaceId },
        { cause: error },
      )
    }
    return this.commands.delete(request)
  }

  /**
   * Initialize or reuse the default Workspace during first-use startup. The
   * directory name is fixed, so the Host never renames or relocates an
   * existing default; its initial title is that same name, which browser
   * consumers label in the reader's language.
   * @param signal - caller lifetime; cancels native directory lookup.
   * @returns the durable Workspace, or undefined when first-use initialization is ineligible; creates no Session or message.
   */
  @Remote('initializeDefault')
  async initializeDefault(signal: AbortSignal): Promise<WorkspaceValue | undefined> {
    const workspace = await this.ctx.workspaceRegistry.initializeDefault(async () => {
      const timeout = AbortSignal.timeout(this.config.documentsLookupTimeoutMs)
      return await defaultWorkspaceDirectory(
        this.config.documentsDirectory, AbortSignal.any([signal, timeout]),
      )
    })
    return workspace === undefined ? undefined : { workspace: workspaceView(workspace) }
  }

  /**
   * Rename one Workspace to a unique non-blank title.
   * @param request - Workspace identity and proposed title.
   * @returns the updated Workspace projection.
   */
  @Remote('rename')
  rename(request: WorkspaceRenameRequest): Promise<WorkspaceValue> {
    return this.commands.rename(request)
  }

  /**
   * Remove one Workspace registration while retaining files and Sessions.
   * @param request - Workspace identity to remove.
   * @returns deletion confirmation.
   */
  @Remote('delete')
  delete(request: WorkspaceDeleteRequest): Promise<WorkspaceDeleteValue> {
    return this.commands.delete(request)
  }

  /**
   * Move one Workspace within the registry display order.
   * @param request - moved Workspace and optional anchor.
   * @returns the complete resulting Workspace order.
   */
  @Remote('insertBefore')
  insertBefore(request: WorkspaceInsertBeforeRequest): Promise<WorkspaceOrderValue> {
    return this.commands.insertBefore(request)
  }

  /**
   * Move one accounted Session within a Workspace.
   * @param request - Workspace, Session, and optional anchor identities.
   * @returns the updated Workspace projection.
   */
  @Remote('insertSessionBefore')
  insertSessionBefore(request: WorkspaceInsertSessionBeforeRequest): Promise<WorkspaceValue> {
    return this.commands.insertSessionBefore(request)
  }

  /**
   * Hide one known Session from Workspace grouping surfaces.
   * @param request - Session identity to archive.
   * @returns the complete resulting archive set.
   */
  @Remote('archiveSession')
  archiveSession(request: WorkspaceArchiveSessionRequest): Promise<WorkspaceArchiveValue> {
    return this.commands.archiveSession(request)
  }

  /**
   * Restore one archived Session to Workspace grouping surfaces.
   * @param request - Session identity to unarchive.
   * @returns the complete resulting archive set.
   */
  @Remote('unarchiveSession')
  unarchiveSession(request: WorkspaceUnarchiveSessionRequest): Promise<WorkspaceArchiveValue> {
    return this.commands.unarchiveSession(request)
  }

  /**
   * Surface one known unarchived Session ahead of unpinned Sessions.
   * @param request - Session identity to pin.
   * @returns the complete resulting pin set, most recently pinned first.
   */
  @Remote('pinSession')
  pinSession(request: WorkspacePinSessionRequest): Promise<WorkspacePinValue> {
    return this.commands.pinSession(request)
  }

  /**
   * Remove one Session's pin without changing its saved Session order.
   * @param request - Session identity to unpin.
   * @returns the complete resulting pin set, most recently pinned first.
   */
  @Remote('unpinSession')
  unpinSession(request: WorkspaceUnpinSessionRequest): Promise<WorkspacePinValue> {
    return this.commands.unpinSession(request)
  }

  /**
   * Stream a complete Workspace baseline followed by ordered increments.
   * @param signal - generation cancellation.
   * @returns baseline followed by ordered Workspace increments.
   */
  @Remote({ mode: 'stream' })
  follow(signal: AbortSignal): AsyncIterable<WorkspaceFollowFrame> {
    return this.feed.follow(signal)
  }

  private requireManaged(): ManagedWorktrees {
    if (this.managed === undefined) {
      throw new RemoteError('workspace/managed-unavailable', 'Managed worktrees are not configured on this Host', {})
    }
    return this.managed
  }

  private requireWorkspace(workspaceId: WorkspaceManagedRequest['workspaceId']): Workspace {
    const workspace = this.ctx.workspaceRegistry.get(WorkspaceId(workspaceId))
    if (workspace === undefined) {
      throw new RemoteError('workspace/not-found', `Workspace "${workspaceId}" not found`, { workspaceId })
    }
    return workspace
  }

  /** Every `workspace/session-activity` a Workspace's own Sessions report, in accounting order. */
  private async activeSessionActivity(workspace: Workspace): Promise<readonly SessionActivity[]> {
    const activity: SessionActivity[] = []
    for (const sessionId of workspace.sessionIds) {
      activity.push(...await this.ctx.waterfall('workspace/session-activity', { sessionId }, () => Promise.resolve([])))
    }
    return activity
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export default WorkspaceController
