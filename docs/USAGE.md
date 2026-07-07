# purplemux-mcp — 기능 · 설치 · 사용법

[purplemux](https://github.com/subicura/purplemux)(subicura의 tmux + LLM 워크스페이스 매니저)를
**Claude Code / Codex에서 MCP 툴로 제어**하기 위한 서버다. purplemux CLI가 감싸고 있는
localhost HTTP API를 그대로 노출해, AI 에이전트가 워크스페이스·탭·터미널·브라우저를 직접 운전할 수 있다.

- 런타임: Node ≥ 20 + TypeScript, 공식 `@modelcontextprotocol/sdk`, **stdio** 전송
- 연결: `http://localhost:$PMUX_PORT` + `X-Pmux-Token` (포트/토큰은 `~/.purplemux/{port,cli-token}`에서 **호출마다** 자동 로드)
- CLI로 셸아웃하지 않고 HTTP API를 직접 호출 (CLI가 버리는 응답 바디까지 복원)

---

## 1. 기능 (16개 툴)

### 터미널 / 탭 오케스트레이션 (headless에서도 동작)
| 툴 | 하는 일 |
|---|---|
| `pmux_list_workspaces` | 워크스페이스 목록 `{id,name,directories}` |
| `pmux_list_tabs` | 탭 목록 (workspaceId 생략 시 전체 워크스페이스) |
| `pmux_create_tab` | 탭 생성 — `panelType`: `terminal`/`claude-code`/`codex-cli`/`agent-sessions`/`web-browser`/`diff` (기본 terminal) |
| `pmux_get_tab` | 단일 탭 정보 |
| `pmux_send_input` | 탭에 텍스트 입력 — **서버가 Enter까지 자동 제출** (개행 추가 금지; trailing `\n` 1개는 자동 제거) |
| `pmux_tab_status` | 탭 상태 (`alive`, 실행 중 명령 등; 브라우저 탭은 `alive:false`가 정상) |
| `pmux_capture_pane` | 현재 pane 화면 스냅샷 `{content}` |
| `pmux_close_tab` | 탭 종료 — 실제 `{ok:boolean}` 바디 반환 |

### 브라우저 자동화 (`web-browser` 탭 · **Electron 런타임 필요**)
| 툴 | 하는 일 |
|---|---|
| `pmux_browser_url` | 현재 URL·타이틀 |
| `pmux_browser_screenshot` | 스크린샷 — 기본 MCP 이미지(PNG), `savePath` 지정 시 절대경로에 파일 저장(덮어쓰기 거부) |
| `pmux_browser_console` | 콘솔 로그 (최근 500개 링버퍼, `since`/`level` 필터) |
| `pmux_browser_network` | 네트워크 요청 목록 (`since`/`method`/`url`/`status` 필터) |
| `pmux_browser_network_body` | 특정 요청의 응답 바디 (requestId) |
| `pmux_browser_eval` | 페이지에서 JS 실행 (CDP, 10초 타임아웃) |

> headless(비 Electron) 환경에서 브라우저 툴은 **503**(hard, 재시도 무의미)을 반환한다.
> 방금 만든 `web-browser` 탭이 아직 `dom-ready` 전이면 **409 "not attached yet"**(transient, 잠시 후 재시도).

### 유틸
| 툴 | 하는 일 |
|---|---|
| `pmux_api_guide` | purplemux HTTP API 레퍼런스(markdown) |
| `pmux_connection_info` | 연결 진단 `{baseUrl?,portSource,tokenSource,hasToken}` — **토큰값은 절대 노출 안 함** |

---

## 2. 설치

### 사전 조건
1. **purplemux 서버 실행 중** (서버가 `~/.purplemux/port`·`cli-token`을 기록 → MCP가 자동으로 읽음)
2. 빌드:
   ```bash
   git clone https://github.com/yoway030/purplemux-mcp.git
   cd purplemux-mcp
   npm install && npm run build   # → dist/index.js
   ```

### Claude Code
```bash
claude mcp add purplemux -s user -- node /ABS/PATH/purplemux-mcp/dist/index.js
```
- 스코프 `-s`: `user`(전역) / `project`(`.mcp.json` 팀공유) / `local`(현재 프로젝트)
- 확인 `claude mcp get purplemux` · 제거 `claude mcp remove purplemux -s user`
- 수동: `~/.claude.json`의 `mcpServers`에
  `"purplemux": { "command": "node", "args": ["/ABS/PATH/.../dist/index.js"] }`

### Codex
```bash
codex mcp add purplemux -- node /ABS/PATH/purplemux-mcp/dist/index.js
```
- 확인 `codex mcp list` · 제거 `codex mcp remove purplemux`
- 수동: `~/.codex/config.toml`
  ```toml
  [mcp_servers.purplemux]
  command = "node"
  args = ["/ABS/PATH/.../dist/index.js"]
  ```

### 포트/토큰 직접 지정 (보통 불필요)
`~/.purplemux` 파일이 없거나 다른 포트를 쓸 때만:
- Claude: `... -e PMUX_PORT=16500 -e PMUX_TOKEN=... -- node ...`
- Codex: `... --env PMUX_PORT=16500 --env PMUX_TOKEN=... -- node ...`

> 등록 후 **세션 재시작** 필요. 경로는 **절대경로**. repo 이동 시 remove 후 새 경로로 재등록.

---

## 3. 사용법 / 워크플로우 예시

등록 후에는 자연어로 지시하면 에이전트가 알아서 툴을 호출한다.

- **현황 파악** — "purplemux 워크스페이스랑 탭 목록 보여줘"
- **명령 실행** — "ws-XXXX에 터미널 탭 만들고 `npm test` 돌려서 결과 캡처해줘"
  (create_tab → send_input → 잠시 후 capture_pane)
- **다른 AI 에이전트 운전 (핵심 유즈케이스)** — "codex-cli 탭 하나 띄워서 이 버그 고치라고 시키고 결과 가져와"
- **병렬 작업 감시** — 여러 터미널 탭에 각각 작업 던지고 `tab_status`/`capture_pane`로 폴링
- **브라우저 디버깅**(Electron) — "저 web-browser 탭 콘솔 에러 보여줘 / 스샷 떠줘 / 이 DOM 값 eval로 뽑아줘"

### 동작 검증 (라이브 테스트)
purplemux 서버가 켜진 상태에서:
```bash
node test/smoke.mjs   # handshake + 16툴 + list_workspaces
node test/e2e.mjs     # 라이브 라운드트립 12케이스 (스크래치 탭 생성→전송→캡처→종료, 자동 정리)
```

---

## 4. 주의사항 / 알려진 특성

- **`send_input`은 자동 제출**된다(서버가 Enter). content에 개행을 넣지 말 것 — 넣어도 trailing `\n` 1개는 제거된다. (라이브 실측으로 확정)
- **브라우저 툴은 Electron 전용.** headless purplemux에서는 503. 이 저장소의 라이브 검증은 터미널 툴 10종까지만 수행됨(브라우저 6종은 설계·구현 완료, Electron 환경에서 검증 예정).
- 포트값은 정수 1–65535만 허용(오염된 `PMUX_PORT`로 토큰이 외부 호스트로 새는 것 차단).
- `memory`/`mem`은 purplemux에 실제 구현이 없어(dead command) MCP에 노출하지 않음.

---

## 5. 문서 맵

- [`docs/01-cli-features.md`](01-cli-features.md) — purplemux CLI 전량 추출(정본)
- [`docs/02-mcp-design.md`](02-mcp-design.md) — MCP 서버 설계(정본)
- [`docs/worklog/`](worklog/) — 단계별 작업 기록 (추출→설계→작업→리뷰→테스트)
- [`docs/panel/`](panel/) — 3에이전트(Sonnet/Opus/Codex) 단계별 초안(프로세스 근거)
- [`docs/reference/`](reference/) — 추출에 사용한 고정 입력(api-guide, cli.js 등)

---

## 6. 에이전트 오케스트레이션 cookbook (`pmux_agent_*`)

기본 16툴 위에 다른 AI 에이전트(claude/codex CLI)를 직접 운전하기 위한 상위 계층. `agent_*` = primary, `send_input`/`capture_pane`은 저수준 폴백.

### 권장 워크플로

1. `pmux_list_workspaces` — workspaceId 확인
2. `pmux_agent_start` — 탭 생성 + CLI 런치. 응답의 **`hooksWired`**(훅 주입 성공 여부)와 **`recommendedFileOutput`**(read-only/plan 에이전트는 `false`)을 반드시 확인
3. `pmux_agent_wait_ready` — 준비 대기
4. `pmux_agent_turn`(send+폴링+회수 한 번에 — **대부분 이것만으로 충분**) 또는 `pmux_agent_send`+`pmux_agent_capture`(직접 폴링하고 싶을 때)
5. 작업이 끝나면 **반드시** `pmux_close_tab`으로 정리

### 훅 세션 vs 비훅 세션 (`signalSource`)

`wait_ready`/`status`/`send`/`turn` 응답의 `signalSource`로 판정 근거를 확인한다:
- **`"cliState"`** — `hooksWired:true`(claude: `~/.purplemux/hooks.json`, codex: `~/.purplemux/codex-hook.sh` 존재) 세션. purplemux 훅 push 기반 결정론적 신호(`needs-input`/`ready-for-review`/`busy`/`notification`)를 사용 — 신뢰도 높음.
- **`"pane"`** — `hooksWired:false` 세션. 화면 텍스트 휴리스틱 폴백(R1) — 훅 세션보다 덜 정확하니 `wait_ready` timeout이나 판정이 애매하면 아래 폴백을 쓴다.

### fileOutput 라우팅 (`recommendedFileOutput`)

- `recommendedFileOutput:true`(codex `workspace-write` / claude non-`plan`) → `fileOutput` 기본값(`true`)을 그대로 둔다. 응답이 길어도 파일로 안전하게 회수된다.
- `recommendedFileOutput:false`(read-only/plan — 파일 쓰기 권한 없음) → `send`/`turn` 호출 시 **`fileOutput:false`**를 명시해 pane BEGIN/END 폴백을 쓴다.

### 문제 시 폴백

- `wait_ready` timeout, 또는 상태 판정이 불확실할 때 → `pmux_capture_pane`으로 화면을 직접 확인한다.
- `agent_blocked`(승인/리뷰 대기 등) → 반환된 `tail`을 보고 상황을 판단 — 필요하면 `pmux_send_input`으로 직접 승인/거절을 입력한다.

### runtimeError 발견 시 재지시 패턴 (design R6)

`wait_ready`/`status`/`send`/`turn` 응답의 `runtimeError?:{match,line}`는 **readiness와 별개의 사실**이다 — ready인 세션도 직전 턴이 529/rate-limit 등으로 조용히 죽었을 수 있다:
- `runtimeError`가 있고 완료 신호(DONE 마커/report 파일)도 없다면, 그 턴은 사실상 유실된 것으로 보고 **같은 프롬프트를 재전송**한다.
- `pmux_agent_turn`은 완료 증거 없이 ready+`runtimeError`를 감지하면 timeout까지 기다리지 않고 `{status:"agent_error", runtimeError, tail}`을 조기 반환한다 — 이 경우 바로 재시도 여부를 판단하면 된다.
- 본문이 "API Error" 등을 인용만 한 경우(예: 에러 핸들링 코드 리뷰)도 `found:true`가 될 수 있다 — `{match,line}`을 보고 실제 실패인지 판단할 것.
