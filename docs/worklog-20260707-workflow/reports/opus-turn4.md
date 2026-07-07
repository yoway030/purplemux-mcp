verdict: REJECT — 턴3 blocking 2건은 해소 확인, 그러나 신규 blocking 2건 (①분류 errorPattern 전체-pane 오탐, ②§2.5 파일 회수의 원자성 갭)

## 안건 ① 회귀 수정 재검토 — 턴3 blocking 2건 판정: 둘 다 해소됨 ✅

- **턴3-1 (send provider 하드코딩) → 해소.** `agentSendShape`에 `provider: providerEnum` 필수 필드 추가(schemas.ts:235), `AgentSendArgs.provider`(agents.ts:51), 핸들러가 `defaultReadyPattern(args.provider)`/`defaultErrorPattern`/`defaultBusyPattern`에 전달(agents.ts:364-378). Claude도 `❯`/오류/busy 패턴이 provider별로 올바르게 적용됨. 확인.
- **턴3-2 (hasPriorTurnEnd stripAnsi 누락) → 해소.** agents.ts:209가 `stripAnsi(pane).split(...)`로 변경 — extractMarkerBlock과 파싱 경로 일치. 확인.
- 부수 확인: busy 상태 도입(`agent_busy`), 분류 tail 제한, send의 busy 거부(`{sent:false, reason:"busy"}`), errorPattern/busyPattern override 대칭(§4.5-2), ReDoS 가드(≤200자) 모두 반영. 기존 16툴 비회귀(tools.ts 변경 없음).

## 그러나 — 신규 blocking 2건

### B1. classifyReadiness의 errorPattern이 **전체 pane** 대상 → 다회차 세션에서 영구 오탐 (pane.ts:129)

분류 순서가 ① error(**full pane**) → ② 셸복귀(마지막 줄) → ③ busy(tail) → ④ ready(tail)인데, busy/ready만 tail로 제한하고 **error만 full-pane**로 남았다. 주석(pane.ts:110-116)은 "stale 글리프가 실제 신호를 outrank 못하게 tail 제한"이라 했으나 error는 그 대칭 케이스가 미처리다.

- **실패 시나리오**: 코드리뷰 협업 중 codex/claude 에이전트가 응답 본문에 `command not found`나 `unexpected argument`를 출력(에러 로그 인용·디버깅 논의에서 극히 흔함). 이 텍스트가 스크롤백에 남는 순간, 이후 모든 `pmux_agent_send`가 full-pane error 매칭으로 `launch_failed`를 반환하며 **영구히 전송 거부**. `skipReadyCheck`는 launch_failed 분기(agents.ts:388) 이전이 아니라 이후(394)라 탈출 불가 → 유일한 탈출구는 매 호출 `errorPattern` override뿐. 다회차 에이전트 협업이라는 이 도구의 핵심 용도에서 데드엔드.
- **수정 권고**: errorPattern도 tail 대상으로 제한(busy/ready와 동일). 진짜 런치 실패는 ② 셸복귀(마지막 줄) 검사가 독립적으로 잡으므로 tail 제한해도 탐지력 손실 거의 없음. 또는 "error 패턴 AND 셸 프롬프트 복귀" 논리곱으로 게이트.

### B2. §2.5 파일 회수 — "파일 존재 = complete" 가정이 원자성 미보장 하에 truncated read 반환

§2.5 회수 순서가 "규약 경로 파일이 **존재하면** `{status:"complete", content}`"로 정의됨. 에이전트가 파일을 스트리밍/부분 기록하는 중에 capture가 끼면 **잘린 내용을 complete로 반환**. pane 경로는 partial/busy를 구분하는데 파일 경로는 그 게이트가 없어, 하이브리드 도입이 오히려 회수 신뢰도를 낮출 수 있다(도입 동기와 역행).

- **수정 권고 (택1 또는 병용)**:
  1. footer 지시를 **write-then-rename**로: `turn-<turn>.md.tmp`에 쓰고 완료 시 `turn-<turn>.md`로 rename → "존재=완결" 불변식 성립(로컬 동일 호스트 전제이므로 rename 원자적).
  2. capture가 파일 **1줄차 상태(complete/partial)를 파싱**해 complete일 때만 `source:"file"` 반환, 아니면 pane 폴백(busy/partial 판정 유지). §2.5가 "1줄차 상태"를 쓰라 했으나 회수 로직이 그 필드를 소비하도록 명시할 것.
- **부수**: 재-emit 패턴(turn 3b/c…)의 접미사가 정수 `turn` 파일명과 안 맞음 — 파일 회수는 정수 turn만, 재-emit은 pane 전용임을 §2.5에 명시 권장.

## 안건 ② §2.5 설계 타당성 — B2 수정 전제로 타당

- 방향 자체는 내 턴1 "참고"(구조화 파일=회수 우선순위 1위, `fs.readFile`로 HTTP-only 위배 없이 가능)와 정합. 승격 적절.
- **경로 안전 양호**: 경로가 검증된 `agentId`(ID_RE, `/`·`..` 불가)+정수 `turn`+API가 준 workspaceDir로만 조립되고 호출자 임의 경로 없음, 읽기 전 `realpath`가 workspaceDir 하위인지 확인 — traversal 방어 견고.
- **degradation 양호**: 쓰기 권한 없으면(plan/read-only) 파일 미생성 → pane 폴백 정상. 동일 호스트 전제도 README와 정합.
- B2(원자성)만 보완하면 설계 승인 가능.

## 안건 ③ §0.5 결정론 우선 원칙 — 타당 ✅

- "코드로 결정론적 판정 가능한 것은 MCP가, LLM은 애매한 것만"은 무상태 얇은 래퍼 + 구조화 반환(`state`/`status`/`reason`) 철학과 정합. 오케스트레이터가 재해석할 필요 없는 판정값을 주는 방향 옳음.
- 단서 1: readiness "분류"는 §0.5가 말하는 순수 결정론이 아니라 정규식 휴리스틱임 — §0.4(sentinel 우선 + override)가 이미 그 한계를 인정하므로 문구 충돌은 없으나, §0.5의 "결정론적으로 판정 가능한 것"에 readiness가 포함되는 것처럼 읽히지 않도록 "분류는 best-effort 휴리스틱, 최종 예외판단은 tail 기반 LLM" 경계를 한 줄 덧붙이면 명확.
- 단서 2(비차단): 폴링 루프를 MCP가 최대 180s 단일 호출로 잡는 것은 이미 timeout 상한이 있어 수용 가능.

## 비차단 관찰 (기록용)

- SHELL_PROMPT_RE `/[$#%]\s*$/`(pane.ts:107)는 마지막 비공백 줄이 응답 본문이고 그 줄이 `%`/`#`/`$`로 끝나면(예: "40% 증가", 마크다운 `#`, 가격 `$`) launch_failed 오탐 가능. 실제로는 codex/claude TUI가 하단에 입력 프롬프트 박스를 재그림하여 마지막 줄이 본문이 아닌 경우가 대부분이라 저확률 — 비차단. B1 수정 시 함께 tail 맥락 강화 검토.

## 종합

턴3 blocking 2건은 정확히 해소됨(안건 ① 자체는 통과). §2.5·§0.5 방향도 타당. 그러나 현재 상태 게이트는 B1(다회차 영구 오탐)·B2(파일 truncated read)로 REJECT. 두 건 모두 국소 수정(errorPattern tail 제한 / write-then-rename+상태줄 파싱)이라 재수정 후 APPROVE 예상.
