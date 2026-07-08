import { resolveConnection, type Connection } from "./config.js";
import { mapHttpError, mapNetworkError } from "./errors.js";

export type HttpMethod = "GET" | "POST" | "DELETE";

export interface CallOptions {
  /** Query params; undefined/null values are skipped. */
  query?: Record<string, string | number | boolean | undefined | null>;
  /** JSON body (sends Content-Type: application/json). */
  body?: unknown;
  /**
   * When true, return raw bytes (Uint8Array) instead of decoding.
   * Used by the screenshot savePath path.
   */
  raw?: boolean;
}

export interface RawResult {
  bytes: Uint8Array;
  contentType: string | null;
}

function buildUrl(
  baseUrl: string,
  path: string,
  query?: CallOptions["query"],
): string {
  const url = new URL(path, baseUrl);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null) continue;
      url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

/**
 * Single entry point for every purplemux HTTP call.
 * - Resolves port/token fresh on each call (no caching).
 * - Sends X-Pmux-Token; JSON body also sends Content-Type: application/json.
 * - Success: parses JSON when content-type includes "json"; raw bytes when
 *   opts.raw; otherwise text (for api-guide / plain responses).
 * - Non-2xx → mapped ToolError. Network failure → mapped ToolError (ECONNREFUSED).
 */
export async function callApi<T = unknown>(
  method: HttpMethod,
  path: string,
  opts: CallOptions = {},
): Promise<T> {
  const conn: Connection = resolveConnection();
  const url = buildUrl(conn.baseUrl, path, opts.query);

  const headers: Record<string, string> = {
    "X-Pmux-Token": conn.token,
  };
  let bodyInit: string | undefined;
  if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
    bodyInit = JSON.stringify(opts.body);
  }

  let res: Response;
  try {
    res = await fetch(url, { method, headers, body: bodyInit });
  } catch (err) {
    throw mapNetworkError(err, {
      port: conn.port,
      portSource: conn.portSource,
    });
  }

  const contentType = res.headers.get("content-type");

  if (!res.ok) {
    // Try JSON → text → empty for the error body.
    let parsed: unknown = null;
    const text = await res.text().catch(() => "");
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    throw mapHttpError(res.status, parsed as never, res.headers, {
      tokenSource: conn.tokenSource,
    });
  }

  if (opts.raw) {
    const buf = new Uint8Array(await res.arrayBuffer());
    return { bytes: buf, contentType } as unknown as T;
  }

  if (contentType && contentType.toLowerCase().includes("json")) {
    // Decode defensively: an empty body (e.g. 204) or a non-JSON body must
    // not blow up res.json() into an opaque SyntaxError.
    const text = await res.text();
    if (!text) return {} as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as unknown as T;
    }
  }
  // text/markdown, text/plain, or empty
  return (await res.text()) as unknown as T;
}
