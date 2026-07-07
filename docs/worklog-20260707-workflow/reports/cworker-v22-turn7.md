DONE

## cworker v22-turn7 report

- Scope:
  - `src/agents.ts`
- `pmux_agent_turn` contract correction:
  - The single `pollTimeoutMs` budget now covers both pre-send waiting and completion polling.
  - Before sending, `pmux_agent_turn` retries transient pre-send states at `pollMs` intervals:
    - `reason:"busy"`
    - `reason:"not_ready"` with `readinessState:"agent_starting"` unless `readinessReason:"input_queued"`
  - Terminal pre-send failures still return immediately as `status:"send_failed"`:
    - `launch_failed`
    - `blocked`
    - signature queued input (`input_queued`)
    - other non-retryable not-ready states
  - Timeout now includes `phase:"pre_send"` or `phase:"awaiting_completion"`.
  - Awaiting-completion timeout still returns `marker`, `expectedReportFile`, `rawCliState`, `command`, and `tail` for capture-based resume.
  - Successful and `agent_error` returns include `sendAttempts` for diagnosis.
- Send diagnostics:
  - `sendAgentPrompt` false returns now include `readinessState` / `readinessReason` when available so `agent_turn` can distinguish retryable starting from true queued input.
- Tool description updated:
  - `pmux_agent_turn` now states it is safe to call immediately after a previous turn because transient pre-send busy/starting states are retried within the same turn budget.

## Verification

- `npm run typecheck` passed.
