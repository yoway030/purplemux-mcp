# purplemux-mcp 에이전트 툴 설계 v2 (전면 재설계)

작성: 메인 오케스트레이터(Fable 5). v1(design-v1.md)을 대체한다.
회귀 사유: 사용자 지시 2건(결정론 우선, pane=상태/파일=내용)이 아키텍처 수준이라 패치가 아닌 재설계가 타당.
입력: pmux-agent-workflow.md, v1 합의 이력(턴1~3), 운영 실측 교훈, 턴4 리뷰.

## 0. 설계 원칙 (우선순위 순)

1. **결정론 우선.** 코드로 판정 가능한 것은 전부 MCP 레이어가 판정한다 — 명령 조립, 상태 분류, 폴링, 회수, 검증, 경로 조립. 툴 반환은 LLM이 재해석할 필요 없는 구조화 판정(`state`/`status`/`reason`/`source`)이다. 오케스트레이터 LLM은 애매한 부분만 메꾼다: 프롬프트 내용, `tail` 기반 예외 판단, 회귀/진행 결정. (경계 명시 — Opus 턴4: readiness "분류"는 정규식 기반 best-effort 휴리스틱이며 순수 결정론이 아니다. 휴리스틱이 애매하면 구조화 판정 + `tail`을 함께 반환해 최종 예외판단을 LLM에 넘긴다.)
2. **역할 분리: pane은 상태 신호, 파일은 내용.** pane 캡처는 readiness/busy/완료신호 판정에만 쓰고, 응답 본문은 파일로 회수한다. pane 본문 회수(sentinel 블록)는 쓰기 불가 에이전트를 위한 폴백이다.
3. **무상태.** agentId/turn/requestId는 호출자 소유. 서버 메모리에 registry·카운터 없음.
4. **HTTP + 로컬 fs 읽기.** 셸아웃 없음. purplemux HTTP API 조합 + (같은 호스트 전제 하) 규약 경로의 파일 **읽기**만. 파일 쓰기는 서브에이전트가 한다.
5. **인젝션 방어.** 명령·경로에 들어가는 모든 입력은 enum/정규식 allowlist. 위험 모드는 enum에서 제외. 패턴 override는 길이 ≤200 + 컴파일 실패 시 ToolError.

## 1. 실측 근거 (v1 운영에서 확보 — 설계를 강제하는 사실들)

| 사실 | 결과 설계 |
|---|---|
| Claude Code TUI는 tmux 히스토리를 ~24줄로 리셋 | 본문은 pane에 남길 수 없다 → 파일 우선(원칙 2), pane 신호는 **1줄** |
| codex `--no-alt-screen`은 스크롤백 보존 | provider 프로파일 근거 |
| 프롬프트 지시문 에코가 감시/추출을 오탐시킴 | 마커·신호줄은 "strip+trim 후 단독 줄"만 인정 |
| busy 중에도 입력 프롬프트 글리프(`›`/`❯`)가 렌더됨 | ready만으론 busy 판별 불가 → busy 패턴(`esc to interrupt`, 양 TUI 공통) 별도 검사 |
| stale 글리프가 스크롤백에 잔존 | 분류 순서 고정: error(tail) → 셸복귀 → busy(tail) → ready(tail) |
| 다회차 협업에서 에이전트가 에러 문자열(`command not found` 등)을 본문에 인용 → 스크롤백 잔존 (Opus 턴4 B1) | **errorPattern도 tail 15줄로 제한.** 진짜 런치 실패는 ①명령 직후 폴링이라 error가 tail에 있고 ②셸복귀 검사가 독립적으로 잡는다 |
| 파일 mid-write 중 capture 유입 시 truncated read (Opus 턴4 B2) | 파일 1줄차 상태(`complete\|blocked`)를 회수 게이트로 소비 — 유효 상태줄 없으면 complete로 반환하지 않음 |
| `claude --resume`/`codex resume`로 권한 변경 재부팅 가능 | 세션 수명 계약에 "권한 변경은 재부팅+resume" 명시 |
| CLI 실측: codex 0.142.5, claude 2.1.201 | 프로파일·enum 고정값 기준 |

