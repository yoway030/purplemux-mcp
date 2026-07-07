DONE

## 담당 범위
turn=3 v2.1 델타 구현 (design-v2.md §3 프로토콜, §4.2, §4.5 사다리, §5.1 모듈 계약 중 sworker 몫: src/pane.ts 소폭 변경, src/paths.ts 신규)

## 수정/생성 파일

### `src/pane.ts` (소폭 변경)
- `parseDoneSignal(o: { pane, agentId, turn, requestId? }): { found; status? }` 추가 (§5.1 시그니처 그대로).
  - stripAnsi 후 `line.trim()`이 `^<<<PMUX_DONE agent=<id> turn=<n>[ req=<rid>] status=(complete|blocked)>>>$`에 **완전 일치**하는 줄만 인정(단독 줄).
  - 매치되는 모든 줄을 순회하며 **마지막 매치**를 채택.
  - `requestId` 지정 시 정규식에 ` req=<rid>` 고정 삽입(불일치·부재 req는 매치 안 됨). `requestId` 미지정 시 정규식에 req 그룹 자체가 없어 **req 없는 신호줄만** 매치(pane 블록 폴백 경로 전용).
  - agentId를 정규식에 넣기 전 `escapeRegExp`로 이스케이프(내부 헬퍼, export 안 함).
- `classifyReadiness`의 `errorPattern` 평가를 **pane 전체 → `tailLines(pane, 15)`**로 변경. 시그니처·나머지 순서(셸복귀→busy→ready→starting)는 불변. JSDoc을 v2 §4.2 근거로 갱신.

### `src/paths.ts` (신규)
- `agentReportPath(workspaceDir, agentId, turn)`: `ID_RE`(profiles.ts 기존 것 재사용)·정수 검증 후 `join(workspaceDir, ".pmux-agents", agentId, turn-<n>.md)`. 검증 실패 시 ToolError — agentId `"../x"`·`"a/b"` 등은 여기서 즉시 차단(경로 격리 1차 방어선).
- `ReportFileCheck` 유니온 (`missing` / `invalid{reason}` / `valid{status,content,bytes}`) §5.1 그대로.
- `readReportFile(workspaceDir, agentId, turn, requestId): Promise<ReportFileCheck>`:
  1. `agentReportPath`로 경로 조립(검증 포함).
  2. `realpath(path)` 시도 → `ENOENT/ENOTDIR`이면 `{state:"missing"}`(격리 위반 아님, §N3).
  3. 존재하면 `realpath(workspaceDir)`와 비교해 `workspaceDir` 하위가 아니면 ToolError(심링크 탈출 방어).
  4. 1줄차 `^status=(complete|blocked) req=(\S+)$` 파싱 실패 → `invalid/status_line`.
  5. req 불일치 → `invalid/req_mismatch`(stale 세션 파일).
  6. **최종 비공백 줄**이 정확히 `<<<PMUX_EOF req=<rid>>>>`가 아니면 → `invalid/eof_missing`(mid-write 및 본문 중간 EOF 인용 둘 다 방어).
  7. 전부 통과 시 `content` = 2줄~EOF 직전 줄, `bytes` = 원본 바이트 수.
- `makeFileFooter(o)`: §3.4 fileOutput=true footer를 분할 문자열 그대로 조립(`"<<<PMUX_"` + `"EOF/DONE ...>>>"` 형태를 별도 인용구로 분리해 반환 문자열에 완성형 마커가 **절대 연속 문자열로 존재하지 않음**). 저장 경로는 `agentReportPath`로 조립(호출자가 넘긴 `workspaceDir`이 이미 절대경로라는 전제 — 절대경로 치환은 agents.ts 몫).

### `test/unit.mjs` (추가만, 기존 케이스 불변)
- `parseDoneSignal`: 마지막 매치 우선, req 불일치 미매치, req 미지정 시 req-없는 신호만 매치, `makeFileFooter` 에코 안전성(완성형 `<<<PMUX_DONE`/`<<<PMUX_EOF` 부재 확인 + 줄마다 `"> "` 프리픽스 붙인 에코 시뮬레이션에서도 미매치).
- `classifyReadiness` errorPattern tail 회귀: 본문 위쪽(tail 밖)에 `"command not found"` 인용 + 최근 15줄은 정상(`›`) → `agent_ready`(v1이었다면 영구 `launch_failed`).
- `agentReportPath`: `"../x"`, `"a/b"` agentId 거부.
- `readReportFile`(실제 임시 파일시스템, `mkdtemp`/`rm`으로 격리·정리): valid / missing(비위반) / status_line 무효 / req_mismatch / eof_missing(mid-write) / 본문 중간에 완성형 EOF 문자열을 인용해도 최종 줄만 커밋으로 인정 / agentId 경로탈출 시 ToolError 전파.

## 테스트 결과
- `npm run typecheck` — **에러 0건** (앞서 한 차례 agents.ts에 구계약 잔존 타입 에러 2건이 있었으나, 다른 워커가 병행 수정한 것으로 보이며 최종 재실행 시 사라짐 — 이번 델타로 발생한 에러 아님).
- `npm run build && node test/unit.mjs` — **39/39 통과** (기존 27건 + 신규 12건).

## 특이사항
- `.gitignore`/`package.json`/`src/schemas.ts`/`src/tools.ts`/`test/e2e.mjs`/`src/agents.ts`는 건드리지 않음 — `git status`로 확인, 전부 다른 워커 소관 변경만 존재.
- `src/pane.ts`의 v1 `buildSentinelFooter`/`makeMarkers`(BEGIN/END 블록)는 이번 지시 범위(§5.1 pane.ts 계약: parseDoneSignal + errorPattern tail만)에 없어 손대지 않음. design §3.4가 언급한 "fileOutput=false 경로 BEGIN/END도 분할 문자열 방식 전환"은 이번 턴 스코프 밖으로 판단 — 필요시 별도 지시 요청.
