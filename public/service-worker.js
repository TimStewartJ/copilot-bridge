// A missing script leaves the old worker active; keep its update URL until browsers retire it.
self.addEventListener("install", (event) => event.waitUntil(self.skipWaiting()));
self.addEventListener("activate", (event) => event.waitUntil(self.registration.unregister()));
