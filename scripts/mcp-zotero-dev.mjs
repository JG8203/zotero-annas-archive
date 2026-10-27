#!/usr/bin/env node
/**
 * Launch @introfini/mcp-server-zotero-dev using ZOTERO_RDP_PORT from this
 * project's .env so Cursor MCP and the MCP Bridge plugin share one port.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const envPath = resolve(root, ".env");
const env = { ...process.env };

if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    // Prefer .env for the shared RDP port; leave other process env alone.
    if (key === "ZOTERO_RDP_PORT" || env[key] === undefined) {
      env[key] = value;
    }
  }
}

env.ZOTERO_RDP_PORT ||= "6100";
env.ZOTERO_RDP_HOST ||= "127.0.0.1";

const child = spawn("npx", ["-y", "@introfini/mcp-server-zotero-dev"], {
  stdio: "inherit",
  env,
  cwd: root,
  shell: process.platform === "win32",
});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 0);
});
