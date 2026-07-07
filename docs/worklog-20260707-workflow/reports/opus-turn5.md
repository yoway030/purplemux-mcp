verdict: REJECT — 턴4 지적(B1·B2·비차단3)은 전부 정확히 반영 확인. 그러나 v2 신규 파일-회수 아키텍처에 blocking 2건(BN1 리포트 파일 신선도/신원 미검증, BN2 footer 상대경로 vs 서버 절대경로 불일치). 둘 다 국소 수정.

## 턴4 지적 반영 확인 — 3/3 정확히 반영 ✅

- **B1 (errorPattern tail 제한)**: §1 표 6행 + §4.2에 "4개 패턴 검사 전부 tail 15 기준 통일", 순서 error(tail)→셸복귀→busy(tail)→ready(tail)→starting. 내가 지적한 "다회차 협업에서 본문 인용 에러 문자열 영구 오탐"까지 근거로 명기. 완전 반영.
- **B2 (1줄차 상태줄 커밋 게이트 + tmp→rename)**: §3.2 "1줄차는 반드시 complete/blocked, 유효 상태줄 없으면 complete 미반환", §4.5 사다리 1(유효 파일)·2(무효 1줄차→working), footer에 write-then-rename 권장. 완전 반영.
- **비차단 3**: SHELL_PROMPT_RE 한계 §6 표 명시 ✅ / turn 정수 전용·재-emit=새 turn 번호 §3.2 ✅ / 결정론 경계 문구 §0.1 괄호 ✅.

## 신규 요소 평가

- **PMUX_DONE 1줄 신호(§3.1)**: 24줄 히스토리 생존을 위한 1줄 설계는 실측 정합. 단독 줄 규칙 재사용 적절. 단 §6 마지막 행의 에코 방어 논리에 허점(아래 비차단 N1).
- **pmux_agent_status(§4.4)**: "pane=상태" 원칙의 결정론 프리미티브로 타당. 1캡처+1status+파일 stat 조합 깔끔. 단 `reportFile`이 `exists`만 노출하고 1줄차 유효성은 안 봄 → 아래 비차단 N2.
- **회수 사다리(§4.5)**: 파일-우선·상태줄 게이트·inconsistent 분리까지 결정론적으로 잘 계단화됨. 그러나 사다리 1단(유효 파일=존재+1줄차)이 **신선도/신원 검증이 없어** BN1을 유발.

## BLOCKING

### BN1. 리포트 파일 신선도·신원 미검증 → 이전 세션 파일을 complete로 오회수 (§4.5 사다리 1, §3.2)

파일 경로가 `turn-<n>.md`(정수 turn만, requestId 없음)인데 turn은 **무상태·호출자 소유라 세션마다 0부터 재시작**한다(원칙 3). 즉 `turn-1.md` 충돌은 예외가 아니라 **정상 케이스**다.

- **실패 시나리오**: 어제 워크플로가 `.pmux-agents/opus/turn-0..5.md`를 남김(.gitignore돼도 파일은 잔존). 오늘 새 세션이 같은 agentId로 turn=1 send 후, 에이전트가 다 쓰기 전에 `pmux_agent_capture(turn=1)` 호출 → 사다리 1단이 **어제의 turn-1.md(1줄차 complete)**를 즉시 `{status:"complete", source:"file"}`로 반환. 오케스트레이터가 stale 내용을 진실로 채택. 반복 사용 시 상시 재현.
- 이는 원칙 1(결정론 우선)도 위배 — 신선도 판정을 코드가 못 하고 LLM이 "이거 어제 것 아냐?"를 눈치채야 함.
- **수정 권고(택1)**: ① send가 requestId(세션 유니크)를 강제하고 footer가 그 `req=<id>`를 **파일 1줄차와 DONE 신호 양쪽에 기입**하도록 지시 → capture가 1줄차 requestId 일치를 회수 조건에 추가(신원 게이트). 무상태 유지. ② 또는 파일 경로에 requestId 포함(`turn-<n>.<req>.md`). ③ 또는 bootstrap(turn=0) send가 `.pmux-agents/<agentId>/`를 청소(fs, 서버 메모리 아님). — ①이 사다리의 "유효 파일" 정의에 신원까지 넣어 가장 결정론적.

