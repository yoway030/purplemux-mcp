# purplemux-mcp

**Claude Code / Codex**에서 로컬 [purplemux](https://github.com/subicura/purplemux)(subicura의 tmux + LLM 워크스페이스 매니저)를 제어하는 MCP 서버다. 워크스페이스·탭·터미널·(Electron)브라우저를 **16개 툴**로 다룬다.

purplemux CLI는 localhost HTTP API를 감싼 얇은 래퍼일 뿐이라, 이 서버는 그 API를 MCP 툴로 그대로 노출한다(CLI로 셸아웃하지 않고 HTTP를 직접 호출). 그래서 에이전트가 터미널을 오케스트레이션하고, 나아가 **다른 AI-CLI 세션까지 직접 운전**할 수 있다.

Node ≥ 20 + 같은 호스트에 purplemux 실행이 필요하다.

---

## 왜 만들었나 — 구독형 CLI를 서브에이전트로

이 프로젝트의 진짜 목적은 **tmux(purplemux) 위에서 돌아가는 구독형 CLI(`claude-code`, `codex-cli`)를 서브에이전트로 부려먹는 것**이다.

- 서브에이전트를 API로 붙이면 **토큰 종량 과금**이 붙는다. 반면 Claude Code(Claude 구독)·Codex CLI(ChatGPT/Codex 구독)는 **정액 구독**으로 돌아가는 대화형 세션이다.
- purplemux는 이 구독형 CLI들을 각각 tmux 페인(탭)으로 띄워 준다. 문제는 "그 탭을 프로그래매틱하게 생성·조작·회수"할 방법이었고, purplemux는 그걸 위한 로컬 HTTP API를 갖고 있다.
- **이 MCP가 그 다리**다. 오케스트레이터(예: 지금 이 Claude Code)가 →
  1. `pmux_create_tab`으로 `claude-code` / `codex-cli` 타입 탭을 띄우고
  2. `pmux_send_input`으로 작업 프롬프트를 넣고(서버가 Enter까지 자동 제출)
  3. `pmux_tab_status` / `pmux_capture_pane`로 진행·결과를 회수하고
  4. `pmux_close_tab`으로 정리한다.

즉 **구독 정액으로 돌아가는 CLI 세션을 "호출 가능한 워커 에이전트"로 바꿔** 팬아웃(fan-out) 오케스트레이션을 하는 게 핵심 시나리오다. 여러 탭에 작업을 나눠 병렬로 돌리고, 상태를 폴링하고, 결과를 합치는 흐름 전체를 자연어 지시로 굴릴 수 있다.

> 참고: 이 저장소 자체도 그 정신으로 만들어졌다 — 추출→설계→작업→리뷰→테스트 5단계를 각각 **3개 서브에이전트(Claude Sonnet / Claude Opus / Codex gpt-5.5-high)의 합의**로 진행했다.

---

## 빠른 시작

```bash
# 1. purplemux 실행 중이어야 함 (서버가 ~/.purplemux/{port,cli-token}을 기록)
# 2. 빌드
npm install && npm run build            # -> dist/index.js

# 3. 등록 (절대경로)
claude mcp add purplemux -s user -- node "$PWD/dist/index.js"
codex  mcp add purplemux        -- node "$PWD/dist/index.js"
```

Claude Code / Codex 세션을 재시작하면 `pmux_*` 툴이 뜬다. 포트·토큰은 **호출마다** `~/.purplemux/`에서 자동으로 읽으므로(캐시 없음), purplemux를 재시작하거나 포트가 바뀌어도 이 서버는 재시작할 필요가 없고 일반 환경에선 env 설정도 필요 없다.

---

## 툴 (16개)

**터미널/탭 (headless에서도 동작):** `pmux_list_workspaces` · `pmux_list_tabs` ·
`pmux_create_tab` · `pmux_get_tab` · `pmux_send_input` · `pmux_tab_status` ·
`pmux_capture_pane` · `pmux_close_tab`

**브라우저 (Electron 필요):** `pmux_browser_url` · `pmux_browser_screenshot` ·
`pmux_browser_console` · `pmux_browser_network` · `pmux_browser_network_body` ·
`pmux_browser_eval`

**유틸:** `pmux_api_guide` · `pmux_connection_info` (토큰값은 절대 노출 안 함)

> `pmux_send_input`은 **자동 제출**된다(서버가 Enter를 침) — 개행을 붙이지 말 것. trailing `\n` 1개는 자동 제거된다. 브라우저 툴은 headless(비 Electron) purplemux에서 **503**을 반환하고, `web-browser` 탭 생성 직후엔 **409 "not attached yet"**(잠시 후 재시도)가 날 수 있다.

`claude-code`/`codex-cli` 탭을 서브에이전트로 쓰는 흐름을 포함한 전체 기능·설치 옵션·사용 예시: **[docs/USAGE.md](docs/USAGE.md)**.

---

## 개발 / 테스트

```bash
npm run build && npm run typecheck
npm run smoke     # handshake + 16툴 + 라이브 list_workspaces
npm run e2e       # 실행 중 purplemux 대상 라이브 라운드트립 12케이스
```

---

## 구조

```
src/            # config, http, errors, schemas, tools, index (stdio 부트스트랩)
test/           # smoke + 라이브 e2e (Node, 프레임워크 없음)
docs/
  USAGE.md               # 기능 · 설치 · 사용법
  01-cli-features.md     # purplemux CLI 추출 정본
  02-mcp-design.md       # MCP 서버 설계 정본
  worklog/               # 단계별 작업기록 (추출→설계→작업→리뷰→테스트)
  panel/                 # 3에이전트(Sonnet/Opus/Codex) 단계별 초안
  reference/             # 추출에 사용한 고정 입력(api-guide 등)
```

---

## 어떻게 만들었나

추출 → 설계 → 작업 → 리뷰 → 테스트 5단계. 각 단계를 세 서브에이전트(Claude Sonnet, Claude Opus, Codex gpt-5.5-high)의 합의로 통과시키고, 이견은 오케스트레이터가 라이브 서버 실측으로 판정했다(예: `send` 자동 제출 동작 확정, 리뷰 단계에서 포트 인젝션에 의한 토큰 유출 취약점 발견·차단). 자세한 내용은 [docs/worklog/](docs/worklog/).

---

## 라이선스

MIT (이 서버). purplemux는 [subicura](https://github.com/subicura/purplemux)의 별도 프로젝트다.