## 2. 턴 라이프사이클 (결정론적 상태 기계)

```
[부팅]  start ──▶ wait_ready ──▶ agent_ready │ launch_failed │ exited │ timeout
[턴 N]  send(turn=N) ──▶ (에이전트 작업) ──▶ status/capture 폴링
                                             ├─ complete  (파일 or pane 블록 회수)
                                             ├─ working   (busy 신호 지속)
                                             ├─ missing   (신호·파일·블록 없음)
                                             └─ inconsistent (신호는 있는데 파일 없음 등)
[종료]  close_tab (기존 툴; 세션은 작업 종료까지 유지)
```

코드가 판정: 위 상태 전부. 오케스트레이터가 판정: `missing`/`inconsistent`/`timeout`에서 무엇을 할지(재요청·압축 재전송·회귀).

## 3. 통신 프로토콜 v2

### 3.1 완료 신호 (pane, 1줄)

에이전트는 턴을 마치면 pane에 **정확히 1줄**을 출력한다:

```
<<<PMUX_DONE agent=<agentId> turn=<n> req=<requestId> status=complete|blocked>>>
```

- 1줄이므로 좁은 pane·24줄 히스토리에서도 생존. strip+trim 후 단독 줄만 인정(에코 방어).
- **req 필드는 fileOutput 경로에서 필수** — §4.4/§4.5의 req 게이트 파서와 일치 (Codex 턴6 blocking 반영). fileOutput=false(pane 블록 폴백)에서는 req 생략 가능.
- `status=blocked`: 에이전트가 과제를 수행할 수 없음을 스스로 신고(내용은 파일에).

### 3.2 본문 (파일) — v2.1: 신원·커밋 이중 게이트

```
<workspaceDir>/.pmux-agents/<agentId>/turn-<n>.md
```

파일 형식 (턴5 BN1·BN4 반영):
```
line 1  : status=complete|blocked req=<requestId>     ← 신원 게이트 (stale 세션 파일 차단)
line 2~ : 본문
last    : <<<PMUX_EOF req=<requestId>>>>              ← 커밋 게이트 (mid-write 차단)
```

- **requestId 필수화(fileOutput 경로)**: `pmux_agent_send`가 requestId 미지정 시 **자동 생성**해 반환값으로 돌려준다(무상태 유지 — 서버는 기억하지 않고 호출자가 이후 capture에 전달). turn은 세션마다 재시작하므로 이전 세션의 `turn-1.md`와의 충돌은 정상 케이스다 — capture는 **1줄차 req가 일치할 때만** 그 파일을 인정한다 (Opus 턴5 BN1).
- **EOF 커밋 마커**: 1줄차 상태줄은 "먼저 쓰고 본문을 이어 쓰는" 순차 기록에서 커밋 게이트가 못 된다(Codex 턴5). capture는 **마지막 줄 `PMUX_EOF`(req 일치)까지 확인**해야 complete로 인정. tmp→rename 권장 문구는 유지하되 강제하지 않는다 — EOF 마커가 어느 쓰기 전략에서든 검증 가능한 커밋 조건.
- **절대경로 지시 (Opus 턴5 BN2)**: footer의 저장 경로는 send가 workspaces API로 `workspaceDir`을 해석한 뒤 **절대경로로 치환**해 지시한다(에이전트 cwd에 의존하지 않음 — 서버 읽기 경로와 동일 문자열 보장).
- `workspaceDir` = 해당 워크스페이스의 첫 `directories[]`. 호출자 임의 경로 입력은 **받지 않는다**. 읽기 전 `realpath`가 `workspaceDir` 하위인지 확인(심링크 탈출 방어). 파일 부재는 격리 위반과 구분해 정상 폴백 처리 (Opus 턴5 N3).
- **turn은 정수 전용**: 재요청(re-emit)은 새 turn 번호로. (pane 블록 폴백에서만 접미사 관행 허용)
- 에이전트 쓰기 실패 대비: 파일이 없으면 sentinel pane 블록(3.3) 폴백.
- 저장소에는 `.pmux-agents/`를 `.gitignore`에 추가.

