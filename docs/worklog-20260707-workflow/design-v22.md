# purplemux-mcp v2.2 설계 — 네이티브 상태 채널 + 회고 반영

design-v2.md(v2.1, 병합됨)의 **증보**. 입력: `worklog-20260707-2-workflow/pmux-mcp-review.md`(실사용 회고), v22-턴1 3-LLM 스코프 합의, purplemux 0.3.2 소스 분석 + 라이브 PoC.

## 0. 핵심 전환 — "화면을 읽지 말고 purplemux에게 물어라"

purplemux 본체는 CLI 상태를 화면으로 판단하지 않는다. **훅 push 기반**이다 (소스 확인):

- Claude: `~/.purplemux/hooks.json`을 settings로 주입 — `SessionStart`/`UserPromptSubmit`/`PreToolUse`/`PostToolUse`(→busy), `Stop`/`StopFailure`(→턴 종료), `PermissionRequest`(→notification) 훅이 `POST /api/status/hook`으로 tmux 세션명과 함께 push
- Codex: `node ~/.purplemux/codex-launcher.js`가 `POST /api/codex/launch-args`로 훅 포함 인자를 받아 launch, notify 이벤트를 `codex-hook.sh`로 push
- 결과가 `GET /api/cli/tabs/:id/status`의 **`cliState`**·**`command`** 필드로 노출 — 우리 MCP가 지금까지 받으면서 안 쓰던 값

### 라이브 PoC 실측 (훅 주입 claude, 2026-07-07)

| 시점 | cliState |
|---|---|
| 부팅 직후 | `idle` |
| 프롬프트 전송 직후 | `busy` |
| 응답 완료 | `needs-input` |
| (plan 제출 시) | `ready-for-review` |
| 훅 미주입 세션 | `idle` 고정 (변화 없음 — 기존 우리 에이전트들의 맹점) |

`command` = tmux 포그라운드 프로세스명: `bash`(셸) ↔ `claude`/`node`(에이전트 생존). **런치 실패·프로세스 종료를 정규식 없이 판정.**

### 신호 우선순위 (결정론 원칙의 완성)

```
1차: cliState (훅 세션)  + command (전 세션)     ← HTTP, 결정론
2차: pane 휴리스틱 (훅 미주입 세션 폴백)          ← 기존 v2.1, 보강(R1)
내용: 파일 프로토콜 (v2.1 그대로)                 + 마커 단축·wrap 내성(R2)
```

## R0. 네이티브 상태 채널 (신규, 최우선)

### R0.1 훅 주입 launch (턴2 게이트 반영 확정판)

**launcher 불필요 판명** (launch-args API 실측): purplemux의 codex launch-args는 `-c hooks.*=[...codex-hook.sh...]` 6종 + developer_instructions뿐 — model/sandbox 미포함. 즉:
- claude: `claude --settings <home>/.purplemux/hooks.json --model <m> --permission-mode <p>` — 파일 부재 시 `--settings` 생략+`hooksWired:false`.
- codex: **기존 자체 조립 유지** + `-c "hooks.<E>=[{matcher=\".*\",hooks=[{type=\"command\",command=\"<home>/.purplemux/codex-hook.sh\"}]}]"` 6종(SessionStart/UserPromptSubmit/PreToolUse/PostToolUse/Stop/PermissionRequest) 덧붙임. hook.sh 부재 시 생략+`hooksWired:false`. **옵션 충돌 원천 소멸** — model/effort/sandbox/`--no-alt-screen` 전부 우리 것 그대로(Codex 턴2 게이트 해소, appliedOptions 필드 불요).
- 훅 인자는 전부 **고정 문자열**(homedir 조립, 사용자 입력 없음) — 단 G1: 셸 명령에 보간되는 모든 가변값(현재 model/effort/sandbox enum·정규식 기존 검증 + **workspaceId는 셸 보간 금지**, codex 훅 인자에 workspaceId 불포함이므로 해당 없음 확인)을 착수 전 재점검.
- 반환에 `hooksWired: boolean` 추가. `recommendedFileOutput`(v2.1) 유지 — 자체 조립이므로 sandbox 기준 계산 그대로 유효.

### R0.1b 라이브 PoC 결과 (G2·G3 해소)

| 경로 | 검증 | 결과 |
|---|---|---|
| G3 훅-탭 상관 | **우리 경로 그대로**(API terminal 탭 생성→send_input launch)로 PoC 수행 | cliState 전이 확인 — 상관은 pane 내 `tmux display-message`(세션명) 기반, env 불요. **성립** |
| claude | `--settings hooks.json` | idle→`busy`→`needs-input` (plan 제출 시 `ready-for-review`) |
| codex (G2) | 자체 조립+`-c hooks.*` 6종 | idle→`busy`→**`ready-for-review`** |

