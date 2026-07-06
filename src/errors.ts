/**
 * Structured tool error carrying HTTP status + any server-provided metadata.
 * The message is human/agent readable; `details` preserves the raw fields
 * (error / validPanelTypes / suggestedCommand / provider metadata / Allow)
 * so the model can act on them.
 */
export class ToolError extends Error {
  status?: number;
  retryable: boolean;
  details: Record<string, unknown>;

  constructor(
    message: string,
    opts: {
      status?: number;
      retryable?: boolean;
      details?: Record<string, unknown>;
    } = {},
  ) {
    super(message);
    this.name = "ToolError";
    this.status = opts.status;
    this.retryable = opts.retryable ?? false;
    this.details = opts.details ?? {};
  }
}

interface ServerBody {
  error?: unknown;
  validPanelTypes?: unknown;
  suggestedCommand?: unknown;
  [k: string]: unknown;
}

/**
 * Map a non-2xx HTTP response into a ToolError per the Stage-2 design table.
 *
 * - 400: invalid request; surface server `error` + `validPanelTypes` (panelType case).
 * - 403: auth failure; source-aware hint at PMUX_TOKEN / ~/.purplemux/cli-token. Never token contents.
 * - 404: not found / body unavailable.
 * - 405: method error; include `Allow` header (implementation-bug signal).
 * - 409: typed conflict; include `error`. provider metadata + suggestedCommand only on
 *        tab-create agent-not-installed/agent-path-missing. "Browser tab not attached yet"
 *        is marked transient/retryable.
 * - 500: purplemux internal failure.
 * - 503: Electron browser bridge unavailable — hard, not retryable.
 */
export function mapHttpError(
  status: number,
  body: ServerBody | string | null,
  headers: Headers,
  ctx: { tokenSource?: string } = {},
): ToolError {
  const obj: ServerBody =
    body && typeof body === "object" ? (body as ServerBody) : {};
  const serverError =
    typeof obj.error === "string"
      ? obj.error
      : typeof body === "string" && body.trim()
        ? body.trim()
        : undefined;

  const details: Record<string, unknown> = { status };
  if (serverError !== undefined) details.error = serverError;

  const attach = (key: keyof ServerBody) => {
    if (obj[key] !== undefined) details[key] = obj[key];
  };

  switch (status) {
    case 400: {
      attach("validPanelTypes");
      const msg =
        serverError ??
        "Bad request (missing/invalid field)";
      return new ToolError(`HTTP 400: ${msg}`, { status, details });
    }
    case 403: {
      const where =
        ctx.tokenSource === "env"
          ? "the PMUX_TOKEN environment variable"
          : "~/.purplemux/cli-token";
      return new ToolError(
        `HTTP 403: ${serverError ?? "Forbidden"} — auth failed; check ${where} ` +
          `(the token is re-read per call, so the next call auto-recovers once it is fixed).`,
        { status, details },
      );
    }
    case 404: {
      return new ToolError(`HTTP 404: ${serverError ?? "Not found"}`, {
        status,
        details,
      });
    }
    case 405: {
      const allow = headers.get("allow");
      if (allow) details.Allow = allow;
      return new ToolError(
        `HTTP 405: ${serverError ?? "Method not allowed"}` +
          (allow ? ` (Allow: ${allow})` : "") +
          " — likely an MCP implementation bug.",
        { status, details },
      );
    }
    case 409: {
      // provider metadata + suggestedCommand only exist on tab-create
      // agent-not-installed / agent-path-missing. Forward every extra server
      // field generically (except `error`, already captured) so we never drop
      // real metadata whose exact key names are unverified in headless mode.
      for (const [k, v] of Object.entries(obj)) {
        if (k !== "error" && v !== undefined) details[k] = v;
      }
      const transient =
        typeof serverError === "string" &&
        /not attached yet/i.test(serverError);
      details.retryable = transient;
      return new ToolError(
        `HTTP 409: ${serverError ?? "Conflict"}` +
          (transient
            ? " — transient (webview not dom-ready yet); retry shortly."
            : ""),
        { status, retryable: transient, details },
      );
    }
    case 500: {
      return new ToolError(
        `HTTP 500: ${serverError ?? "Internal purplemux error"}`,
        { status, details },
      );
    }
    case 503: {
      details.retryable = false;
      return new ToolError(
        `HTTP 503: ${serverError ?? "Browser bridge unavailable (Electron-only feature)"} ` +
          "— hard failure, not retryable (purplemux is not running under Electron).",
        { status, retryable: false, details },
      );
    }
    default: {
      return new ToolError(
        `HTTP ${status}: ${serverError ?? "Request failed"}`,
        { status, details },
      );
    }
  }
}

/** Turn a fetch/network throw into a ToolError, special-casing ECONNREFUSED. */
export function mapNetworkError(
  err: unknown,
  ctx: { port: string; portSource: string },
): ToolError {
  const code =
    typeof err === "object" && err !== null
      ? ((err as { code?: string; cause?: { code?: string } }).code ??
        (err as { cause?: { code?: string } }).cause?.code)
      : undefined;
  if (code === "ECONNREFUSED") {
    return new ToolError(
      `purplemux server not running or port changed ` +
        `(tried port ${ctx.port} from ${ctx.portSource}). ECONNREFUSED.`,
      { details: { code, port: ctx.port, portSource: ctx.portSource } },
    );
  }
  const msg = err instanceof Error ? err.message : String(err);
  return new ToolError(`Network error: ${msg}`, {
    details: { code, port: ctx.port, portSource: ctx.portSource },
  });
}