### 3.3 pane 블록 폴백 (쓰기 불가 에이전트용)

v1의 `<<<PMUX_BEGIN ...>>> 본문 <<<PMUX_END ...>>>` 블록. `fileOutput=false`일 때의 기본 경로이자, 파일 부재 시 회수 폴백.

### 3.4 footer 자동 주입 (send가 조립 — 에이전트가 규약을 알 필요 없음)

`fileOutput=true`(기본) — **에코 방어를 위해 완성형 마커 문자열을 지시문에 절대 포함하지 않는다** (Codex 턴5 / Opus 턴5 N1). DONE 신호와 EOF 마커는 **분할 문자열 + 조립 지시**로 전달:
```
[응답 규약] 응답을 모두 완성한 뒤 <절대경로 workspaceDir>/.pmux-agents/<agentId>/turn-<n>.md 에 저장하세요.
- 1줄차: status=complete req=<rid>   (수행 불가면 complete 대신 blocked)
- 2줄부터 본문. (가능하면 .tmp에 쓰고 rename)
- 마지막 줄: "<<<PMUX_" 뒤에 "EOF req={rid}>>>" 를 이어붙인 한 줄   ← 조립 결과는 정확히 <<<PMUX_ + EOF req={rid} + '>' 3개
저장이 끝난 후 화면에는 "<<<PMUX_" 뒤에 "DONE agent={agentId} turn={n} req={rid} status=complete>>>" 를 이어붙인 한 줄만 출력하세요.
```
(표기 주의: 플레이스홀더는 `{x}` — 꺾쇠 `<x>`를 쓰면 마커의 `>>>`와 시각적으로 충돌해 `>` 개수 오독을 유발한다. 실제 footer 조립 코드는 실값을 치환하며, **조립 지시대로 만든 파일/신호가 파서를 통과하는지의 왕복(roundtrip) 단위테스트를 필수**로 한다.)

→ pane 에코에는 완전한 `<<<PMUX_DONE ...>>>`/`<<<PMUX_EOF ...>>>` 문자열이 존재할 수 없으므로, 단독 줄 규칙과 결합하면 신호 오탐이 결정론적으로 차단된다.
`fileOutput=false`: v1 footer(BEGIN/END 블록 + maxResponseLines 제한). 이 경로의 BEGIN/END 지시도 동일한 분할 문자열 방식으로 전환한다.

## 4. 툴 (신규 5개, 16 → 21)

### 4.1 `pmux_agent_start` — v1 유지

terminal 탭 생성 → **셸 readiness 유계 폴링**(기본 5000ms, 300ms 간격 — 라이브 테스트 실측: 갓 생성된 탭은 셸 프롬프트가 그려지기까지 수백 ms 걸려 1회 캡처는 상시 조기 실패) → 프로파일 명령 전송. 에이전트 부팅 대기는 여전히 하지 않음(비차단, wait_ready 몫). `shellTimeoutMs?` 파라미터(≤30000). 시한 내 셸 미확인 시에만 `not_shell_ready`(+`tail`) — 이때 탭은 생성된 상태이므로 반환에 `command`를 포함해 호출자가 `pmux_send_input`으로 수동 재개할 수 있게 한다. 주의: `wait_ready`의 `launch_failed`("셸 복귀") 판정은 **명령 전송 성공 이후에만 유의미**(무상태 서버는 미전송 유휴 셸과 구분 불가) — start가 성공 반환한 뒤에 호출하는 것이 계약.
입력: `workspaceId`, `name?`, `provider`(enum), `model?`(MODEL_RE), `effort?`(enum; claude는 bootstrapHint로), `sandbox?`(codex enum), `permissionMode?`(claude enum, `bypassPermissions` 제외, 2.1.201 기준 `plan|manual|acceptEdits|dontAsk|auto`)
반환: `{ tabId, sessionName, command, provider, bootstrapHint?, recommendedFileOutput }` / 셸 미준비 시 `{ state:"not_shell_ready", tabId, command, tail }`

