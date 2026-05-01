import type { PushSubscription } from "web-push";
import type { DatabaseSync } from "./db.js";

export interface StoredPushSubscription {
  id: string;
  endpoint: string;
  expirationTime: number | null;
  p256dh: string;
  auth: string;
  userAgent?: string;
  createdAt: string;
  updatedAt: string;
  lastSeenAt: string;
}

export interface PushSubscriptionInput {
  endpoint: string;
  expirationTime?: number | null;
  keys: {
    p256dh: string;
    auth: string;
  };
}

function hydrate(row: any): StoredPushSubscription {
  return {
    id: String(row.id),
    endpoint: String(row.endpoint),
    expirationTime: row.expirationTime === null || row.expirationTime === undefined
      ? null
      : Number(row.expirationTime),
    p256dh: String(row.p256dh),
    auth: String(row.auth),
    userAgent: row.userAgent ?? undefined,
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
    lastSeenAt: String(row.lastSeenAt),
  };
}

export function isPushSubscriptionInput(value: unknown): value is PushSubscriptionInput {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  const keys = candidate.keys as Record<string, unknown> | undefined;
  const expirationTime = candidate.expirationTime;
  return typeof candidate.endpoint === "string"
    && candidate.endpoint.startsWith("https://")
    && !!keys
    && typeof keys.p256dh === "string"
    && keys.p256dh.trim() !== ""
    && typeof keys.auth === "string"
    && keys.auth.trim() !== ""
    && (
      expirationTime === undefined
      || expirationTime === null
      || typeof expirationTime === "number"
    );
}

export function toWebPushSubscription(subscription: StoredPushSubscription): PushSubscription {
  return {
    endpoint: subscription.endpoint,
    expirationTime: subscription.expirationTime,
    keys: {
      p256dh: subscription.p256dh,
      auth: subscription.auth,
    },
  };
}

export function createPushSubscriptionStore(db: DatabaseSync) {
  function listSubscriptions(): StoredPushSubscription[] {
    return (db.prepare(`
      SELECT * FROM push_subscriptions
      ORDER BY datetime(lastSeenAt) DESC, datetime(createdAt) DESC
    `).all() as any[]).map(hydrate);
  }

  function getSubscriptionByEndpoint(endpoint: string): StoredPushSubscription | undefined {
    const row = db.prepare("SELECT * FROM push_subscriptions WHERE endpoint = ?").get(endpoint) as any;
    return row ? hydrate(row) : undefined;
  }

  function upsertSubscription(input: PushSubscriptionInput, userAgent?: string): StoredPushSubscription {
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    db.prepare(`
      INSERT INTO push_subscriptions (
        id, endpoint, expirationTime, p256dh, auth, userAgent, createdAt, updatedAt, lastSeenAt
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(endpoint) DO UPDATE SET
        expirationTime = excluded.expirationTime,
        p256dh = excluded.p256dh,
        auth = excluded.auth,
        userAgent = excluded.userAgent,
        updatedAt = excluded.updatedAt,
        lastSeenAt = excluded.lastSeenAt
    `).run(
      id,
      input.endpoint,
      input.expirationTime ?? null,
      input.keys.p256dh,
      input.keys.auth,
      userAgent ?? null,
      now,
      now,
      now,
    );

    return getSubscriptionByEndpoint(input.endpoint)!;
  }

  function deleteSubscription(endpoint: string): boolean {
    const result = db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").run(endpoint);
    return result.changes > 0;
  }

  function touchSubscription(endpoint: string): void {
    db.prepare("UPDATE push_subscriptions SET lastSeenAt = ? WHERE endpoint = ?").run(new Date().toISOString(), endpoint);
  }

  function countSubscriptions(): number {
    const row = db.prepare("SELECT COUNT(*) AS count FROM push_subscriptions").get() as { count: number };
    return row.count;
  }

  return {
    listSubscriptions,
    getSubscriptionByEndpoint,
    upsertSubscription,
    deleteSubscription,
    touchSubscription,
    countSubscriptions,
  };
}

export type PushSubscriptionStore = ReturnType<typeof createPushSubscriptionStore>;
