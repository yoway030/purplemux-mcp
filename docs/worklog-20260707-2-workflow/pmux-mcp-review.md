# pmux MCP 사용 회고

## 요약

pmux MCP 자체는 필요한 기능을 갖고 있었지만, 에이전트 탭, 일반 탭, wrapper 방식, pane 직접 입력 방식의 경계가 처음에 명확하지 않아 시행착오가 있었다.

가장 큰 문제는 MCP wrapper가 판단하는 ready/busy/done 상태와 실제 Codex/Claude CLI 화면 상태가 완전히 맞지 않았다는 점이다. 그 결과 사람이 보기에는 준비되었거나 응답이 끝난 상태인데도 `not_ready`, `launch_failed`, `missing` 같은 결과가 나왔다.

## 문제점

1. CLI와 MCP를 혼용하며 초반 비용이 생김

   처음에는 `purplemux` CLI로 탭 목록과 사용법을 확인했고, 이후 사용자가 "pmux mcp를 써"라고 한 뒤 MCP 도구를 검색해서 전환했다. MCP 도구가 처음부터 노출되어 있지 않아 `tool_search`가 필요했고, 그 전까지는 CLI 인자 실수로 불필요한 터미널 탭도 하나 생성됐다.

2. `pmux_agent_start`와 `pmux_agent_send`의 readiness 판정이 Codex에서 잘 맞지 않음

   `pmux_agent_start`로 만든 Codex 터미널은 실제로 Codex UI가 떠 있었지만, `pmux_agent_send`는 `not_ready` 또는 `launch_failed`로 판단했다. 화면상으로는 프롬프트가 보였는데 MCP wrapper의 ready pattern과 실제 Codex 화면 상태가 맞지 않은 것으로 보인다.

3. `codex-cli` panelType 탭이 바로 사용 가능하지 않았음

   `pmux_create_tab`으로 `codex-cli` 탭을 만들었지만 내부적으로는 빈 shell 상태였고, agent wrapper 기준으로는 `launch_failed`였다. 반면 `pmux_agent_start`로 만든 터미널 탭은 Codex가 실제 실행됐다. 즉 "codex-cli 패널"과 "터미널에서 codex 실행"의 동작 차이가 LLM 입장에서 직관적이지 않았다.

4. `pmux_agent_capture`와 실제 pane 내용의 차이

   Claude는 `pmux_agent_send`의 BEGIN/END 마커를 비교적 잘 따라줬지만, 그래도 `pmux_agent_capture`가 `missing`을 반환하면서 tail에만 결과가 보이는 경우가 있었다. 결국 `pmux_capture_pane`이 더 신뢰도 높은 수단이 됐다.

5. Codex의 3턴 응답이 중간에서 멈춤

   Codex는 3턴 합성에서 제목과 첫 줄 정도만 출력하고 멈췄다. 추가 입력은 "다음 tool call 이후 제출될 메시지" 큐에 들어갔고 즉시 처리되지 않았다. 이는 Codex CLI의 인터랙티브 상태와 pmux 입력 타이밍이 어긋난 문제로 보인다.

## 명령 처리가 매끄럽지 않았던 원인

가장 큰 원인은 상태 모델 불일치다.

MCP wrapper는 에이전트가 ready/busy/done인지 pane 텍스트 패턴으로 판단한다. 그런데 실제 Codex/Claude CLI 화면은 버전, UI 문구, alt-screen 여부, 현재 입력 상태에 따라 다르게 보인다. 그래서 사람이 보기에는 준비됐는데 wrapper는 준비 안 됐다고 판단하거나, 응답이 끝났는데 capture는 `missing`을 반환하는 일이 생겼다.

또 하나는 도구 계층이 여러 개였다는 점이다.

- `pmux_agent_start`: 터미널 만들고 에이전트 CLI 실행
- `pmux_agent_send`: PMUX 규약 포함해서 에이전트에게 요청
- `pmux_agent_capture`: 규약 기반 결과 회수
- `pmux_send_input`: pane에 직접 입력
- `pmux_capture_pane`: 화면 직접 캡처
- `pmux_create_tab`: 패널만 생성

이 중 어떤 조합이 Codex/Claude에 안정적인지 사전 지식 없이 바로 알기 어려웠다.

## 데이터 교환 문제

큰 데이터 손실은 없었다. Claude 쪽은 1턴, 2턴, 3턴 결과가 모두 pane capture로 확보됐고, Codex도 1턴, 2턴 결과는 확보됐다.

