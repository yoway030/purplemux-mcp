REJECT

blocking: docs/worklog-20260707-workflow/design-v2.md:89,124,138-142 — `PMUX_DONE` is specified as req-gated in status/capture, but the v2.1 footer tells the agent to print `<<<PMUX_DONE agent=<agentId> turn=<n> status=complete>>>` with no `req=<rid>`; either the real DONE signal will never match the req-gated parser, or the parser must accept non-req DONE and reopens stale DONE false positives for reused agentId/turn.

EOF 커밋 게이트 판정:
- §3.2/§4.5의 파일 이중 게이트, 즉 1줄차 `status=<s> req=<rid>`와 마지막 줄 `PMUX_EOF req=<rid>`를 모두 확인하고 content를 2줄부터 EOF 직전까지만 읽는 방식은 순차 기록에서 검증 가능한 커밋 조건입니다.
- 이전에 제가 지적한 "1줄차만 먼저 쓰인 뒤 본문이 아직 쓰이는 중인데 complete로 읽히는" 문제는 EOF가 마지막 줄에 req 일치로 존재해야만 유효 파일로 인정하는 조건으로 해소됩니다.
- tmp→rename을 강제하지 않아도, writer가 프로토콜대로 EOF를 마지막에 쓰는 한 reader는 EOF 부재 파일을 `working`으로 분류할 수 있으므로 truncated read를 complete로 반환하지 않습니다.

반영 확인:
- DONE 에코 오탐 대응 방향은 타당합니다. footer가 완성형 마커를 직접 포함하지 않고 분할 문자열 조립을 지시하면 prompt echo 안에 완전한 DONE/EOF 라인이 생기지 않습니다.
- stale 파일 대응도 방향은 타당합니다. requestId를 fileOutput 경로에서 사실상 필수화하고, send가 자동 생성해 반환하며, capture가 1줄차 req와 EOF req를 모두 확인하는 구조는 이전 세션의 `turn-1.md` 재사용 문제를 닫습니다.
- 절대경로 치환도 타당합니다. send가 workspaceDir을 해석해 footer와 서버 읽기 경로에 같은 절대경로를 쓰게 하면 에이전트 cwd 의존성이 줄어듭니다.

정리:
- EOF 기반 파일 커밋 설계는 APPROVE입니다.
- 전체 v2.1은 DONE footer에 `req=<rid>`를 포함하도록 고치기 전까지 REJECT입니다. DONE split string은 예컨대 `"DONE agent=<agentId> turn=<n> req=<rid> status=complete>>>"` 형태로 조립 지시되어야 §4.4/§4.5의 req 게이트와 일치합니다.
