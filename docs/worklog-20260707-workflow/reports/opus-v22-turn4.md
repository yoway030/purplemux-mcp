verdict: APPROVE — B1 완전 해소(회귀 스위트 포함), C1·C3 타당. 라운드A 병합 가능.

# opus v2.2-turn4 — B1 수정 재검토 (최종)

## B1 해소 확인 ✅
- **순수 함수 `hasPriorTurnCompletion`(pane.ts:507)**: 마커 단일소스(`makeMarkers`/`makeDoneMarker`/`legacyDoneMarker`)에서 파생한 패턴만 사용 — 손으로 쓴 정규식 제거. 구조:
  - 구형 long-form DONE/END: `wildcardReqRegex`로 `agent=<id> turn=<n>` + **선택적/와일드카드 `req=\S+`** 매칭 → pre-R2 시맨틱(이전 턴 req 미상시 any/no-req 허용) 보존.
  - requestId 공급 시: R2 **단축형** `<<<PMUX_DONE req=<rid> status=…>>>` / `<<<PMUX_END req=<rid>>>>` exact 추가 → 기본 fileOutput=true 경로의 단축 DONE 인정.
  - standalone-line + wrap-tolerant(≤4줄 결합) — parseDoneSignal/extractMarkerBlock과 동일 정책.
- **`wildcardReqRegex` straddle 클램프(pane.ts:472-477)**: DONE 마커의 `turn=3 `와 ` status=` 사이 단일 공백이 prefix 말미·suffix 선두로 중복 계수되는 경계버그를 `min(rawSuffix, len-prefix, …)`로 정확 차단. 검증했고 파생 정규식이 no-req/probe-req 양쪽을 올바로 매칭.
- **agents.ts 자체 스캐너 제거·대체**: send가 `hasPriorTurnCompletion({turn: expectPrevTurnEnd, requestId: expectPrevRequestId})`로 위임(846-851). schemas에 `expectPrevRequestId` 추가(71) + validateId(718). 이전 턴 req를 호출자가 전달하는 계약이 API로 노출됨 — 단축형이 req-키인 구조적 제약에 대한 올바른 해법.
- **회귀 테스트(unit 700-808, 15케이스급)**: 내가 턴3에서 지목한 실패모드를 정확히 인코딩 —
  - 714 단축 DONE(req 공급)→인정 / **723 req 미공급 시 단축형 불인정**(B1 원인 그 자체) / 731·739 구형(no-req·arbitrary req) / 747·756 END / 765 wrap / 779 req불일치·788 turn불일치·797 agentId불일치 오염가드 / 806 무마커→false.
  → B1은 재발 방지 계약까지 포함해 완전 해소.

## 추가 수정 검토
- **C1 (queued 감지, pane.ts:239 `lastComposerLine` + classify 재배치)** ✅: composer 판정을 "pane 물리적 마지막 줄"이 아니라 "tail 내 glyph로 시작하는 마지막 줄"로 변경하고, **queued/bare 검사를 readyPattern fast-path보다 앞(312·316 vs 319)**에 배치. `--no-alt-screen`에서 dirty composer 아래로 상태바가 재그려질 때 fast-path가 `›`를 tail 아무데서나 보고 ready로 오승격하던 구멍을 닫음. 테스트 522(상태바가 composer 아래 렌더→여전히 input_queued)가 정확히 이 경로를 검증. 실캡처 460·466도 커버.
- **C3 (`requireBusyTransition`, agents.ts:546·625·639·657)** ✅: **기본 false=부팅 readiness**(즉시 ready 반환, 내 턴3 비블로킹 #3 해소), **true=send 후 대기**(busySeen 관측 후에만 ready). G4의 boot vs turn-completion 시맨틱을 파라미터로 정확히 분리. busy 윈도를 폴 간격이 놓치면 timeout+rawCliState/tail 반환(G8) — busy 자동강등 없이 수동복구 경로 유지. description(539)에 계약 명시.

## 비블로킹 관찰 (후속, 병합 저해 아님)
1. `lastComposerLine`이 pane 폴백에서 본문 중 `›`로 시작하는 줄(인용/마크다운)을 composer로 오인해 false input_queued 가능. 단 (a) 훅 세션은 cliState authoritative라 무관, (b) 오류 방향이 "ready로 과승격"이 아니라 "not_ready로 보수"라 안전측. glyph 휴리스틱 고유 한계로 수용.
2. 라운드B에서 agent_turn은 내부적으로 `requireBusyTransition:true`를 세팅해야 함(계약). claude 플랜모드 턴전이(ready-for-review→blocked) 실측은 라운드B 도그푸드 항목으로 유지(턴3 관찰 #2).

## 결론
B1이 재발방지 회귀스위트와 함께 완전 해소됐고, C1·C3는 실재 결함(queued-below-statusbar·boot/post-send busy 게이트)을 정확히 겨냥한 타당한 보강이다. typecheck·unit 81/81·e2e 31/31 통과. **라운드A(R0+R1+R2) APPROVE — 병합 가능.** 라운드B(R3 agent_turn·R4·R5)로 진행 권고.
