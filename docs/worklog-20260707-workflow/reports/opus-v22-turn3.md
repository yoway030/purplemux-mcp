verdict: CHANGES_REQUESTED (1 blocking — expectPrevTurnEnd 스캐너가 R2 단축 DONE/END 마커를 못 잡음. 나머지 G1~G8·R0.1b 매핑·마커 roundtrip·fixture 실캡처 전부 충실 이행)

# opus v2.2-turn3 — 라운드A 구현 리뷰

## BLOCKING

**B1 · src/agents.ts:401-403 (및 390-392) — 이전 턴 완료 스캐너가 R2 단축 마커와 비호환 → 기본 경로(fileOutput=true) 다회차에서 expectPrevTurnEnd 상시 오탐**
- 문제: `hasPriorDoneSignal`의 정규식은 `^<<<PMUX_DONE agent=<id> turn=<n>(?: req=…)? status=…>>>$` 로 **agent=+turn= 접두 필수**. 그러나 R2로 `makeDoneMarker`(pane.ts:319-320)는 requestId 존재 시 **단축형 `<<<PMUX_DONE req=<rid> status=…>>>`**(agent/turn 없음)을 방출한다. fileOutput=true(기본)는 항상 requestId를 생성하므로 화면에 찍히는 DONE은 단축형 → 스캐너 정규식과 불일치. `hasPriorTurnEnd`(390-392)도 동일 구조라 fileOutput=false 단축 END(`<<<PMUX_END req=…>>>`)를 놓침. 이 둘을 쓰는 `hasPriorTurnCompletion`(410-416)이 send의 expectPrevTurnEnd 검증(857-869)에서 항상 false 반환.
- 회귀성: v2.1에선 DONE이 long-form이라 매칭됐다. R2 단축이 **기존 동작 기능을 조용히 깨뜨림** — 라운드A 헌장("정합성·상태 모델")에 정면 위배.
- 구조적 한계: 단축형은 req-키이고 expectPrevTurnEnd는 turn 숫자만 받음 → prevRequestId를 스레딩하지 않으면 특정 이전 턴의 단축 DONE을 지목 불가. 설계/시그니처 레벨 보완 필요(옵션: expectPrevTurnEnd에 prevRequestId 동반, 또는 스캐너에 단축형 후보 추가 + req 인자 전달).
- 시나리오: 턴1 완료→화면에 `<<<PMUX_DONE req=ab12 status=complete>>>`. 턴2 send(expectPrevTurnEnd=1) → 스캐너가 `agent=… turn=1…`을 찾음→부재→`{sent:false, reason:"missing_prev_turn_end"}`. 정당한 턴2가 차단됨. 이게 바로 라운드B 도그푸드 대상인 Codex 3턴 합성 시나리오다.
- 테스트 공백: unit.mjs에 expectPrevTurnEnd/hasPriorTurnCompletion 케이스 없음(parseDoneSignal만 단축/구형/wrap 커버). 수정 시 "단축 DONE로 완료된 이전 턴 인정" 회귀 테스트 동반 필수.

## 게이트 이행 확인 (블로킹 외 전부 충족)
- **G1** ✅ 셸 보간 가변값 없음 확인. codex 훅 인자는 homedir 조립 고정문자열, `shellQuote`(agents.ts:267, POSIX `'\''` 이스케이프 정확) 적용. workspaceId는 `-c hooks.*`에 미포함(설계 R0.1 line40대로) — HTTP query/body로만 흘러 인젝션 표면 없음.
- **G2·G3** ✅ 설계 R0.1b PoC로 해소됨(codex idle→busy→ready-for-review, 우리 terminal-탭 경로로 상관 성립). mapCliState(profiles.ts:142-160)가 R0.1b 매핑표(설계 51-56) **정확 구현**: busy→busy, notification→blocked, needs-input→ready(양쪽), ready-for-review→codex:ready/claude:blocked, idle·미지원→null(pane 폴백, 열린집합).
- **G4** ✅ busySeen(agents.ts:594) — cliState ready는 busySeen 관측 후에만 반환(652). 완료판정 핵심인 capture는 cliState 미사용(파일 EOF 게이트/pane 마커)이라 stale 레이스 면역.
- **G5** ✅ command=shell을 툴별 매핑: wait_ready(616)·send(761)→launch_failed(런치후 계약), status(1039)→중립 `shell_ready`. 무상태 모호성 해소.
- **G6** ✅ agent_blocked: wait_ready 종단 반환(632-641), send `reason:"blocked"`(795), status readiness.state 노출(1047). ReadinessState에 추가(pane.ts:204). 일관.
- **G7** ✅ fixture 실캡처 확인(codex-idle-real.txt = 실제 상태바 `gpt-5.5 high · … · Wo…` + `›`). signalSource per-call 전 툴 노출(hooksWired 아님). rawCliState/command 동봉.
- **G8** ✅ wait_ready timeout payload에 rawCliState·command·tail 포함(710-718). busy는 timeout까지 ready 자동강등 없음.
- **R2 마커** ✅ 단일소스 makeDoneMarker/makeMarkers 단축형 + legacy 파서(pane.ts:63,331) 구형호환 + wrap-tolerant(matchWrappedMarker, raw join·전체 trim으로 wrap 경계 문자손실 없음) + roundtrip 테스트(footer에 완성마커 부재 assert, unit:386/786). 에코방어 유지.

## 비블로킹 관찰 (라운드B/후속 고려)
1. profiles.ts:101 `BUSY_RE = /…|\bworking\b|[⠀-⣿]/i` — pane 폴백에서 응답 본문이 "working"을 포함하거나 tail에 braille 문자가 있으면 거짓 busy 가능. 훅 세션은 cliState busy가 authoritative라 영향 적음(비훅 폴백 한정). 필요 시 `working`을 상태바 문맥(스피너 인접)으로 좁히거나 `Working…`(말줄임표 포함)으로 한정 검토.
2. claude 플랜모드 다회차: 턴 완료가 needs-input이 아니라 `ready-for-review`(→agent_blocked)로 관측되면, 다음 send가 reason:"blocked"로 막힐 수 있음. 지금 이 리뷰 세션(plan 모드 opus)이 정확히 그 패턴 — 라운드B 도그푸드에서 claude 플랜모드 턴전이 cliState 실측 요망.
3. wait_ready 부팅 시나리오: cliState가 boot에서 needs-input로 직행(busy 미관측)하면 busySeen=false라 cliState ready 경로가 비활성→pane 폴백에 의존. PoC상 boot=idle이라 실무 무해하나, 어휘 드리프트 시 소폭 지연 가능(비블로킹).

## 결론
R0 네이티브 상태 채널·R1 폴백 강등·R2 마커는 설계에 충실하고 G1~G8 전부 이행됐다. 단 B1(단축 마커 vs 이전-턴 스캐너 비호환)은 라운드A가 목표한 다회차 정합성을 조용히 깨는 회귀이므로 병합 전 수정+회귀테스트 필수. B1 해소 시 라운드A APPROVE.
