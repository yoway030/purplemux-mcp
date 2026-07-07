verdict: REJECT — blocking 1건: EOF 커밋 마커의 닫는 괄호 개수가 footer(지시)와 parser(검증) 사이에서 불일치(4 vs 3). fileOutput=true(기본) 파일 회수가 실제 에이전트에 대해 항상 실패 → v2 핵심 경로 붕괴. 그 외는 설계 충실 이행.

## BLOCKING

### B1. src/paths.ts:132 (footer) vs src/paths.ts:99 (parser) — EOF 마커 `>` 개수 불일치 → 파일 회수 영구 실패

- **parser** (`readReportFile`, paths.ts:99): `const eofMarker = \`<<<PMUX_EOF req=${requestId}>>>\`` → `<<<PMUX_EOF req=abc>>>` (**닫는 `>` 3개**). design §3.2 규격(`<<<PMUX_EOF req=<requestId>>>>`에서 `<requestId>`는 플레이스홀더 → 실제 3개)과 일치. 파서는 옳음.
- **footer** (`makeFileFooter`, paths.ts:132): 분할 조각이 JS 리터럴 `"EOF req=${requestId}>>>>"` → 치환 후 `EOF req=abc>>>>`, 접두 `<<<PMUX_` 결합 시 에이전트가 조립·기록하는 문자열은 `<<<PMUX_EOF req=abc>>>>` (**닫는 `>` 4개**). 플레이스홀더 표기의 `>`를 리터럴로 한 번 더 센 off-by-one.
- **실패 시나리오**: fileOutput=true(기본)로 send → 에이전트가 footer를 **정확히** 따라 마지막 줄에 `<<<PMUX_EOF req=abc>>>>`(4개) 기록 → `pmux_agent_capture`가 `readReportFile`에서 최종 비공백 줄 `...>>>>`(4) ≠ 기대 `...>>>`(3) → `eof_missing` → 사다리 2단 `{status:"working", reason:"file_invalid_or_midwrite"}` 반환. **1줄차·req·본문이 모두 완벽해도 complete를 절대 못 냄.** 회귀 없이 무한 working → 오케스트레이터는 완료된 턴을 영영 회수 못 하고 pane 폴백도 안 탐(requestId 있으면 파일 분기로 들어가 사다리 4 pane 추출 전에 working 반환). v2의 "파일=내용" 주 경로가 통째로 무력화.
- **테스트가 못 잡은 이유**: unit(readReportFile 케이스)은 파일 문자열을 parser 기준 3개로 직접 구성해 통과, e2e 가짜 에이전트도 3개로 직접 기록 — **footer 텍스트를 실제 파싱해 조립하는 건 실LLM뿐**이라 40/40·e2e가 초록이어도 실패가 은닉됨. 정확히 크로스-아티팩트(지시문↔검증기) 불일치 유형.
- **수정**: paths.ts:132 조각을 `"EOF req=${requestId}>>>"`(3개)로. 회귀 방지로, footer가 조립을 지시하는 EOF/DONE 문자열을 parser 상수와 **동일 소스에서 파생**하도록(예: `eofMarker.slice("<<<PMUX_".length)`를 footer가 재사용) 리팩터 권장 — 지금 DONE은 우연히 3개로 일치하지만 같은 이중관리 위험 있음.

## 비차단 확인 (참고 — 승인 저해 아님, B1만 고치면 됨)

- **에코 안전 (②)**: 견고. footer/fallback footer 모두 분할문자열(`"<<<PMUX_" 뒤에 "..."`)이라 에코에 완성 마커가 리터럴로 존재 불가. parseDoneSignal(pane.ts:174)·extractMarkerBlock는 strip+trim 단독줄 exact 매치 + 마지막매치 → 3중 방어 정상. buildPaneFallbackFooter(agents.ts:300)도 BEGIN/END 분할 적용 확인.
- **경로 격리 (③)**: 양호. agentReportPath가 ID_RE·정수 turn 검증, readReportFile가 realpath(file)·realpath(workspaceDir) 후 `startsWith(realWorkspace+sep)` 포함검사, ENOENT/ENOTDIR→missing(격리위반과 구분, N3) 정확. content는 `slice(1, lastIdx)`로 1줄차·EOF 제외 올바름.
- **사다리 정확성 (①)**: capture(agents.ts:599-659) 구현이 §4.5 순서와 일치 — valid→file complete/blocked, invalid→working(req_mismatch→`stale_file_req_mismatch`), 파일없음+DONE(req)→inconsistent, 파일없음→pane 추출, 그다음 busy→working/missing. req 게이트(BN1) 정상, EOF 최종줄 판정 로직(paths.ts:97-100) 정확(B1 괄호만 고치면 동작).
- **턴6 비차단 4건**: #2(EOF=최종 비공백 줄 엄격판정) 구현됨(paths.ts:97-100). #3(capture requestId 무조건 required 아님) 구현됨 — requestId 없으면 파일 건너뛰고 pane 폴백(agents.ts:599, 설명 명시). #1(§4.5 입력 줄 중복)은 design 문서 편집사항. #4(동시 동일경로)는 노트-온리로 미조치 — 수용.
- **비회귀 (⑤)**: 기존 16툴 로직 불변, tools.ts는 registerAgentTools 등록만. smoke 21툴 통과와 정합.
- **경미**: (a) reportFileStatus(agents.ts:317-338)는 eof_missing일 때 statusLine/reqMatch를 undefined로 두는데 실제론 그 둘이 유효/일치한 상태 — 진단정보 손실(비차단). (b) makeFileFooter:130 1줄차 지시에 `   (수행 불가면...)` 괄호가 같은 줄에 있어 에이전트가 파렌을 1줄차에 포함하면 STATUS_LINE_RE($앵커) 탈락 — 에이전트 컴플라이언스 리스크, 문구 분리 권장(비차단).

## 종합

B1을 제외하면 구현은 v2.1 설계를 충실히·정확히 이행했다(사다리·격리·에코방어·req게이트·EOF최종줄·턴6 반영 모두 확인). 그러나 B1은 기본 경로(fileOutput=true) 파일 회수를 실제 에이전트에 대해 100% 무력화하고 자동 테스트가 구조적으로 못 잡는 종류라 반드시 선수정. 한 글자(`>>>>`→`>>>`) 수정 + 지시/검증 문자열 단일소스화로 재발방지. 수정 후 재검토 없이 APPROVE 가능한 수준.
