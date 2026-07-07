AGREE

# codex v22-turn1 스코프 검토

오케스트레이터 스코프안 R1~R5는 이번 회고 5건을 실제로 줄이는 방향과 맞다. 단, R1은 "ready 오탐/미탐"만이 아니라 회고 #5의 **입력 큐잉/진행 중/입력 대기 구분 실패**까지 같은 상태 모델 문제로 묶어야 한다. 이 구분을 빼면 Codex에서 `not_ready`는 줄어도, busy 중 추가 입력이 다음 tool call 뒤로 큐잉되는 문제는 남는다.

## 항목별 판정

### R1 readiness 재설계

찬성. 현재 `CODEX_READY_RE = /›/`는 Codex CLI의 빈 composer 표시 하나에 과의존한다. Codex TUI에서 `›`는 주로 composer가 비어 있고 입력 가능한 상태일 때 보이는 신호이며, 다회차 후에는 화면 하단 상태바는 살아 있어도 bare `›`가 tail 15줄에 없거나, busy/approval/queued 상태와 섞여 보일 수 있다. 따라서 "상태바 존재 + busy 부재 => ready 후보"를 추가하는 방향은 맞다.

다만 `ready`로 바로 승격하기 전 다음 제외 조건이 필요하다.

- `Working` 스피너, `Esc to interrupt` 계열, tool call 진행 표시가 있으면 `agent_busy`.
- 승인/확인 프롬프트, 권한 요청, 선택지 UI가 있으면 `agent_starting` 또는 별도 `agent_blocked`가 더 정확하다. 기존 enum을 유지한다면 ready로 보지 말아야 한다.
- composer에 사용자가 보낸 텍스트가 아직 제출/처리되지 않고 남아 있는 상태는 `agent_ready`가 아니다. 회고 #5처럼 "다음 tool call 이후 제출될 메시지" 큐에 들어간 경우를 감지할 최소한의 `queued_input` reason이 필요하다.
- 셸 프롬프트 복귀 판정은 Codex 상태바가 최근 tail에 없을 때만 강하게 적용해야 한다. Codex 출력 본문 마지막 줄이 `$`, `%`, `#`로 끝나는 저확률 오탐을 줄일 수 있다.

R1의 구체 판정 로직 제안:

1. `stripAnsi`, tail 폭은 15보다 넉넉한 30~40줄로 확장한다. Codex 하단 composer/status와 직전 assistant 출력이 같이 잡혀야 한다.
2. error tail 매칭.
3. Codex statusbar/profile signature 추출: `Read Only`, `Workspace Write`, `gpt-`, reasoning effort, working directory/statusbar 구획 등 실제 하단 상태줄 패턴 중 2개 이상이 최근 tail에 있으면 `codexFrameSeen=true`.
4. shell prompt returned는 `!codexFrameSeen && lastNonBlank matches SHELL_PROMPT_RE`일 때만 `launch_failed`.
5. busy 매칭: 기존 `esc to interrupt` 외에 `Working`과 spinner 변형, tool 실행 중 표식을 포함한다.
6. queued/composer dirty 감지: 최근 composer 라인이 `› <non-empty text>` 형태이거나, paste된 user prompt 일부가 하단 입력 영역에 남아 있고 busy 신호가 없으면 `agent_starting` with reason `input queued/composer dirty` 또는 새 상태 `agent_queued`.
7. ready 매칭: `busy=false && queued=false && (bare composer line present || codexFrameSeen)`이면 `agent_ready`. bare composer는 `^\s*›\s*$`처럼 빈 composer에 한정한다.

테스트는 캡처 fixture 중심이어야 한다: fresh empty composer, response completed but no bare `›`, Working spinner, approval prompt, queued composer text, shell prompt returned, output ending with `$`/`%`.

### R2 마커 wrap 내성

찬성. `extractMarkerBlock`과 `parseDoneSignal`이 "strip+trim 후 단독 줄 exact"만 인정하는 것은 에코 방어에는 좋지만, 좁은 pane에서 긴 `<<<PMUX_BEGIN agent=... turn=... req=...>>>`가 visual wrap되면 정상 마커도 `missing`이 된다.

구현은 exact match를 유지하면서 보조 경로로만 wrap tolerant parser를 추가하는 것이 좋다. 인접한 최대 2~3개 줄을 대상으로, 각 줄이 마커 fragment로만 구성되어 있을 때만 `trimmedParts.join("")` 또는 공백 보존 join으로 복원해 비교한다. Korean instruction, 따옴표, 일반 문장과 섞인 줄은 후보에서 제외해야 echo false positive가 늘지 않는다. `requestId` 게이트는 계속 필수다.

마커 단축도 검토할 만하다. 예: `<<<PMUX_B a=codex t=1 r=abc>>>`, `<<<PMUX_E ...>>>`, `<<<PMUX_D ... s=complete>>>`. 다만 기존 마커와 호환 파서를 같이 둬야 하므로 v2.2에서는 "wrap tolerant 먼저, 단축 마커는 additive alias"가 안전하다.

