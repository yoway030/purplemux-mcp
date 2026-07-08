// Unit tests for src/guide.ts (dist/ build).
import { assert, check } from "./helpers.mjs";

import { ORCHESTRATION_GUIDE, SERVER_INSTRUCTIONS } from "../../dist/guide.js";

// ---- guide (LLM-facing docs consistency) --------------------------------

check("guide: SERVER_INSTRUCTIONS is a distillation of ORCHESTRATION_GUIDE", () => {
  // Every tool named in the instructions must appear in the full guide too —
  // the short version must never tell a different story.
  const toolsInInstructions = SERVER_INSTRUCTIONS.match(/pmux_[a-z_]+/g) ?? [];
  assert(toolsInInstructions.length > 0, "instructions must name tools");
  for (const t of new Set(toolsInInstructions)) {
    assert(ORCHESTRATION_GUIDE.includes(t), `guide missing tool ${t}`);
  }
});

check("guide: golden-path tools are documented in both texts", () => {
  for (const t of [
    "pmux_agent_start",
    "pmux_agent_wait_ready",
    "pmux_agent_turn",
    "pmux_close_tab",
    "pmux_guide",
  ]) {
    assert(SERVER_INSTRUCTIONS.includes(t), `instructions missing ${t}`);
    assert(ORCHESTRATION_GUIDE.includes(t), `guide missing ${t}`);
  }
});

check("guide: SERVER_INSTRUCTIONS stays concise (injected into every session)", () => {
  assert(
    SERVER_INSTRUCTIONS.length < 3000,
    `instructions too long: ${SERVER_INSTRUCTIONS.length} chars`,
  );
});
