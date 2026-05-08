#!/usr/bin/env node
import { generateKeyPairSync } from "node:crypto";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const publicPem = publicKey.export({ type: "spki", format: "pem" });
const privatePem = privateKey.export({ type: "pkcs8", format: "pem" });

console.log("# Public key: put this in BRIDGE_UPDATE_MANIFEST_PUBLIC_KEY_PEM or BRIDGE_UPDATE_MANIFEST_PUBLIC_KEY_BASE64.");
console.log(publicPem);
console.log("# Private key: put this in the GitHub secret BRIDGE_UPDATE_MANIFEST_PRIVATE_KEY_PEM.");
console.log("# Do not commit it.");
console.log(privatePem);
