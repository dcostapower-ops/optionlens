// Guided setup for Stockypower. Run by setup.bat (or `npm run setup`).
//
//  1. Asks for your Anthropic API key, checks it works and can see Stocky.
//  2. Asks for your Massive API key and checks it works.
//  3. Saves both to stockypower/.env.
//  4. Connects Stocky to Massive (scripts/connect-massive.mjs).
//
// Keys you type are hidden on screen and only ever written to .env.

import readline from "node:readline";
import { spawnSync } from "node:child_process";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { loadEnv, readEnvFile, writeEnvValues, ROOT, ENV_PATH } from "./load-env.mjs";

loadEnv();

const AGENT_ID = process.env.STOCKY_AGENT_ID || "agent_01Vs8LnyLYVarn95Uhjm4saV";
const ENVIRONMENT_ID = process.env.STOCKY_ENVIRONMENT_ID || "env_01DjvqsavJUkxFrZeHNnMHMU";
const MASSIVE_BASE = process.env.MASSIVE_BASE_URL || "https://api.massive.com";

const clean = (s) => String(s ?? "").trim().replace(/^["']|["']$/g, "").trim();
const tail = (k) => (k.length > 8 ? `…${k.slice(-4)}` : "");

// One prompt reader for the whole run; typed text is hidden (pasting works too).
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY) });
let muted = false;
rl._writeToOutput = (s) => {
  if (!muted) rl.output.write(s);
};
const lines = rl[Symbol.asyncIterator]();

async function askHidden(question) {
  process.stdout.write(question);
  muted = true;
  const { value, done } = await lines.next();
  muted = false;
  process.stdout.write("\n");
  if (done) throw new Error("Input closed before a key was entered.");
  return clean(value);
}

// ── Anthropic ──────────────────────────────────────────────────────────────

// Returns { ok: true } or { ok: false, why }.
async function checkAnthropicKey(apiKey) {
  if (!apiKey.startsWith("sk-ant-")) {
    return { ok: false, why: "That doesn't look like an Anthropic API key. Keys start with sk-ant-." };
  }
  const client = new Anthropic({ apiKey, authToken: null, maxRetries: 1 });
  try {
    await client.beta.agents.retrieve(AGENT_ID);
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError)
      return { ok: false, why: "Anthropic says this key is invalid. It may have been mistyped, deleted or disabled." };
    if (err instanceof Anthropic.NotFoundError || err instanceof Anthropic.PermissionDeniedError)
      return {
        ok: false,
        why: `The key works, but it can't see Stocky (${AGENT_ID}). Make the key in the same Console workspace as Stocky.`,
      };
    if (err instanceof Anthropic.APIConnectionError)
      return { ok: false, why: "Couldn't reach Anthropic. Check your internet connection." };
    return { ok: false, why: `Anthropic error: ${err.message}` };
  }
  try {
    await client.beta.environments.retrieve(ENVIRONMENT_ID);
  } catch (err) {
    if (err instanceof Anthropic.NotFoundError || err instanceof Anthropic.PermissionDeniedError)
      return { ok: false, why: `The key can see Stocky but not its environment (${ENVIRONMENT_ID}).` };
    return { ok: false, why: `Anthropic error: ${err.message}` };
  }
  return { ok: true };
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
      console.log("works.");
      if (res.warn) console.log(`  Note: ${res.warn}`);
      return current;
    }
    console.log(`not usable.\n  ${res.why}`);
  }
  console.log(`\n${help}`);
  for (;;) {
    const key = await askHidden(`Paste your ${label} and press Enter (it stays hidden): `);
    if (!key) {
      console.log("  Nothing was entered. Right-click usually pastes in this window.");
      continue;
    }
    process.stdout.write("  Checking… ");
    const res = await check(key);
    if (res.ok) {
      console.log(`works (${tail(key)}).`);
      if (res.warn) console.log(`  Note: ${res.warn}`);
      writeEnvValues({ [name]: key });
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
