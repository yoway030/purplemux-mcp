# 계획: 지속 가능한 개발 리팩토링 (2026-07-08)

## 원칙

**동작 불변(behavior-preserving)**. 모든 단계에서 `build + typecheck + unit + smoke` 그린 유지.
목표는 "다음 사람(또는 다음 세션의 LLM)이 안전하게 고칠 수 있는 코드" — 중복 제거,
파일당 단일 관심사, 테스트가 지켜주는 경계.

## 현재 문제 (조사 결과)

1. **복붙 중복**: `jsonResult`/`errorResult`/`guard`가 tools.ts(L15-53)와 agents.ts(L199-230)에
   동일하게 존재 — 에러 페이로드 형태를 바꾸려면 두 파일을 고쳐야 함.
2. **agents.ts 1729줄 단일 파일**: 타입(50-197) · HTTP 래퍼(236-311) · 훅 배선(337-408) ·
   readiness 어댑터(410-515) · report 상태(545-602) · send/turn 코어(604-1136) ·
   툴 등록(1138-1729)이 한 파일. 관심사 7개.
3. **핸들러 비일관성**: send/turn/capture는 이름 있는 함수(`sendAgentPrompt` 등)를 호출하는데
   wait_ready(~355줄)와 status(~107줄)만 registerTool 클로저에 인라인 — 테스트·이동 불가.
4. **패턴 컴파일 보일러플레이트 4벌**: ready/error/busy/runtimeError 패턴 컴파일이
   sendAgentPrompt·runAgentTurn·wait_ready·status에 그대로 반복.
5. **package.json description 구식**: "16 tools" (실제 23).
6. **CI 부재**: 회귀를 사람이 로컬에서만 잡음.
7. **test/unit.mjs 1487줄 단일 파일**: 섹션 주석으로 구분돼 있으나 계속 자람.

## 작업 (phase별, 각 phase 끝에 검증)

### P1. 공유 헬퍼 통합 (중복 제거)
- `src/tool-result.ts` 신설: `jsonResult`, `textResult`, `errorResult`, `guard`.
  tools.ts와 agents.ts가 import. 동작·페이로드 형태 변경 없음.

### P2. agents.ts 균질화 (분리 전 정지작업)
- wait_ready 인라인 핸들러(355줄) → 최상위 `runWaitReady(args)` 함수로 리프트.
- status 인라인 핸들러(107줄) → 최상위 `runAgentStatus(args)` 함수로 리프트.
- `compileAllPatterns(args, provider)` 헬퍼로 4벌 보일러플레이트 통합.
- 리프트는 코드 이동 + 클로저 캡처를 파라미터로 바꾸는 것만 — 로직 수정 금지.

### P3. agents.ts → src/agents/ 디렉토리 분리
유일한 export가 `registerAgentTools`라 외부 영향 없음(unit 테스트도 agents 미참조).
- `src/agents/index.ts` — `registerAgentTools` (툴 등록 + description 문자열만)
- `src/agents/types.ts` — Arg 타입, API shim, `AgentSendValue`, `CaptureEvidence`
- `src/agents/api.ts` — `capturePane`, `tabStatus`, `tabAlive`, `resolveWorkspaceDir`,
  `extractTabId`, `sessionName`
- `src/agents/wiring.ts` — `wireHooksAndBoot`, `shellQuote`, `waitForShellReady`,
  `looksShellReady`, start 핸들러 코어(`runAgentStart`)
- `src/agents/readiness.ts` — `isShellCommand`, `nativeCliState`, `runtimeErrorInTail`,
  `withRuntimeError`, `compileOptionalPattern`, `compileAllPatterns`,
  `classifyTurnReadiness`, `isReadyStateForTurn`, `runWaitReady`, `runAgentStatus`
- `src/agents/report.ts` — `readReportStatusLine`, `reportFileStatus`,
  `buildPaneFallbackFooter`, `generateRequestId`, `recommendedFileOutput`
- `src/agents/turn.ts` — `sendAgentPrompt`, `captureAgentEvidence`, `runAgentTurn`
- 기존 `src/agents.ts`는 삭제, tools.ts는 `./agents/index.js` import.

### P4. 인프라 정비
- package.json: description "23 tools"로 정정, `"test": "npm run build && npm run unit && npm run smoke"` 추가.
- `.github/workflows/ci.yml` 신설: push/PR에 build + typecheck + unit + smoke
  (smoke는 purplemux 없이도 handshake/툴 목록 검증 가능 — 라이브 호출은 isError 미단언).
- e2e는 라이브 purplemux 필요라 CI 제외(로컬 전용 명시).

### P5. test/unit.mjs 분할
- `test/unit/` 디렉토리: `helpers.mjs`(check/assert 공유) + 대상 모듈별
  `profiles.test.mjs` · `pane.test.mjs` · `paths.test.mjs` · `boot.test.mjs` · `guide.test.mjs`.
- `test/unit.mjs`는 러너로 축소(각 파일 순차 import, 실패 집계) — `npm run unit` 인터페이스 불변.

## 비목표 (이번 패스에서 하지 않음, 사유 포함)

- **readiness 사다리 3벌 통합** (send L654-766 / wait_ready / classifyTurnReadiness):
  세 곳은 의도된 차이(expectEcho 게이트, input_queued 승격 규칙, turn 컨텍스트)가 있고
  실기동으로 검증된 로직 — 통합은 동작 변경 위험이 커서 별도 작업으로 분리.
  이번엔 각 사다리에 차이점을 주석으로 명시하는 것까지만.
