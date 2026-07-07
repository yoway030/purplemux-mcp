DONE

## 담당 범위
turn=2 리뷰 회귀 수정 (design-v1.md §2.2 분류 순서·agent_busy 추가, §4.6 classifyReadiness 시그니처 변경)

## 수정 파일
- `src/pane.ts`
  - `ReadinessState`에 `"agent_busy"` 추가 (`"agent_ready" | "agent_busy" | "agent_starting" | "launch_failed"`).
  - `classifyReadiness`를 §2.2 지정 순서로 재구현:
    1. `errorPattern` (pane 전체) → `launch_failed`
    2. 셸 프롬프트 복귀 (마지막 비공백 줄, `SHELL_PROMPT_RE = /[$#%]\s*$/`) → `launch_failed`
    3. `busyPattern` — **`tailLines(pane, 15)`에서만 평가** → `agent_busy`
    4. `readyPattern` — **`tailLines(pane, 15)`에서만 평가** → `agent_ready`
    5. 그 외 → `agent_starting`
  - 시그니처에 `busyPattern?: RegExp` 파라미터 추가.
  - 순서 변경의 의도: stale 글리프(예전 세션의 `›`가 스크롤백 위쪽에 남아있는 경우) 오판 방지 — error/셸복귀가 ready/busy보다 먼저 검사되고, ready/busy는 tail 15줄로 범위가 제한되므로 스크롤백 위쪽의 낡은 글리프가 최근 실패/busy 신호를 이길 수 없음.
- `src/profiles.ts`
  - `defaultBusyPattern(p: Provider): RegExp` export 추가. codex/claude 공통으로 `BUSY_RE = /esc to interrupt/i` 반환 (provider 인자는 시그니처 대칭을 위해 받되 미사용).
- `test/unit.mjs`
  - 케이스 4개 추가:
    1. `stale ready glyph earlier + recent command-not-found → launch_failed` — 위쪽에 stale `›`, 최근 줄에 `command not found` + 셸 프롬프트.
    2. `stale ready glyph earlier + recent shell-prompt return → launch_failed` — 위쪽에 stale `›`, 최근 줄은 순수 셸 프롬프트 복귀(에러 문자열 없음).
    3. `agent_busy (esc to interrupt in tail)` — busy 패턴만 존재 시 `agent_busy`.
    4. `busy takes priority over ready when both present in tail` — 같은 tail 안에 `❯`와 `esc to interrupt`가 동시에 있을 때 busy 우선.

## 테스트 결과
- `npm run typecheck` — 통과 (에러 0건, `src/agents.ts` 관련 에러 없음).
- `npm run build && node test/unit.mjs` — **27/27 통과** (기존 23건 + 신규 4건).

## 특이사항
- 없음. `src/agents.ts`, `src/schemas.ts`, `src/tools.ts`, `test/e2e.mjs`는 수정하지 않음 (다른 워커 담당).
