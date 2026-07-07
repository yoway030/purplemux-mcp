DONE

## 담당 범위
turn=4 리뷰 회귀 수정 (blocking 1건 + 비차단 1건): `src/paths.ts`의 EOF footer 조각 `'>'` 개수 불일치 버그 및 마커 문자열 단일 소스화.

## 근본 원인
`src/paths.ts:132`(수정 전) footer 조각이 `"EOF req=${requestId}>>>>"`로 **'>' 4개**를 하드코딩했으나, `readReportFile`의 파서(`paths.ts:99`, 수정 전)는 `` `<<<PMUX_EOF req=${requestId}>>>` ``로 **'>' 3개**를 기대 — 완성형 마커를 손으로 두 번 따로 타이핑하면서 개수가 어긋남(design-v2.md §3.4 원문의 마크다운 표기 `req=<requestId>>>>`를 그대로 옮기면서, `<requestId>`가 플레이스홀더 자체의 닫는 `>`를 포함한 표기였다는 점을 놓침). 결과: footer 지시를 정확히 따르는 에이전트일수록 파일 마지막 줄이 파서 기대와 어긋나 영구 `eof_missing`.

## 수정 파일 (src/pane.ts, src/paths.ts, test/unit.mjs만 — 다른 파일 무수정)

### `src/pane.ts`
- `makeDoneMarker(o: {agentId, turn, requestId?, status}): string` 신규 export — DONE 마커 완성 문자열의 **단일 소스**.
- `parseDoneSignal`을 정규식 조립 방식에서 `makeDoneMarker`가 만든 두 후보 문자열(status=complete/blocked)과의 **정확 문자열 비교** 방식으로 리팩터. 더 이상 agentId를 정규식에 이스케이프해 넣지 않음(`escapeRegExp` 헬퍼 제거) — 생성기와 파서가 완전히 같은 빌더를 쓰므로 두 쪽이 어긋날 수 없음.

### `src/paths.ts`
- `eofMarker(requestId: string): string` 신규 export — EOF 커밋 마커의 **단일 소스** (`<<<PMUX_EOF req=<rid>>>` — '>' 3개, 정확).
- `readReportFile`의 마지막 줄 비교를 `eofMarker(requestId)` 호출로 교체(하드코딩 리터럴 제거).
- `makeFileFooter` 전면 리라이트:
  - `eofRest`/`doneRest`를 `eofMarker(requestId)`/`makeDoneMarker({...})`가 반환한 **완성 문자열을 `MARKER_PREFIX="<<<PMUX_"` 기준으로 slice**해서 얻음 — 손으로 다시 타이핑하지 않으므로 파서와 절대 어긋날 수 없음(1번 지시 반영).
  - 1줄차 지시(`- 1줄차: status=complete req=<rid>`)와 `(blocked 대체 안내)` 괄호를 **별도 줄로 분리** + "다른 텍스트는 1줄차에 추가하지 마세요" 문구 추가(2번 비차단 지시 반영).
  - JSDoc에 근본 원인·수정 근거 명시.

### `test/unit.mjs`
- **왕복(roundtrip) 테스트 신규 추가** (3번 지시): `makeFileFooter`가 만든 footer 문자열에서 정규식으로 (a) 저장 경로 (b) 1줄차 템플릿 (c) "마지막 줄"/"화면에는" 줄의 인용부호 두 조각을 **런타임에 그대로 추출**해 조립 → 가상 에이전트가 지시를 문자 그대로 따랐다고 가정하고 파일/DONE 신호를 생성 → `readReportFile` → `valid`, `parseDoneSignal` → `found:true` 검증. 값을 하드코딩하지 않고 footer 출력에서 직접 뽑아 쓰므로, footer 조립 로직이 다시 어긋나면 이 테스트가 실패하도록 설계(지시 요구사항 그대로).
- 기존 `readReportFile`/`parseDoneSignal` 테스트는 그대로 유지(파서 쪽 기대값은 원래도 정확했으므로 무변경).

## 테스트 결과
- `npm run typecheck` — 에러 0건.
- `npm run build && node test/unit.mjs` — **40/40 통과** (기존 39건 + 신규 roundtrip 1건).
- 논리 검증: 되돌려서 eofRest에 '>' 1개를 더 넣으면 roundtrip 테스트의 `assertEqual(fileResult.state, "valid")`에서 반드시 실패함을 코드 경로상 확인(직접 되돌려 재현하지는 않음 — 수정 후 상태로 커밋 유지).

## 특이사항
- `src/agents.ts`는 `parseDoneSignal`/`makeFileFooter`/`readReportFile`만 이름으로 import하고 있어 `makeDoneMarker`/`eofMarker` 신규 export는 순수 추가(하위 호환 영향 없음) — 확인함, 무수정.
- `.gitignore`/`package.json`/`src/schemas.ts`/`src/tools.ts`/`test/e2e.mjs`/`src/agents.ts`는 `git status`로 무변경 확인.
