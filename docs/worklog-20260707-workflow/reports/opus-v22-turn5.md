verdict: APPROVE ×2 — 라운드A 최종 병합 가능(블로킹 0), R6 설계 승인. 비블로킹 2건(멀티라인 queued 잔여 리스크·R1 문서 드리프트) + R6 권고 3건.

# opus v2.2-turn5 — 라운드A 마감 + R6 설계 승인

## ① 라운드A 최종 검토 — APPROVE (블로킹 없음)

4건 실화면 결함 수정 전수 확인, 전부 관찰된 실결함을 정확히 겨냥하고 방어층·에코안전을 보존:

- **codex 불릿 프리픽스 (`normalizeMarkerCandidate`, pane.ts:34-53)** ✅: `^[•●◦▪∙*-]\s+` 1회 스트립, **선행 장식만 허용·후행은 여전히 엄격**(마커 뒤 텍스트 불허). parseDoneSignal/extractMarkerBlock/hasPriorTurnCompletion 공용 단일소스. 에코안전 불변 — 분할문자열 footer라 완성 마커가 에코에 애초에 부재하므로 장식 스트립이 완성시킬 대상이 없음. codex `• <<<PMUX_DONE…>>>` 회수 실패(doneSignal:false/expectPrev false-neg) 해소.
- **queued 판정 프로토콜 시그니처 전환 (`hasProtocolSignature`, pane.ts:272-276·371-376)** ✅: 핵심 통찰 — 우리 send는 항상 `PMUX_`/`응답 규약` 포함 footer 주입하므로 **시그니처 없는 composer 텍스트 = CLI 플레이스홀더(= ready), 시그니처 있음 = 진짜 미제출 우리 프롬프트(= input_queued)**. codex가 매 턴 후 재표시하는 placeholder("› Implement {feature}")를 not_ready로 오판하던 회귀(턴4 발견)를 정확히 제거. 시그니처를 tail 전체가 아닌 composer 글리프 줄에만 검사 — footer 에코가 tail에 잔존해도 오탐 안 되게 한 의도적 선택(에코 방어).
- **첫 send placeholder (turn≤1 규칙, agents.ts:887-894)** ✅: turn 0/1엔 정의상 우리의 직전 미제출 프롬프트가 없으므로 input_queued는 스퓨리어스 → `ready=true` + `validationWarning:"composer_placeholder_assumed"`로 진행. turn≥2는 진짜 queued를 not_ready로 유지. 경고 노출로 판단 위임.
- **busy 창 miss (transitionSeen 일반화, agents.ts:567-691)** ✅: 리터럴 busy 목격 요구 → **baseline(첫 관측 상태) 대비 later ready 전이**로 일반화. 폴 간격이 busy 창을 놓쳐도 baseline≠ready였다면 전이 인정. 첫 폴이 이미 ready(stale)면 baseline=ready라 전이 불성립→timeout+payload(baseline·transitionSeen·rawCliState 노출, agents.ts:754-755) — G4/G8의 보수적 정론 유지(stale-ready를 완료로 오선언 안 함).
- **wait_ready 부팅 시맨틱** ✅: requireBusyTransition 기본 false=부팅(즉시 ready), input_queued를 부팅 폴백에서 `composer_placeholder_assumed`로 ready 반환(agents.ts:709-724). 턴4 검토대로.

라이브 다회차 PASS(stale 실전 감지·expectPrev 통과·파일 무손실)로 실증. **블로킹 0, 병합 가능.**

### 비블로킹 (라운드B 하드닝 권고)
1. **멀티라인 queued 잔여 false-ready**: `lastComposerLine`은 글리프로 시작하는 1줄만 보고, 진짜 미제출 우리 프롬프트가 멀티라인이면 시그니처는 `\n\n` 뒤 비-글리프 줄에 위치→글리프 줄엔 시그니처 부재→"placeholder"(ready)로 오판 가능. 단 (a) 비훅 폴백 한정(훅 세션은 cliState authoritative), (b) 상류 busy-게이트가 busy 중 전송을 막아 미제출 프롬프트 잔존 자체가 희소, (c) turn≤1 override가 부팅 케이스 커버 → 삼중으로 좁아 비블로킹. 권고: 라운드B agent_turn 도그푸드에 **비훅 codex 다회차**를 포함해 실증하고, 필요 시 시그니처 검사를 글리프 줄~후속 composer 연속줄(유계)로 확장.
2. **R1 문서 드리프트**: design-v22.md R1절(79-82)이 여전히 구형 "글리프+텍스트→input_queued"를 서술 — 실제는 프로토콜 시그니처 기반으로 최종 전환됨. 턴3~5 라이브 수정 5건(장식·placeholder·시그니처·transitionSeen·turn≤1)이 R1/R2 본문에 미반영. 정본이 구현과 어긋나면 후속 라운드 리뷰 기준이 흔들림 → R1/R2절을 최종 구현에 맞춰 갱신 권고(코드 자체는 주석이 정확).

## ② R6 (런타임 오류 감지) — 설계 APPROVE

- **동기 타당**: sworker 529 Overloaded 조용한 죽음 실측 — 태스크는 죽었는데 모든 상태 신호(cliState needs-input·pane ready)가 정상. 상태모델의 진짜 사각("ready인데 작업 실패"). 회고 "상태 확인 불충분"의 정확한 연장.
- **설계 정합**: "상태를 바꾸지 않는다 — ready 세션은 실제로 ready(재지시 가능)"가 **정론**. 런타임 오류를 not_ready로 뭉개면 상태모델이 깨짐. 직교 사실 `runtimeError?:{match,line}`로 노출하고 재지시/재시도는 LLM 판단에 위임 — 원칙1 경계(결정론 감지 + 애매 행동은 LLM)와 일치. 라운드B agent_turn의 "완료 증거 없이 ready+runtimeError→조기 `agent_error` 반환"도 완료게이트(유효 파일/DONE) AND 조건이라 건전.
- **권고(설계 승인의 조건 아님, 구현 시 반영)**:
  a. **오탐 명시**: 응답 본문이 "API Error"/"rate limit"을 인용하면(예: 에러핸들링 코드 리뷰, 심지어 이 설계문서도 "API Error: 529" 포함) 오탐 가능 — errorPattern과 동급의 알려진 한계로 문서화하고 **tail 스코프**(전체 pane 금지) + override 유지. 상태 불변 + LLM에 {match,line,tail} 동봉이라 저위험.
  b. **분리 유지**: detectRuntimeError는 readiness errorPattern(command not found=런치실패)과 목적이 다르므로(런타임 중단) launch_failed 분류에 절대 피드백 금지 — 설계대로 별 함수로 유지.
  c. **감지 창**: 폴 사이 발생 후 tail서 스크롤아웃되면 후속 폴이 놓침 — agent_turn 연속 폴링은 라이브 포착 가능, 단발 status는 best-effort임을 명시.
- 529 실측 tail fixture 단위테스트(설계 line116) 필수 유지.

## 결론
라운드A 최종본(R0+R1+R2 + 턴3~5 라이브 수정)은 블로킹 없이 병합 가능하며 실화면 결함을 실증 해소했다. R6 설계는 상태모델을 해치지 않는 직교-사실 접근으로 건전 — **APPROVE**. R1/R2 문서 갱신과 멀티라인 queued 실증을 라운드B로 이월 권고.
