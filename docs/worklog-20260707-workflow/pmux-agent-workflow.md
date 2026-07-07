# pmux 서브에이전트 대화형 운영 개선안

## 배경

pmux로 Codex, Claude 같은 서브에이전트를 여러 개 띄워 협업시키려면 단발 실행보다 대화형 세션이 기본이 되어야 한다.

단발 실행인 `codex exec`나 `claude -p`는 매번 새 프로세스와 새 컨텍스트로 시작하기 때문에, 여러 턴을 주고받는 협업에는 적합하지 않다. 반대로 대화형 세션은 한 번 실행된 뒤 역할, 이전 발언, 합의사항을 계속 기억할 수 있고 다음 반응도 빠르다.

따라서 pmux의 서브에이전트 워크플로는 기본적으로 long-lived interactive session을 중심으로 설계해야 한다.

## 현재 문제점

### 1. 에이전트 패널이 실제 에이전트 세션을 보장하지 않음

`panelType: codex-cli`, `panelType: claude-code`로 탭을 만들어도 실제로는 셸 프롬프트에서 시작할 수 있다.

사용자 입장에서는 에이전트 탭처럼 보이지만, 내부적으로는 직접 `codex` 또는 `claude` 명령을 실행해야 한다. 이 상태가 명확히 표시되지 않으면 입력을 바로 보내다가 실패하거나 셸에 그대로 명령이 들어갈 수 있다.

### 2. 단발 실행과 대화형 실행이 섞임

`codex exec`, `claude -p`는 기존 컨텍스트가 필요 없는 빠른 단발 질문에는 유용하지만, 서브에이전트 협업에는 부적합하다.

특히 3턴 이상 의견을 주고받는 작업에서는 매번 컨텍스트를 다시 주입해야 하고, 에이전트별 역할과 이전 합의가 자연스럽게 유지되지 않는다.

### 3. CLI별 옵션 차이가 명확히 분리되지 않음

Codex와 Claude는 실행 모드별로 지원하는 옵션이 다르다.

예를 들어 `codex exec`와 대화형 `codex`는 옵션 집합이 다르고, Claude도 `-p` 전용 옵션과 대화형 옵션이 다르다. 이 차이를 구분하지 않고 실행하면 `unexpected argument` 같은 오류가 발생한다.

### 4. 상태 확인이 불충분함

`pmux_tab_status`의 `idle`만으로는 다음 상태를 구분하기 어렵다.

- 에이전트가 응답을 완료하고 입력 대기 중인 상태
- 명령이 실패하고 셸 프롬프트로 돌아온 상태
- TUI는 살아 있지만 실제 입력 가능 여부가 불확실한 상태
- 이전 명령 출력이 아직 pane에 남아 있는 상태

결국 `pmux_capture_pane`로 화면을 직접 확인해야 했다.

### 5. 출력 파싱이 불안정함

대화형 화면에는 다음 정보가 함께 섞일 수 있다.

- CLI 도움말
- 이전 명령
- 셸 프롬프트
- TUI 기본 안내 문구
- 예시 프롬프트
- 실제 에이전트 응답

이 상태에서는 응답 본문만 안정적으로 추출하기 어렵다.

### 6. 빠른 연속 입력에 취약함

이전 명령이 완전히 끝났는지 확인하지 않고 다음 입력을 보내면, 입력이 실행되지 않거나 TUI 내부에 붙어버릴 수 있다.

특히 Claude 탭에서 `claude -p` 실행 후 출력 회수가 불안정한 상태에서 다음 명령을 보내자, bracketed paste 형태의 입력이 pane에 남는 문제가 있었다.

## 개선 원칙

### 1. 대화형 세션을 기본값으로 사용

서브에이전트 협업의 기본 실행 방식은 대화형 세션이어야 한다.

권장 기본 명령:

```sh
codex --no-alt-screen -s read-only
claude --permission-mode dontAsk
```

단발 실행은 명시적으로 요청한 경우나 기존 컨텍스트가 필요 없는 빠른 자문이 필요한 경우에만 사용한다.

```sh
codex exec -s read-only --ephemeral "<prompt>"
claude -p --output-format json --permission-mode dontAsk "<prompt>"
```

### 2. 에이전트 부팅 단계를 분리

`create_tab`만으로 에이전트가 준비되었다고 간주하지 않는다. 탭 생성과 에이전트 세션 시작은 별도 단계로 다룬다.

권장 흐름:

```text
create_tab
start_agent_session(provider=codex|claude)
wait_agent_ready
send_input
capture_response
close_or_keep_session
```