### BN2. footer는 **상대경로** 쓰기 지시, 서버는 **절대경로** 읽기 → cwd≠workspaceDir[0]이면 주 경로 상시 미스 (§3.4 vs §3.2)

§3.4 footer는 `.pmux-agents/<agentId>/turn-<n>.md 에 저장`(에이전트 cwd 기준 상대)인데, 서버는 §3.2 `<workspaceDir=directories[0]>/.pmux-agents/...`(절대)로 읽는다.

- **실패 시나리오**: 에이전트 셸 cwd가 workspace의 두 번째 디렉터리이거나 하위 디렉터리면, 에이전트는 그 cwd 하위에 파일을 쓰고 서버는 directories[0] 하위를 stat → `exists=false` → 매 턴 pane 폴백. v2의 핵심 전제(파일=내용)가 조용히 무력화되고 24줄 TUI에서 본문 유실로 되돌아감.
- terminal 탭 기본 cwd가 directories[0]과 일치하면 우연히 동작하나 **보장 없음** — 결정론 원칙에 어긋나는 "우연 의존".
- **수정 권고**: footer가 send 조립 시 **해석된 절대 workspaceDir을 치환해 절대경로로 저장 지시**(에이전트가 그대로 복사) — 서버 읽기 경로와 동일 문자열 보장. 또는 설계에 "에이전트 cwd=directories[0] 고정" 전제를 §3.2에 명문화(단 start가 cwd를 강제할 수단 확인 필요).

## 비차단 관찰 (기록)

- **N1 — DONE 예시 줄의 치환 에코**: footer를 send가 조립(§3.4)하며 `<agentId>/<n>`을 실값 치환하므로, 화면에 출력하라고 보여준 `<<<PMUX_DONE ... status=complete>>>` **예시 줄 자체가 실제 신호와 동일 문자열로 pane 상단에 에코**된다. §6은 "마지막 매치만 인정 + 실제 신호는 하단"으로 방어하나, 에이전트가 자기 신호를 **한 번도 못 냄(blocked/크래시/스크롤아웃)** 경우 상단 에코가 유일·마지막 매치가 되어 `doneSignal=found:complete` 오탐. capture는 파일-우선이라 내용 오회수까지는 안 가지만(BN1 없을 때), `pmux_agent_status.doneSignal`과 사다리 3단(inconsistent) 판정이 흔들림. → 권고: 에코 예시 줄은 플레이스홀더를 **리터럴로 유지**(`<agentId>` 그대로)하거나, DONE 신호를 "유효 파일과 공출현할 때만 유효"로 게이트.
- **N2**: `pmux_agent_status.reportFile`이 `exists`만 노출 — capture의 "유효(1줄차)" 개념과 어긋나 exists=true를 complete로 오해 소지. 1줄차 상태(status/none)를 함께 노출하면 사다리와 일관.
- **N3(구현 힌트)**: paths.ts `realpath` 격리 검증은 대상 파일 부재 시 throw하므로, 파일 미존재를 "격리 위반"과 구분해 정상 폴백(missing)으로 처리할 것.

## 종합

턴4 3건은 모범적으로 반영됐고 상태기계·사다리·status 프리미티브의 결정론 설계 방향은 우수. 다만 v2가 새로 들인 파일-회수 경로에서 BN1(신선도/신원)·BN2(경로 정합)는 "파일=진실" 전제를 직접 무너뜨리므로 승인 전 필수 수정. 둘 다 footer 조립 한 곳(requestId 기입 + 절대경로 치환)에서 대부분 해결되는 국소 수정이라, 반영 후 APPROVE 예상.
