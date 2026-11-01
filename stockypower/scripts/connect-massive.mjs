// One-time setup: give the Stocky agent access to the Massive (formerly Polygon.io)
// stocks feed.
//
//   node scripts/connect-massive.mjs        (or: npm run connect-massive)
//
// The script:
//   1. Creates (or reuses) a vault named "Stockypower - Massive" and stores your
//      Massive key in it as the MASSIVE_API_KEY environment-variable credential.
//      Stocky's sandbox only ever sees a placeholder. Anthropic swaps in the real
//      key on the way out, and only for requests to api.massive.com /
//      api.polygon.io.
//   2. If Stocky's environment uses `limited` networking, adds those hosts to its
//      allowed_hosts list so the sandbox can reach Massive at all.
//   3. Writes STOCKY_VAULT_ID to stockypower/.env so every Stockypower session
//      attaches the vault.
//
// You can run it again safely: it updates the key in place, and won't add a
// host twice.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envPath = path.join(root, ".env");
try {
  process.loadEnvFile(envPath);
} catch {
  /* no .env */
}

const MASSIVE_KEY = process.env.MASSIVE_API_KEY;
const ENVIRONMENT_ID = process.env.STOCKY_ENVIRONMENT_ID || "env_01DjvqsavJUkxFrZeHNnMHMU";
const VAULT_NAME = "Stockypower - Massive";
const SECRET_NAME = "MASSIVE_API_KEY";
const MASSIVE_HOSTS = ["api.massive.com", "api.polygon.io"];

if (!MASSIVE_KEY) {
  console.error("MASSIVE_API_KEY is not set. Add your Massive API key to stockypower/.env first.");
  process.exit(1);
}

const client = new Anthropic();

// ── 1. Vault + credential ──────────────────────────────────────────────────

async function findOrCreateVault() {
  if (process.env.STOCKY_VAULT_ID) {
    const v = await client.beta.vaults.retrieve(process.env.STOCKY_VAULT_ID);
    if (!v.archived_at) return v;
  }
  for await (const v of client.beta.vaults.list()) {
    if (v.display_name === VAULT_NAME && !v.archived_at) return v;
  }
  return client.beta.vaults.create({ display_name: VAULT_NAME, metadata: { app: "stockypower" } });
}

const vault = await findOrCreateVault();
console.log(`Vault: ${vault.id} (${vault.display_name})`);

const credentialAuth = {
  type: "environment_variable",
  // Massive accepts "Authorization: Bearer <key>", so the key only has to be
  // substituted into headers. A key put in the URL (?apiKey=...) would NOT be
  // substituted.
  injection_location: { header: true },
  networking: { type: "limited", allowed_hosts: MASSIVE_HOSTS },
};

let existing = null;
for await (const c of client.beta.vaults.credentials.list(vault.id)) {
  if (c.auth?.type === "environment_variable" && c.auth.secret_name === SECRET_NAME && !c.archived_at) {
    existing = c;
    break;
  }
}

if (existing) {
  await client.beta.vaults.credentials.update(existing.id, {
    vault_id: vault.id,
    auth: { ...credentialAuth, secret_value: MASSIVE_KEY },
  });
  console.log(`Updated credential ${existing.id} (${SECRET_NAME})`);
} else {
  const cred = await client.beta.vaults.credentials.create(vault.id, {
    display_name: "Massive stocks API key",
    auth: { ...credentialAuth, secret_name: SECRET_NAME, secret_value: MASSIVE_KEY },
  });
  console.log(`Created credential ${cred.id} (${SECRET_NAME})`);
}

// ── 2. Environment networking ──────────────────────────────────────────────

const env = await client.beta.environments.retrieve(ENVIRONMENT_ID);
const cfg = env.config;
if (cfg?.type !== "cloud") {
  console.warn(
    `\nWARNING: environment ${ENVIRONMENT_ID} is "${cfg?.type}". Vault environment-variable credentials ` +
      `only work in Anthropic cloud environments. Stockypower will still give Stocky a Massive data ` +
      `snapshot file for each symbol, but Stocky can't call Massive live from this environment.`,
  );
} else if (cfg.networking?.type === "limited") {
  const hosts = new Set(cfg.networking.allowed_hosts ?? []);
  const missing = MASSIVE_HOSTS.filter((h) => !hosts.has(h));
  if (missing.length) {
    await client.beta.environments.update(ENVIRONMENT_ID, {
      config: {
        type: "cloud",
        networking: {
          type: "limited",
          allowed_hosts: [...hosts, ...missing],
          allow_mcp_servers: cfg.networking.allow_mcp_servers,
          allow_package_managers: cfg.networking.allow_package_managers,
        },
      },
    });
    console.log(`Environment ${ENVIRONMENT_ID}: added ${missing.join(", ")} to allowed_hosts`);
  } else {
    console.log(`Environment ${ENVIRONMENT_ID}: Massive hosts already allowed`);
  }
} else {
  console.log(`Environment ${ENVIRONMENT_ID}: networking is unrestricted, so Massive is already reachable`);
}

// ── 3. Save STOCKY_VAULT_ID to .env ────────────────────────────────────────

let dotenv = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
if (/^STOCKY_VAULT_ID=.*$/m.test(dotenv)) {
  dotenv = dotenv.replace(/^STOCKY_VAULT_ID=.*$/m, `STOCKY_VAULT_ID=${vault.id}`);
} else {
  dotenv += `${dotenv && !dotenv.endsWith("\n") ? "\n" : ""}STOCKY_VAULT_ID=${vault.id}\n`;
}
fs.writeFileSync(envPath, dotenv);
console.log(`\nSaved STOCKY_VAULT_ID=${vault.id} to ${envPath}`);
console.log("Done. Restart Stockypower (npm start) so new sessions attach the vault.");