### 3. readiness 상태를 명확히 구분

pmux 또는 래퍼는 최소한 다음 상태를 구분해야 한다.

```text
shell_ready
agent_starting
agent_ready
agent_busy
agent_idle
agent_error
exited
```

특히 `shell_ready`와 `agent_ready`는 반드시 분리되어야 한다. 셸이 준비된 것과 에이전트가 입력 가능한 것은 다르다.

### 4. provider별 실행 프로파일을 고정

CLI 옵션을 매번 추측하지 않도록 실행 프로파일을 고정한다.

```text
codex_interactive    = codex --no-alt-screen -s read-only
codex_once           = codex exec -s read-only --ephemeral
claude_interactive   = claude --permission-mode dontAsk
claude_once          = claude -p --output-format json --permission-mode dontAsk
```

이 프로파일은 pmux 내부 설정 또는 별도 래퍼에서 관리한다.

### 5. 최초 실행 시 CLI capability를 탐지

오케스트레이터는 첫 서브에이전트를 실행할 때 provider CLI의 실제 지원 옵션을 파악해야 한다. CLI 버전마다 지원 인자와 동작이 달라질 수 있으므로, 하드코딩된 명령만 믿으면 안 된다.

최초 실행 시 수행할 탐지:

```text
codex --help
codex exec --help
claude --help
claude -p --help
```

탐지해야 할 항목:

```text
interactive 명령 형식
one-shot 명령 형식
model 지정 옵션
reasoning effort 지정 옵션
sandbox 또는 permission 옵션
output format 옵션
session persistence 옵션
지원하지 않는 옵션
```

탐지 결과는 provider별 capability registry로 저장한다.

예:

```json
{
  "provider": "codex",
  "version": "0.142.5",
  "interactive": {
    "base": ["codex", "--no-alt-screen"],
    "model_flag": "-m",
    "sandbox_flag": "-s",
    "supports_ephemeral": false
  },
  "once": {
    "base": ["codex", "exec"],
    "sandbox_flag": "-s",
    "supports_ephemeral": true
  }
}
```

이 registry는 같은 세션 안에서 재사용하고, CLI 버전이 바뀌면 다시 탐지한다.

### 6. 작업 속성에 따라 대화형 실행 인자를 조립

오케스트레이터는 사용자 요청 또는 preset을 바탕으로 필요한 agent 속성을 결정한 뒤, capability registry를 사용해 실제 CLI 명령을 조립해야 한다.

입력 속성:

```text
provider
model
reasoning_effort
permission_mode
sandbox_mode
tools
interactive=true
```

출력 명령 예:

```text
codex --no-alt-screen -m gpt-5.5 -s read-only
claude --model sonnet --permission-mode manual
```

원칙:

- 기본은 항상 대화형 실행이다.
- one-shot 명령은 명시적으로 요청되었거나 fallback일 때만 사용한다.
- 사용자가 모델, effort, 권한을 지정하면 그 값을 우선한다.
- 사용자가 지정하지 않으면 작업 유형 preset을 사용한다.
- capability registry에 없는 옵션은 명령에 넣지 않고 bootstrap prompt에만 반영한다.
- 위험 권한은 실행 전에 사용자 확인을 요구한다.

예를 들어 `reasoning_effort`를 CLI가 직접 지원하지 않으면, 실행 인자로 넣지 않고 bootstrap prompt에 다음처럼 포함한다.

```text
reasoning_effort: high
이 작업은 깊은 검토가 필요하므로 성급히 결론 내리지 말고 근거를 함께 제시하세요.
```

### 7. 응답 마커를 강제

pane 캡처에서 실제 응답만 안정적으로 추출하려면 모든 턴에 sentinel marker를 붙인다.

예:

```text
당신의 응답은 반드시 아래 마커 사이에만 작성하세요.

<<<PMUX_BEGIN agent=A turn=2>>>
...
<<<PMUX_END agent=A turn=2>>>
```

응답 회수 시에는 `PMUX_BEGIN`과 `PMUX_END` 사이만 파싱한다.

### 8. 서브에이전트 출력 회수 방식을 표준화

서브에이전트의 출력 내용을 효율적으로 알아오기 위한 별도 메커니즘이 필요하다.

단순히 `pmux_capture_pane` 전체를 읽는 방식은 비효율적이다. pane에는 이전 명령, 도움말, 프롬프트, 예시 문구, 현재 응답이 모두 섞이기 때문이다.

권장 회수 방식은 우선순위를 둔다.

