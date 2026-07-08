import { randomBytes } from "node:crypto";

import { ToolError } from "../errors.js";
import { ID_RE, MODEL_RE } from "../profiles.js";

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function validateId(value: string | undefined, field: string): void {
  if (value !== undefined && !ID_RE.test(value)) {
    throw new ToolError(`${field} must match ${ID_RE.source}.`, {
      details: { field, value },
    });
  }
}

export function validateModel(model: string | undefined): void {
  if (model !== undefined && !MODEL_RE.test(model)) {
    throw new ToolError(`model must match ${MODEL_RE.source}.`, {
      details: { field: "model", value: model },
    });
  }
}

export function generateRequestId(): string {
  return randomBytes(6).toString("hex");
}