### R3 `pmux_agent_turn` 복합 툴

찬성. 회고상 LLM에게 `send -> capture polling -> capture_pane fallback`을 매번 올바르게 조합시키는 비용이 컸다. 21개에서 22개로 늘리는 값어치가 있다.

권장 계약:

- 입력은 `pmux_agent_send` 인자 대부분 + `timeoutMs`, `pollMs`, `captureTailLines`, `fallbackPaneLines`.
- 내부 순서: readiness/send 1회 -> `pmux_agent_capture` 폴링 -> complete/blocked/partial/working/missing 반환 -> timeout/missing 시 `pmux_capture_pane` tail 또는 content fallback 포함.
- 반환은 단순 본문만이 아니라 `sent`, `sendReason`, `captureStatus`, `source`, `elapsedMs`, `polls`, `tail`, `paneFallback`을 포함해야 한다.
- 장시간 작업에서 MCP 호출 자체가 너무 오래 잡히지 않도록 기본 60~90초, max 180초 정도로 제한한다.
- low-level `agent_send/status/capture`는 유지한다. 복합 툴은 권장 happy path이지 디버깅 primitive를 대체하면 안 된다.

### R4 라우팅 힌트

찬성. `pmux_agent_start` 반환의 `next`/`fallback`은 LLM 사용성을 직접 개선한다. 특히 `recommendedFileOutput:false`일 때 "send에는 fileOutput:false를 넣어라"를 기계적으로 다음 단계에 적어주는 것이 좋다.

`pmux_create_tab` 설명에는 반드시 `codex-cli`/`claude-code` panelType은 agent wrapper가 실행한 세션과 동일하지 않을 수 있으며, 에이전트 협업 목적이면 `pmux_agent_start`를 우선 쓰라고 명시해야 한다. 회고 #3은 이 경계가 모호해서 생긴 문제다.

### R5 cookbook

찬성. `docs/USAGE.md`에 에이전트 협업용 짧은 cookbook이 필요하다. 최소 예시는 다음 순서가 좋다.

1. `pmux_list_workspaces`
2. 새 에이전트는 `pmux_agent_start`
3. `next`에 따라 `pmux_agent_wait_ready`
4. `recommendedFileOutput:false`면 `pmux_agent_send(fileOutput:false)` 또는 v2.2의 `pmux_agent_turn(fileOutput:false)`
5. `capture`가 `missing/partial/working`이면 다음 턴을 보내지 말고 status/pane fallback 확인
6. 실패 시 `pmux_capture_pane`, 마지막에 `pmux_close_tab`

## 빠진 항목 / 뺄 항목

빠진 항목:

- 회고 #5의 queueing 구분. R1에 반드시 포함해야 한다. `agent_busy`와 `agent_ready` 사이에 "입력은 보냈지만 Codex가 아직 현재 턴으로 소비하지 않은 상태"가 존재한다.
- Codex pane fixture 기반 회귀 테스트. readiness는 코드만 봐서는 맞았는지 확인하기 어렵다.
- `pmux_agent_turn`의 timeout 정책과 phase별 구조화 반환. 단일 호출이 실패 원인을 숨기면 오히려 디버깅이 어려워진다.
- wrap tolerant marker parser의 echo 방어 조건. "인접 줄 concat"만 하면 footer 지시문 조각을 오탐할 수 있다.

뺄 항목은 없다. 다만 마커 단축은 v2.2 필수라기보다 additive 개선이다. 먼저 wrap parser와 테스트로 `missing`을 줄이고, 단축 마커는 호환성을 유지한 채 넣는 것이 안전하다.

## 리스크 top3

1. R1 ready 조건이 넓어져 busy/approval/queued 상태를 ready로 오탐하면, 새 입력이 Codex composer에 쌓이거나 다음 tool call 뒤로 밀린다. 회고 #5의 재발이다.
2. R2 wrap parser가 너무 관대하면 footer echo나 본문 인용을 정상 marker로 오탐한다. 단독 줄 원칙의 보안/결정론 가치가 약해진다.
3. R3 복합 툴이 긴 작업을 한 호출에 묶으면서 timeout, partial, missing을 단순 실패로 뭉개면 오케스트레이터가 복구 결정을 못 한다. phase별 반환을 유지해야 한다.

## 최종 의견

R1~R5 모두 v2.2 스코프로 채택에 동의한다. 단, R1은 "상태바 존재 + busy 부재"만으로 끝내지 말고 Codex의 dirty composer/queued input/approval prompt를 ready에서 제외하는 판정까지 포함해야 한다. 이 보강이 들어가면 회고의 #2, #4, #5가 같은 상태 모델 개선으로 연결된다.
