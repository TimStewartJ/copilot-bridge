import type { PushSubscriptionInput } from "../server/push-subscription-store.js";

export const TEST_PUSH_SUBSCRIPTION: PushSubscriptionInput = {
  endpoint: "https://push.example.test/send/subscription-id",
  expirationTime: null,
  keys: {
    p256dh: "test-p256dh",
    auth: "test-auth",
  },
};

export const TEST_PUSH_ENV = {
  BRIDGE_PUSH_VAPID_PUBLIC_KEY: "test-public-key",
  BRIDGE_PUSH_VAPID_PRIVATE_KEY: "test-private-key",
  BRIDGE_PUSH_VAPID_SUBJECT: "mailto:test@example.com",
};
