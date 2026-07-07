verdict: AGREE (조건부 — R1은 실화면 캡처 게이트, R3는 유계·재개 계약 필수, 회고 #5 큐잉 상태 명시 편입 요구)

# opus v2.2-turn1 — 스코프 검토

## 총평
오케스트레이터 스코프안 R1~R5는 회고 5건을 정확히 겨냥했고, design-v2 원칙(결정론·pane=상태/파일=내용·무상태)과 충돌하지 않는다. 방향에 **AGREE**. 단 (a) R1은 미검증 경험칙 위에 서 있어 실화면 캡처로 게이트해야 하고, (b) R3 복합툴은 유계·재개 계약이 없으면 MCP 타임아웃/결정론 훼손 위험이 있으며, (c) 회고 #5의 "생성중 vs 입력대기 vs 큐 막힘" 구분이 5개 항목 어디에도 명시되지 않았다. 이 세 조건을 편입하면 승인.

## 항목별 판정

### R1 readiness 재설계 — AGREE, 단 실화면 캡처 선행 게이트
- 증상 진단 타당: 현재 `CODEX_READY_RE=/›/`가 tail(15)에서 안 잡히면 분류가 `agent_starting`으로 떨어지고 `send`는 `state!==agent_ready`라 `not_ready` 반환(agents.ts:584). 회고 #2 증상과 코드가 일치.
- **그러나 "›는 빈 composer에만 존재" 는 경험칙이며 코드/설계 어디에도 근거가 없다.** 이 명제가 틀리면 대체 패턴도 틀린다. → R1 착수 전 **실 codex/claude pane 덤프(다회차·좁은 pane 포함)를 fixture로 확보**하는 것을 blocking 선행조건으로.
- 반대: "상태바 존재 ∧ busy 부재 → ready" 를 **기본 판정으로 뒤집는(invert)** 방식. start가 명령 전송 직후 codex TUI 렌더 전이면 마지막 비공백 줄이 명령 에코라 shell-return도 busy도 아님 → 거짓 ready로 즉시 통과, 전송 유실. starting 창이 사라진다.
- **구체 판정 로직 제안(additive, invert 아님):**
  ```
  분류 순서 유지: error(tail15) → shell-return(last non-blank) → busy(tail15)
    → ready → starting
  ready := readyPattern.test(tail15)                       // 기존 글리프 빠른 경로 유지
        OR (statusBarPattern.test(tail15) AND NOT busy)    // 신규 폴백
  ```
  - `statusBarPattern`(provider별, 실화면으로 확정): codex는 하단 크롬 토큰의 union — 예 `/Read Only|Full Access|Auto|context (left|used)|⏎|\bgpt-[\d.]/i`. 단 버전 문자열(`gpt-5.5 medium`)은 휘발성이라 **단일 토큰 의존 금지**, 2개 이상 union.
  - 실패모드가 "거짓 not_ready(작업 차단)"에서 "거짓 ready(드묾·복구가능)"로 바뀌므로 순개선. starting 창은 "글리프도 상태바도 없음"으로 보존.
  - override 3종(readyPattern/errorPattern/busyPattern)은 이미 존재 — `statusBarPattern`도 override 추가 권장.
- 스코프: pane.ts(classifyReadiness), profiles.ts(default*Pattern + statusBar 추가) — 오케스트레이터안과 일치.

### R2 마커 wrap 내성 — AGREE
- 실측 확인: DONE 신호 **74자**, EOF **31자**. 80col 미만·분할 pane에서 DONE/BEGIN/END는 wrap, EOF는 대체로 생존. 즉 실제 피해자는 긴 마커(DONE·BEGIN·END)다.
- 현행 `parseDoneSignal`/`extractMarkerBlock`은 `trimmed === marker` 정확 단독줄 매칭(pane.ts:196, 79) → wrap 시 구조적 실패. 회고 #4와 일치.
- **우선순위 제안: ① 마커 단축(결정론, 휴리스틱 약화 없음)을 1차로.** pane 신호는 req로 이미 유일 식별되므로 agent/turn은 신호줄에서 잉여 → `<<<PMUX_DONE req=<rid> status=complete>>>` 로 단축(74→~44자). ② 그 위에 wrap-tolerant 재구성(연속 줄 greedy 결합 후 marker 동치 검사)을 belt-and-suspenders로.
- 에코 방어 영향 없음: §3.4 분할문자열 footer가 "완성형 마커는 에코에 물리적으로 부재"를 보장하므로, 줄 결합 매칭을 허용해도 프롬프트 에코 오탐은 발생 불가. 이 점을 명시할 것.
- **주의(조율 리스크):** 마커 단축은 생성기(makeDoneMarker/makeMarkers)+파서+footer 지시+roundtrip 단위테스트를 **동시** 변경해야 함. 과거 trailing-`>` drift 버그(pane.ts:159 주석) 이력 있음 → roundtrip 테스트 없이는 착수 금지.
- **원천 해결 조사 권장:** pmux capture API가 tmux `capture-pane -J`(wrap 결합)를 노출하는지 확인. 가능하면 이게 가장 깨끗한 층. turn2 조사 항목으로.

### R3 pmux_agent_turn 복합툴 — AGREE, 단 유계·재개 계약 필수
- 회고 #4 정확히 대응. 21→22툴 타당. 단 두 가지 계약 없으면 원칙 위배:
  1. **유계 블로킹 + 재개 반환.** send→폴링을 단일 호출로 블로킹하면 긴 턴에서 MCP 클라이언트 타임아웃. 내부 timeout 도달 시 `{status:"working", marker:{agentId,turn,requestId}, expectedReportFile}` 반환해 호출자가 capture로 재개하게. 즉 "무한 블로커"가 아니라 "기존 프리미티브로 degrade하는 편의 래퍼".
  2. **로직 재구현 금지, 조합만.** turn은 send/status/capture/parseDoneSignal을 **호출**해야 하며 판정 로직을 복제하면 안 됨(결정론 단일소스 원칙). 무상태 유지 위해 자동생성 requestId를 반드시 반환.
- 이 항목이 5건 중 가장 무겁고 표면적↑ → **R1/R2(정합성 수정) 병합 이후 별도 게이트** 권장(아래 시퀀싱).

### R4 라우팅 힌트 — AGREE (저위험 고효용)
- start 반환 `next`/`fallback` 정적 필드(회고 3-예시), 툴 description primary/fallback 문구(회고 2) — 순수 문서/상수, 리스크 낮음.
- create_tab `codex-cli` panelType 주의(회고 #3: codex-cli 패널=빈 shell, launch_failed): create_tab은 기존 16툴 소관이므로 **description 편집만**. "codex-cli 패널 ≠ 실행중 codex; 에이전트는 pmux_agent_start 사용" 명시.
- **여기에 회고 #5 큐잉 방지 계약을 편입:** "busy 중 pmux_send_input 직접 입력 금지(codex가 큐로 삼켜 지연/유실). 항상 agent_send/agent_turn의 busy 게이트를 경유" — 이게 회고 #5의 실질 해법.

### R5 cookbook USAGE.md — AGREE
- USAGE.md 부재 확인 → 신규 생성. 회고 60~118행 권장 워크플로 반영. 저위험.
- 단 "MCP 도구가 처음부터 노출 안 됨/tool_search 필요"(회고 #1,#7)는 **이 서버 밖(하네스 deferred-tool)** 문제 → USAGE에 "Start here: pmux_list_workspaces" 진입점만 안내하고 근본해결은 out-of-scope로 명시.

## 빠졌거나 조정할 항목
1. **[빠짐·중요] 회고 #5 큐잉 상태 구분.** "생성중 / 입력대기 / 큐 막힘"을 R1~R5 어디서도 다루지 않음. 최소한 R4의 send_input 금지 계약 + agent_status에 busy 지속 시 "queued 가능성" 힌트 문구로 흡수. (강한 안: status에 `inputQueuedRisk` 힌트 필드 — 단 결정론적으로 판정 불가하니 tail 기반 LLM 위임 유지.)
2. **[조정] R3를 R1/R2와 분리 게이트.** 정합성 수정(R1/R2)과 신규 표면(R3)을 한 라운드에 묶으면 회귀 원인 격리가 어려움. 어제 v2.1 병합 직후라 더욱.
3. **[유지·언급] 회고 #6 파일기반 교환은 이미 v2.1 fileOutput/recommendedFileOutput로 해결됨** — 신규 작업 아님, 스코프에서 빼는 게 맞음(오케스트레이터안이 이미 제외한 것 확인).

## 리스크 Top 3
1. **R1이 미검증 경험칙 위에 구축.** `›` 명제·상태바 토큰이 codex 버전 의존이라 특정 버전 과적합 위험. → 실화면 fixture 선행 + union 패턴 + override 유지 + invert 금지로 완화.
2. **R2 프로토콜 변경의 조율 붕괴.** 마커 단축은 생성기/파서/footer/테스트 동시수정 필요, 과거 drift 버그 이력. → roundtrip 단위테스트를 변경과 동일 커밋에 강제. capture-pane -J 가능성 먼저 조사.
3. **R3 블로킹 타임아웃 + 결정론 훼손.** 무한 블록은 MCP 타임아웃, 로직 복제는 단일소스 위반. → 유계+재개 반환 계약, 프리미티브 조합만 허용.

## 권장 시퀀싱
Phase A(정합성): R1(실화면 게이트 후) + R2 → 단위/e2e 회귀 통과 확인.
Phase B(무해 병렬): R4 + R5(문서·상수, A와 동시 가능).
Phase C(표면 확장): R3(A 병합 검증 후, 유계·재개 계약으로).
