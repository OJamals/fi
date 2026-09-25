/** Tool UI slot declarations and their composed component props. */
import type { ReactNode } from 'react'
import type {
  HostObservable, InjectFace, PropsLocale, PropsRenderSlots, PropsRuntime, SlotHookFactory,
} from '@deepseek-ai/dsh-client-ui-slots'
import type { RemoteHostFacts } from '@deepseek-ai/dsh-api-remotes/client'
import type {
  AssistantChatData, OpenFileOptions, PreparingToolCall, StartedToolCall,
  ToolResultNode, UseDisclosure,
} from '@deepseek-ai/dsh-client-ui-chat/client'
import type { MessageImageLoader, MessageImageSource } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /**
     * Keyed Tool call view dispatched by wire Tool name, including your package's
     * tools. Register with `key: '<tool name>'`; a typo never renders.
     *
     * Registering an occupied key replaces its view; unclaimed keys use the
     * generic row. The owner passes call identity and the running or settled node
     * by phase; useToolCallArgumentsPartial streams a preparing call's raw arguments.
     */
    'tool.call.toolview': {
      kind: 'keyed'
      scope: 'session'
      owner: ToolCallOwnerProps
      hookContext: ToolCallHookContext
      inject: ToolCallInjected
    }
    /**
     * Durable images of a settled image-bearing Tool call, rendered through
     * the attachment presentation plugin. The Tool tree declares this child
     * once and supplies its renderer to every atomic view, so the generic
     * fallback and keyed views use the same session-authorized gallery.
     */
    'tool.call.images': { kind: 'single'; scope: 'session'; owner: ToolImagesOwnerProps }
  }
}

/** Subscribe to this preparing call's raw argument prefix; other phases return an empty string. */
export type UseToolCallArgumentsPartial = () => string

/** Call-local sources supplied by the Tool tree to the slot's Hook binding. */
export interface ToolCallHookContext {
  readonly callId: string
  /** This call's Step source, present only while preparing. */
  readonly assistant: HostObservable<Readonly<AssistantChatData> | undefined> | undefined
}

/** Framework-bound subscriptions available to atomic Tool views on demand. */
export interface ToolCallInjected {
  hooks: {
    toolCallArgumentsPartial: SlotHookFactory<'tool.call.toolview', UseToolCallArgumentsPartial>
  }
}

/** Owner currency of the Tool image gallery slot: references plus the loader. */
export interface ToolImagesOwnerProps {
  /** Durable references or submission-echo previews in result order. */
  images: readonly MessageImageSource[]
  /** Session-authorized image URL loader for the durable arm. */
  loadImage: MessageImageLoader
  /** Horizontal placement inside the owning record. */
  align: 'start' | 'end'
}

/** Render a Tool image gallery through the Tool tree's authorized child slot. */
export type RenderToolImages = (owner: Omit<ToolImagesOwnerProps, 'loadImage'>) => ReactNode
/** Standard owner currency supplied to every atomic Tool view. */
export interface ToolCallCommonProps {
  /** Stable Hook; each invocation owns its open state and subscribes to enclosing-Turn resets. */
  useDisclosure: UseDisclosure
  /** Call identity, stable across all stages. */
  callId: string
  /** Wire Tool name and keyed dispatch value. */
  toolName: string
  /** Session workspace root for relative summaries. */
  cwd?: string | undefined
  /** Host account home; POSIX home-rooted summaries display as `~`. */
  home?: string | undefined
  /** Open an argument path at its optional requested line. */
  openFile: (path: string, options?: OpenFileOptions) => void
  /** Chat-supplied, session-authorized loader for durable images; Tool views do not manage attachment URLs. */
  loadImage: MessageImageLoader
  /** Result-image gallery renderer supplied by ToolCallTree; absent, views show the flattened result. */
  renderImages?: RenderToolImages | undefined
  /** Inspect this call in the trajectory view when available. */
  inspect?: (() => void) | undefined
}

/** Stage-specific tool data; only start/result expose the dispatched call material. */
export type ToolCallPhaseProps =
  | { readonly phase: 'preparing'; readonly block: PreparingToolCall }
  | { readonly phase: 'start'; readonly block: StartedToolCall }
  | { readonly phase: 'result'; readonly block: ToolResultNode }

/** Common owner callbacks and the data admitted at the current tool stage. */
export type ToolCallOwnerProps = ToolCallCommonProps & ToolCallPhaseProps

/** Full props of a registered atomic Tool view. */
export type ToolCallViewProps = PropsRuntime<'tool.call.toolview'>

/** Existing argument/result business components exclude the preparation stage. */
export type StartedToolCallViewProps = Exclude<ToolCallViewProps, { readonly phase: 'preparing' }>

/** Injected Host description for POSIX home-path display. */
export type ToolHostInfoInjected = {
  hooks: {
    /**
     * Fixed Host facts, reached through a hook rather than injected as values:
     * the renderer memoizes an entry's inject result for the registration's
     * lifetime, so facts read there would freeze at whatever the first render
     * saw. Select the field the view needs (`info => info.home`).
     */
    hostInfo: HostObservable<RemoteHostFacts>
  }
}

/** Full props of the Tool call-tree renderer registered as a tool-call Chat Node. */
export type ToolTreeProps = PropsRuntime<'conversation.chat.node', 'tool-call'>
  & PropsRenderSlots<'tool.call.toolview' | 'tool.call.images'>
  & PropsLocale<'conversation'>
  & InjectFace<ToolHostInfoInjected>