**Provider별 cliState 매핑 (실측 — 일괄 매핑 금지!)**:
```
공통:   busy → agent_busy / idle·unknown·기타 → pane 폴백 / notification → agent_blocked
claude: needs-input → agent_ready / ready-for-review → agent_blocked (plan 승인 대기)
codex:  ready-for-review → agent_ready (턴 완료의 codex 어휘) / needs-input → agent_ready
```
(구현 시 fixture로 재확인 — G7 계약)

### R0.2 상태 판정 사다리 (wait_ready / send 검증 / status / turn 공통)

```
0. tab_status 1회: alive=false → exited
1. command ∈ SHELL_NAMES(bash|zsh|fish|sh|dash) → (런치 후라면) launch_failed / (초기) shell_ready
2. cliState = "busy"                  → agent_busy       (send 거부 — 회고 #5 큐잉 방지)
3. cliState ∈ {"needs-input"}         → agent_ready      (결정론 ready)
4. cliState ∈ {"ready-for-review","notification"} → agent_blocked (신규 상태 — 승인/리뷰 대기, send 부적합, tail 동봉해 LLM 판단 위임)
5. cliState = "idle"|"unknown"|미지원값 → pane 휴리스틱 폴백 (R1)
```
- `agent_blocked`를 ReadinessState에 추가 (Codex 턴1 제안 수용).
- cliState 값은 열린 집합으로 다룬다(알 수 없는 값 → 폴백). 반환에 `signalSource: "cliState"|"pane"` 명시.

## R1. pane 휴리스틱 보강 (폴백 계층으로 강등, 그러나 견고하게)

v22-턴1 Codex 제안 + Opus 게이트 수용:
- tail 폭 15 → **30**으로 확장 (composer+상태바+직전 출력 공존).
- `codexFrameSeen` := 상태바 시그니처(`Read Only|Workspace|gpt-|·` 구획 등) 중 **2개 이상** tail 내 존재.
- shell-return 판정은 `!frameSeen && lastNonBlank matches SHELL_PROMPT_RE`일 때만 (본문 `$`/`%` 끝 오탐 축소 — v2 §6 알려진 한계 해소).
- busy 패턴에 `Working`·스피너 변형 추가.
- queued/composer-dirty: `›` 뒤 비어있지 않은 텍스트 && busy 아님 → `agent_starting` reason:"input_queued" (bare composer `^\s*›\s*$`만 ready 후보).
- ready := bare composer OR (frameSeen AND NOT busy AND NOT queued). **additive** — 기존 글리프 빠른 경로 유지 (Opus: invert 금지).
- claude 쪽도 동일 구조(frameSeen: 입력박스 테두리·상태줄).
- **fixture 중심 단위테스트** (Codex): fresh composer / 응답완료 bare› 없음 / Working / 승인 프롬프트 / queued 텍스트 / 셸 복귀 / 본문 `$` 끝.

## R2. 마커 단축 + wrap 내성 (Opus 우선순위대로)

1. **마커 단축(1차)**: pane 신호는 req로 유일 식별되므로 `agent`/`turn`은 잉여 —
   `<<<PMUX_DONE req=<rid> status=complete>>>` (74→~44자), BEGIN/END도 `<<<PMUX_BEGIN req=<rid>>>>` 형태로 단축. **파일 1줄차/EOF 형식은 불변**(v2.1 프로토콜 유지). 생성기+파서+footer+roundtrip 테스트 **동시 변경 필수** — 단일 소스(makeDoneMarker/eofMarker) 원칙 유지라 변경 지점은 각 1곳.
   - requestId 없는 경로(fileOutput=false, req 미지정): 기존 agent/turn 형식 유지(구분자 필요).
2. **wrap-tolerant 매칭(2차, belt-and-suspenders)**: 연속 줄 결합 후 마커 동치 검사. §3.4 분할 문자열 footer 덕에 에코에는 완성형이 물리적으로 부재 → 줄 결합을 허용해도 에코 오탐 불가(명시).
3. **조사 항목**: pmux capture API가 tmux `capture-pane -J`(wrap 결합)를 지원하는지 — 지원하면 2를 대체. (구현 단계에서 확인, 미지원이면 2 진행)

## R3. `pmux_agent_turn` 복합 툴 (22번째 툴, 분리 게이트)

send→폴링(R0 사다리)→capture→반환을 단일 호출로. LLM은 이 하나만 알면 된다 (회고 제안 4).
- 입력: send와 동일 + `pollTimeoutMs?`(기본 120000, ≤300000), `pollMs?`(기본 2000).
- **유계·재개 계약** (Opus 턴1 필수 조건): timeout 시 `{ status:"timeout", marker, expectedReportFile, tail }` 반환 — 호출자는 같은 marker로 `pmux_agent_capture`를 이어 부르면 됨(무상태라 자연 성립). 부분 실패(전송 성공·회수 실패)도 marker 반환으로 재개 가능.
- 반환: `{ status:"complete"|"blocked"|"timeout"|"send_failed", content?, source?, marker, attempts, elapsedMs, tail? }`.