```text
1. 구조화 출력 파일
2. sentinel marker 기반 pane 파싱
3. 마지막 N줄 캡처
4. 전체 pane 캡처 fallback
```

#### 구조화 출력 파일

가능하면 각 턴의 응답을 에이전트가 지정된 파일에도 기록하게 한다.

예:

```text
.pmux/agents/poet-a/turn-001.json
.pmux/agents/poet-a/turn-002.json
.pmux/agents/poet-a/latest.json
```

권장 JSON 형식:

```json
{
  "agent_id": "poet-a",
  "turn": 1,
  "status": "complete",
  "summary": "푸른 창문과 식은 물컵 이미지를 제안함",
  "content": "실제 응답 본문",
  "next_intent": "다른 에이전트의 리듬 제안을 반영할 준비가 됨"
}
```

이 방식은 pane 파싱보다 안정적이고, 오케스트레이터가 최신 응답만 빠르게 읽을 수 있다.

#### sentinel marker 기반 pane 파싱

파일 기록이 어렵거나 대화형 TUI만 사용할 수 있는 경우에는 sentinel marker를 사용한다.

```text
<<<PMUX_BEGIN agent=poet-a turn=1>>>
응답 본문
<<<PMUX_END agent=poet-a turn=1>>>
```

래퍼는 마지막 `PMUX_BEGIN`과 `PMUX_END` 쌍만 추출한다. 이전 턴과 섞이지 않도록 `agent`, `turn`, `request_id`를 포함하는 것이 좋다.

#### 출력 요약 필드 분리

긴 응답을 매번 전체 relay하지 않기 위해 에이전트는 짧은 요약을 함께 제공해야 한다.

예:

```text
summary: 핵심 이미지 3개와 결말 방향을 제안함
content: 전체 응답
relay_to_others: 다른 에이전트에게 전달할 2~3문장 요약
```

오케스트레이터는 기본적으로 `relay_to_others`만 다른 서브에이전트에게 전달하고, 최종 합성 시에만 `content` 전체를 사용한다.

#### 증분 회수

긴 응답을 기다려야 하는 작업에서는 전체 완료 후 한 번에 읽는 대신 증분 회수가 필요할 수 있다.

가능하면 다음 상태를 제공한다.

```text
partial
complete
error
timeout
```

`partial` 상태에서는 중간 출력만 보여주고 다음 turn 입력은 보내지 않는다. 다음 입력은 반드시 `complete` 상태에서만 보낸다.

#### 출력 회수 API 제안

래퍼 또는 pmux는 다음과 같은 API를 제공하는 것이 좋다.

```text
capture_response(agent_id, turn)
capture_latest(agent_id)
capture_summary(agent_id, turn)
wait_response(agent_id, turn, timeout_ms)
```

각 API는 전체 pane이 아니라 파싱된 응답 객체를 반환해야 한다.

예:

```json
{
  "agent_id": "poet-a",
  "turn": 2,
  "status": "complete",
  "summary": "...",
  "content": "...",
  "raw_ref": "pane snapshot id or file path"
}
```

### 9. 입력 전 상태 검증

다음 입력을 보내기 전 반드시 다음 조건을 확인한다.

- 에이전트 프로세스가 살아 있는가?
- 셸 프롬프트로 튕겨 나가지 않았는가?
- 이전 턴의 `PMUX_END` 마커가 있는가?
- 에러 패턴이 없는가?
- 현재 상태가 `agent_ready` 또는 `agent_idle`인가?

이 조건을 만족하지 않으면 새 입력을 보내지 말고 먼저 캡처와 상태를 저장한다.

### 10. 세션 컨텍스트를 유지

한 번 띄운 서브에이전트는 작업이 끝날 때까지 닫지 않는다.

대화형 세션을 유지하면 다음 장점이 있다.

- 역할 프롬프트를 반복 주입하지 않아도 된다.
- 이전 발언과 합의사항을 자연스럽게 활용할 수 있다.
- 다음 턴 반응이 빠르다.
- 에이전트별 개성이 유지된다.
- 중간 수정 요청이 자연스럽게 처리된다.

### 11. 서브에이전트 속성을 명시적으로 지정

서브에이전트는 실행 전에 역할과 속성을 명확히 받아야 한다. 속성이 불명확하면 모든 에이전트가 비슷한 답을 내거나, 중간 토론에서 담당 영역이 겹친다.

속성은 두 가지 방식으로 지정할 수 있어야 한다.

#### 사전 정의 방식

작업 유형별로 자주 쓰는 에이전트 구성을 preset으로 둔다.

예:

