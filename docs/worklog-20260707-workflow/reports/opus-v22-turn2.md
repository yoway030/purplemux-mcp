APPROVE (설계 승인 — R0 방향 타당·PoC 근거 견고. 단 구현 게이트 7건: workspaceId allowlist[차단급], codex cliState PoC 미검증, PoC가 agent_start 경로였는지 확인, post-send stale race, 공통 사다리 step1 무상태 모호성, agent_blocked 소비자 일관성, R1 fixture=실캡처)

# opus v2.2-turn2 — design-v22 설계 합의

## 판정: APPROVE
R0(네이티브 상태 채널)은 v2.1의 정규식 화면판독보다 원칙1(결정론)에 명백히 부합하는 상위 기반이며, 라이브 PoC(busy→needs-input 전이 실측)로 근거가 확보됐다. pane을 폴백으로 강등한 결과 나의 턴1 최대 우려(R1이 미검증 경험칙 위에 구축)가 구조적으로 완화됐다. 턴1 조건 6건 전부 반영 확인. 승인하되, 아래 구현 게이트를 라운드 A 착수 전 계약으로 편입할 것.

## 턴1 조건 반영 확인 (6/6 ✓)
1. R1 실화면 게이트→fixture: §66 fixture 중심 단위테스트 목록화(fresh/bare›/Working/승인/queued/셸복귀/본문$끝) ✓ — 단 fixture는 **실 캡처에서 추출**해야 함(합성 금지, 과적합 방지). 아래 게이트7.
2. R3 유계·재개 계약: §80 timeout→{status:timeout, marker, expectedReportFile, tail}, 동일 marker로 capture 재개 ✓ (무상태라 자연 성립 — 정확).
3. R3 분리 게이트: §93-96 라운드 A(R0+R1+R2)/B(R3+R4+R5) ✓.
4. 큐잉 편입: §49 busy→send 거부 + §63 queued(`›`뒤 텍스트&&¬busy)→starting reason:input_queued ✓ — R0 훅 busy가 authoritative라 회고 #5가 근본 해소.
5. 마커 단축 우선+roundtrip: §71 단축 1차, 생성기+파서+footer+roundtrip 동시변경 필수, 파일 1줄차/EOF 불변 ✓.
6. capture -J 조사: §74/§102 조사 항목 ✓.

## R0 설계 타당성
- **cliState/command 재사용**: 기존 `GET /tabs/:id/status`가 이미 반환하던(우리가 안 쓰던) 필드 활용 — 신규 API 의존 없이 결정론 확보. 우수.
- **3층 신호 우선순위**(cliState→pane→file)와 **열린 집합 + signalSource 노출**(§54): 미지원값·버전 드리프트에 자연 폴백. self-healing 속성이 핵심 — hooks.json이 present-but-incompatible여도 cliState가 idle에 머물면 pane 폴백으로 강등되어 오작동이 아니라 열화로 수렴. 이 점이 R0을 안전하게 만든다.
- **hooksWired + 파일 부재 폴백**(§38-39): 미설치 변형 환경에서 기존 프로파일로 무변화 복귀. 방어적.
- **agent_blocked 신규 상태**(§50,53): ready-for-review/notification을 중립 반환+tail로 LLM 위임 — 나의 "애매하면 tail+LLM" 경계 원칙과 일치. 타당.

## 구현 게이트 (라운드 A 착수 전 계약)

**G1 [차단급] workspaceId allowlist 부재 = 신규 명령 인젝션 벡터.**
현재 `workspaceId`는 schemas.ts:18에서 `z.string().min(1)`뿐, 정규식 없음. 오늘은 HTTP query/body(인코딩)로만 흘러 안전하나, R0.1 codex 런치는 이를 pane에 보내는 셸 명령 `node <home>/.purplemux/codex-launcher.js --workspace-id <workspaceId>`에 **문자열 보간**한다 → 메타문자 주입 가능. 셸 명령에 들어가는 workspaceId(및 보간되는 모든 인자)는 착수 전 enum/정규식 allowlist 필수(원칙5). tabId 등 다른 보간 후보도 동시 점검.

