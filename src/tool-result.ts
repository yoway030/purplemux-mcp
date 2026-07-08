import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { ToolError } from "./errors.js";

/** Encode any JSON-serializable value as a single text content block. */
export function jsonResult(value: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  };
}

/** Plain text content (used for guide / api-guide markdown). */
export function textResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

/** Structured tool-error result surfaced to the model (isError:true). */
export function errorResult(err: unknown): CallToolResult {
  if (err instanceof ToolError) {
    const payload = { message: err.message, ...err.details };
    return {
      isError: true,
      content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify({ message }, null, 2) }],
  };
}

/** Wrap a handler so any throw becomes a structured error result. */
export function guard<A>(
  fn: (args: A) => Promise<CallToolResult>,
): (args: A) => Promise<CallToolResult> {
  return async (args: A) => {
    try {
      return await fn(args);
    } catch (err) {
      return errorResult(err);
    }
  };
}
