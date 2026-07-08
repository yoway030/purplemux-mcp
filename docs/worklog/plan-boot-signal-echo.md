# 계획: 부트 신호 + bootstrap echo + 오케스트레이터 힌트 (2026-07-08)

## 배경 (실사용에서 관찰된 문제)

1. **wait_ready runtimeError 오탐**: codex 부팅 직후 `"You have 3 usage limit resets available"` 안내 문구가
   `DEFAULT_RUNTIME_ERROR_RE`의 `usage limit`에 걸려 runtimeError로 분류됨. ready 판정과 동시라 진행엔 지장이
   없었지만, runtimeError를 보고 abort하는 오케스트레이터는 오작동 가능.
2. **부팅 준비 판정이 전부 휴리스틱**: 글리프(›/❯)·frame signature·busy 스피너 패턴. cliState가 오면 낫지만
   pane 폴백은 오탐/미탐 여지가 구조적으로 남음.
3. **read-only/plan + fileOutput=true 모순**: 기본 조합이 turn 1에서야 실패로 드러남.
4. **오케스트레이터가 model/effort를 확인 없이 기본값으로 실행**하는 문제(사용자 피드백).

## 개선안

### A. SessionStart 훅 기반 부트 신호 (프로세스 기동의 결정론적 증거)

- 새 모듈 `src/boot.ts`.
- `pmux_agent_start`가 `bootId`(hex 12자, ID_RE 부합)를 생성.
- 실행 커맨드 앞에 env 접두: `PMUX_BOOT_FILE='<home>/.purplemux/boot/<bootId>' <command...>`.
- 이 저장소가 소유하는 훅 스크립트 `~/.purplemux/pmux-boot-hook.sh`를 idempotent하게 생성(0755):
  `$PMUX_BOOT_FILE`이 `$HOME/.purplemux/boot/` 하위일 때만 `ts=<epoch>`를 그 파일에 기록.
- 훅 배선:
  - claude: 기존 `~/.purplemux/hooks.json`을 읽어 SessionStart에 부트 훅 엔트리를 추가한 병합 설정
    `~/.purplemux/hooks-with-boot.json`을 생성해 `--settings`로 전달. hooks.json이 없거나 파싱 실패면
    부트 훅만 담은 설정으로 대체(기존 hooksWired 의미는 유지, bootWired는 별도 보고).
  - codex: 기존 `-c hooks.SessionStart=[...]` 배열에 부트 스크립트 command를 추가(codex-hook.sh 유무와 무관).
- `pmux_agent_start` 반환에 `bootId`, `bootFile`, `bootWired` 추가.
- `pmux_agent_wait_ready`에 `bootId?` 파라미터 추가: 폴링마다 부트 파일 존재를 확인, 모든 반환에
  `boot: {fileSeen}` 포함. 파일이 보이면 "프로세스는 떴다"는 결정론적 사실 확보(launch_failed 진단 보조).
- 오래된 부트 파일(>24h)은 start 시 best-effort 정리.

### B. bootstrap echo — LLM 정상응답의 결정론적 증거

- `pmux_agent_start`에 `bootstrapEcho?: boolean` (기본 true) 추가.
- true면 CLI positional 초기 프롬프트를 커맨드에 덧붙임(두 CLI 모두 `[PROMPT]` positional 지원 확인).
- 프롬프트는 서버 고정 템플릿(자유 문자열 삽입 없음 — bootId hex만 삽입, §4.6 불변식 유지), 단일 라인:
  "연결 점검: 어떤 도구도 사용하지 말고, "<<<PMUX_" 뒤에 "DONE req=<bootId> status=complete>>>" 를
  이어붙인 한 줄만 정확히 출력하세요."
  - split-marker 트릭(makeFileFooter와 동일)으로 지시문 에코가 완성 마커로 오인될 수 없음.
  - 마커 텍스트는 makeDoneMarker에서 슬라이스(단일 소스 원칙).
  - claude effort 힌트(bootstrapHint)가 있으면 echo 프롬프트 앞에 접합해 전달.
- `pmux_agent_wait_ready`에 `expectEcho?: boolean` 추가: bootId와 함께 주면 폴링마다
  `parseDoneSignal(pane, requestId=bootId)` 확인. **echo가 보이기 전에는 agent_ready를 반환하지 않음**
  (완료 증거 기반 준비 판정). input_queued→ready 승격도 expectEcho 시 비활성.
  echo가 보이면 runtimeError 매치가 있어도 ready 반환(완료 증거 우선 — 기존 turn 규칙과 동일),
  runtimeError는 정보로 병기.
- 비용: 모델 턴 1회(수초, 소량 토큰). 원치 않으면 `bootstrapEcho:false`.

### C. 오케스트레이터 힌트

- `pmux_agent_start` description에 추가: "실행 전, 사용자가 이미 지정하지 않았다면 각 서브에이전트의
  model/effort(codex는 sandbox, claude는 permissionMode 포함)를 사용자에게 확인하라."

### D. runtimeError 패턴 협소화

- `DEFAULT_RUNTIME_ERROR_RE`의 `usage limit`을 오탐 없는 형태로 교체:
  `usage limit (reached|exceeded|hit)` + `(reached|hit) (the|your)? usage limit` 방향.
  "usage limit resets available" 안내 문구는 매치되지 않아야 함.

## 비목표

- wait_ready 기존 휴리스틱 제거(하위호환 유지 — bootId/expectEcho 미지정 시 기존 동작 그대로).
- purplemux 앱 소유 파일(hooks.json, codex-hook.sh) 수정.

## 검증

- 단위테스트: echo 프롬프트 split-safety(프롬프트 문자열에 완성 마커 부재), 병합 설정 생성,
  runtimeError 신구 패턴 케이스("resets available" 비매치, "usage limit reached" 매치).
- 실기동: bootstrapEcho로 codex/claude 기동 → boot file 생성 + echo DONE 확인 → wait_ready ready.

## 결과 (2026-07-08, codex/claude 서브에이전트 합의 리뷰 2라운드 + 실기동 검증 완료)

- 계획 리뷰(codex medium, claude opus) → 합의 → 구현 → 코드 리뷰 → [BLOCKING] 1건(훅 경로
  shell-계층 quote 부재 → SAFE_HOOK_PATH_RE allowlist로 해소) + NIT 반영 → 재합의.
- positional 프롬프트 자동 제출: 두 CLI 실측 확인(codex v0.142.5, claude v2.1.202) → bootstrapEcho 기본 true.
- 실기동: claude boot file ✓(matcher "" 발화), claude/codex echo DONE ✓, --effort 반영 ✓,
  usage-limit 배너 runtimeError 비매치 ✓, 정상 종료 pane → agent_ready(ready-for-review→null 폴백 안전) ✓.
- **codex hook trust 게이트 실증**: 신규 부트 훅은 codex TUI에서 1회 trust 승인 필요("⚠ 1 hook
  needs review"). 승인 전에는 fileSeen:false + echoSeen:true 조합이 정상 상태 — start 설명문에 문서화.
- 추가 수확(실사용 발견 → 수정 반영): claude 스피너("✻ Booping… (…") busy 미탐 → BUSY_RE 확장,
  claude cliState ready-for-review가 정상 턴 완료 후에도 유지되어 send 영구 차단 → null 강등 +
  pane 승인 다이얼로그 탐지 신설, requireBusyTransition의 pre-submit baseline 오염 hang 실측
  → expectEcho 단일 게이트 설계 정당성 확인.
