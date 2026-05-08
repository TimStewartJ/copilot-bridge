#!/usr/bin/env node
import { createHash, createPrivateKey, sign } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { basename } from "node:path";

function readArgs(argv) {
  const args = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      throw new Error(`Unexpected argument: ${token}`);
    }
    const key = token.slice(2);
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for --${key}`);
    }
    args.set(key, value);
    i += 1;
  }
  return args;
}

function required(args, key) {
  const value = args.get(key)?.trim();
  if (!value) {
    throw new Error(`--${key} is required`);
  }
  return value;
}

function optional(args, key) {
  const value = args.get(key)?.trim();
  return value || undefined;
}

function assertHttpsUrl(label, value) {
  const url = new URL(value);
  if (url.protocol !== "https:") {
    throw new Error(`${label} must be an HTTPS URL.`);
  }
  return url.toString();
}

function readSigningKey() {
  if (process.env.BRIDGE_UPDATE_MANIFEST_PRIVATE_KEY_PEM?.trim()) {
    return process.env.BRIDGE_UPDATE_MANIFEST_PRIVATE_KEY_PEM;
  }
  if (process.env.BRIDGE_UPDATE_MANIFEST_PRIVATE_KEY_BASE64?.trim()) {
    return Buffer.from(process.env.BRIDGE_UPDATE_MANIFEST_PRIVATE_KEY_BASE64.trim(), "base64").toString("utf8");
  }
  if (process.env.BRIDGE_UPDATE_MANIFEST_PRIVATE_KEY_PATH?.trim()) {
    return readFileSync(process.env.BRIDGE_UPDATE_MANIFEST_PRIVATE_KEY_PATH.trim(), "utf8");
  }
  throw new Error(
    "Update manifest signing key is not configured. Set BRIDGE_UPDATE_MANIFEST_PRIVATE_KEY_PEM, BRIDGE_UPDATE_MANIFEST_PRIVATE_KEY_BASE64, or BRIDGE_UPDATE_MANIFEST_PRIVATE_KEY_PATH.",
  );
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

const args = readArgs(process.argv.slice(2));
const packagePath = required(args, "package-path");
const packageUrl = assertHttpsUrl("package URL", required(args, "package-url"));
const releaseUrl = optional(args, "release-url");
const releaseNotesUrl = optional(args, "release-notes-url");
const outputPath = required(args, "output");
const signatureOutputPath = required(args, "signature-output");
const packageStats = statSync(packagePath);

const manifest = {
  schemaVersion: 1,
  appId: "copilot-bridge",
  keyId: optional(args, "key-id") ?? process.env.BRIDGE_UPDATE_MANIFEST_KEY_ID ?? "default",
  version: required(args, "version"),
  channel: required(args, "channel"),
  platform: required(args, "platform"),
  sourceCommit: required(args, "source-commit"),
  publishedAt: optional(args, "published-at") ?? new Date().toISOString(),
  ...(releaseUrl ? { releaseUrl: assertHttpsUrl("release URL", releaseUrl) } : {}),
  ...(releaseNotesUrl ? { releaseNotesUrl: assertHttpsUrl("release notes URL", releaseNotesUrl) } : {}),
  package: {
    name: basename(packagePath),
    url: packageUrl,
    sha256: sha256File(packagePath),
    sizeBytes: packageStats.size,
  },
};

const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
const privateKey = createPrivateKey(readSigningKey());
const signature = sign(null, Buffer.from(manifestText, "utf8"), privateKey).toString("base64");

writeFileSync(outputPath, manifestText, "utf8");
writeFileSync(signatureOutputPath, `${signature}\n`, "ascii");

console.log(`Update manifest written: ${outputPath}`);
console.log(`Update manifest signature written: ${signatureOutputPath}`);
