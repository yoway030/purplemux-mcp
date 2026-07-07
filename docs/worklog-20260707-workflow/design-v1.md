# purplemux-mcp 에이전트 툴 v1 설계 (합의 초안)

작성: 메인 오케스트레이터(Claude Fable 5). 입력: `pmux-agent-workflow.md` + 1단계 3-LLM 합의(Fable/Opus 4.8/Codex gpt-5.5).

## 0. 합의된 원칙

1. **무상태(stateless)**. 이 서버는 포트/토큰조차 호출마다 다시 읽는 얇은 래퍼다. agent registry·turn 카운터를 서버 메모리에 두지 않는다. `agentId`/`turn`/`requestId`는 전부 **호출자 파라미터**다. (Opus 주장 채택, Codex 리스크#3 "stale state"와도 정합)
2. **HTTP-only 유지**. 셸아웃 없음. 모든 신규 툴은 기존 HTTP 엔드포인트(`create tab`, `send`, `result`, `status`)의 조합이다.
3. **인젝션 방어**. CLI 명령 조립에 들어가는 모든 입력은 zod enum 또는 엄격한 정규식 allowlist로 제한한다. 위험 모드(`danger-full-access`, `bypassPermissions`)는 v1 enum에서 **아예 제외**한다(확인 UI가 없는 레이어이므로 지원하지 않는 것이 확인 요구보다 안전).
4. **결정론적 sentinel 우선, 휴리스틱은 override 가능**. readiness 패턴·에러 패턴은 기본값 내장 + 파라미터로 override 가능(CLI 버전차 흡수).
5. **결정론 우선 (사용자 지시)**. 코드로 결정론적으로 판정할 수 있는 것은 전부 MCP 레이어가 처리한다 — 명령 조립, readiness 분류, 폴링 루프, 마커/파일 회수, 입력 전 검증, 경로 조립. 오케스트레이터 LLM은 **애매한 부분만** 메꾼다: 프롬프트 내용 작성, `tail`을 보고 내리는 예외 판단, 회귀/진행 결정. 툴 반환값은 LLM이 재해석할 필요 없는 구조화된 판정(`state`/`status`/`reason`)이어야 한다.
6. **D 제외 근거 정정**(Opus): 구조화 출력 파일 회수는 `fs.readFile`로 HTTP-only 위배 없이 가능하다(screenshot `savePath`가 이미 fs 사용). 제외 사유는 "원칙 위배"가 아니라 **v1 범위 축소**다. capability 자동 탐지(셸아웃), preset 시스템, 별도 runner도 v1 제외.

## 1. 실측 근거 (이 워크플로 자체의 도그푸딩에서 확보)

- `codex --no-alt-screen`: tmux 스크롤백 완전 보존 → 긴 응답 회수 안정.
- Claude Code TUI: 자체 리드로우로 tmux 히스토리가 ~24줄로 유지됨 → **화면을 넘는 응답은 회수 불가**. 대응: ① sentinel 지시에 응답 길이 제한을 표준 포함 ② `capture`가 `missing/partial`을 구분 반환해 호출자가 압축 재요청(재-emit) 패턴을 쓰게 함.
- `pmux_send_input` 자동 제출은 멀티라인 bracketed paste에서 정상 동작(bootstrap 프롬프트 전송 검증됨).
- CLI 버전 실측: codex 0.142.5 (`-m`, `-s`, `--no-alt-screen`, `-c model_reasoning_effort=`), claude 2.1.201 (`--model`, `--permission-mode`).

## 2. 신규 툴 4개 (16 → 20)

기존 저수준 툴은 그대로 두고, 그 조합인 고수준 "agent" 툴을 추가한다. 세션 수명 정책(문서 §10)은 툴 계약(설명)에 명시: **작업이 끝날 때까지 세션을 유지하고, 종료는 `pmux_close_tab`으로** (별도 close 툴은 만들지 않는다 — 순수 중복).

### 2.1 `pmux_agent_start`

terminal 탭 생성 → 셸 readiness 확인(1회 capture) → 프로파일로 조립한 interactive CLI 명령 전송. **ready 대기는 하지 않는다**(비차단, `pmux_agent_wait_ready`로 분리 — 문서 §2 부팅 단계 분리).

입력:
- `workspaceId` (필수), `name?`
- `provider`: `"codex" | "claude"` (enum)
- `model?`: `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$` (allowlist 정규식, 공백·메타문자 불가)
- `effort?`: `low|medium|high|xhigh` (enum) — codex는 `-c model_reasoning_effort=`, claude는 CLI 미지원이므로 **명령에 넣지 않고 응답의 `bootstrapHint`로 반환**(문서 §6: 미지원 옵션은 bootstrap prompt로)
- `sandbox?` (codex 전용): `read-only|workspace-write` (enum, 기본 read-only)
- `permissionMode?` (claude 전용): `plan|manual|acceptEdits|dontAsk|auto` (enum, 기본 plan) — claude 2.1.201 실측값(`--help` choices) 기준, `default`는 존재하지 않음(→`manual`), `bypassPermissions`는 의도적으로 제외

명령 프로파일(고정):
- codex: `codex --no-alt-screen -s <sandbox>[ -m <model>][ -c model_reasoning_effort=<effort>]`
- claude: `claude[ --model <model>] --permission-mode <mode>`

반환: `{ tabId, sessionName, command, provider, bootstrapHint? }`
에러: 셸 프롬프트가 안 보이면(탭 부팅 지연) `state:"not_shell_ready"`로 실패 반환(재시도 안내).

### 2.2 `pmux_agent_wait_ready`

capture 폴링으로 readiness 분류. 문서 §3의 상태 집합을 다음으로 사상(`agent_idle`은 `agent_ready`의 alias — v1은 구분하지 않음을 명시, Codex 지적 반영):

- `agent_ready` — provider별 입력 프롬프트 패턴 검출 (codex: `›` 입력행+상태줄, claude: `❯` 입력행)
- `agent_busy` — busy 패턴 검출 (기본 `esc to interrupt` — codex·claude TUI 공통 실측). wait_ready는 계속 폴링, send는 거부 (4단계 리뷰 반영)
- `agent_starting` — 런치 명령 에코는 있으나 프롬프트/실패 패턴 아직 없음
- `launch_failed` — 명령 에코 후 **셸 프롬프트 복귀** 또는 `command not found`/`unexpected argument` 등 에러 패턴 (Opus: 조용한 부팅 실패 구분)
- `exited` — `tab_status.alive === false`
- `timeout` — 시한 내 판정 불가

**분류 순서(4단계 리뷰 반영 — stale 글리프 오판 방지)**: ① errorPattern → ② 셸 프롬프트 복귀(마지막 비공백 줄) → ③ busyPattern → ④ readyPattern — 단 ready/busy는 **pane 전체가 아닌 tail(마지막 ~15줄)**에서만 평가 → ⑤ 그 외 `agent_starting`. `busyPattern?` override 파라미터도 ready/error와 동일 규격으로 제공.

입력: `workspaceId`, `tabId`, `provider`, `timeoutMs?`(기본 30000, 최대 180000), `pollMs?`(기본 1500, 최소 500), `readyPattern?`/`errorPattern?`(정규식 문자열 override)
반환: `{ state, elapsedMs, polls, tail }` — `tail`은 마지막 ~15줄 (Opus: raw_ref 진단용)

### 2.3 `pmux_agent_send`

입력 전 상태 검증(문서 §9) → sentinel 지시 자동 주입 → 전송.

입력: `workspaceId`, `tabId`, **`provider`(필수 — 4단계 리뷰에서 누락 발견: 이것 없이는 ready 검사 기본 패턴을 정할 수 없음)**, `agentId`(`^[a-z0-9][a-z0-9_-]{0,31}$`), `turn`(정수 ≥0; 0=bootstrap 권장), `prompt`, `requestId?`(같은 정규식, Codex 반영), `maxResponseLines?`(기본 40 — Claude TUI 히스토리 실측 반영), `expectPrevTurnEnd?`(정수; 지정 시 이전 턴 END 마커 존재를 검증 — **stripAnsi 적용 후 매칭, extractMarkerBlock과 동일 경로**), `skipReadyCheck?`, `readyPattern?`, `errorPattern?`, `busyPattern?`

동작:
1. capture 1회 → 검증: 프롬프트 패턴 존재(ready), 이전 턴 END 존재(`expectPrevTurnEnd` 지정 시), 에러 패턴 부재. 실패 시 **전송하지 않고** `{ sent:false, reason, tail }` 반환 (Opus: 검증 결과 구조화 반환).
2. 프롬프트 뒤에 표준 sentinel footer 주입:
   ```
   응답은 반드시 <<<PMUX_BEGIN agent=<id> turn=<n>[ req=<rid>]>>> 와 <<<PMUX_END ...>>> 사이에만, <maxResponseLines>줄 이내로 작성하세요.
   ```
3. `send` 호출. 반환 `{ sent:true, marker:{agentId,turn,requestId?}, validation:{ready:true, prevTurnEnd?:true} }`

bootstrap 표준화(문서 §12, Codex 반영): 별도 툴 대신 **turn=0 send가 bootstrap**이다. 역할/제약 본문은 호출자(오케스트레이터 LLM)가 작성하고, 이 툴은 marker+길이 제한 지시를 표준 주입한다. 권장 bootstrap 필드 목록은 툴 설명에 문서화.

### 2.4 `pmux_agent_capture`

pane에서 지정 마커 쌍만 추출(문서 §7·§8).

입력: `workspaceId`, `tabId`, `agentId`, `turn`, `requestId?`
동작: capture → `agentId`+`turn`(+`requestId`)이 일치하는 **마지막** BEGIN/END 쌍 추출. 프롬프트 에코에 포함된 마커 지시문(같은 줄에 "사이에만" 등 지시 텍스트가 있는 경우/BEGIN·END가 한 줄에 함께 에코된 경우)은 제외 휴리스틱 적용.
반환:
- `{ status:"complete", content }`
- `{ status:"partial", contentSoFar, tail }` — BEGIN만 존재(생성 중). **이 상태에서 다음 send 금지**(문서 §8 증분 회수)
- `{ status:"missing", tail }` — 마커 없음. Claude TUI 히스토리 유실 가능성 포함 → 호출자는 "N줄 이내 재전송(turn 접미사 b/c…)" 패턴 사용

### 2.5 파일 기반 회수 (v1 승격 — 사용자 지시 + 운영 실증)

운영 중 pane 회수 실패 2건(Claude TUI 히스토리 ~24줄 유실, 지시문 에코 오탐)을 실측했고, 사용자가 "pane은 상태 확인만, 긴 결과는 파일" 하이브리드를 지시했다. 문서 §8의 회수 우선순위 1위(구조화 파일)를 v1에 포함한다.

- **`pmux_agent_send`에 `fileOutput?: boolean` 추가** (기본 false). true면 sentinel footer에 지시 추가: "응답 전문을 `<workspaceDir>/.pmux-agents/<agentId>/turn-<turn>.md` 에 저장하고(1줄차 상태), pane 마커 블록에는 ≤10줄 요약만". `workspaceDir`은 workspaces API의 해당 워크스페이스 첫 directory.
- **`pmux_agent_capture` 회수 순서**: ① 규약 경로 파일이 존재하면 `{status:"complete", content, source:"file"}` ② 없으면 기존 pane 마커 추출(`source:"pane"`). pane은 상태 판단(busy/partial) 용도로 유지.
- **경로 안전**: 파일 경로는 검증된 `agentId`(ID_RE)·`turn`(정수)·API가 준 workspaceDir로만 조립. 호출자 임의 경로 입력 없음. 읽기 전에 `realpath`가 workspaceDir 하위인지 확인.
- **한계 명시**: 에이전트가 쓰기 권한이 없으면(plan/read-only) 파일이 안 생김 → pane 폴백이 정상 동작. fs 읽기는 MCP 서버가 purplemux와 같은 호스트에서 돈다는 기존 전제(README) 안에서만 유효.
- `.pmux-agents/`는 저장소 `.gitignore`에 추가 권장.

## 3. 구현 구조

```
src/profiles.ts   # provider enum, 명령 조립, readiness/에러 기본 패턴 (신규)
src/pane.ts       # sentinel 추출, readiness 분류 순수 함수 (신규, 단위테스트 대상)
src/agents.ts     # 신규 툴 4개 등록 (신규)
src/schemas.ts    # zod shape 추가
src/tools.ts      # registerAll에서 agents.ts 호출 (기존 16개 불변)
test/unit.mjs     # pane.ts·profiles.ts 순수 함수 단위테스트 (신규)
test/e2e.mjs      # 라이브 케이스 추가: terminal 탭에서 마커를 echo하는 가짜 에이전트로 send/capture 라운드트립, wait_ready launch_failed 케이스(존재하지 않는 명령)
```

- 순수 함수(파싱·분류·조립)를 `pane.ts`/`profiles.ts`로 분리해 라이브 서버 없이 검증 가능하게 한다.
- e2e에서 실제 codex/claude 부팅 케이스는 **옵션**(환경변수 게이트, CI/CLI 부재 시 skip).

## 4. 리스크 대응표 (1단계 합의 리스크 → 설계 반영)

| 리스크 | 반영 |
|---|---|
| 명령 조립 인젝션 (Codex#1) | 모든 조립 입력 enum/정규식 allowlist, 자유문자열은 명령에 절대 미포함 |
| readiness 휴리스틱 오판 (Codex#2, Opus#2) | sentinel 우선 설계 + 패턴 override 파라미터 + `tail` 반환으로 호출자 판단 여지 |
| 서버 상태 수명 (Codex#3, Opus#1) | 완전 무상태 — 서버 측 registry/turn 카운터 없음 |
| 조용한 부팅 실패 (Opus#3) | `launch_failed` 상태 + `tail` 진단 |
| Claude TUI 히스토리 유실 (실측) | `maxResponseLines` 기본 40 + `missing` 상태 + 재-emit 패턴 문서화 |

## 4.5 합의 부속 — 2단계 non-blocking 반영 지침 (구현 필수)

3-LLM 합의(턴 2, 양측 APPROVE)에서 나온 non-blocking 6건. 코드 작업 단계에서 반영한다.

1. (Opus) `pane.ts` 단위테스트에 **"프롬프트 지시문 에코 + 실제 마커 동시 존재"** 케이스를 명시적으로 포함.
2. (Opus) `errorPattern` override를 `pmux_agent_send`에도 추가 — `readyPattern`과 대칭.
3. (Opus) `partial` 상태에서 다음 send 금지는 **호출자 계약**(무상태 서버는 강제 불가)임을 send/capture 툴 설명에 명시.
4. (Codex) permissionMode enum은 claude 2.1.201 실측(`acceptEdits|auto|bypassPermissions|manual|dontAsk|plan`)에 맞춰 `plan|manual|acceptEdits|dontAsk|auto`로 확정, 툴 설명에 버전 기준 명시.
5. (Codex) 패턴 override는 ReDoS 방지: 길이 제한(≤200자) + `new RegExp` 컴파일 실패 시 명확한 ToolError.
6. (Codex) `pmux_agent_start`의 `command` 반환은 유지하되, 조립 입력이 전부 allowlist이므로 현재 민감정보 없음 — 향후 인자 추가 시 redaction 검토를 주석으로 남김.

## 4.6 모듈 인터페이스 계약 (병렬 작업용 — 두 워커 공통 준수)

worker-sonnet이 아래 시그니처를 **정확히** export하고, worker-codex는 이를 import한다고 가정하고 작성한다.

```ts
// src/profiles.ts (worker-sonnet)
export type Provider = "codex" | "claude";
export type Effort = "low" | "medium" | "high" | "xhigh";
export type Sandbox = "read-only" | "workspace-write";
export type PermissionMode = "plan" | "manual" | "acceptEdits" | "dontAsk" | "auto";
export const ID_RE: RegExp;     // ^[a-z0-9][a-z0-9_-]{0,31}$
export const MODEL_RE: RegExp;  // ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$
export interface AgentCommandOpts {
  provider: Provider; model?: string; effort?: Effort;
  sandbox?: Sandbox; permissionMode?: PermissionMode;
}
// 검증 실패 시 ToolError(src/errors.js) throw. effort는 claude 명령에 미포함 → bootstrapHint로.
export function buildAgentCommand(opts: AgentCommandOpts): { command: string; bootstrapHint?: string };
export function defaultReadyPattern(p: Provider): RegExp;
export function defaultErrorPattern(p: Provider): RegExp;
// 사용자 제공 패턴 컴파일: 길이 ≤200, 컴파일 실패 시 ToolError (§4.5-5)
export function compileUserPattern(src: string, field: string): RegExp;

// src/pane.ts (worker-sonnet) — 전부 순수 함수
export function stripAnsi(s: string): string;
export function tailLines(s: string, n: number): string;
export function makeMarkers(o: { agentId: string; turn: number; requestId?: string }): { begin: string; end: string };
// begin = `<<<PMUX_BEGIN agent=${agentId} turn=${turn}${requestId ? ` req=${requestId}` : ""}>>>` / END 동형
export function buildSentinelFooter(o: { agentId: string; turn: number; requestId?: string; maxResponseLines: number }): string;
export type MarkerResult =
  | { status: "complete"; content: string }
  | { status: "partial"; contentSoFar: string }
  | { status: "missing" };
// 마지막 유효 쌍 추출. 마커는 strip+trim 후 "그 줄에 마커만 단독"일 때만 인정(프롬프트 에코 제외 휴리스틱).
export function extractMarkerBlock(o: { pane: string; agentId: string; turn: number; requestId?: string }): MarkerResult;
export type ReadinessState = "agent_ready" | "agent_busy" | "agent_starting" | "launch_failed";
// 분류 순서: error → 셸복귀(마지막 줄) → busy(tail) → ready(tail) → starting (§2.2)
export function classifyReadiness(o: { pane: string; provider: Provider; readyPattern?: RegExp; errorPattern?: RegExp; busyPattern?: RegExp }): { state: ReadinessState; reason?: string };
export function defaultBusyPattern(p: Provider): RegExp; // 기본 /esc to interrupt/ (양 TUI 실측)
```

worker-codex 담당 파일에서 위 함수만 사용해 §2의 툴 4개를 구현한다. `exited`/`timeout` 판정(§2.2)은 `agents.ts`의 폴링 루프에서 `tab_status`·시한으로 처리.

## 5. v1 제외 (기록)

- CLI capability 자동 탐지 — 셸아웃 필요. 프로파일은 실측 버전(codex 0.142.5 / claude 2.1.201) 기준 고정, override 파라미터로 버전차 흡수.
- 구조화 출력 파일 회수 — **v1 범위 축소** (HTTP-only 위배 아님). v2 후보 1순위.
- preset 시스템 / `pmux-agent-runner` 래퍼 — 정책 엔진 성격, MCP 레이어 밖.