`recommendedFileOutput`(라이브 테스트 실측 반영): **fileOutput 기본 true × sandbox 기본 read-only는 기본값끼리 데드락** — 에이전트가 규약 파일을 쓰려다 승인 프롬프트/거부에 걸림. start는 sandbox/permissionMode를 아는 유일한 지점이므로 결정론적 힌트를 반환한다: codex는 `sandbox !== "read-only"`, claude는 `permissionMode ∉ {plan}`. 호출자는 이 값이 false면 send에 `fileOutput:false`를 쓰는 것이 계약(send 설명에도 명시).

### 4.2 `pmux_agent_wait_ready` — v1 유지 (busy 포함)

폴링 분류: `agent_ready | agent_busy(계속 폴링) | agent_starting(계속) | launch_failed | exited | timeout`.
분류 순서(§1, Opus 턴4 B1 반영): **error(tail 15)** → 셸복귀(마지막 비공백 줄) → busy(tail 15) → ready(tail 15) → starting. errorPattern을 전체 pane에 적용하면 다회차 협업에서 본문에 인용된 에러 문자열이 영구 오탐을 만든다 — 4개 패턴 검사 전부 tail 기준으로 통일.
입력: `workspaceId`, `tabId`, `provider`, `timeoutMs?`(기본 30000, ≤180000), `pollMs?`(기본 1500, ≥500), `readyPattern?`/`errorPattern?`/`busyPattern?`(≤200자)
반환: `{ state, elapsedMs, polls, tail }`

### 4.3 `pmux_agent_send`

입력 전 검증 → footer 주입 → 전송. **provider 필수**(v1 리뷰 blocking 교훈).
입력: `workspaceId`, `tabId`, `provider`, `agentId`(ID_RE), `turn`(≥0; 0=bootstrap), `prompt`, `requestId?`, `fileOutput?`(기본 **true**), `maxResponseLines?`(기본 40, fileOutput=false일 때만 의미), `expectPrevTurnEnd?`(stripAnsi 후 매칭 — DONE 신호 또는 END 마커 중 하나라도 있으면 인정), `skipReadyCheck?`, `readyPattern?`/`errorPattern?`/`busyPattern?`
검증 실패 시 전송 없이 `{ sent:false, reason:"not_ready"|"busy"|"launch_failed"|"missing_prev_turn_end", tail }`.
성공 시 `{ sent:true, marker:{ agentId, turn, requestId }, expectedReportFile? }` — fileOutput=true면 requestId 미지정 시 서버가 **자동 생성해 여기로 반환**(호출자가 capture에 그대로 전달; 서버는 기억하지 않음 — 무상태 유지). `expectedReportFile`은 footer에 치환된 절대경로.
주의: partial/working 중 재전송 금지는 **호출자 계약**(무상태 서버는 강제 불가) — 설명에 명시.

### 4.4 `pmux_agent_status` (신규) — 무대기 상태 스냅샷

"pane은 상태 확인용"의 결정론 프리미티브. 1회 캡처+1회 tab_status+파일 stat으로:
```
{
  alive: boolean,
  readiness: { state, reason? },          // §4.2와 동일 분류기
  doneSignal: { found: boolean, status? } // 지정 agentId/turn/req의 PMUX_DONE 신호줄 (마지막 매치)
  reportFile: {                           // 규약 경로 검사 (fs) — Opus 턴5 N2 반영
    path, exists,
    statusLine?: "complete"|"blocked"|"invalid",  // 1줄차 파싱 결과
    reqMatch?: boolean, eofPresent?: boolean, bytes?
  },
  tail: string                            // 마지막 15줄 (애매할 때 LLM 판단용)
}
```
입력: `workspaceId`, `tabId`, `provider`, `agentId?`, `turn?`(agentId·turn 없으면 readiness만), 패턴 override 3종.

### 4.5 `pmux_agent_capture` — 결정론적 회수 사다리

