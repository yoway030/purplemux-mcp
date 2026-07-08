# 계획: 지속 가능성 리팩토링 R2 (2026-07-08)

목표(사용자 지시): 1라운드 미진분 + **중복 코드 제거** + **데드 코드 제거**.
원칙은 R1과 동일 — 동작 불변, 각 단계 `npm test` 그린, emitted 문자열/JSON byte 보존.

## 조사 결과 요약 (dead-code / duplication 감사 2건)

데드코드: 완전 사멸 3건(tabAlive, PanelType, http.ts ToolError 재수출),
클린 unexport 5건, noUnusedLocals 활성화 가능(tabAlive 제거 후 위반 0).
중복: STATUS_LINE_RE 2벌, ID_RE 하드코딩 3곳, MARKER_PREFIX 인라인 2곳,
smoke/e2e stdio 클라이언트 보일러플레이트, turn.ts sent:false 9벌 /
wait-ready.ts jsonResult 11벌 구조 반복, Effort/Sandbox/PermissionMode
타입이 agents/types.ts에 재선언.

## 작업

### D1. 데드코드 제거 (저위험)
- 삭제: `tabAlive`(agents/api.ts:47, 콜사이트 0), `PanelType`(schemas.ts:16,
  참조 0 — panelTypeEnum 자체는 유지), http.ts 끝의 `export { ToolError }`
  재수출(모든 소비자가 errors.js에서 import).
- unexport(파일 내부 전용 확정): `eofMarker`(paths), `stripAnsi`(pane),
  `bootDir`·`BOOT_HOOK_SCRIPT_PATH_BASENAME`·`assertSafeHookPath`(boot).
- **유지(unexport 안 함)**: exported 시그니처에 새는 타입들(Source, Resolved,
  ReportFileCheck, MarkerResult, AgentCommandOpts, HttpMethod, CallOptions,
  MarkerInfo) — 소비자가 타입을 명명할 수 있어야 지속가능. 공개 타입 표면으로 인정.
- tsconfig에 `noUnusedLocals` + `noUnusedParameters` 활성화 — 데드 로컬의
  재발을 컴파일러가 차단(무의존 지속성 게이트). `_p` 언더스코어 파라미터는 면제됨.
- pane.ts legacy 마커 경로(legacyMarkers/legacyDoneMarker/matchWrappedMarker)는
  프로덕션 도달 가능한 구형 호환 — **데드 아님, 유지**.

### D2. 상수·타입 단일 소스화 (저위험 중복 제거)
- `STATUS_LINE_RE` paths.ts에서 export, report.ts:35 인라인 정규식 대체 (byte-identical).
- schemas.ts의 `/^[a-z0-9][a-z0-9_-]{0,31}$/` 3곳(agentId/requestId/bootId) →
  profiles의 `ID_RE` import 사용. describe 문자열은 verbatim 유지(클라이언트에
  노출되는 스키마 바이트 보존).
- report.ts의 인라인 `"<<<PMUX_"` 2곳 → paths의 `MARKER_PREFIX` import.
- agents/types.ts의 effort/sandbox/permissionMode 인라인 유니온 →
  profiles의 `Effort`/`Sandbox`/`PermissionMode` 타입 import (구조 동일 확인됨).
- tailLines(…, 15) 반복 7곳의 매직넘버 → pane.ts `TAIL_LINES = 15` 명명 상수.

### D3. 테스트 클라이언트 공유화 (테스트 전용, 저위험)
- `test/lib/mcp-client.mjs` 신설: spawn + 라인버퍼 파서 + pending 맵 + rpc()
  + call() + 타임아웃. smoke.mjs/e2e.mjs가 공유(각자의 단언/리포팅은 유지).
  rpc id는 auto-increment로 통일(smoke의 고정 id는 어디서도 단언 안 됨 — 감사 확인).

### D4. 반환 리터럴 빌더 (중위험 — emitted JSON byte 보존 필수)
- turn.ts sendAgentPrompt: 9개 `withRuntimeError({sent:false,...})` 분기 →
  로컬 `fail(reason, extra?)` 빌더. 단, line-56 분기(signalSource 변수 선언
  전, literal "cliState")는 수기 유지. `...extra`로 readinessState 등 조건부
  키의 "부재"를 보존(undefined 키 신설 금지).
- wait-ready.ts runWaitReady: 12개 jsonResult 중 in-loop 11개 → 로컬
  `emit(state, signalSource, reason?)` 빌더. reason 키는 state 바로 다음
  위치 유지(JSON.stringify 삽입 순서), reason 없는 분기는 키 부재 유지.
  12번째(터미널 timeout, lastRawCliState/baseline/transitionSeen 사용)는 별개 — 대상 외.
- 검증: 각 분기 필드-순서-부재를 빌더 출력과 1:1 대조. 리뷰에서 집중 확인 요청.

