# Worklog · Stage 1 — 추출 (Extraction)

**목표:** `subicura/purplemux` CLI 기능 전량 추출 → MCP 구현용 정본 인벤토리 확정.
**산출물:** `docs/01-cli-features.md` (정본), 패널 초안 `docs/panel/stage1/agent{1,2,3}-extract.md`, 고정 소스 `docs/reference/`.

## 방식
- 대상: 로컬 설치본 `purplemux@0.3.2` (`~/.npm-global/lib/node_modules/purplemux`) + 라이브 서버(`PMUX_PORT=16500`). GitHub README보다 실제 설치 소스가 정확해서 소스를 ground truth로 사용.
- 3에이전트 독립 추출 → 정본 합성 → 3에이전트 합의 게이트.
  - Agent1 = Claude **Sonnet**
  - Agent2 = Claude **Opus**
  - Agent3 = **Codex gpt-5.5 high** (`codex exec`)

## 발견 요약
- purplemux CLI는 **localhost HTTP API(`X-Pmux-Token`) 위의 얇은 래퍼**. 14개 사용자 명령 + 1개 미문서화 GET(tab-info) 엔드포인트.
- panelType enum 6종(`terminal|claude-code|codex-cli|agent-sessions|web-browser|diff`), 기본값 `terminal`.
- 상태코드 인벤토리 완비: 200/201/400/403/404/405/409/500/503 (Agent1이 번들 서버 디컴파일로 서버측 코드 확정).
- `memory`/`mem`은 **사망 명령** (dispatcher엔 있으나 구현/라우트 없음 — 라이브 확인). MCP 미노출.
- CLI 결함들(→ MCP는 CLI 셸아웃 대신 HTTP 직접 호출 권장): `--full` stripFlags 토큰 삼킴, argv 공백 붕괴, `tab close`가 실제 `{ok}` 바디 폐기.

## 쟁점과 해소 (핵심)
- **`tab send` 자동 제출 여부**로 패널 의견 갈림:
  - Agent1·Agent2: api-guide 근거로 "자동 Enter 없음, 호출자가 `\n` 넣어야".
  - Agent3(codex): 서버 번들 근거로 "bracketed-paste 후 서버가 Enter 전송(×2, ~600ms)".
- **오케스트레이터 실측으로 확정**: 라이브 터미널 탭에 `echo <mark>`를 개행 없이 send → 명령 실행됨(마크가 타이핑 라인+출력 2회). ⇒ **서버가 자동 Enter. codex가 맞음.** (합의 게이트에서 Opus·Sonnet도 각자 재실측해 동일 확인.)
- MCP 규칙 도출: `pmux_send_input`은 content 자동 제출됨을 전제, trailing `\n` 1개 정규화(제거).

## 합의 게이트 결과
| 에이전트 | 판정 | 비고 |
|---|---|---|
| Opus | **APPROVE** | 라이브 재실측, tab-info/DELETE `{ok}`/기본 panelType 재확인. 비차단 nit 3 |
| Sonnet | **APPROVE** | 라이브 재실측. `\n` 이중Enter 미재현 → 문구 완화 권고, `claudeSessionId` 별칭 주석 권고 |
| Codex | (턴 종료) | high 추론이 1.3MB 번들 재정독에 5분+ 무출력 → 리뷰 턴 kill. **실질 입장은 자신의 원안(auto-Enter)이 실측으로 입증되어 이미 승인 방향 확정** |

**결론: 합의 성립 (2/3 명시 승인 + 실측 근거, 차단 이슈 0).** 반영한 비차단 수정:
1. auto-Enter 이중제출 문구 완화 + `send` 개행 정규화 규칙 명시.
2. `claudeSessionId`=`agentSessionId` 레거시 별칭 주석.
3. screenshot/eval 확장 키는 headless 미검증 → 하드코딩 금지 주의.

## 운영 메모 (다음 단계 반영)
- codex 리뷰용 호출엔 "번들 전체 재정독 금지, 정본 문서만 검토" 제약을 걸어 시간 폭주 방지.
- codex는 stdin 파이프 이슈로 SIGTERM 발생 → `< /dev/null` + 로그파일 백그라운드로 안정화됨.

## 다음: Stage 2 · 설계
정본 15(+옵션1) 툴 셋을 MCP 서버 설계로 구체화 (언어/전송 stdio/스키마/인증/에러매핑/Claude Code·Codex 등록).