다만 구조화된 데이터 교환은 매끄럽지 않았다.

- `pmux_agent_capture`가 완성 본문을 structured result로 안정적으로 돌려주지 못하고 `missing + tail`이 된 경우가 있었다.
- 긴 프롬프트를 pane에 직접 보낼 때 줄바꿈과 화면 접힘 때문에 사람이 읽기에는 괜찮지만 기계적으로 추출하기는 불편했다.
- Codex 3턴처럼 응답이 중단되면 "현재 생성 중인지, 입력 대기인지, 큐가 막힌 건지" 구분이 어렵다.

결과적으로 최종 작업은 structured capture보다 pane 텍스트를 읽고 수동으로 추출하는 방식에 가까웠다.

## LLM이 더 원활히 쓰게 하는 방법

1. 추천 워크플로우를 명확히 문서화

   예시:

   - 먼저 `pmux_list_workspaces`
   - 새 에이전트는 `pmux_agent_start`
   - 반드시 `pmux_agent_wait_ready`
   - 실패하면 `pmux_capture_pane`
   - Codex는 `pmux_send_input + pmux_capture_pane` fallback 사용
   - 작업 종료 후 `pmux_close_tab`

2. agent wrapper 성공 경로와 pane fallback 경로를 도구 설명에 더 선명히 표시

   지금도 설명은 있지만, LLM 입장에서는 어떤 도구가 primary인지 판단하기 어렵다. 각 도구 description에 "Codex에서 ready 판정 실패 시 이 도구를 쓰라" 같은 라우팅 문장이 있으면 좋다.

3. `pmux_agent_start` 결과에 다음 권장 호출을 포함

   예시:

   ```json
   {
     "next": "call pmux_agent_wait_ready, then pmux_agent_send",
     "fallback": "if wait_ready timeout but pane shows Codex prompt, use pmux_send_input"
   }
   ```

4. pane capture와 agent capture를 통합한 고수준 도구 제공

   예: `pmux_agent_turn`

   - 입력 전송
   - readiness 확인
   - BEGIN/END 마커 주입
   - 일정 시간 polling
   - 실패 시 pane fallback
   - 최종 본문 추출

   LLM에게는 이 하나가 훨씬 쓰기 쉽다.

5. Codex/Claude별 known patterns 업데이트

   Codex CLI 화면의 `›`, `Working`, `Read Only`, `gpt-5.5 medium` 같은 실제 문구를 ready/busy 판정에 반영하면 `not_ready` 오판이 줄어들 것이다.

6. 긴 프롬프트/결과는 파일 기반 교환 권장

   이번에는 read-only/plan 모드라 `recommendedFileOutput:false`가 나왔는데, 가능한 경우에는 workspace-write 모드와 report file 기반이 더 안정적이다. 시처럼 짧은 작업은 pane으로도 되지만, 여러 턴 합성에는 파일 출력이 훨씬 낫다.

## MCP 인식과 사용법 파악

가능한 방법은 있었다. 실제로 `tool_search`로 "purplemux pmux tab create send result status..."를 검색하자 MCP 도구들이 노출됐다. 문제는 처음부터 MCP namespace가 보이지 않았고, 사용자가 "pmux"라고만 말했을 때 CLI와 MCP 중 어느 쪽을 원하는지 애매했다는 점이다.

개선 방향:

- pmux 관련 요청이 오면 먼저 `tool_search`에서 MCP 도구를 찾는 규칙을 둔다.
- "pmux mcp"가 명시되면 CLI를 쓰지 않고 바로 `mcp__purplemux` 도구를 사용한다.
- MCP 도구 목록에 "Start here: `pmux_list_workspaces`" 같은 첫 진입점이 더 강하게 표시되면 좋다.
- agent 작업용 cookbook 예제가 있으면 LLM이 시행착오 없이 따라갈 수 있다.

## 결론

이번 문제는 pmux MCP의 기능 부족보다는 LLM이 안정적인 사용 경로를 즉시 고르기 어려운 도구 UX 문제에 가까웠다.

특히 Codex CLI의 상태 감지와 structured capture가 불안정해서 fallback인 `pmux_send_input` / `pmux_capture_pane`에 의존하게 된 점이 핵심이다. 도구 설명과 고수준 wrapper가 보강되면 LLM이 훨씬 더 안정적으로 pmux MCP를 사용할 수 있다.
