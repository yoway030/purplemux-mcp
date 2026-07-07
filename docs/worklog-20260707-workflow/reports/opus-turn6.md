verdict: APPROVE — 턴5 blocking 6건(BN1·BN2·N1·Codex BN3/BN4·N2·N3) 전부 견고하게 해소. 잔여는 편집/구현정밀도 비차단 4건뿐. 설계 승인.

## 턴5 지적 반영 판정 — 6/6 해소 ✅

- **BN1 (stale 파일 신원)** → 해소. §3.2 requestId 신원 게이트: send가 미지정 시 자동생성·반환(무상태), §4.5 사다리 1이 "1줄차 req 일치 + EOF req 일치"만 유효 파일로 인정, 사다리 2가 불일치를 `stale_file_req_mismatch`로 **구조화 구분** 반환. turn-1.md 세션간 충돌이 정상 케이스임을 명시하고 req로 결정론 차단 — 정확히 내 권고안대로. 경로가 아닌 **내용(1줄차 req)** 기반 게이트라 더 견고.
- **BN2 (상대경로 vs 절대경로)** → 해소. §3.2·§3.4 footer가 send 조립 시 해석된 workspaceDir을 **절대경로로 치환**, §4.3 `expectedReportFile`도 절대경로 반환 → 에이전트 쓰기 경로와 서버 읽기 경로 동일 문자열 보장. cwd 의존 제거.
- **N1 + Codex BN3 (신호 에코 오탐)** → 해소, 방식 우수. §3.4 **분할 문자열 지시**로 footer 어디에도 완성형 `<<<PMUX_DONE...>>>`/`<<<PMUX_EOF...>>>`가 존재하지 않음("<<<PMUX_" + "DONE agent=... >>>" 조립 지시). 에코된 지시줄엔 `<<<PMUX_"` 뒤에 `" 뒤에 "`가 와서 완성 마커가 리터럴로 못 만들어짐 → 단독줄 규칙·마지막매치와 결합해 **결정론적** 차단. 3중 방어(§6). BEGIN/END 폴백 경로도 동일 전환 명시.
- **Codex BN4 (순차기록 mid-write)** → 해소. §3.2 마지막 줄 `PMUX_EOF`(req 일치) 커밋 마커 + §4.5가 EOF까지 확인해야 complete. 1줄차 상태만으론 커밋 게이트가 안 된다는 지적을 정확히 수용 — 상태줄(신원) + EOF(커밋)의 **이중 게이트**가 tmp→rename 강제 없이도 쓰기전략 무관하게 검증 가능. 내 턴4 B2 상태줄 제안보다 견고.
- **N2 (status.reportFile 노출)** → 해소. §4.4 `statusLine`/`reqMatch`/`eofPresent`/`bytes` 추가 → status 스냅샷이 capture "유효" 개념과 일관.
- **N3 (파일부재≠격리위반)** → 해소. §3.2·§5 paths.ts에 명시.

## 사다리·상태기계 정합성 재확인 (신규 결함 없음)

- DONE이 파일 EOF보다 먼저 도착(플러시 지연) → 사다리 2가 `working` 반환(EOF 부재) → 재폴링 시 EOF 확정 후 사다리 1 complete. 안전.
- DONE(req 일치) + 파일 전무 → 사다리 3 `inconsistent`(오케스트레이터 위임). 일관.
- 원칙 1(결정론)과 정합: 코드가 complete/working/stale/inconsistent/missing까지 구조화 판정, 애매(inconsistent/missing/timeout)만 LLM 위임.

## 비차단 (구현 시 반영 권장 — 승인 저해 아님)

1. **§4.5 입력 줄 중복(편집)**: `입력:` 라인이 2개(첫 줄 `requestId?`, 둘째 `requestId` 필수). 첫 줄 삭제로 정리. schema는 §5대로 파일회수 시 필수.
2. **EOF는 "파일의 마지막 비공백 줄"로 엄격 검증할 것(구현 정밀도)**: 본문이 프로토콜 마커를 인용해 중간에 `<<<PMUX_EOF req=...>>>`가 섞이면 조기 truncation 위험. 파서는 "EOF 포함"이 아니라 **최종 줄이 EOF(req 일치)** 조건으로 판정하고 content는 2줄~최종EOF직전으로. (분할문자열 footer 덕에 에이전트 자기 인용 가능성은 낮지만 방어적으로.)
3. **capture `requestId` 스키마를 무조건 required로 굳히지 말 것**: fileOutput=false pane-블록 폴백(BEGIN/END는 req 없이도 성립)·bootstrap 회수에서 req가 없을 수 있음. zod에선 optional 유지 + "파일 회수 시 필수"를 런타임/설명으로 안내 권장. §5 문구가 "필수화"라 과도 강제될까 주의.
4. **동일 agentId+turn 동시 재사용(경계)**: 같은 경로 turn-<n>.md를 두 드라이버가 동시에 쓰면 마지막 쓰기가 이기고 다른 쪽 capture는 req 불일치로 영구 working. 단일 오케스트레이터 전제에선 비발생 — 한 줄 한계 명시만 권장.

## 종합

v2.1은 5턴에 걸친 3-LLM 합의 지적을 빠짐없이, 그리고 내가 제안한 것보다 더 견고한 메커니즘(내용기반 req 게이트 + EOF 커밋 마커 + 분할문자열 에코차단)으로 수렴시켰다. 잔여 4건은 전부 편집/구현정밀도 수준으로 코드 단계에서 흡수 가능. **설계 APPROVE — 구현 단계 진입 동의.**
