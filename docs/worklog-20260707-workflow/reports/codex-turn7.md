APPROVE

검토 범위: design-v2.md §3.1, §3.4, §4.5, §6.5.

턴6 blocking 해소 확인:
- §3.1의 DONE 신호 형식이 `<<<PMUX_DONE agent=<agentId> turn=<n> req=<requestId> status=complete|blocked>>>`로 고정되어 §4.4/§4.5의 req 게이트 파서와 일치합니다.
- §3.4 footer 조립 지시도 `"DONE agent=<agentId> turn=<n> req=<rid> status=complete>>>"`를 분할 문자열로 조립하게 하므로, req 없는 DONE이 생성되는 불일치가 사라졌습니다.
- 완성형 DONE/EOF 문자열을 footer에 직접 포함하지 않는 분할 문자열 방식은 prompt echo에 완전 마커가 생기는 문제를 닫습니다.

Opus 비차단 반영 확인:
- §4.5는 requestId를 스키마상 optional로 유지하되 파일 경로 회수는 requestId 없이는 시도하지 않는 런타임 규칙으로 정리되어, pane 블록 폴백과 fileOutput 경로가 충돌하지 않습니다.
- §4.5의 EOF 판정은 "최종 비공백 줄" 기준이며 content 범위가 2줄부터 EOF 직전까지로 명확해졌습니다. 본문 중간에 EOF 문자열이 인용되는 경우를 complete로 오판하지 않는 조건입니다.
- §6.5의 동일 agentId+turn 동시성 한계는 단일 오케스트레이터 전제로 명시되어 있고, req 불일치가 stale/working으로 구조화된다는 점도 충분합니다.

남은 blocking 없음.
