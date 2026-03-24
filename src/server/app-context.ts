// AppContext — dependency injection container for the entire app
// Production creates one context; staging preview creates a second, isolated context.

import type { TaskStore } from "./task-store.js";
import type { TaskGroupStore } from "./task-group-store.js";
import type { ScheduleStore } from "./schedule-store.js";
import type { SettingsStore } from "./settings-store.js";
import type { SessionMetaStore } from "./session-meta-store.js";
import type { SessionTitlesStore } from "./session-titles.js";
import type { ReadStateStore } from "./read-state-store.js";
import type { GlobalBus } from "./global-bus.js";
import type { EventBusRegistry } from "./event-bus.js";
import type { SessionManager } from "./session-manager.js";

export interface AppContext {
  taskStore: TaskStore;
  taskGroupStore: TaskGroupStore;
  scheduleStore: ScheduleStore;
  settingsStore: SettingsStore;
  sessionMetaStore: SessionMetaStore;
  sessionTitles: SessionTitlesStore;
  readStateStore: ReadStateStore;
  globalBus: GlobalBus;
  eventBusRegistry: EventBusRegistry;
  sessionManager: SessionManager;
  isStaging?: boolean;
}