입력: `workspaceId`, `tabId`, `agentId`, `turn`, `requestId?`
입력: `workspaceId`, `tabId`, `agentId`, `turn`, `requestId?` — 스키마상 optional(pane 블록 폴백은 req 없이 성립), 단 **파일 경로 회수는 requestId 없이는 시도하지 않음**(런타임 규칙 + 설명 명시. Opus 턴6 비차단 3)
판정 사다리(순서 고정 — "유효 파일" = 존재 + 1줄차 `status=<s> req=<rid>` 파싱·req 일치 + **최종 비공백 줄**이 `PMUX_EOF`·req 일치(본문 중간 인용 방어, content는 2줄~최종 EOF 직전. Opus 턴6 비차단 2)):
1. 유효 파일 → `{ status:<1줄차 상태>, content:<2줄~EOF 직전>, source:"file", doneSignal:boolean }` (신호가 히스토리에서 밀렸어도 유효 파일이 진실)
2. 파일 존재하나 무효(1줄차 파싱 실패 / req 불일치 / EOF 부재) → `{ status:"working", reason:"file_invalid_or_midwrite"|"stale_file_req_mismatch", tail }` — req 불일치는 stale로 명시 구분 (Opus 턴5 BN1 / Codex 턴5 BN4)
3. `PMUX_DONE` 신호(req 일치) 존재 **and** 유효 파일 없음 → `{ status:"inconsistent", tail }` (오케스트레이터 판단 영역)
4. 파일 없음 → pane 블록 추출: complete → `{ status:"complete", content, source:"pane" }` / BEGIN만 → `{ status:"partial", contentSoFar, tail }`
5. 아무것도 없음 → busy 신호 있으면 `{ status:"working", tail }`, 없으면 `{ status:"missing", tail }`

## 5. 구현 구조 (v1 구현으로부터의 델타)

```
src/profiles.ts   [유지] — 변경 없음
src/pane.ts       [소폭] — parseDoneSignal(단독 줄·마지막 매치·req 게이트), classifyReadiness error도 tail 15로 (턴4 B1)
src/paths.ts      [신규] — 규약 경로 조립 + realpath 격리 검증(파일 부재≠격리 위반, 턴5 N3) + 리포트 파일 파서(1줄차 status/req + EOF 검증)
src/agents.ts     [중폭] — send footer v2.1(절대경로 치환·분할 문자열 지시·requestId 자동 생성·반환), capture 사다리 v2.1, status 툴, workspaceDir 해석
src/schemas.ts    [소폭] — provider(send)·fileOutput·requestId(capture 필수화)·status shape
test/unit.mjs     [추가] — DONE 신호(에코에 완전 마커 부재 검증 포함), 리포트 파일 파서(유효/1줄차 무효/req 불일치/EOF 부재), 경로 격리(탈출 시도 거부)
test/e2e.mjs      [추가] — 가짜 에이전트가 규약 파일(+EOF)+DONE 신호 생성 → capture source:"file" / stale req 파일 → working(stale) / EOF 없는 파일 → working
.gitignore        [1줄] — .pmux-agents/
```

v1에서 이미 구현·검증된 것(그대로 승계): 명령 조립+allowlist, readiness 분류기(순서·tail·busy), 마커 블록 추출(에코 방어), stripAnsi, ReDoS 가드, 무상태 원칙, 기존 16툴 불변.

## 5.1 모듈 인터페이스 계약 (병렬 작업용)

