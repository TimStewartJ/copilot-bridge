-- Historical schema fixture only; no live product writer initializes these tables.
    -- Agent-published dashboard feed cards
    CREATE TABLE IF NOT EXISTS feed_cards (
      id TEXT PRIMARY KEY,
      dedupeKey TEXT,
      title TEXT NOT NULL,
      body TEXT,
      kind TEXT NOT NULL DEFAULT 'note',
      priority TEXT NOT NULL DEFAULT 'normal',
      status TEXT NOT NULL DEFAULT 'active',
      taskId TEXT REFERENCES tasks(id) ON DELETE SET NULL,
      sessionId TEXT,
      url TEXT,
      linksJson TEXT NOT NULL DEFAULT '[]',
      metadataJson TEXT,
      visualJson TEXT,
      actionJson TEXT,
      pinned INTEGER NOT NULL DEFAULT 0,
      statusChangedAt TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_feed_cards_dedupeKey
      ON feed_cards(dedupeKey) WHERE dedupeKey IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_feed_cards_status_updated
      ON feed_cards(status, pinned DESC, updatedAt DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_feed_cards_status_created
      ON feed_cards(status, pinned DESC, createdAt DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_feed_cards_status_changed
      ON feed_cards(status, statusChangedAt DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_feed_cards_taskId ON feed_cards(taskId);
    CREATE INDEX IF NOT EXISTS idx_feed_cards_sessionId ON feed_cards(sessionId);
    CREATE INDEX IF NOT EXISTS idx_feed_cards_kind ON feed_cards(kind);
    CREATE INDEX IF NOT EXISTS idx_feed_cards_updatedAt ON feed_cards(updatedAt, kind);

    -- Idempotent promotion of decision cards into canonical checklist actions.
    CREATE TABLE IF NOT EXISTS feed_card_checklist_promotions (
      feedCardId TEXT PRIMARY KEY REFERENCES feed_cards(id) ON DELETE CASCADE,
      checklistItemId TEXT NOT NULL UNIQUE REFERENCES checklist_items(id) ON DELETE CASCADE,
      createdAt TEXT NOT NULL
    );

    -- Canonical Focus objects. feed_cards remains a rollback-compatible projection.
    CREATE TABLE IF NOT EXISTS focus_object_identities (
      id TEXT PRIMARY KEY,
      objectType TEXT NOT NULL CHECK (objectType IN ('decision', 'alert', 'event')),
      dedupeKey TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_focus_object_identities_dedupeKey
      ON focus_object_identities(dedupeKey) WHERE dedupeKey IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_focus_object_identities_type
      ON focus_object_identities(objectType);

    CREATE TABLE IF NOT EXISTS decisions (
      id TEXT PRIMARY KEY REFERENCES focus_object_identities(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      body TEXT,
      priority TEXT NOT NULL DEFAULT 'normal',
      status TEXT NOT NULL DEFAULT 'active',
      taskId TEXT REFERENCES tasks(id) ON DELETE SET NULL,
      sessionId TEXT,
      url TEXT,
      linksJson TEXT NOT NULL DEFAULT '[]',
      metadataJson TEXT,
      visualJson TEXT,
      launchPromptJson TEXT,
      pinned INTEGER NOT NULL DEFAULT 0,
      activationId TEXT NOT NULL,
      statusChangedAt TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_decisions_status_updated
      ON decisions(status, pinned DESC, updatedAt DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_decisions_taskId ON decisions(taskId);

    CREATE TABLE IF NOT EXISTS alerts (
      id TEXT PRIMARY KEY REFERENCES focus_object_identities(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      body TEXT,
      priority TEXT NOT NULL DEFAULT 'high',
      status TEXT NOT NULL DEFAULT 'active',
      taskId TEXT REFERENCES tasks(id) ON DELETE SET NULL,
      sessionId TEXT,
      url TEXT,
      linksJson TEXT NOT NULL DEFAULT '[]',
      metadataJson TEXT,
      visualJson TEXT,
      launchPromptJson TEXT,
      pinned INTEGER NOT NULL DEFAULT 0,
      activationId TEXT NOT NULL,
      statusChangedAt TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_alerts_status_updated
      ON alerts(status, pinned DESC, updatedAt DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_alerts_taskId ON alerts(taskId);

    CREATE TABLE IF NOT EXISTS focus_events (
      id TEXT PRIMARY KEY REFERENCES focus_object_identities(id) ON DELETE CASCADE,
      category TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT,
      priority TEXT NOT NULL DEFAULT 'normal',
      status TEXT NOT NULL DEFAULT 'active',
      taskId TEXT REFERENCES tasks(id) ON DELETE SET NULL,
      sessionId TEXT,
      url TEXT,
      linksJson TEXT NOT NULL DEFAULT '[]',
      metadataJson TEXT,
      visualJson TEXT,
      launchPromptJson TEXT,
      pinned INTEGER NOT NULL DEFAULT 0,
      activationId TEXT NOT NULL,
      statusChangedAt TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_focus_events_status_updated
      ON focus_events(status, pinned DESC, updatedAt DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_focus_events_taskId ON focus_events(taskId);
    CREATE INDEX IF NOT EXISTS idx_focus_events_category ON focus_events(category);

    CREATE TABLE IF NOT EXISTS focus_action_links (
      sourceType TEXT NOT NULL CHECK (sourceType IN ('decision', 'alert', 'event')),
      sourceId TEXT NOT NULL REFERENCES focus_object_identities(id) ON DELETE CASCADE,
      activationId TEXT NOT NULL,
      actionId TEXT NOT NULL REFERENCES checklist_items(id) ON DELETE CASCADE,
      createdAt TEXT NOT NULL,
      PRIMARY KEY (sourceType, sourceId, activationId, actionId)
    );
    CREATE INDEX IF NOT EXISTS idx_focus_action_links_actionId
      ON focus_action_links(actionId);

    CREATE TABLE IF NOT EXISTS focus_legacy_reconciliation_issues (
      id TEXT PRIMARY KEY,
      feedCardId TEXT,
      feedRowId INTEGER NOT NULL UNIQUE,
      error TEXT NOT NULL,
      rawRowJson TEXT NOT NULL,
      detectedAt TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_focus_legacy_reconciliation_issues_feedCardId
      ON focus_legacy_reconciliation_issues(feedCardId);

    -- Voice jobs

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
  