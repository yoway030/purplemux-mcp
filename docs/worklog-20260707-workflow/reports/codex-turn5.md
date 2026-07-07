REJECT

blocking: docs/worklog-20260707-workflow/design-v2.md:78-80,156 — PMUX_DONE footer contains the exact done signal as a standalone line, while §6 admits prompt echo can occur; before the real agent completion signal exists, `pmux_agent_status`/`pmux_agent_capture` can treat the echoed instruction line as `doneSignal.found=true`, producing false `inconsistent` or otherwise misleading status during normal work.

blocking: docs/worklog-20260707-workflow/design-v2.md:64,125-127,152 — "1줄차 complete|blocked" is not a reliable mid-write commit gate by itself; a sequential writer can create `turn-N.md`, write `complete\n`, then continue writing body, and capture step 1 will return truncated content as `source:"file"` complete. To close Opus B2 deterministically, the design needs a mandatory atomic protocol (`.tmp` then rename) or another verifiable commit condition such as EOF commit marker plus stable-size/read-after-delay validation.

non-blocking assessment: §4.2's error(tail) → shell-return → busy(tail) → ready(tail) ordering is the right fix for Opus B1 and for my turn3 stale glyph issue; the previous full-pane errorPattern false positive is addressed.

non-blocking assessment: §4.4 `pmux_agent_status` is a useful deterministic primitive, but it inherits the PMUX_DONE echo problem unless done-signal parsing excludes prompt examples or uses a non-echoable/nonce-gated protocol.

non-blocking assessment: §4.5 회수 사다리 is directionally sound: valid file first, mid-write/inconsistent states, pane fallback, then working/missing gives the orchestrator structured outcomes instead of raw pane interpretation.

non-blocking assessment: §0.1 결정론 원칙 is sound because it explicitly bounds readiness as best-effort heuristic and returns `tail` for exception judgment rather than pretending regex classification is fully deterministic.
