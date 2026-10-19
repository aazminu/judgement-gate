// Generates .dev.vars for the local demo: throwaway RSA key, mock GitHub, real Jev via OpenRouter.
// Usage: OPENROUTER_API_KEY=... node scripts/init-dev-vars.mjs
import crypto from "node:crypto";
import fs from "node:fs";

const key = process.env.OPENROUTER_API_KEY;
if (!key) throw new Error("set OPENROUTER_API_KEY");
const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString().trim().replace(/\n/g, "\n");
fs.writeFileSync(
  ".dev.vars",
  [
    "GITHUB_WEBHOOK_SECRET=dev-secret",
    "GITHUB_APP_ID=1",
    `GITHUB_APP_PRIVATE_KEY="${pem}"`,
    `JEV_API_KEY=${key}`,
    "GITHUB_API_URL=http://localhost:8788",
    "MODE=enforce",
    "",
  ].join("\n"),
);
console.log("wrote .dev.vars (gitignored)");
