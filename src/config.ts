import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Source of a resolved value:
 * - "env"  → came from an environment variable
 * - "file" → came from a file under ~/.purplemux
 * - "none" → not available anywhere (used by diagnostics only)
 */
export type Source = "env" | "file" | "none";

export interface Resolved {
  value: string;
  source: Source;
}

const PMUX_DIR = join(homedir(), ".purplemux");
const PORT_FILE = join(PMUX_DIR, "port");
const TOKEN_FILE = join(PMUX_DIR, "cli-token");

/**
 * A port value is safe only if it is a plain decimal integer in 1..65535.
 * Rejecting anything else prevents a poisoned PMUX_PORT / port-file such as
 * "1234@evil.example:80" from turning `http://localhost:${port}` into a URL
 * whose host is an attacker's — which would send X-Pmux-Token off-host.
 */
export function isValidPort(v: string): boolean {
  return /^\d+$/.test(v) && Number(v) >= 1 && Number(v) <= 65535;
}

/** Read a file and trim it; return null if missing/unreadable/empty. */
function readTrimmed(path: string): string | null {
  try {
    const raw = readFileSync(path, "utf8").trim();
    return raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the port. env PMUX_PORT beats ~/.purplemux/port.
 * Returns null (with source "none") when neither is present.
 */
export function resolvePort(): Resolved | null {
  const env = process.env.PMUX_PORT?.trim();
  if (env) return { value: env, source: "env" };
  const file = readTrimmed(PORT_FILE);
  if (file) return { value: file, source: "file" };
  return null;
}

/**
 * Resolve the token. env PMUX_TOKEN beats ~/.purplemux/cli-token.
 * Returns null (with source "none") when neither is present.
 */
export function resolveToken(): Resolved | null {
  const env = process.env.PMUX_TOKEN?.trim();
  if (env) return { value: env, source: "env" };
  const file = readTrimmed(TOKEN_FILE);
  if (file) return { value: file, source: "file" };
  return null;
}

export interface Connection {
  baseUrl: string;
  port: string;
  portSource: Source;
  token: string;
  tokenSource: Source;
}

/**
 * Full connection resolution used by every networked tool call.
 * Resolves fresh on every call (no caching) so a purplemux restart /
 * port change / token regen is absorbed without restarting the MCP server.
 * Throws a plain Error with an actionable message when port or token is missing.
 */
export function resolveConnection(): Connection {
  const port = resolvePort();
  if (!port) {
    throw new Error(
      "PMUX_PORT not set and ~/.purplemux/port missing (is the server running?)",
    );
  }
  if (!isValidPort(port.value)) {
    throw new Error(
      `Invalid purplemux port "${port.value}" (from ${port.source}); expected an integer 1-65535.`,
    );
  }
  const token = resolveToken();
  if (!token) {
    throw new Error(
      "PMUX_TOKEN not set and ~/.purplemux/cli-token missing (is the server running?)",
    );
  }
  return {
    baseUrl: `http://localhost:${port.value}`,
    port: port.value,
    portSource: port.source,
    token: token.value,
    tokenSource: token.source,
  };
}