```ts
// src/pane.ts 추가분 (sworker)
// 단독 줄·마지막 매치. requestId 지정 시 req 일치 필수. 미지정 시 req 없는 신호만 매치(pane 블록 폴백용).
export function parseDoneSignal(o: { pane: string; agentId: string; turn: number; requestId?: string }):
  { found: boolean; status?: "complete" | "blocked" };
// classifyReadiness: errorPattern 평가를 tail 15로 변경(시그니처 불변, §4.2)

// src/paths.ts (sworker, 신규 — fs는 이 모듈에만)
export function agentReportPath(workspaceDir: string, agentId: string, turn: number): string;
//   ID_RE·정수 검증(실패 시 ToolError) 후 join(workspaceDir, ".pmux-agents", agentId, `turn-${turn}.md`)
export type ReportFileCheck =
  | { state: "missing" }
  | { state: "invalid"; reason: "status_line" | "req_mismatch" | "eof_missing" }
  | { state: "valid"; status: "complete" | "blocked"; content: string; bytes: number };
export function readReportFile(workspaceDir: string, agentId: string, turn: number, requestId: string): Promise<ReportFileCheck>;
//   realpath 격리(위반 시 ToolError), 부재=missing(§N3), 1줄차 `status=<s> req=<rid>` 파싱+req 일치,
//   최종 비공백 줄 EOF(req 일치), content=2줄~EOF 직전
export function makeFileFooter(o: { workspaceDir: string; agentId: string; turn: number; requestId: string }): string;
//   §3.4 fileOutput=true footer — 분할 문자열 지시. 반환 문자열에 완성형 <<<PMUX_DONE/EOF ...>>>가 절대 포함되지 않아야 함(단위테스트 대상)
```

worker-cworker(agents.ts)는 위 함수 + 기존 profiles/pane 함수만 사용. workspaceDir 해석(workspaces API→directories[0], 부재 시 ToolError)과 requestId 자동 생성(ID_RE 부합, 예: 소문자 hex 12자)은 agents.ts 몫.

## 6. 리스크와 한계 (명시)

| 리스크 | 대응 |
|---|---|
| 에이전트가 규약(파일 저장)을 안 지킴 | footer가 규약을 매 턴 주입 + capture 사다리의 pane 폴백 + `missing`/`inconsistent`는 오케스트레이터 판단으로 위임(원칙 1의 "애매한 부분") |
| 파일 mid-write 레이스 | 1줄차 상태줄이 커밋 게이트(사다리 1·2) + footer가 "완성 후 저장, 가능하면 tmp→rename" 지시 + DONE 신호는 보조 신호 |
| SHELL_PROMPT_RE(`[$#%]\s*$`) 오탐 — 본문 마지막 줄이 `%`/`#`/`$`로 끝나는 경우 (Opus 턴4 비차단) | 알려진 한계로 명시. TUI가 하단에 입력박스를 재그리므로 실제 마지막 줄이 본문인 경우는 드묾 — 오탐 시 `tail` 반환으로 LLM이 교정(원칙 1 경계) |
| MCP 서버와 purplemux가 다른 호스트 | 기존 전제(README) 유지. reportFile.exists=false로 자연 폴백 — 추가 처리 없음 |
| 읽기 전용 에이전트 | fileOutput=false로 pane 블록 사용(호출자 선택) |
| 신호줄 에코 | **분할 문자열 지시(§3.4)로 에코에 완전한 마커가 아예 존재하지 않음** + 단독 줄 규칙 + 마지막 매치만 인정 — 3중 방어 (턴5 BN3 해소) |
| 이전 세션 stale 파일 | requestId 신원 게이트(1줄차 req 일치) — capture가 `stale_file_req_mismatch`로 구조화 반환 (턴5 BN1 해소) |
| 순차 기록 mid-write | EOF 커밋 마커(마지막 줄, req 일치)가 쓰기 전략 무관 검증 조건 (턴5 BN4 해소) |

## 6.5 알려진 한계 (비차단, 명시)

- 동일 `agentId`+`turn`을 두 오케스트레이터가 동시에 쓰면 마지막 쓰기가 이기고 다른 쪽은 req 불일치로 `working`에 머묾 — 단일 오케스트레이터 전제(Opus 턴6 비차단 4).
- readiness 분류는 best-effort 휴리스틱(§0.1 경계). SHELL_PROMPT_RE 오탐 저확률 케이스는 §6 표 참조.

## 7. v1 제외 항목 (승계)

- CLI capability 자동 탐지(셸아웃) — 프로파일 고정 + 패턴 override로 흡수
- preset 시스템 / 별도 runner — MCP 레이어 밖(오케스트레이터 스킬/문서 영역)
- 서버측 세션 registry — 무상태 원칙 위배
