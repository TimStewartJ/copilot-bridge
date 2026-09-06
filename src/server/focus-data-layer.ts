import type { DatabaseSync } from "./db.js";
import type { GlobalBus } from "./global-bus.js";
import type { ChecklistStore } from "./checklist-store.js";
import { createFeedStore, type FeedCard, type FeedCardVisual } from "./feed-store.js";
import {
  createAlertStore,
  createDecisionStore,
  createFocusEventStore,
  createFocusIdentityStore,
  createFocusReconciliationErrorStore,
  type FocusObject,
} from "./focus-domain-store.js";
import { createFocusMutationCoordinator } from "./focus-mutation-coordinator.js";
import { createFocusDetailsStore } from "./focus-details-store.js";
import { createFocusAttentionStore, createFocusAuditStore, createFocusDigestViewStore, createFocusTransitionStore } from "./focus-attention-store.js";
import { createFocusAuthorityStore, createFocusCoverageStore } from "./focus-governance-store.js";
import { createFocusNotificationDeliveryStore } from "./focus-notification-delivery-store.js";
import { createFocusSessionLaunchStore } from "./focus-session-launch-store.js";
import { createFocusProtectionStore } from "./focus-protection-store.js";

export function createFocusDataLayer(
  db: DatabaseSync,
  bus: GlobalBus,
  checklistStore: ChecklistStore,
  options: {
    onVisualUnreferenced?: (visual: FeedCardVisual, object: FocusObject | FeedCard) => void;
    reconcile?: boolean;
  } = {},
) {
  const decisionStore = createDecisionStore(db);
  const alertStore = createAlertStore(db);
  const eventStore = createFocusEventStore(db);
  const identityStore = createFocusIdentityStore(db);
  const reconciliationErrorStore = createFocusReconciliationErrorStore(db);
  const detailsStore = createFocusDetailsStore(db);
  const transitionStore = createFocusTransitionStore(db);
  const attentionStore = createFocusAttentionStore(db);
  const authorityStore = createFocusAuthorityStore(db);
  const coverageStore = createFocusCoverageStore(db, authorityStore);
  const digestViewStore = createFocusDigestViewStore(db);
  const auditStore = createFocusAuditStore(db);
  const notificationDeliveryStore = createFocusNotificationDeliveryStore(db);
  const sessionLaunchStore = createFocusSessionLaunchStore(db);
  const protectionStore = createFocusProtectionStore(db, bus);
  const mutations = createFocusMutationCoordinator({
    db,
    bus,
    decisionStore,
    alertStore,
    eventStore,
    identityStore,
    detailsStore,
    transitionStore,
    attentionStore,
    authorityStore,
    options: {
      onVisualUnreferenced: options.onVisualUnreferenced,
    },
  });
  const feedStore = createFeedStore(db, {
    mutations,
    checklistStore,
  });
  const reconciliation = options.reconcile === false
    ? { imported: 0, deleted: 0, quarantined: 0 }
    : mutations.reconcileLegacyFeed();
  return {
    decisionStore,
    alertStore,
    eventStore,
    identityStore,
    reconciliationErrorStore,
    detailsStore,
    transitionStore,
    attentionStore,
    authorityStore,
    coverageStore,
    digestViewStore,
    auditStore,
    notificationDeliveryStore,
    sessionLaunchStore,
    protectionStore,
    mutations,
    feedStore,
    reconciliation,
  };
}

export type FocusDataLayer = ReturnType<typeof createFocusDataLayer>;