## R4. 라우팅 힌트

- start 반환에 `next: "pmux_agent_wait_ready 후 pmux_agent_send 또는 pmux_agent_turn"`, `fallback: "wait_ready timeout이나 판정 불확실 시 pmux_capture_pane으로 직접 확인"` 필드(정적 문자열).
- 툴 설명에 primary/fallback 라우팅 1줄씩: agent_* = primary, send_input/capture_pane = 저수준 폴백.
- `pmux_create_tab` 설명에 "claude-code/codex-cli panelType 탭은 UI 부착 전 빈 셸일 수 있음 — 에이전트 오케스트레이션은 pmux_agent_start 권장".

## R5. cookbook (USAGE.md)

권장 워크플로(회고 제안 1 그대로) + agent_turn 중심 최단 경로 + 훅 세션/비훅 세션 차이 + fileOutput 라우팅(recommendedFileOutput) 예제.

## R6. 런타임 오류 감지 — "조용한 태스크 죽음" (운영 실측 추가)

라운드 A 운영 중 실측: sworker(claude)가 **API Error: 529 Overloaded**로 3m29s 작업을 중단하고 프롬프트로 복귀. 세션은 ready이므로 모든 상태 신호(cliState needs-input, pane ready)가 정상 — **태스크가 죽었다는 사실은 어디에도 안 잡힘**. 오케스트레이터가 tail을 직접 봐야만 발견 가능했다(회고 "상태 확인 불충분"의 변형).

- `pane.ts`: `detectRuntimeError(tail): { found: boolean; match?: string }` 순수 함수 — 기본 패턴 `API Error|Overloaded|rate limit|usage limit|stream disconnected|connection error`(대소문자 무시, ≤200자 override 가능). **상태를 바꾸지 않는다** — ready인 세션은 실제로 ready다(재지시 가능). 별도 사실로 노출.
- `wait_ready`/`status`/`send` 반환에 `runtimeError?: { match, line }` 필드(발견 시) — 소비자(LLM)가 "완료 신호 없이 ready + runtimeError"를 보면 재지시/재시도 판단.
- (라운드 B) `agent_turn`: 폴링 중 완료 증거 없이 ready+runtimeError 감지 시 `{ status:"agent_error", runtimeError, tail }` 조기 반환 — timeout까지 기다리지 않음.
- 단위테스트: 529 실측 tail 재현 fixture.

## 게이트 계획 (Opus 턴1: R3 분리)

- 라운드 A: R0+R1+R2 (정합성·상태 모델) → 리뷰 → 테스트
- 라운드 B: R3+R4+R5 (신규 표면·문서) → 리뷰 → 테스트(라이브 다회차 도그푸드 — 회고 시나리오 재현: Codex 3턴 합성)

## 구현 게이트 (턴2 합의 — 라운드 A 계약)

- **G1** 셸 보간 가변값 전수 allowlist 재점검 (신규 훅 인자는 고정 문자열로 확인됨).
- **G2·G3** ✅ 해소 — R0.1b PoC 표 참조.
- **G4** post-send stale 레이스: send 직후 첫 cliState 스냅샷만으로 완료 선언 금지 — 완료 판정은 busy 국면 관측(busy→종료 전이) **또는** 유효 파일(EOF)/DONE 신호 증거 필요. turn/wait 폴링 루프에 busySeen 플래그.
- **G5** 사다리 step1(command=shell)은 중립 사실로 반환하고 툴별 매핑: wait_ready(런치 후 계약)→launch_failed, status→중립 노출.
- **G6** agent_blocked 표면 일관성: wait_ready에서 **종단**, send는 `{sent:false, reason:"blocked"}`, status/turn 동일 상태명, 모든 분기 exhaustive 처리.
- **G7** R1 fixture는 실 pane 캡처에서 추출(합성 금지). 호출자 분기 기준은 hooksWired가 아니라 per-call `signalSource`(+`rawCliState` 노출).
- **G8** (Codex 턴2) wait_ready/turn timeout 반환에 rawCliState·command·tail 필수 — stale busy 수동 복구 경로. busy는 timeout까지 ready로 자동 강등 금지.

## 리스크

| 리스크 | 대응 |
|---|---|
| purplemux 버전에 따라 cliState 어휘 변동 | 열린 집합 + 미지원값 폴백 + `signalSource` 노출 |
| hooks.json/launcher 부재 환경 | `hooksWired:false` + 기존 프로파일 폴백 (변화 없음) |
| launcher가 우리 옵션(model/effort) 미수용 | launcher 우선, 미지원 옵션은 bootstrapHint로 (v2 §6 원칙 재사용) |
| 마커 단축發 drift 재발 | 단일 소스 + roundtrip 테스트가 이미 강제 (v2.1 자산) |
| ready-for-review/notification 의미 오해석 | agent_blocked로 중립 반환 + tail 동봉 — 해석은 LLM 몫 (§0.1 경계) |
