APPROVE

no blocking

① 회귀 수정 재검토:
- 턴3의 stale ready glyph 지적은 해소됐다고 봅니다.
- `src/pane.ts`는 `errorPattern`을 full pane에서 먼저 검사하고, 마지막 비공백 줄의 shell prompt 복귀를 그 다음에 검사한 뒤, `busyPattern`/`readyPattern`은 tail 15줄에서만 평가합니다. 과거 scrollback의 `›`/`❯`가 현재 실패를 가리는 구조가 제거됐습니다.
- `agent_busy`가 `ReadinessState`에 추가됐고, `src/agents.ts`에서 `pmux_agent_wait_ready`는 busy를 terminal state로 반환하지 않고 계속 폴링하며, `pmux_agent_send`는 busy 시 `{sent:false, reason:"busy"}`로 거부합니다.
- `pmux_agent_send`가 `provider`를 필수 파라미터로 받아 provider별 ready/error/busy 기본 패턴을 쓰도록 바뀐 점도 맞습니다.
- `hasPriorTurnEnd`가 `stripAnsi(pane)` 후 marker를 검사하므로 ANSI 포함 END marker 누락 위험도 줄었습니다.
- `src/schemas.ts`는 `provider`와 `busyPattern`을 `agentSendShape`/`agentWaitReadyShape`에 반영했고, `permissionMode`는 최신 design-v1의 claude 2.1.201 실측 enum과 일치합니다.

② design-v1.md §2.5 파일 기반 회수 v1 승격:
- 타당합니다. 이번 운영에서 pane 회수의 구조적 한계가 이미 실증됐고, 파일 우선 회수는 문서 원안의 우선순위 1번을 v1으로 앞당기는 결정입니다.
- 경로를 호출자 입력이 아니라 `workspaceDir + ".pmux-agents" + agentId + turn`으로 조립하고, `agentId`/`turn`을 검증하며, 읽기 전 `realpath` 하위성 검사를 요구하는 설계는 인젝션 및 임의 파일 읽기 리스크를 실질적으로 줄입니다.
- 파일이 없거나 권한상 생성되지 않는 경우 pane marker로 폴백한다는 계약도 read-only/plan 모드와 호환됩니다.

③ design-v1.md §0.5 결정론 우선 원칙:
- 타당합니다. MCP 레이어가 명령 조립, readiness 분류, 폴링, marker/file 회수, 입력 전 검증, 경로 조립을 구조화된 반환값으로 처리하게 하는 방향은 LLM 오케스트레이터의 임의 해석을 줄입니다.
- 단, `tail` 기반 예외 판단과 프롬프트 작성은 계속 LLM 영역으로 남기는 경계도 현실적입니다.