### D5. 1라운드 보류분 처리
- boot.test.mjs HOME 복원이 HOME 미설정 환경에서 문자열 "undefined"를 쓰는
  기존 패턴 → `realHome === undefined ? delete process.env.HOME : 복원`으로 수정.
- **계속 보류(비목표)**: pane.ts 분할(중복 제거와 무관한 churn), readiness
  사다리 3벌 통합(의도된 차이 — R1 주석으로 문서화 완료).

## 비목표
- footer 3종(buildPaneFallbackFooter/buildSentinelFooter/makeFileFooter) 통합:
  세 프로토콜의 발화 문자열이 전부 다르고 과거 byte-drift 사고 이력 —
  MARKER_PREFIX 상수 공유(D2)까지만.
- lint/knip 등 의존성 추가 — noUnusedLocals가 무의존 대체.

## 합의 반영 (codex + claude 리뷰)

- **D1 보정(양측 BLOCKING/SHOULD)**: noUnusedLocals 위반은 tabAlive 외 1건 더 —
  tools.ts:5 미사용 `CallToolResult` type import. 함께 제거. 그 외 위반 0 실측.
- **D2 수치 보정(claude)**: tailLines(x,15)는 7곳이 아니라 **9곳**(status.ts:23,
  start.ts:199 포함). 상수명은 기존 TAIL_WIDTH(30, 다른 용도)와 혼동 없게
  `TAIL_LINES`. report.ts의 `"<<<PMUX_"`는 **4곳**(slice 2 + 발화 템플릿 보간 2 —
  보간 치환도 byte-identical). 추가(codex): boot.ts:290/295의 ID 패턴 파생형도
  `ID_RE.source` 조합으로 단일화, agents.test.mjs의 하드코딩 `"<<<PMUX_"`도
  MARKER_PREFIX import로 교체.
- **D3 스코프 확정(양측)**: 공유 클라이언트는 transport만(spawn/파서/pending/
  rpc auto-id/call raw 반환). per-request 타임아웃 도입 금지(신규 동작),
  워치독·exit code는 각 파일 소유 유지. e2e:94의 `idc` 직접 참조는 클라이언트
  캡슐화로 깨지므로 e2e 자체 카운터로 교체(값은 임의 — 안전). content 텍스트
  매핑은 파일별 유지(smoke `||` vs e2e `??` 차이 인지).
- **D4 유지 확정(claude 20분기 전수 대조, 재현 불가 0건)** + 함정 명문화:
  wait-ready 77행(exited) 분기는 polls 증가·lastPane 재캡처 **이전**에 stale
  tail로 발화 — emit()은 tail을 파라미터로 받지 말고 호출 시점에
  `tailLines(lastPane, 15)`를 내부 계산할 것(11분기 전부 현재 값과 일치).
  turn.ts 56행 분기는 signalSource TDZ로 수기 유지. extra의 undefined 값 키는
  JSON.stringify가 드롭하므로 바이트 동일.

## 검증
- 각 단계 후 `npm test`(build+unit 135+smoke 23) + typecheck.
- D4 후 라이브 e2e(33케이스 — send/wait_ready 응답 필드 실검증 포함) 필수.
- 최종 codex/claude 리뷰 합의(특히 D4 분기별 JSON 보존).

## 결과 (2026-07-08, 전 항목 완료 + codex/claude 최종 리뷰 합의)

- D1~D5 전부 이행 + 병행 feat(표준 기본 model/effort — 사용자 지정). 커밋:
  feat(기본모델) → D1 → D2 → D3 → D4/D5 → 리뷰 NIT 반영.
- **최종 리뷰 양측 합의, BLOCKING 0건.** codex: D4 emit 11분기·fail 8분기
  전수 base 대조 일치, D1~D3·기본값 주입 전 영역 0건. claude: 정적 재구성에
  더해 **가짜 purplemux 서버 대상 차등 실행 하네스(18시나리오)**로 base와
  HEAD 출력 byte 동일 실증(elapsedMs만 마스킹), wire 표면(instructions +
  tools/list) diff는 승인된 기능 문자열 4건뿐.
- 리뷰 지적 반영: e2e 미사용 send 제거(NIT), 기본값 고정 주입의 환경 요건
  (claude >=2.1.202, codex config.toml 우선순위)을 USAGE 주의사항에 문서화
  (SHOULD). ID_RE.source 앵커 가정은 코드 주석으로 이미 문서화 — 유지.
- 수치: turn.ts 477→409줄, wait-ready.ts 355→272줄, 데드 export 3건 삭제 +
  내부 전용 5건 unexport, noUnusedLocals/noUnusedParameters 상시 게이트,
  unit 136개(前 라운드 표기 135는 feat 커밋의 +1 반영 전 수치).
- 검증: build/typecheck/unit 136/smoke 23 그린, 라이브 e2e 33/33 (D3 후,
  D4 후 각 1회).
