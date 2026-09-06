import type { DatabaseSync } from "./db.js";
import { runImmediateTransaction } from "./db-transaction.js";
import { initializeFocusSessionLaunchSchema } from "./focus-session-launch-store.js";
import { initializeFocusProtectionSchema } from "./focus-protection-store.js";
import { initializeFocusLegacyProjectionSchema } from "./focus-legacy-projection-store.js";

export function initializeFocusSupplementalSchema(db: DatabaseSync): void {
  const linkColumns = db.prepare("PRAGMA table_info(focus_action_links)").all();
  if (linkColumns.some((column) => column.name === "actionId" && column.pk === 0)) {
    runImmediateTransaction(db, () => db.exec(`
      DROP TRIGGER IF EXISTS focus_action_deletion_history;
      CREATE TABLE focus_action_links_expanded (
        sourceType TEXT NOT NULL CHECK (sourceType IN ('decision','alert','event')),
        sourceId TEXT NOT NULL REFERENCES focus_object_identities(id) ON DELETE CASCADE,
        activationId TEXT NOT NULL,
        actionId TEXT NOT NULL REFERENCES checklist_items(id) ON DELETE CASCADE,
        createdAt TEXT NOT NULL,
        PRIMARY KEY (sourceType, sourceId, activationId, actionId)
      );
      INSERT INTO focus_action_links_expanded SELECT * FROM focus_action_links;
      DROP TABLE focus_action_links;
      ALTER TABLE focus_action_links_expanded RENAME TO focus_action_links;
      CREATE INDEX idx_focus_action_links_actionId ON focus_action_links(actionId);
    `));
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS focus_object_details (
      objectId TEXT PRIMARY KEY REFERENCES focus_object_identities(id) ON DELETE CASCADE,
      lifecycle TEXT NOT NULL CHECK (lifecycle IN ('active','acknowledged','handed_off','resolved','accepted_risk','dismissed')),
      sourceFamily TEXT,
      producer TEXT,
      observedAt TEXT,
      validUntil TEXT,
      interventionBy TEXT,
      evidenceJson TEXT NOT NULL DEFAULT '[]',
      impact TEXT,
      consequenceOfDelay TEXT,
      alternativesJson TEXT NOT NULL DEFAULT '[]',
      recommendation TEXT,
      fallback TEXT,
      outcome TEXT,
      resolutionReason TEXT,
      notificationMode TEXT NOT NULL DEFAULT 'focus' CHECK (notificationMode IN ('focus','summary','immediate')),
      authorizationGrantId TEXT,
      episodeReason TEXT,
      contentFingerprint TEXT NOT NULL DEFAULT '',
      lastMeaningfulChangeAt TEXT NOT NULL,
      acknowledgedAt TEXT,
      handedOffAt TEXT,
      resolvedAt TEXT,
      originalTaskId TEXT,
      originalTaskTitle TEXT,
      orphanedAt TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_focus_details_lifecycle ON focus_object_details(lifecycle, interventionBy);
    CREATE INDEX IF NOT EXISTS idx_focus_details_family ON focus_object_details(sourceFamily, lastMeaningfulChangeAt);
    CREATE INDEX IF NOT EXISTS idx_focus_details_original_task ON focus_object_details(originalTaskId);
    CREATE INDEX IF NOT EXISTS idx_focus_links_source ON focus_action_links(sourceId, createdAt);

    -- Deliberately no live-object foreign key: deletion must not delete history.
    CREATE TABLE IF NOT EXISTS focus_transitions (
      id TEXT PRIMARY KEY,
      objectId TEXT NOT NULL,
      objectType TEXT NOT NULL CHECK (objectType IN ('decision','alert','event','action')),
      title TEXT NOT NULL,
      activationId TEXT NOT NULL,
      fromLifecycle TEXT,
      toLifecycle TEXT,
      reason TEXT NOT NULL,
      actor TEXT NOT NULL CHECK (actor IN ('agent','user','legacy','system')),
      relatedActionId TEXT,
      sessionId TEXT,
      detailsJson TEXT NOT NULL DEFAULT '{}',
      createdAt TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_focus_transitions_object ON focus_transitions(objectId, createdAt, id);
    CREATE INDEX IF NOT EXISTS idx_focus_transitions_created ON focus_transitions(createdAt DESC, id);
    CREATE TRIGGER IF NOT EXISTS focus_transitions_no_update BEFORE UPDATE ON focus_transitions
      BEGIN SELECT RAISE(ABORT, 'Focus transitions are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS focus_transitions_no_delete BEFORE DELETE ON focus_transitions
      BEGIN SELECT RAISE(ABORT, 'Focus transitions are append-only'); END;

    CREATE TABLE IF NOT EXISTS focus_action_details (
      actionId TEXT PRIMARY KEY REFERENCES checklist_items(id) ON DELETE CASCADE,
      stableKey TEXT UNIQUE,
      sourceUrl TEXT,
      originalTaskId TEXT,
      originalTaskTitle TEXT,
      orphanedAt TEXT
    );

    CREATE TABLE IF NOT EXISTS focus_authority_grants (
      id TEXT PRIMARY KEY,
      stableKey TEXT UNIQUE,
      title TEXT NOT NULL,
      taskId TEXT,
      sourceFamily TEXT NOT NULL,
      producer TEXT NOT NULL,
      scope TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active','revoked')),
      validFrom TEXT NOT NULL,
      validUntil TEXT NOT NULL,
      allowImmediate INTEGER NOT NULL DEFAULT 0,
      allowQuietHoursOverride INTEGER NOT NULL DEFAULT 0,
      constraintsJson TEXT NOT NULL DEFAULT '[]',
      grantedBy TEXT NOT NULL,
      revokedAt TEXT,
      revokeReason TEXT,
      orphanedAt TEXT,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_focus_authority_match ON focus_authority_grants(sourceFamily, producer, taskId, status, validUntil);

    CREATE TABLE IF NOT EXISTS focus_coverage_assertions (
      id TEXT PRIMARY KEY,
      stableKey TEXT UNIQUE,
      title TEXT NOT NULL,
      taskId TEXT,
      sourceFamily TEXT NOT NULL,
      producer TEXT NOT NULL,
      scope TEXT NOT NULL,
      explicitState TEXT NOT NULL CHECK (explicitState IN ('valid','broken','unknown')),
      lastCheckedAt TEXT,
      validUntil TEXT,
      interventionBy TEXT,
      expectedIntervalMinutes INTEGER NOT NULL DEFAULT 1440,
      atRiskMinutes INTEGER NOT NULL DEFAULT 60,
      evidenceJson TEXT NOT NULL DEFAULT '[]',
      reason TEXT,
      authorityGrantId TEXT,
      originalTaskTitle TEXT,
      orphanedAt TEXT,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_focus_coverage_family ON focus_coverage_assertions(sourceFamily, taskId, validUntil);

    CREATE TABLE IF NOT EXISTS focus_digest_views (
      digestId TEXT PRIMARY KEY,
      lastViewedAt TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS focus_notification_deliveries (
      id TEXT PRIMARY KEY,
      objectId TEXT NOT NULL,
      activationId TEXT NOT NULL,
      transitionId TEXT,
      reason TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('eligible','suppressed','sent','failed')),
      suppressionReason TEXT,
      resolvedGrantId TEXT,
      pendingUntil TEXT,
      claimToken TEXT,
      claimedAt TEXT,
      sentAt TEXT,
      error TEXT,
      outcomeJson TEXT,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      UNIQUE (objectId, activationId, reason)
    );
    CREATE INDEX IF NOT EXISTS idx_focus_deliveries_pending ON focus_notification_deliveries(status, pendingUntil);

    CREATE TABLE IF NOT EXISTS focus_attention_events (
      id TEXT PRIMARY KEY,
      eventType TEXT NOT NULL,
      objectId TEXT,
      objectType TEXT,
      activationId TEXT,
      transitionId TEXT,
      actor TEXT NOT NULL,
      reason TEXT,
      detailsJson TEXT NOT NULL DEFAULT '{}',
      createdAt TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_focus_attention_events_type ON focus_attention_events(eventType, createdAt);
    CREATE INDEX IF NOT EXISTS idx_focus_attention_events_object ON focus_attention_events(objectId, createdAt);
    CREATE INDEX IF NOT EXISTS idx_focus_attention_events_created ON focus_attention_events(createdAt);

    CREATE TABLE IF NOT EXISTS focus_attention_audits (
      id TEXT PRIMARY KEY,
      objectId TEXT,
      title TEXT NOT NULL,
      category TEXT NOT NULL CHECK (category IN ('false_positive','missed_attention','stale','misclassified','leakage','notification','coverage','other')),
      severity TEXT NOT NULL CHECK (severity IN ('low','normal','high')),
      status TEXT NOT NULL CHECK (status IN ('open','resolved','dismissed')),
      notes TEXT NOT NULL,
      outcome TEXT,
      actor TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      resolvedAt TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_focus_attention_audits_status ON focus_attention_audits(status, severity, updatedAt);

    CREATE TRIGGER IF NOT EXISTS focus_preserve_task_provenance
    BEFORE DELETE ON tasks
    BEGIN
      UPDATE focus_object_details SET
        originalTaskId = OLD.id,
        originalTaskTitle = OLD.title,
        orphanedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE objectId IN (
        SELECT id FROM decisions WHERE taskId = OLD.id
        UNION ALL SELECT id FROM alerts WHERE taskId = OLD.id
        UNION ALL SELECT id FROM focus_events WHERE taskId = OLD.id
      );
      INSERT INTO focus_transitions (
        id, objectId, objectType, title, activationId, fromLifecycle, toLifecycle, reason, actor, detailsJson, createdAt
      )
      SELECT lower(hex(randomblob(16))), i.id, i.objectType, COALESCE(d.title,a.title,e.title),
        COALESCE(d.activationId,a.activationId,e.activationId), details.lifecycle, details.lifecycle,
        'task-orphaned', 'system', json_object('taskId', OLD.id, 'taskTitle', OLD.title),
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      FROM focus_object_identities i JOIN focus_object_details details ON details.objectId=i.id
      LEFT JOIN decisions d ON d.id=i.id LEFT JOIN alerts a ON a.id=i.id LEFT JOIN focus_events e ON e.id=i.id
      WHERE COALESCE(d.taskId,a.taskId,e.taskId)=OLD.id;
      INSERT INTO focus_attention_events (id, eventType, objectId, objectType, actor, reason, detailsJson, createdAt)
      SELECT lower(hex(randomblob(16))), 'global_leakage_prevented', d.objectId, i.objectType,
        'system', 'task-deleted', json_object('taskId', OLD.id, 'taskTitle', OLD.title),
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      FROM focus_object_details d JOIN focus_object_identities i ON i.id = d.objectId
      WHERE d.originalTaskId = OLD.id AND d.orphanedAt IS NOT NULL;
      UPDATE focus_authority_grants SET status = 'revoked',
        revokedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
        revokeReason = 'task-deleted', orphanedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
        updatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE taskId = OLD.id;
      UPDATE focus_coverage_assertions SET originalTaskTitle = OLD.title,
        orphanedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE taskId = OLD.id;
      INSERT INTO focus_action_details (actionId, originalTaskId, originalTaskTitle, orphanedAt)
      SELECT id, OLD.id, OLD.title, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      FROM checklist_items WHERE taskId = OLD.id
      ON CONFLICT(actionId) DO UPDATE SET originalTaskId = OLD.id, originalTaskTitle = OLD.title,
        orphanedAt = excluded.orphanedAt;
    END;

    CREATE TRIGGER IF NOT EXISTS focus_action_deletion_history
    BEFORE DELETE ON checklist_items
    BEGIN
      INSERT INTO focus_transitions (
        id, objectId, objectType, title, activationId, fromLifecycle, toLifecycle,
        reason, actor, relatedActionId, detailsJson, createdAt
      ) VALUES (
        lower(hex(randomblob(16))), OLD.id, 'action', OLD.text, OLD.id,
        CASE WHEN OLD.done = 1 THEN 'resolved' ELSE 'active' END, NULL,
        'deleted', 'system', OLD.id,
        json_object('taskId', OLD.taskId, 'done', OLD.done,
          'createdAt', OLD.createdAt, 'completedAt', OLD.completedAt,
          'originalTaskId', (SELECT originalTaskId FROM focus_action_details WHERE actionId=OLD.id),
          'originalTaskTitle', (SELECT originalTaskTitle FROM focus_action_details WHERE actionId=OLD.id),
          'sourceUrl', (SELECT sourceUrl FROM focus_action_details WHERE actionId=OLD.id),
          'sources', json((SELECT COALESCE(json_group_array(json_object(
            'sourceId', sourceId, 'sourceType', sourceType, 'activationId', activationId
          )), '[]') FROM focus_action_links WHERE actionId = OLD.id))),
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      );
      INSERT INTO focus_attention_events (id, eventType, objectId, objectType, activationId, actor, reason, createdAt)
      VALUES (lower(hex(randomblob(16))), 'deleted', OLD.id, 'action', OLD.id, 'system',
        'action-deleted', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
    END;
  `);
  initializeFocusSessionLaunchSchema(db);
  initializeFocusProtectionSchema(db);
  initializeFocusLegacyProjectionSchema(db);
  backfillFocusDetails(db);
}

export function backfillFocusDetails(db: DatabaseSync): void {
  db.exec(`
    INSERT INTO focus_object_details (
      objectId, lifecycle, sourceFamily, producer, observedAt,
      lastMeaningfulChangeAt, originalTaskId, originalTaskTitle, resolutionReason
    )
    SELECT o.id,
      CASE o.status WHEN 'done' THEN 'resolved' WHEN 'dismissed' THEN 'dismissed' ELSE 'active' END,
      CASE WHEN instr(i.dedupeKey, ':') > 0
        THEN substr(i.dedupeKey, 1, instr(i.dedupeKey, ':') - 1)
        ELSE COALESCE(i.dedupeKey, o.category) END,
      'legacy', o.createdAt,
      COALESCE(o.updatedAt, o.statusChangedAt, o.createdAt),
      o.taskId, tasks.title,
      CASE WHEN o.status != 'active' THEN 'legacy-status-change' ELSE NULL END
    FROM (
      SELECT id, status, taskId, createdAt, updatedAt, statusChangedAt, 'decision' AS category FROM decisions
      UNION ALL SELECT id, status, taskId, createdAt, updatedAt, statusChangedAt, 'alert' FROM alerts
      UNION ALL SELECT id, status, taskId, createdAt, updatedAt, statusChangedAt, category FROM focus_events
    ) o
    JOIN focus_object_identities i ON i.id = o.id
    LEFT JOIN tasks ON tasks.id = o.taskId
    WHERE NOT EXISTS (SELECT 1 FROM focus_legacy_reconciliation_issues q WHERE q.feedCardId = o.id)
    ON CONFLICT(objectId) DO NOTHING;
  `);
}
