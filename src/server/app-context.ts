// AppContext — dependency injection container for the entire app
// Production creates one context; staging preview creates a second, isolated context.

import type { TaskStore } from "./task-store.js";
import type { TaskGroupStore } from "./task-group-store.js";
import type { ScheduleStore } from "./schedule-store.js";
import type { SettingsStore } from "./settings-store.js";
import type { SessionMetaStore } from "./session-meta-store.js";
import type { SessionWorkspaceStore } from "./session-workspace-store.js";
import type { SessionTitlesStore } from "./session-titles.js";
import type { BridgeSessionStateStore } from "./bridge-session-state-store.js";
import type { CopilotCliSessionCatalog } from "./copilot-cli-session-catalog.js";
import type { ReadStateStore } from "./read-state-store.js";
import type { ChecklistStore } from "./checklist-store.js";
import type { FeedStore } from "./feed-store.js";
import type { DocsStore } from "./docs-store.js";
import type { DocsIndex } from "./docs-index.js";
import type { DocsSnapshotStore } from "./docs-snapshot-store.js";
import type { TagStore } from "./tag-store.js";
import type { McpServerStore } from "./mcp-server-store.js";
import type { CopilotModelPriceStore } from "./copilot-model-price-store.js";
import type { CopilotUsageStore } from "./copilot-usage-store.js";
import type { CopilotUsageReader } from "./copilot-usage.js";
import type { TelemetryStore } from "./telemetry-store.js";
import type { SessionContextStore } from "./session-context-store.js";
import type { GlobalBus } from "./global-bus.js";
import type { EventBusRegistry } from "./event-bus.js";
import type { SessionManager } from "./session-manager.js";
import type { TranscriptionService } from "./transcription-service.js";
import type { VoiceJobManager } from "./voice-job-manager.js";
import type { RuntimePaths } from "./runtime-paths.js";
import type { DeferredPromptStore } from "./deferred-prompt-store.js";
import type { DeferredPromptRunner } from "./deferred-prompt-runner.js";
import type { DeferLoopStore } from "./defer-loop-store.js";
import type { DeferLoopRunner } from "./defer-loop-runner.js";
import type * as SchedulerModule from "./scheduler.js";
import type { PushSubscriptionStore } from "./push-subscription-store.js";
import type { PushNotificationService } from "./push-notification-service.js";
import type { BridgeToolsMcpServer } from "./agent-tools-mcp/index.js";
import type { ManagementJobStore } from "./management-job-store.js";

export interface AppContext {
  taskStore: TaskStore;
  taskGroupStore: TaskGroupStore;
  scheduleStore: ScheduleStore;
  settingsStore: SettingsStore;
  sessionMetaStore: SessionMetaStore;
  sessionWorkspaceStore: SessionWorkspaceStore;
  sessionTitles: SessionTitlesStore;
  bridgeSessionStateStore: BridgeSessionStateStore;
  cliSessionCatalog?: CopilotCliSessionCatalog;
  readStateStore: ReadStateStore;
  checklistStore: ChecklistStore;
  feedStore: FeedStore;
  docsStore?: DocsStore;
  docsIndex?: DocsIndex;
  docsSnapshotStore?: DocsSnapshotStore;
  tagStore?: TagStore;
  mcpServerStore?: McpServerStore;
  copilotModelPriceStore?: CopilotModelPriceStore;
  copilotUsageStore: CopilotUsageStore;
  copilotUsageReader?: CopilotUsageReader;
  telemetryStore?: TelemetryStore;
  sessionContextStore?: SessionContextStore;
  globalBus: GlobalBus;
  eventBusRegistry: EventBusRegistry;
  sessionManager: SessionManager;
  transcriptionService: TranscriptionService;
  voiceJobManager: VoiceJobManager;
  pushSubscriptionStore?: PushSubscriptionStore;
  managementJobStore?: ManagementJobStore;
  pushNotificationService?: PushNotificationService;
  /** Deferred prompt persistence */
  deferredPromptStore?: DeferredPromptStore;
  /** Recurring defer loop persistence */
  deferLoopStore?: DeferLoopStore;
  /** Deferred prompt dispatcher */
  deferredPromptRunner?: DeferredPromptRunner;
  /** Recurring defer loop dispatcher */
  deferLoopRunner?: DeferLoopRunner;
  /** Scheduler module instance. Staging previews provide an isolated module. */
  scheduler?: typeof SchedulerModule;
  /** Root of .copilot directory — defaults to homedir()/.copilot for production */
  copilotHome?: string;
  /** Public API mount path used for server-generated links (e.g. "/api" or "/staging/<prefix>/api") */
  apiBasePath?: string;
  runtimePaths?: RuntimePaths;
  bridgeToolsMcpServer?: BridgeToolsMcpServer;
  /** Shared launcher log file path when this server was started by the launcher */
  launcherLogPath?: string;
  isStaging?: boolean;
}
