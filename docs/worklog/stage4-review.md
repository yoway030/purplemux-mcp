# Worklog · Stage 4 — 리뷰 (Review)

**목표:** 구현 코드 심층 리뷰 → 합의된 실이슈 수정.
**대상:** `src/{index,config,http,errors,schemas,tools}.ts`.

## 방식
- 사전에 확정적 폴리시 5건(Stage 3 이월분: content-type 대소문자, 409 메타 제네릭 포워딩, 503 retryable, eval 설명, expression `.min(1)`) 먼저 적용.
- 이후 **3에이전트 독립 심층 리뷰**(Sonnet/Opus/Codex) — 잔여 실버그/견고성/보안/엣지 헌팅. 각 지적을 교차검증해 합의된 것만 반영.

## 리뷰 결과 & 교차검증
| 이슈 | Codex | Sonnet | Opus | 처리 |
|---|---|---|---|---|
| `savePath` 임의경로/덮어쓰기·상대경로 | blocking | nit | nit | **3/3 → 수정** |
| 포트 인젝션: `PMUX_PORT="1234@evil:80"` → baseUrl 호스트 탈취, 토큰 오프호스트 유출 | blocking | – | – | **오케스트레이터 실증 → 수정** |
| json인데 빈/비JSON 바디 → `res.json()` opaque SyntaxError | – | – | nit | **수정** |
| base64 모드서 서버가 png 바이트 반환 시 UTF-8 디코드→깨진 이미지 | – | – | nit | **수정** |
| readTrimmed ENOENT/EACCES 동일취급, `as never` | – | nit | – | 스킵(경미) |

## 반영한 수정 (4건)
1. **config.ts** `isValidPort()`(정수 1–65535) + `resolveConnection`에서 검증 실패 시 즉시 에러. `connection_info`도 `portValid` 노출 + 무효 시 baseUrl 숨김. → **포트 인젝션/토큰 유출 차단.**
2. **schemas/tools** `savePath` `.min(1)` + `isAbsolute` 강제 + `writeFile flag:"wx"`(기존 파일 덮어쓰기 거부) + 실패를 `ToolError`로 래핑.
3. **http.ts** json 응답을 text→parse 방식으로 디코드(빈 바디 `{}`, 비JSON은 원문 반환) — `res.json()` 예외 제거.
4. **tools screenshot 기본경로** 항상 raw로 받아 content-type 보고 png 바이트면 직접 base64 인코딩, json이면 파싱 — 서버 양쪽 응답 형태 견고 처리.

## 실증 검증 (결정적)
- `npm run build` / `typecheck` 클린, 라이브 스모크 16툴+`pmux_list_workspaces` 정상, `connection_info.portValid:true`.
- **보안 회귀 테스트:** `PMUX_PORT="1234@example.com:80"`로 서버 기동 → `pmux_list_workspaces` 호출 → `isError:true`, "Invalid purplemux port … 1-65535", **오프호스트 요청 시도 없음(fetch 전 차단)**.

## 합의 판정
- Sonnet·Opus = APPROVE. Codex = CHANGES_REQUESTED(2 blocking) → **요구 사항 그대로 적용 + 실측 검증으로 해소**(이견 무시 아님). ⇒ **Stage 4 합의 성립.**

## 다음: Stage 5 · 테스트 & 등록
라이브 e2e(생성→전송→캡처→종료 라운드트립) + Claude Code / Codex에 MCP 등록 + 3에이전트 최종 합의.
