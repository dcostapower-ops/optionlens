// Guided setup for Stockypower. Run by setup.bat (or `npm run setup`).
//
//  1. Asks for your Anthropic API key, checks it works and can see Stocky.
//  2. Asks for your Massive API key and checks it works.
//  3. Saves both to stockypower/.env.
//  4. Connects Stocky to Massive (scripts/connect-massive.mjs).
//
// Keys are only ever written to .env. The key's line is erased from the screen after Enter.

import readline from "node:readline";
import { spawnSync } from "node:child_process";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { loadEnv, makeClient, readEnvFile, writeEnvValues, ROOT, ENV_PATH } from "./load-env.mjs";

loadEnv();

const AGENT_ID = process.env.STOCKY_AGENT_ID || "agent_01Vs8LnyLYVarn95Uhjm4saV";
const ENVIRONMENT_ID = process.env.STOCKY_ENVIRONMENT_ID || "env_01DjvqsavJUkxFrZeHNnMHMU";
const MASSIVE_BASE = process.env.MASSIVE_BASE_URL || "https://api.massive.com";

const clean = (s) => String(s ?? "").trim().replace(/^["']|["']$/g, "").trim();
const tail = (k) => (k.length > 8 ? `…${k.slice(-4)}` : "");

// One plain prompt reader for the whole run. Typing and pasting are visible
// (hidden input confused people on Windows: pasting showed nothing). Once Enter
// is pressed, the line with the key is erased from the screen.
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY) });
const lines = rl[Symbol.asyncIterator]();

async function askKey(question) {
  process.stdout.write(question);
  const { value, done } = await lines.next();
  if (done) throw new Error("Input closed before a key was entered.");
  if (process.stdout.isTTY) {
    readline.moveCursor(process.stdout, 0, -1);
    readline.clearLine(process.stdout, 0);
    readline.cursorTo(process.stdout, 0);
    process.stdout.write("> (key entered)\n");
  } else {
    process.stdout.write("\n");
  }
  return clean(value);
}

// ── Anthropic ──────────────────────────────────────────────────────────────

