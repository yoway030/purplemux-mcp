APPROVE

최종 확인 결과 blocking 없음.

확인 항목:
- EOF 마커는 `src/paths.ts`의 `eofMarker()`가 파서와 footer 생성의 단일 소스이며, footer는 `eofMarker(requestId).slice(MARKER_PREFIX.length)`로 조립 지시를 만든다. `>` 개수 drift가 재발하기 어려운 구조입니다.
- DONE 마커도 `src/pane.ts`의 `makeDoneMarker()`를 `parseDoneSignal()`과 footer 생성이 공유한다. `requestId` 게이트와 `status` 매칭이 일관됩니다.
- `readReportFile()`은 1줄차 status/req와 최종 비공백 줄 EOF/req를 모두 확인하고, content를 2줄부터 EOF 직전까지만 반환합니다. 중간 EOF 인용과 mid-write truncated read 모두 방어됩니다.
- `pmux_agent_start`는 1회 capture 대신 `shellTimeoutMs` 기반 유계 폴링을 하며, 셸 미준비 시에도 `command`와 `tail`을 반환합니다.
- `recommendedFileOutput`은 codex `sandbox !== read-only`, claude `permissionMode !== plan` 기준으로 반환되어 fileOutput 기본 true와 read-only/plan 권한의 데드락을 호출자 계약으로 해소합니다.
- `requestId` 자동 생성은 `randomBytes(6).toString("hex")`라 `ID_RE`에 부합합니다.
- 설계 `design-v2.md` §4.1의 shell polling, `recommendedFileOutput`, wait_ready 호출 계약이 구현 설명과 일치합니다.
- e2e는 agent_start 실제 경로, file report + DONE, stale req, EOF 누락, status snapshot, 기존 16툴 회귀를 포함해 실효성이 충분합니다.