- **pane.ts 분할**: 697줄이지만 "pane 텍스트 해석" 단일 우산 아래 있고 unit 테스트가
  dist/pane.js를 직접 import — façade 재수출로 쪼갤 수 있으나 이번 패스 가치 대비 churn 큼.
- **lint/formatter 도입**: 프로젝트가 무프레임워크·최소 의존 철학 — 필요해지면 별도 결정.
- **툴 description 별도 파일 분리**: index.ts(등록부)에 두는 게 등록과 문서의 응집에 유리.

## 합의 반영 (codex + claude 리뷰, BLOCKING 0건)

- **P3 모듈 재조정**: `wiring.ts` → `start.ts`로 개명(runAgentStart + wireHooksAndBoot +
  waitForShellReady + shellQuote + recommendedFileOutput — start 시점 정책 집결).
  `runWaitReady` → `wait-ready.ts`, `runAgentStatus` → `status.ts` 독립(둘 다 boot/report
  의존이 readiness 어댑터보다 넓음 — codex 지적). 미배정 헬퍼 홈 명시(claude 지적):
  `common.ts` = sleep · validateId · validateModel · generateRequestId,
  `compileRuntimeErrorPattern`은 readiness.ts의 compileAllPatterns에 흡수,
  asString은 api.ts 로컬. types.ts에 NativeState·TabStatusSnapshot·ReportFileStatus·
  RuntimeErrorInfo·MarkerInfo 포함.
- **P2 리스크 하향 확인**(claude 실측): wait_ready/status 인라인 핸들러는 바깥 스코프를
  전혀 캡처하지 않음 — 리프트는 순수 이동. runAgentTurn의 패턴 컴파일을 compileAllPatterns로
  선행시켜도 sendAgentPrompt가 첫 루프에서 동일 ToolError를 던지므로 관찰 가능 동작 불변
  (구현 시 주석으로 명시, 되돌리지 말 것).
- **P4 강화**: smoke.mjs가 현재 아무것도 단언하지 않음(항상 exit 0) — init.result 존재 +
  툴 수 23 단언, 라이브 호출은 isError 허용. package.json description에서 툴 개수 숫자
  자체를 제거(산문 속 숫자는 반드시 썩음). `npm test` = build+unit+smoke, build가 타입
  게이트임을 명시(typecheck는 --noEmit 중복). CI node 버전 20 고정.
  `prebuild`로 dist 클린(node -e rmSync, 무의존) — src/agents.ts 삭제 후 dist/agents.js
  잔존이 npm pack에 실리는 것 차단.
- **P5 러너 규칙**: 순차 `await import()`(정적 import 금지 — TLA 인터리빙이
  process.env.HOME 리다이렉트 격리를 깸), 파일별 try/catch로 한 파일 크래시가 나머지를
  막지 않게, failures 카운터는 helpers.mjs 싱글턴, FIXTURES_DIR는 `../fixtures`로 수정.
- **검증 강화**: P3 후 라이브 e2e + agent start→wait_ready→turn 실기동 1회는 필수(선택 아님).
  P3 후 새로 export되는 순수 헬퍼(compileAllPatterns, recommendedFileOutput, extractTabId,
  sessionName, looksShellReady, buildPaneFallbackFooter, reportFileStatus)에 unit 테스트 추가
  — agents 코어가 unit 커버리지 0인 공백(codex 지적) 일부 해소.

## 검증

- 각 phase 후: `npm run build && npm run typecheck && npm run unit && npm run smoke`(23툴).
- P3 후: 라이브 e2e 12케이스 + pmux_agent_start→wait_ready→turn 1회 실기동(가능하면).
- 최종: git diff가 "이동+import 변경"임을 리뷰로 확인 (로직 diff 최소).

## 결과 (2026-07-08, 전 phase 완료 + codex/claude 최종 리뷰 합의)

- P1~P5 전부 이행. 커밋: P1/P2 → P3 → P4 → P5+사다리주석 → 리뷰반영.
- **동작 불변 byte 수준 검증**(claude 반박 리뷰): 전 함수 본문 재구성 diff 결과
  승인된 4개 지점(핸들러 리프트 3건 + compileAllPatterns 치환) 외 byte-identical.
  등록 순서·description 문자열·기본값·컴파일 순서·러너 격리 모두 반증 실패 → 합의.
  codex 리뷰도 BEHAVIOR PRESERVATION / TEST INTEGRITY 합의.
- **실기동 검증**: 라이브 e2e 33/33, 새 dist로 codex start→wait_ready{bootId,
  expectEcho}→agent_ready(fileSeen+echoSeen)→turn 1 complete→close_tab ✓.
- **리뷰 지적 반영**: prepack 추가(npm pack 시 stale dist 차단, codex SHOULD),
  agents 순수 헬퍼 unit 테스트 13건 신설(test/unit/agents.test.mjs — 계획 필수
  항목 이행, claude SHOULD; recommendedFileOutput/looksShellReady export 포함),
  errorResult 비공개화(양측 NIT), smoke 툴 수 상수의 의도적 게이트 성격 주석화.
- 최종 게이트: unit 135개(기존 122 + 신규 13) · smoke 23툴 단언 · build/typecheck 통과.
- 수치 변화: src 최대 파일 1729줄(agents.ts) → 477줄(agents/turn.ts),
  test 최대 1487줄(unit.mjs) → 917줄(unit/pane.test.mjs), 복붙 헬퍼 0, CI 신설.
