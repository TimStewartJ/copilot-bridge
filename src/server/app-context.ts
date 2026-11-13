// AppContext — dependency injection container for the entire app
// Production creates one context; staging preview creates a second, isolated context.

import type { TaskStore } from "./task-store.js";
import type { TaskGroupStore } from "./task-group-store.js";
import type { ScheduleStore } from "./schedule-store.js";
import type { SettingsStore } from "./settings-store.js";
import type { SessionMetaStore } from "./session-meta-store.js";
import type { InterruptedRunStore } from "./interrupted-run-store.js";
import type { ChatMessageIdStore } from "./chat-message-id-store.js";
import type { UnsentMessageStore } from "./unsent-message-store.js";
import type { BackgroundCommandStore } from "./background-command-store.js";
import type { SessionWorkspaceStore } from "./session-workspace-store.js";
import type { SessionPlaybookStore } from "./session-playbook-store.js";
import type { SkillCatalog } from "./skill-catalog.js";
import type { SkillPackManager } from "./skill-packs.js";
import type { SkillUsageStore } from "./skill-usage-store.js";
import type { TaskStartersStore } from "./task-starters-store.js";
import type { UnattendedRunStore } from "./unattended-run-store.js";
import type { TaskHistoryStore } from "./task-history-store.js";
import type { CompletionReportStore } from "./completion-report-store.js";
import type { TaskPageStore } from "./task-page-store.js";
import type { SessionTitlesStore } from "./session-titles.js";
import type { BridgeSessionStateStore } from "./bridge-session-state-store.js";
import type { CopilotCliSessionCatalog } from "./copilot-cli-session-catalog.js";
import type { ReadStateStore } from "./read-state-store.js";
import type { ModelAbTestStore } from "./model-ab-test.js";
import type { ChecklistStore } from "./checklist-store.js";
import type { DocsStore } from "./docs-store.js";
import type { DocsIndex } from "./docs-index.js";
import type { SearchIndex } from "./search-index.js";
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
import type {
  PushEventNotificationDisposer,
  PushNotificationService,
} from "./push-notification-service.js";
import type { BridgeToolsMcpServer } from "./agent-tools-mcp/index.js";
import type { ManagementJobStore } from "./management-job-store.js";
import type { StagingPreviewDiscoveryController } from "./staging-preview-discovery.js";
import type { SessionOverlayMaintenance } from "./session-overlay-maintenance.js";
import type { CalendarStore } from "./calendar-store.js";
import type { HelmService } from "./helm/helm-service.js";
import type { HelmStore } from "./helm/helm-store.js";
import type { HelmThinkerStore } from "./helm/thinker/store.js";
import type { HelmThinker } from "./helm/thinker/thinker.js";
import type { VoiceGateway } from "./voice/voice-gateway.js";
import type { VoiceRuntime } from "./voice/voice-runtime.js";

export interface AppContext {
  taskStore: TaskStore;
  taskGroupStore: TaskGroupStore;
  scheduleStore: ScheduleStore;
  settingsStore: SettingsStore;
  sessionMetaStore: SessionMetaStore;
  sessionWorkspaceStore: SessionWorkspaceStore;
  sessionPlaybookStore?: SessionPlaybookStore;
  /** Cached scan of bundled, home and pack skills with their playbook metadata. */
  skillCatalog?: SkillCatalog;
  skillPacks?: SkillPackManager;
  skillUsageStore?: SkillUsageStore;
  /** Suggested chats on each task panel. */
  taskStartersStore?: TaskStartersStore;
  /** Chats where defers or schedules ran turns since the user last wrote there. */
  unattendedRunStore?: UnattendedRunStore;
  taskHistoryStore?: TaskHistoryStore;
  /** Evidence reports recorded by verify_complete. */
  completionReportStore?: CompletionReportStore;
  /** HTML pages chats published on tasks. */
  taskPageStore?: TaskPageStore;
  sessionTitles: SessionTitlesStore;
  bridgeSessionStateStore: BridgeSessionStateStore;
  cliSessionCatalog?: CopilotCliSessionCatalog;
  readStateStore: ReadStateStore;
  /** Which arm of a model A/B test each new chat started on. */
  modelAbTestStore?: ModelAbTestStore;
  checklistStore: ChecklistStore;
  /** The Bridge's own calendar events. */
  calendarStore?: CalendarStore;
  stopPushEventNotifications?: PushEventNotificationDisposer;
  docsStore?: DocsStore;
  docsIndex?: DocsIndex;
  searchIndex?: SearchIndex;
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
  interruptedRunStore?: InterruptedRunStore;
  /** The browser message id each saved chat message was sent as. */
  chatMessageIdStore?: ChatMessageIdStore;
  /** Chat messages the Bridge accepted that the agent never received. */
  unsentMessageStore?: UnsentMessageStore;
  /** Commands running in attached shells, kept so one the Bridge stops can be reported to its agent. */
  backgroundCommandStore?: BackgroundCommandStore;
  /** Recurring defer loop persistence */
  deferLoopStore?: DeferLoopStore;
  /** Deferred prompt dispatcher */
  deferredPromptRunner?: DeferredPromptRunner;
  /** Recurring defer loop dispatcher */
  deferLoopRunner?: DeferLoopRunner;
  /** Scheduler module instance. Staging previews provide an isolated module. */
  scheduler?: typeof SchedulerModule;
  /** Periodic owner of session-overlay/defer row cleanup. Started at boot. */
  sessionOverlayMaintenance?: SessionOverlayMaintenance;
  /**
   * Discovers atomically published preview generations from management jobs run by
   * the separate runner process.
   */
  stagingPreviewDiscovery?: StagingPreviewDiscoveryController;
  /** Root of .copilot directory — defaults to homedir()/.copilot for production */
  copilotHome?: string;
  /** Public API mount path used for server-generated links (e.g. "/api" or "/staging/<prefix>/api") */
  apiBasePath?: string;
  runtimePaths?: RuntimePaths;
  bridgeToolsMcpServer?: BridgeToolsMcpServer;
  /** Shared launcher log file path when this server was started by the launcher */
  launcherLogPath?: string;
  /** Which sessions are Helm conversations. Available before the API router so resumes can consult it. */
  helmStore?: HelmStore;
  /** Helm, Bridge's orchestration manager. Created by the API router, which owns the facade it acts through. */
  helm?: HelmService;
  /** Which sessions are Helm thinker runs, their briefs and Helm's memory. Available before the API router. */
  helmThinkerStore?: HelmThinkerStore;
  /** Helm's looks over every Bridge, which write the brief Home shows, and Helm's memory. Created with Helm. */
  helmThinker?: HelmThinker;
  /** Hands-free voice conversations for Helm. Created by the API router. */
  voiceGateway?: VoiceGateway;
  /** Local speech engine and installer shared by voice mode and chat mic transcription. */
  voiceRuntime?: VoiceRuntime;
  isStaging?: boolean;
}