// Returns { ok: true } or { ok: false, why }.
const ANTHROPIC_BASE = (process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com").replace(/\/+$/, "");

// Non-secret description of a key, for comparing with the hint the Console shows.
const keyShape = (k) => `${k.slice(0, 13)}…${k.slice(-4)}, ${k.length} characters`;

// Second opinion: is the key accepted in the classic x-api-key header?
async function acceptedViaXApiKey(apiKey) {
  try {
    const r = await fetch(`${ANTHROPIC_BASE}/v1/models?limit=1`, {
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      signal: AbortSignal.timeout(15_000),
    });
    return r.ok;
  } catch {
    return false;
  }
}

// Can this key see Stocky and its environment? Returns null if yes, else an error object.
async function tryStocky(client) {
  try {
    await client.beta.agents.retrieve(AGENT_ID);
    await client.beta.environments.retrieve(ENVIRONMENT_ID);
    return null;
  } catch (err) {
    return err;
  }
}

// Returns { ok: true, extra? } or { ok: false, why }.
async function checkAnthropicKey(apiKey) {
  if (apiKey.startsWith("sk-ant-oat"))
    return {
      ok: false,
      why:
        "That's a Claude subscription / Claude Code login token (sk-ant-oat…), not an API key.\n" +
        "  Create an API key at https://platform.claude.com -> API Keys. It starts with sk-ant-api03-.",
    };
  if (apiKey.startsWith("sk-ant-admin"))
    return {
      ok: false,
      why: "That's an Admin API key (sk-ant-admin…). Stockypower needs a regular API key (sk-ant-api03-…).",
    };
  if (!apiKey.startsWith("sk-ant-"))
    return { ok: false, why: "That doesn't look like an Anthropic API key. API keys start with sk-ant-api03-." };

  let extra = {};
  let err = await tryStocky(await makeClient({ apiKey, authToken: null, maxRetries: 1 }));

  if (err instanceof Anthropic.AuthenticationError && process.env.ANTHROPIC_KEY_HEADER !== "x-api-key") {
    // Rule out the SDK's header style before blaming the key.
    if (await acceptedViaXApiKey(apiKey)) {
      process.env.ANTHROPIC_KEY_HEADER = "x-api-key";
      extra = { ANTHROPIC_KEY_HEADER: "x-api-key" };
      err = await tryStocky(await makeClient({ apiKey, authToken: null, maxRetries: 1 }));
    }
  }

  if (!err) return { ok: true, extra };
  if (err instanceof Anthropic.AuthenticationError)
    return {
      ok: false,
      why:
        `Anthropic says this key is invalid (key read as: ${keyShape(apiKey)}).\n` +
        "  It was checked two different ways, so the key itself is the problem: it was deleted,\n" +
        "  disabled, or copied incompletely. In https://platform.claude.com -> API Keys,\n" +
        "  click Create Key and copy the NEW key straight away (the full key is shown only once).",
    };
  if (err instanceof Anthropic.NotFoundError || err instanceof Anthropic.PermissionDeniedError)
    return {
      ok: false,
      why:
        `The key is valid, but it can't see Stocky (${AGENT_ID}) or its environment.\n` +
        "  Create the key in the same Console workspace where you built Stocky.",
    };
  if (err instanceof Anthropic.APIConnectionError)
    return { ok: false, why: "Couldn't reach Anthropic. Check your internet connection." };
  return { ok: false, why: `Anthropic error: ${err.message}` };
}

// ── Massive ────────────────────────────────────────────────────────────────

async function checkMassiveKey(key) {
  if (!key) return { ok: false, why: "No key entered." };
  try {
    const r = await fetch(`${MASSIVE_BASE}/v2/aggs/ticker/AAPL/prev?adjusted=true`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (r.ok) return { ok: true };
    if (r.status === 401 || r.status === 403)
      return { ok: false, why: `Massive rejected this key (HTTP ${r.status}).` };
    return { ok: true, warn: `Massive answered HTTP ${r.status}; keeping the key anyway.` };
  } catch (err) {
    return { ok: true, warn: `Couldn't reach Massive to test the key (${err.message}); keeping it anyway.` };
  }
}

// ── Ask until a key passes ─────────────────────────────────────────────────

async function getKey({ name, label, help, current, check }) {
  if (current) {
    process.stdout.write(`Checking the ${label} already in .env (${tail(current)})… `);
    const res = await check(current);
    if (res.ok) {
      if (res.extra && Object.keys(res.extra).length) writeEnvValues(res.extra);
      console.log("works.");
      if (res.warn) console.log(`  Note: ${res.warn}`);
      return current;
    }
    console.log(`not usable.\n  ${res.why}`);
  }
  console.log(`\n${help}`);
  for (;;) {
    const key = await askKey(`Paste your ${label} here, then press Enter:\n> `);
    if (!key) {
      console.log("  Nothing was entered. To paste: right-click inside this window, or press Ctrl+V.");
      continue;
    }
    process.stdout.write("  Checking… ");
    const res = await check(key);
    if (res.ok) {
      console.log(`works (${tail(key)}).`);
      if (res.warn) console.log(`  Note: ${res.warn}`);
      writeEnvValues({ [name]: key, ...(res.extra ?? {}) });
      return key;
    }
    console.log(`\n  ${res.why}\n  Let's try again.`);
  }
}

console.log("\n=== Stockypower setup ===\n");

const fileVals = readEnvFile();

await getKey({
  name: "ANTHROPIC_API_KEY",
  label: "Anthropic API key",
  help:
    "Step 1 of 2: Anthropic API key.\n" +
    "  Get one at https://platform.claude.com -> API Keys -> Create Key,\n" +
    "  in the SAME workspace where your Stocky agent lives.",
  current: clean(fileVals.ANTHROPIC_API_KEY),
  check: checkAnthropicKey,
});

await getKey({
  name: "MASSIVE_API_KEY",
  label: "Massive API key",
  help: "\nStep 2 of 2: Massive API key.\n  Copy it from your Massive account dashboard (API Keys).",
  current: clean(fileVals.MASSIVE_API_KEY),
  check: checkMassiveKey,
});

rl.close();
console.log(`\nSaved your keys to ${ENV_PATH}`);
console.log("\nConnecting Stocky to the Massive feed…\n");

const r = spawnSync(process.execPath, [path.join(ROOT, "scripts", "connect-massive.mjs")], {
  stdio: "inherit",
  cwd: ROOT,
});
if (r.status !== 0) {
  console.error("\nSetup couldn't connect Stocky to Massive. See the error above.");
  process.exitCode = 1;
} else {
  console.log("\n=== Setup complete ===");
}
