// The app's dependency container; a staging preview builds a second, isolated one.

import type { TaskStore } from "./task-store.js";
import type { TaskGroupStore } from "./task-group-store.js";
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
import type { TaskStartersService } from "./task-starters.js";
import type { UnattendedRunStore } from "./unattended-run-store.js";
import type { TaskHistoryStore } from "./task-history-store.js";
import type { CompletionReportStore } from "./completion-report-store.js";
import type { TaskPageStore } from "./task-page-store.js";
import type { SessionTitlesStore } from "./session-titles.js";
import type { BridgeSessionStateStore } from "./bridge-session-state-store.js";
import type { CopilotCliSessionCatalog } from "./copilot-cli-session-catalog.js";
import type { ReadStateStore } from "./read-state-store.js";
import type { ModelComparisonService } from "./model-comparison.js";
import type { ChatGradeStore, ChatGradesService } from "./chat-grading.js";
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
import type { TriggerStore } from "./triggers/store.js";
import type { TriggerService } from "./triggers/service.js";
import type { TriggerChatRunner } from "./triggers/chat-runner.js";
import type { TriggerTaskRunner } from "./triggers/task-runner.js";
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
import type { CuaDriverInstaller } from "./cua-driver.js";

export interface AppContext {
  taskStore: TaskStore;
  taskGroupStore: TaskGroupStore;
  settingsStore: SettingsStore;
  sessionMetaStore: SessionMetaStore;
  sessionWorkspaceStore: SessionWorkspaceStore;
  sessionPlaybookStore?: SessionPlaybookStore;
  /** Cached scan of bundled, home and pack skills with their playbook metadata. */
  skillCatalog?: SkillCatalog;
  skillPacks?: SkillPackManager;
  skillUsageStore?: SkillUsageStore;
  /** Installs and locates Cua Driver, the desktop automation engine. */
  cuaDriver?: CuaDriverInstaller;
  /** Suggested chats on each task panel. */
  taskStartersStore?: TaskStartersStore;
  /** Serves, refreshes and auto-refreshes suggested chats; created with the API services. */
  taskStarters?: TaskStartersService;
  /** Chats where triggers ran turns since the user last wrote there. */
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
  /** Side-by-side model comparison: twins, judging and the report (Settings › Models). */
  modelComparisons?: ModelComparisonService;
  /** Grades chats with Copilot's trajectory classifiers when the user asks (Settings › Usage). */
  chatGrades?: ChatGradesService;
  chatGradeStore?: ChatGradeStore;
  checklistStore: ChecklistStore;
  /** The Bridge's own calendar events. */
  calendarStore?: CalendarStore;
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
  managementJobStore?: ManagementJobStore;
  /** Chat delivery outbox: queued trigger and job results and restart notices for chats. */
  deferredPromptStore?: DeferredPromptStore;
  interruptedRunStore?: InterruptedRunStore;
  /** The browser message id each saved chat message was sent as. */
  chatMessageIdStore?: ChatMessageIdStore;
  /** Chat messages the Bridge accepted that the agent never received. */
  unsentMessageStore?: UnsentMessageStore;
  /** Commands in attached shells, kept so one the Bridge stops can be reported to its agent. */
  backgroundCommandStore?: BackgroundCommandStore;
  /** Every automation: chat wake-ups, chats started in tasks, new tasks. */
  triggerStore?: TriggerStore;
  triggerService?: TriggerService;
  /** Runs triggers that wake their own chat. */
  triggerChatRunner?: TriggerChatRunner;
  /** Runs triggers that start a chat in a task or create a task. */
  triggerTaskRunner?: TriggerTaskRunner;
  /** Delivers the outbox to chats. */
  deferredPromptRunner?: DeferredPromptRunner;
  /** Periodic owner of session-overlay/trigger row cleanup. Started at boot. */
  sessionOverlayMaintenance?: SessionOverlayMaintenance;
  /** Discovers preview generations published by the separate management job runner. */
  stagingPreviewDiscovery?: StagingPreviewDiscoveryController;
  /** Root of .copilot directory — defaults to homedir()/.copilot for production */
  copilotHome?: string;
  /** API mount path for server-made links, e.g. "/api" or "/staging/<prefix>/api". */
  apiBasePath?: string;
  runtimePaths?: RuntimePaths;
  bridgeToolsMcpServer?: BridgeToolsMcpServer;
  /** Shared launcher log file path when this server was started by the launcher */
  launcherLogPath?: string;
  /** Which sessions are Helm conversations; made before the API router so resumes can ask. */
  helmStore?: HelmStore;
  /** Helm, the orchestration manager; the API router creates it and owns its facade. */
  helm?: HelmService;
  /** Helm thinker runs, their briefs and Helm's memory; made before the API router. */
  helmThinkerStore?: HelmThinkerStore;
  /** Helm's passes over every Bridge that write Home's brief and Helm's memory; made with Helm. */
  helmThinker?: HelmThinker;
  /** Hands-free voice conversations for Helm. Created by the API router. */
  voiceGateway?: VoiceGateway;
  /** Local speech engine and installer shared by voice mode and chat mic transcription. */
  voiceRuntime?: VoiceRuntime;
  isStaging?: boolean;
}