**G2 [검증차단] codex cliState 경로 PoC 미검증.**
§14 PoC 표는 **claude 전용**(SessionStart/Stop 훅). 회고의 핵심 고통은 codex였는데, codex는 별도 경로(codex-launcher.js + codex-hook.sh + notify 이벤트)라 cliState 어휘·전이가 claude와 다를 수 있다. codex 훅 PoC(busy→needs-input/notify 실측)를 라운드 A 내에서 확보하기 전까지 codex는 cliState를 pane보다 우선 신뢰하지 말 것 — 미검증 구간은 pane+file 우위 유지.

**G3 [검증] PoC가 agent_start 경로였는지 확인.**
R0 가치 전체가 "우리 MCP가 만든 terminal 탭에 send한 에이전트의 훅이 그 탭의 cliState로 상관(correlate)된다"에 달림. PoC가 purplemux 네이티브 런치가 아니라 **agent_start(터미널 탭 생성→명령 send) 경로**로 수행됐고 훅이 tmux 세션명/`$TMUX_PANE`을 통해 우리 탭에 귀속됐는지 확인. 만약 hooks.json이 purplemux가 네이티브 런치 시 주입하는 env(세션 바인딩)에 의존한다면 우리 send 경로에선 그 env가 없어 상관 실패 → cliState가 안 움직인다. 이 경우 R0.1은 "런치 방식을 purplemux와 정확히 미러"해야 하며 근사로는 부족.

**G4 [스펙] post-send stale 상태 레이스.**
POST send와 busy 훅 발화 사이 지연 동안 cliState가 직전 turn의 `needs-input`/`idle`로 남아있을 수 있음. agent_turn/capture가 send 직후 첫 cliState를 완료로 오판하면 회고 #5(codex 부분출력) 재현. 완료 판정은 **busy 국면 관측(busy→needs-input 전이) 또는 유효 파일(EOF)/DONE 신호 증거를 요구**하고, 첫 스냅샷만으로 complete 선언 금지. 파일 경로는 EOF 게이트가 이미 보호하나 cliState-only 완료(fileOutput=false)는 이 레이스에 노출.

**G5 [스펙] 공통 사다리 step1의 무상태 모호성.**
§48 `command∈SHELL → (런치 후라면) launch_failed / (초기) shell_ready` — 무상태 서버는 "런치 후"를 알 수 없음(v2.1 §4.1 이미 명시한 한계). "공통 사다리"로 두면 status(무대기 스냅샷)에서 오판. 해법: 셸 감지는 중립 사실(`command=shell`)로 반환하고 각 툴이 자기 컨텍스트로 매핑(wait_ready=런치 후 계약→launch_failed, status=중립). 파라미터화하거나 사다리를 툴별로 특화.

**G6 [스펙] agent_blocked 소비자 일관성.**
ReadinessState에 값 추가 시 파급: wait_ready에서 agent_blocked는 **종단(terminal)**인가(승인 프롬프트는 자기해소 안 됨→계속 폴링하면 timeout 낭비)? send는 `sent:false, reason:"blocked"`? 모든 exhaustive switch/분기가 신규 값을 처리하는지. §50은 "send 부적합"만 말하고 wait_ready 종단성 미명시 → 명시 요.

**G7 [경미] R1 fixture=실캡처, hooksWired는 런치힌트일 뿐.**
R1 fixture는 실 codex/claude pane 덤프에서 추출(합성 시 동일 과적합). 그리고 `hooksWired:true`는 파일 존재만 뜻하지 배선 정상을 보장 안 함 → 문서/계약은 "런타임 진실은 per-call `signalSource`"임을 명시, 호출자는 hooksWired가 아니라 signalSource로 분기.

## 리스크 Top 3
1. **훅-탭 상관 미성립(G3)**: 성립 안 하면 R0 전체가 무효화되고 pane 폴백으로 회귀. → agent_start 경로 PoC로 라운드 A 최우선 검증.
2. **codex 경로 미검증(G2)**: 회고 핵심 대상인데 PoC 공백. → codex 훅 PoC 게이트.
3. **신규 인젝션 벡터(G1)**: 셸 보간 진입으로 v2.1엔 없던 표면. → allowlist 착수 전 필수.

세 리스크 모두 설계 결함이 아니라 구현 검증 항목이며, 폴백(hooksWired:false/signalSource=pane)이 안전망으로 존재하므로 설계 승인에 지장 없음.
