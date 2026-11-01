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

import Anthropic from "@anthropic-ai/sdk";
import { loadEnv, makeClient, writeEnvValues, ENV_PATH } from "./load-env.mjs";

loadEnv();

const MASSIVE_KEY = process.env.MASSIVE_API_KEY;
const ENVIRONMENT_ID = process.env.STOCKY_ENVIRONMENT_ID || "env_01DjvqsavJUkxFrZeHNnMHMU";
const VAULT_NAME = "Stockypower - Massive";
const SECRET_NAME = "MASSIVE_API_KEY";
const MASSIVE_HOSTS = ["api.massive.com", "api.polygon.io"];

const client = await makeClient();

try {
  await connectMassive();
} catch (err) {
  console.error("\nERROR: " + explainError(err));
  process.exitCode = 1;
}

async function connectMassive() {
  if (!MASSIVE_KEY) {
    throw new Error("MASSIVE_API_KEY is not set. Add your Massive API key to stockypower/.env first.");
  }

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

  writeEnvValues({ STOCKY_VAULT_ID: vault.id });
  process.env.STOCKY_VAULT_ID = vault.id;
  console.log(`\nSaved STOCKY_VAULT_ID=${vault.id} to ${ENV_PATH}`);
  console.log("Done. Restart Stockypower (npm start) so new sessions attach the vault.");
}

// Plain-English explanation for the errors people actually hit.
function explainError(err) {
  if (err instanceof Anthropic.AuthenticationError)
    return "Anthropic rejected ANTHROPIC_API_KEY (invalid key). Create a new key at https://platform.claude.com -> API Keys, in the same workspace as Stocky, and put it in .env.";
  if (err instanceof Anthropic.PermissionDeniedError)
    return "This Anthropic key isn't allowed to do this. Use a key from the workspace where Stocky lives, with a Developer or Admin role.";
  if (err instanceof Anthropic.NotFoundError)
    return "Stocky's environment wasn't found with this key. The key is probably from a different Console workspace than Stocky.";
  if (err instanceof Anthropic.APIConnectionError) return "Couldn't reach the Anthropic API. Check your internet connection.";
  return err?.message || String(err);
}
