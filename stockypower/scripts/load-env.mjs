// Loads stockypower/.env into process.env.
//
// Unlike process.loadEnvFile(), values in .env WIN over variables already set
// in the operating system. That way an old ANTHROPIC_API_KEY saved in Windows
// can't silently override the key you put in .env. Empty values in .env are
// skipped, so they don't blank out a real OS value.

import fs from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const ENV_PATH = path.join(ROOT, ".env");

export function readEnvFile() {
  if (!fs.existsSync(ENV_PATH)) return {};
  // Strip a UTF-8 BOM (Notepad sometimes adds one).
  const text = fs.readFileSync(ENV_PATH, "utf8").replace(/^﻿/, "");
  return parseEnv(text);
}

export function loadEnv() {
  for (const [k, v] of Object.entries(readEnvFile())) {
    const value = String(v).trim().replace(/^["']|["']$/g, "");
    if (value) process.env[k] = value;
  }
}

// Sets or replaces KEY=value lines in .env, keeping every other line as-is.
export function writeEnvValues(values) {
  let text = fs.existsSync(ENV_PATH)
    ? fs.readFileSync(ENV_PATH, "utf8").replace(/^﻿/, "")
    : fs.existsSync(path.join(ROOT, ".env.example"))
      ? fs.readFileSync(path.join(ROOT, ".env.example"), "utf8")
      : "";
  for (const [k, v] of Object.entries(values)) {
    const line = `${k}=${v}`;
    const re = new RegExp(`^\\s*#?\\s*${k}=.*$`, "m");
    if (re.test(text)) text = text.replace(re, line);
    else text += `${text && !text.endsWith("\n") ? "\n" : ""}${line}\n`;
  }
  fs.writeFileSync(ENV_PATH, text);
}

// Anthropic client for Stockypower. Normally the SDK default. If setup found
// that the API only accepts this key in the classic `x-api-key` header, it
// sets ANTHROPIC_KEY_HEADER=x-api-key and we send it that way instead.
export async function makeClient(opts = {}) {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const key = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (process.env.ANTHROPIC_KEY_HEADER === "x-api-key" && key) {
    const { apiKey, ...rest } = opts;
    return new Anthropic({ ...rest, apiKey: null, authToken: null, defaultHeaders: { "x-api-key": key } });
  }
  return new Anthropic(opts);
}
