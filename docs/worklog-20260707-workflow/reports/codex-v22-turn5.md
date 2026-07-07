APPROVE

# codex v22-turn5 최종 검토

라운드A 최종본 승인. blocking 없음.

## 라운드A 최종본

내 턴4 이후 추가 수정 4건은 모두 타당하다.

- 부팅/첫 send placeholder: Codex가 빈 composer에 placeholder ghost text를 재표시하는 실화면 동작을 반영했다. 단순 "glyph 뒤 텍스트 있음 = queued"보다 정확하다.
- busy 창 miss: `requireBusyTransition:true`에서 `transitionSeen`을 busy 관측뿐 아니라 baseline non-ready -> ready 전이까지 인정한 것은 polling 간격 때문에 짧은 busy를 놓치는 실제 케이스를 잘 흡수한다. baseline이 처음부터 ready면 계속 timeout될 수 있어 stale-ready guard도 유지된다.
- bullet prefix: `normalizeMarkerCandidate`가 decoration prefix 하나만 제거하고 trailing junk는 계속 금지하므로, Codex 출력 장식은 허용하면서 echo/본문 오탐 방어는 유지된다.
- queued 판정 전환: `PMUX_` 또는 `응답 규약` 프로토콜 시그니처 기반으로 좁힌 것은 C1 우려를 여전히 방어한다. `pmux_agent_send`는 항상 footer를 붙이므로 진짜 미제출 입력에는 이 시그니처가 남는다. 반대로 시그니처 없는 composer text는 placeholder/history일 수 있어 ready 후보로 보는 것이 맞다.

확인한 핵심 경로:

- `src/pane.ts`: signature-bearing composer는 `agent_starting/input_queued`, signature-free composer는 `agent_ready/placeholder composer`.
- `src/agents.ts`: send validation은 later turn에서 `input_queued`를 strict하게 막고, `turn <= 1`에서만 placeholder warning 경로를 허용한다.
- `src/agents.ts`: wait_ready timeout payload에 `baseline`/`transitionSeen`/`rawCliState`/`command`/`tail`이 남아 복구 판단이 가능하다.
- `test/unit.mjs`: signature-bearing queued, placeholder, bullet prefix, wrapped marker, echo-safety 회귀가 고정됐다.

검증: `npm run typecheck`, `npm run build`, `node test/unit.mjs` 통과. `npm test`는 package script가 없어 실행 불가했다.

## R6 설계

R6 승인. 런타임 오류는 readiness 상태를 바꾸면 안 되고, 별도 fact로 노출해야 한다는 설계가 맞다. `API Error: 529 Overloaded` 뒤 세션은 실제로 다시 입력 가능한 ready 상태이므로, 상태를 `launch_failed`나 `agent_busy`로 오염시키면 복구 경로가 나빠진다.

구현 시 조건:

- `detectRuntimeError(tail)`는 순수 함수로 두고, 기본 패턴은 conservative하게 유지한다.
- `wait_ready`/`status`/`send`는 `runtimeError`를 상태와 별도 필드로 추가한다.
- 라운드B `agent_turn`은 완료 증거 없이 `ready + runtimeError`를 보면 `agent_error`로 조기 반환하되, 파일/PMUX_DONE complete가 있으면 그 완료 증거를 우선해야 한다.
- override를 받는다면 기존 pattern guard처럼 길이 제한과 regex compile 에러 처리가 필요하다.