```text
poem_workshop:
  - name: poet-a
    provider: codex
    role: image_director
    focus: 장면, 사물, 감각 이미지
    style: 구체적이고 절제된 자유시
  - name: poet-b
    provider: codex
    role: rhythm_editor
    focus: 반복, 행갈이, 호흡
    style: 짧은 행과 긴 행의 대비
  - name: poet-c
    provider: claude
    role: ending_critic
    focus: 정서, 사유, 결말
    style: 여운을 남기되 과잉 설명을 피함
```

사전 정의 방식은 반복 작업에 적합하다. 예를 들어 시 합성, 코드 리뷰, 설계 검토, 문서 편집처럼 매번 비슷한 역할 분담이 필요한 작업에 사용할 수 있다.

#### 사용자 대화형 지정 방식

작업마다 필요한 에이전트 속성이 다르면 시작 전에 사용자에게 짧게 물어본다.

예:

```text
이번 작업의 서브에이전트 구성을 지정해 주세요.

1. 에이전트 수: 3
2. 각 에이전트 역할:
   - A: 이미지와 장면
   - B: 리듬과 문장
   - C: 정서와 결말
3. 선호 provider:
   - 모두 Codex
   - 모두 Claude
   - 혼합
4. 토론 방식:
   - 독립 초안 후 합성
   - 서로 3턴 토론
   - 한 에이전트가 작성하고 나머지가 비평
```

사용자가 직접 지정하지 않으면 pmux 래퍼는 작업 유형에 맞는 기본 preset을 제안하고, 사용자는 그대로 승인하거나 일부만 수정할 수 있어야 한다.

### 12. bootstrap prompt를 표준화

대화형 세션이 준비되면 첫 입력으로 bootstrap prompt를 보내 에이전트의 속성을 고정한다.

bootstrap prompt에는 최소한 다음 정보가 들어가야 한다.

```text
agent_id
provider
model
reasoning_effort
permission_mode
sandbox_mode
role
focus
style
constraints
output_format
turn_policy
collaboration_policy
```

예:

```text
당신은 pmux 서브에이전트 poet-b입니다.

provider: codex
model: gpt-5.5
reasoning_effort: high
permission_mode: read-only
sandbox_mode: read-only
역할: 리듬 편집자
중점: 반복, 행갈이, 호흡, 소리
스타일: 짧은 행과 긴 행의 대비를 사용하되 과장하지 않음
제약: 다른 에이전트의 역할을 침범하지 말 것
협업 방식: 사회자가 전달하는 다른 에이전트 의견을 반영해 3턴 동안 수정 의견을 낼 것
출력 형식: 반드시 PMUX_BEGIN/PMUX_END 마커 안에만 답할 것
```

### 13. 모델, effort, 권한 설정을 agent 속성에 포함

서브에이전트 속성은 역할 설명만이 아니라 실행 설정까지 포함해야 한다.

최소 설정 항목:

```text
provider: codex | claude
model: 사용할 모델 이름
reasoning_effort: low | medium | high | xhigh
permission_mode: read-only | ask | auto | dontAsk | manual
sandbox_mode: read-only | workspace-write | danger-full-access
tools: 허용할 도구 목록
max_turns: 최대 턴 수
timeout_ms: 턴별 제한 시간
keep_alive: 작업 후 세션 유지 여부
```

작업 성격에 따라 기본값을 다르게 둔다.

```text
creative:
  model: 기본 최신 모델
  reasoning_effort: medium
  permission_mode: read-only
  sandbox_mode: read-only
  tools: none

code_review:
  model: 고성능 모델
  reasoning_effort: high
  permission_mode: read-only
  sandbox_mode: read-only
  tools: read, search

implementation:
  model: 고성능 모델
  reasoning_effort: high
  permission_mode: ask
  sandbox_mode: workspace-write
  tools: read, edit, test

high_risk:
  model: 고성능 모델
  reasoning_effort: high
  permission_mode: manual
  sandbox_mode: read-only
  tools: read
```

권한은 provider별 CLI 옵션으로 변환되어야 한다.

예:

```text
codex:
  sandbox_mode=read-only       -> codex --no-alt-screen -s read-only
  sandbox_mode=workspace-write -> codex --no-alt-screen -s workspace-write

claude:
  permission_mode=dontAsk -> claude --permission-mode dontAsk
  permission_mode=manual  -> claude --permission-mode manual
```

위험한 설정은 사용자 확인 없이 자동 적용하지 않는다.

사용자 확인이 필요한 예:

```text
sandbox_mode: workspace-write
sandbox_mode: danger-full-access
permission_mode: bypassPermissions
tools: Bash, Edit, Write
```

사용자 대화형 지정 시에는 역할뿐 아니라 모델과 권한도 물어볼 수 있어야 한다.

예:

```text
서브에이전트 실행 설정을 지정해 주세요.

1. provider: Codex / Claude / 혼합
2. model: 기본값 / 빠른 모델 / 고성능 모델 / 직접 입력
3. reasoning effort: low / medium / high / xhigh
4. 권한: read-only / workspace-write / manual approval
5. 도구: 없음 / 읽기만 / 읽기+수정 / 전체
6. 작업 후 세션 유지: 유지 / 종료
```

## 권장 워크플로

### 대화형 서브에이전트 협업

```text
1. workspace 확인
2. provider CLI capability 탐지 또는 캐시 확인
   - codex/claude help 출력 기반으로 지원 옵션 확인
   - CLI 버전이 바뀌었으면 capability registry 갱신
3. agent 속성 결정
   - preset 사용
   - 또는 사용자에게 대화형으로 역할, 수, provider, 모델, effort, 권한, 토론 방식을 질문
4. agent 속성과 capability registry를 바탕으로 interactive CLI 명령 조립
5. agent 수만큼 terminal 탭 생성
6. 각 탭에서 조립된 provider별 interactive CLI 실행
7. capture_pane으로 agent prompt readiness 확인
8. agent별 bootstrap prompt 전송
9. bootstrap 응답 확인
10. turn 1 입력
11. sentinel 기반 응답 회수
12. 응답 요약을 다른 agent에게 relay
13. turn 2, turn 3 반복
14. 최종 응답 합성
15. 필요하면 세션 유지, 아니면 close_tab
```

### 단발 실행 사용 조건

단발 실행은 다음 경우에만 사용한다.

- 컨텍스트 유지가 필요 없는 짧은 질문
- 단순 비교 의견
- 빠른 문장 변형
- 대화형 세션 부팅이 실패했을 때의 fallback

서브에이전트가 여러 턴 협업해야 하는 작업에서는 사용하지 않는다.

## 래퍼 제안

`pmux-agent-runner` 같은 얇은 래퍼를 두면 안정성이 크게 좋아진다.

담당 기능:

- provider CLI capability 탐지
- capability registry 캐시 및 버전별 갱신
- provider별 interactive command 조립
- preset 기반 agent 속성 로드
- 사용자 대화형 agent 속성 지정
- model, effort, permission, sandbox 설정 검증
- 위험 권한에 대한 사용자 확인
- agent별 bootstrap prompt 생성
- 탭 생성
- 에이전트 CLI 부팅
- readiness 확인
- turn별 입력 전송
- sentinel 기반 응답 추출
- timeout 처리
- 에러 패턴 감지
- 세션 유지 또는 정리

예상 인터페이스:

```text
pmux-agent-runner presets
pmux-agent-runner detect --provider codex
pmux-agent-runner detect --provider claude
pmux-agent-runner configure --interactive
pmux-agent-runner plan-command --provider codex --model gpt-5.5 --effort high --sandbox read-only --interactive
pmux-agent-runner start --provider codex --name poet-a --model gpt-5.5 --effort high --sandbox read-only
pmux-agent-runner bootstrap --agent poet-a --role rhythm_editor --focus "반복, 행갈이, 호흡" --permission read-only
pmux-agent-runner wait-ready --agent poet-a
pmux-agent-runner send --agent poet-a --turn 1 --prompt prompt.txt
pmux-agent-runner capture --agent poet-a --turn 1
pmux-agent-runner close --agent poet-a
```

## 핵심 결론

pmux 서브에이전트는 단발 실행기가 아니라 대화형 장기 세션 오케스트레이터로 동작해야 한다.

현재 가장 큰 문제는 에이전트 탭처럼 보이는 상태와 실제 에이전트 입력 가능 상태가 분리되어 있다는 점이다.

개선 방향은 다음 항목으로 요약된다.

```text
대화형 세션 기본화
명확한 readiness 상태 제공
최초 실행 시 CLI capability 탐지
작업 속성에 따른 대화형 실행 인자 조립
provider별 실행 프로파일 고정
서브에이전트 속성의 사전 정의 또는 사용자 대화형 지정
sentinel 기반 turn 응답 추출
```

이 구조가 갖춰지면 pmux 기반 서브에이전트 협업은 더 빠르고, 컨텍스트를 잘 활용하며, 실패 지점을 명확히 복구할 수 있다.
