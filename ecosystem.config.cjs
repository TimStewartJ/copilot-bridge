// PM2 ecosystem config for Copilot Bridge
const path = require("path");

const NODE_PATH = path.join(
  process.env.USERPROFILE || "",
  ".local",
  "nodejs",
  "node-v22.21.0-win-x64",
  "node.exe",
);
const ROOT = __dirname;

module.exports = {
  apps: [
    {
      name: "bridge",
      script: path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs"),
      args: path.join(ROOT, "src", "server", "index.ts"),
      interpreter: NODE_PATH,
      cwd: ROOT,
      env_file: ".env",
      max_restarts: 5,
      min_uptime: "10s",
      restart_delay: 5000,
      autorestart: true,
    },
    {
      name: "tunnel",
      script: "devtunnel",
      args: "host copilot-bridge",
      interpreter: "none",
      cwd: ROOT,
      autorestart: true,
      max_restarts: 3,
      restart_delay: 10000,
    },
  ],
};
