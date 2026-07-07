verdict: APPROVE — 턴8 B1 근본 해소(마커 단일소스화), 비차단 (a)(b) 및 라이브 발견 2건 모두 타당하게 반영. 실에이전트 도그푸드가 파일 프로토콜 왕복을 실증. 구현 승인 — 병합 가능.

## 턴8 B1 (EOF `>` 4vs3) — 근본 해소 확인 ✅

내가 권고한 "지시/검증 문자열 단일소스 파생"이 정확히 구현됨:
- `eofMarker(requestId)` (paths.ts:16) = `<<<PMUX_EOF req=<rid>>>` (3개) 단일 진실원. 파서(paths.ts:112)와 footer(paths.ts:153 `slice(MARKER_PREFIX.length)`)가 **같은 함수 출력**을 사용 → 손으로 센 `>` 없음.
- `makeDoneMarker` (pane.ts:161-168) 동일 패턴. `parseDoneSignal`이 makeDoneMarker 출력과 문자열 동등비교(pane.ts:189-196), footer의 `doneRest`도 그 출력을 slice(paths.ts:154). 생성기↔파서 드리프트 구조적으로 불가능.
- 왕복 검증: 라이브 도그푸드에서 **실제 codex가 footer를 파싱해 EOF/DONE을 조립·기록**하고 파서가 통과 → 자동테스트가 못 잡던 크로스-아티팩트 결함이 실경로로 커버됨. B1이 재발할 표면 제거됨.

## 비차단 (a)(b) 반영 확인 ✅

- **(b) 1줄차 파렌 오염**: 상태 지시와 "blocked" 대체 안내를 **별도 줄로 분리**(paths.ts:163-164) + "다른 텍스트 추가 금지" 명시 → 에이전트가 파렌을 1줄차에 끌어들여 STATUS_LINE_RE($앵커) 탈락하는 위험 제거.
- **(a) status 진단정보 손실**: `readReportStatusLine`(agents.ts:351)로 eof_missing 상황에서도 statusLine/reqMatch를 별도 산출 → status.reportFile 진단 충실화.

## 라이브 발견 2건 — 타당 ✅

- **start 캡처 레이스 → 유계 폴링**: 단발 capture를 `waitForShellReady({timeoutMs: shellTimeoutMs ?? 5000})`로 교체(agents.ts:432-436), not_shell_ready에 command·tail·recommendedFileOutput 동봉(agents.ts:438-447). 탭 부팅 지연으로 셸 프롬프트를 놓쳐 명령이 유실되던 레이스를 유계 재시도로 해소 — 결정론 원칙과 정합, 상한(기본 5s) 존재.
- **fileOutput×read-only 데드락 → recommendedFileOutput 힌트**: `recommendedFileOutput`(agents.ts:327-332) = codex read-only/claude plan이면 false(파일쓰기 불가 → pane 폴백 권장), 아니면 true. start가 이 힌트를 반환(agents.ts:444,458). fileOutput 기본 true인데 read-only 에이전트는 파일을 못 써 capture가 영구 missing/working에 빠지던 데드락을, 부팅 시점에 오케스트레이터에게 신호로 알려 회피. 무상태 유지(강제 아닌 힌트) — 적절한 선택. start 설명(agents.ts:415)·§4.1 문서화 확인.

## 잔여 정합성 재확인 (신규 blocking 없음)

- 사다리·격리·req 게이트·EOF 최종줄 판정·에코 3중방어: 턴8에서 정확 확인, B1 수정으로 파일 회수가 실제로 complete 반환(도그푸드 source:"file", doneSignal 유실에도 파일 게이트만으로 회수 성공 — 파일=진실 원칙 실증).
- pane 폴백 footer(buildPaneFallbackFooter, agents.ts:334)도 BEGIN/END 분할문자열 유지.
- 기존 16툴 비회귀: smoke 21툴 + e2e 26/26 통과와 정합.

## 최종 검증 결과 수용

typecheck·build·unit 41+/41+·smoke 21툴·e2e 26/26·**라이브 도그푸드 PASS**(실 codex 부팅→send→파일 프로토콜 complete 회수). 특히 라이브 도그푸드는 이 설계의 유일한 사각(실LLM만이 footer를 실제로 파싱)을 직접 검증해, 5턴에 걸친 합의의 핵심 리스크(에코 오탐·stale 파일·mid-write·마커 드리프트)를 모두 실경로로 닫았다.

## 종합

turn1(스코프)→turn9(구현)까지 3-LLM 합의가 제기한 모든 blocking(provider 하드코딩, ANSI 불일치, errorPattern 전체pane, stale 파일 신원, 경로 정합, 신호 에코, mid-write 커밋, EOF 마커 드리프트)이 순차 해소되고 라이브로 실증됐다. 무상태·HTTP+로컬읽기·인젝션 방어·결정론 우선 원칙도 시종 유지. **최종 APPROVE — purplemux 본체 무수정, MCP 레이어 21툴 구현 병합 동의.**
