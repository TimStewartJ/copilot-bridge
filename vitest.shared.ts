export const sharedTestConfig = {
  root: ".",
  environment: "node",
  env: {
    NODE_ENV: "test",
  },
  testTimeout: 10_000,
} as const;
