APPROVE

# codex v22-turn2 설계 합의 검토

`design-v22.md`의 R0 추가는 타당하다. 상태 판정을 pane 텍스트 휴리스틱에서 purplemux 본체의 hook-push 기반 `cliState`/`command`로 올리는 것은 이번 회고의 핵심 실패 원인(#2 ready 오탐/미탐, #5 큐잉)을 가장 직접적으로 줄인다. v2.1의 "pane은 상태, 파일은 내용" 원칙보다도 한 단계 더 낫다. 상태는 pane이 아니라 purplemux가 이미 가진 native state를 먼저 읽고, pane은 훅 미주입/미지원/unknown일 때 fallback으로 쓰는 구조가 맞다.

## R1 반영 여부

턴1에서 제안한 Codex TUI 보강은 설계에 충분히 반영됐다.

- frameSeen 2-시그니처: `Read Only|Workspace|gpt-|·` 등 2개 이상으로 `codexFrameSeen`을 잡는 방식으로 반영됨.
- queued/composer-dirty: `›` 뒤 non-empty text + not busy => `agent_starting` reason `input_queued`로 반영됨.
- tail 확장: 15 -> 30으로 반영됨. 30은 적정 시작값이다. 필요하면 fixture로 40까지 조정하면 된다.
- shell-return 조건 강화: `!frameSeen && SHELL_PROMPT_RE`일 때만 shell return을 강하게 보는 방식으로 반영됨.
- fixture 테스트: fresh composer, bare `›` 없음, Working, approval, queued, shell return, 본문 `$` 끝 케이스가 명시됨.

R1은 이제 1차 판정이 아니라 fallback 계층이므로 리스크가 낮아졌다. 그래도 훅 없는 세션과 launcher 부재 환경에서는 여전히 실제로 쓰이므로 fixture 테스트는 blocking으로 유지해야 한다.

## R0 타당성

R0의 방향은 승인한다.

`tab_status`의 `cliState`를 먼저 소비하면 `busy` 중 `send`를 거부할 수 있어 Codex CLI의 "다음 tool call 이후 제출될 메시지" 큐잉을 줄인다. `needs-input`을 ready로 보고, `ready-for-review`/`notification`을 `agent_blocked`로 분리하는 것도 맞다. 승인/리뷰 대기 상태를 ready로 취급하면 자동 입력이 깨지기 쉽다.

`command`를 함께 쓰는 것도 필요하다. 특히 Codex launcher 경유 실행은 foreground command가 `node`로 보일 수 있다. shell command(`bash|zsh|fish|sh|dash`)로 복귀한 경우를 launch failure/process ended로 보는 것은 정규식 tail 판정보다 안정적이다. 단, start가 실제 launch 명령을 보낸 뒤인지 여부는 기존 v2.1 계약처럼 유지해야 한다.

## Codex 관점 세부 판정

### launcher 경유 launch와 옵션 충돌

로컬 `~/.purplemux/codex-launcher.js`를 확인했다. launcher 자체는 `--workspace-id`와 `--resume-session-id`만 파싱하고, 실제 `codex` 인자 배열은 `/api/codex/launch-args` 응답에 전적으로 위임한다. 즉 MCP가 기존처럼 `codex --no-alt-screen -s <sandbox> -m <model> -c model_reasoning_effort=<effort>`를 직접 조립하는 경로와는 다르다.

따라서 설계의 "launcher 우선, 미지원 옵션은 bootstrapHint" 방침은 맞지만 구현 게이트에서 다음을 명확히 해야 한다.

- `model`, `effort`, `sandbox`가 launcher/API 경로에서 실제 적용되는지 확인한다.
- 적용되지 않는 옵션은 조용히 무시하지 말고 `bootstrapHint`와 별도 반환 필드로 알려야 한다. 예: `appliedOptions`, `ignoredOptions` 또는 `launcherOptionsSupported`.
- `recommendedFileOutput`은 현재 Codex `sandbox !== read-only` 기준인데, launcher가 sandbox를 적용하지 못하면 이 힌트가 틀릴 수 있다. launcher 경로에서는 실제 launch args에서 sandbox/approval 모드를 추론하거나, 불확실하면 보수적으로 `recommendedFileOutput:false`를 반환하는 편이 안전하다.
- `--no-alt-screen`이 launcher args에 포함되는지 확인해야 한다. 빠지면 pane fallback/R1/R2의 신뢰도가 낮아진다.

이 항목들은 설계 반려 사유는 아니지만 구현 리뷰에서 반드시 확인해야 할 조건이다.

### codex notify 이벤트 신뢰성

라이브 PoC로 `busy -> needs-input` 전이가 확인됐다면 1차 신호로 쓸 근거는 충분하다. 다만 Codex notify/hook은 Claude의 `UserPromptSubmit/Stop`처럼 이벤트 이름이 풍부하지 않을 수 있고, hook script도 이벤트 payload를 직접 해석하기보다 purplemux API에 provider/session을 push하는 구조다. 그래서 다음 방어가 필요하다.

- `cliState=busy`는 send 거부가 맞다. stale busy 가능성보다 큐잉 재발 비용이 더 크다.
- `cliState=idle|unknown|null|미지원값`은 pane fallback이 맞다. 초기 부팅 직후 idle, 훅 미주입 세션 idle 고정, notify 누락을 모두 흡수한다.
- `cliState=needs-input`은 ready로 봐도 좋지만, 반환에 `signalSource:"cliState"`와 raw `cliState`를 포함해야 한다.
- `cliState=notification|ready-for-review`는 `agent_blocked`가 맞다. 이때 tail을 붙여 LLM이 승인/리뷰/알림 성격을 판단하게 해야 한다.
- missed Stop으로 busy가 오래 남는 경우를 위해 `wait_ready` timeout 결과에 raw `cliState`, `command`, `tail`을 반드시 포함해야 한다. 자동 fallback으로 ready 처리하면 안 된다.

### cliState 열린 집합 처리

열린 집합 처리 설계는 적절하다. unknown 값을 hard fail로 보면 purplemux 버전 변화에 취약하다. unknown/idle/null은 `signalSource:"pane"` fallback으로 내리고, 반환에는 `rawCliState`를 보존해야 한다.

추가로 `ReadinessState`에 `agent_blocked`가 들어가면 다음 표면도 같이 바뀌어야 한다.

- `wait_ready`: `agent_blocked`는 terminal state로 반환.
- `send`: `agent_blocked`면 `sent:false, reason:"blocked"` 또는 `"agent_blocked"`로 반환. `not_ready`와 구분해야 한다.
- `status`: `readiness.state`, `signalSource`, `rawCliState`, `command`를 포함.
- `turn`: blocked 상태에서 send를 시도하지 않고 `send_failed` 또는 `blocked` 계열로 구조화 반환.

## R2/R3/R4/R5 간단 판정

R2는 approve. req 기반 단축 마커는 좁은 pane 문제의 1차 해법이고, wrap tolerant parser는 보조 해법으로 두는 순서가 맞다. 단축 마커는 기존 agent/turn 형식과 호환 파서를 유지해야 한다.

R3는 approve. R0 판정 사다리를 내부에서 공통 사용하고, timeout 시 marker를 돌려줘 `pmux_agent_capture`로 재개 가능하게 한 점이 중요하다.

R4/R5는 approve. 특히 `pmux_create_tab`의 `codex-cli` panelType과 `pmux_agent_start`의 차이를 문서/description에 박아야 회고 #3이 줄어든다.

## 리스크 top3

1. Codex launcher가 `model/effort/sandbox/--no-alt-screen`을 지원하지 않는데 MCP가 적용됐다고 가정하는 리스크. 반환값에 실제 적용/무시를 노출하고, `recommendedFileOutput`은 실제 sandbox 확인 전 보수적으로 계산해야 한다.
2. hook/notify 누락 또는 stale `busy` 리스크. `busy`는 send 거부가 맞지만 timeout 결과에 raw state와 tail을 충분히 줘야 수동 복구가 가능하다.
3. `agent_blocked` 추가에 따른 표면 불일치 리스크. `wait_ready/send/status/turn` 모두 같은 상태명을 쓰지 않으면 LLM 라우팅이 다시 흔들린다.

## 최종 의견

R0+R1+R2 설계는 승인한다. R0는 v2.2의 우선순위 1번으로 넣는 것이 맞고, R1은 fallback으로 강등된 상태에서도 내 턴1 제안을 충분히 반영했다. Codex 쪽 구현 전제는 "launcher 경유 시 옵션 적용 여부를 확인하고, 불확실한 것은 명시 반환한다"로 게이트하면 된다.
