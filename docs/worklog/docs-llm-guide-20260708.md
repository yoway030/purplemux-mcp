# 문서 정리: LLM 대상 가이드 계층화 (2026-07-08)

## 배경

실사용에서 오케스트레이터 LLM이 서브에이전트를 `pmux_create_tab`(claude-code/codex-cli
panelType) + `pmux_send_input`으로 실행하려다 실패하는 사례 확인. 원인 진단:
- README 앞부분 예시가 저수준 경로를 "핵심 흐름"처럼 제시 (잘못된 affordance)
- MCP 접속 시점에 툴 계층(agent_* = primary)을 알려주는 채널 부재
- `pmux_api_guide`는 purplemux HTTP API 레퍼런스일 뿐, MCP 툴 가이드가 아님

## 변경

1. **`src/guide.ts` 신설** — LLM 대상 문서 단일 소스:
   - `SERVER_INSTRUCTIONS`: MCP `instructions`로 initialize 시 모든 클라이언트에 자동 전달
     (툴 계층 + 골든 패스 + 안티패턴 경고, <3000자 유지 — unit 테스트로 강제)
   - `ORCHESTRATION_GUIDE`: 새 `pmux_guide` 툴이 반환하는 전체 가이드
     (계층 표 · 골든 패스 · 부트 검증 · fileOutput 라우팅 · 상태 신호 · 복구 치트시트)
2. **`pmux_guide` 툴 추가** (로컬 정적 — purplemux 연결 불필요) → 총 23툴
3. **설명 정비**: `pmux_api_guide`(HTTP API 레퍼런스임을 명시), `pmux_create_tab`
   (claude-code/codex-cli panelType은 UI 패널이지 관리형 에이전트 세션이 아님을 경고)
4. **README.md / README.en.md**: 인트로 4단계 예시를 agent_* 흐름으로 교체 + 안티패턴 경고,
   22→23툴, 부트 검증 언급, USAGE 링크 문구의 구식 표현 제거
5. **docs/USAGE.md**: §1을 23툴로 재구성(agent 계층을 최상단 primary로), §6 cookbook에
   model/effort 사용자 확인 단계 · bootId/expectEcho 부트 검증 · bootWired 진단 · agentId
   호출자 소유 규칙 · codex hook trust 반영
6. **test/unit.mjs**: 가이드 일관성 테스트 3건 (instructions⊂guide 툴명 검증, 골든패스 툴
   양쪽 존재, instructions 길이 상한)

## 리뷰 (codex + claude 병렬, 전건 반영)

- codex [BLOCKING]: `bootWired:false`면 부트 파일이 영원히 안 생겨 `fileSeen:false`가 무신호
  — 가이드/USAGE에 "bootWired 먼저 확인" 문서화로 해소
- claude [SHOULD]: `agentId` 출처 미설명(골든 패스 최대 사용성 공백) — 호출자 선택 id,
  탭 전체 턴에 재사용, `boot` 예약어 금지 명시로 해소
- 그 외: 툴명 축약(agent_send 등) → 전체 이름으로 통일, codex hook trust를 실측 관찰
  (v0.142.5)로 표기, alive:false를 upstream 동작으로 귀속, not_shell_ready 복구 행 추가,
  README:77 저수준 흐름 잔재 문구 수정, USAGE "터미널 툴 10종" 구식 수치 수정

## 검증

`npm run build` · `npm run typecheck` · `npm run unit`(가이드 테스트 3건 포함) 통과,
smoke 23툴 등록 확인, initialize 응답에 instructions 실림 실측, `pmux_guide` 실호출
(7.2KB markdown) 확인.
