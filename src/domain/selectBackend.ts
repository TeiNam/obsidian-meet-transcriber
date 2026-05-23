/**
 * 백엔드 선택 정책 (`selectBackend`) — 순수 함수.
 *
 * 본 모듈은 사용자가 설정한 `Backend_Selection_Mode` 와 호출 측이 주입한 `Network_Probe`
 * (자격증명 / 네트워크 상태) 를 입력으로 받아 `Backend_Decision` 을 반환하는 단일 순수
 * 함수 `selectBackend` 만을 export 한다. AWS SDK / Obsidian API / `navigator` 등 외부
 * 효과는 일체 호출하지 않으며, 모든 외부 상태는 `networkProbe` 파라미터로 주입받는다.
 *
 * 본 모듈은 `design.md §4.10` 의 시그니처와 `design.md §Correctness Properties` 의
 * Property 2, `requirements.md` 의 Requirement 3.1 ~ 3.4 와 12.2 를 1:1 로 추적한다.
 *
 * 관련 요구사항:
 * - Requirement 3.1 — 세션 시작 시점에 `Backend_Selection_Mode` 평가.
 * - Requirement 3.2 — `cloud-only` 면 항상 `cloud`.
 * - Requirement 3.3 — `local-only` 면 항상 `local`.
 * - Requirement 3.4 — `auto` 의 사전 감지 단계에서 `accessKeyId` / `secretAccessKey` 가
 *   비어 있거나 `navigator.onLine === false` 면 `local` 로 폴백하고 사유를 표면화.
 * - Requirement 12.2 — 본 함수는 외부 효과 없는 순수 함수로 PBT 와 unit test 양쪽에서
 *   자유롭게 호출 가능해야 한다.
 *
 * 검증 속성 (Property 2):
 * - 결정성: 동일 입력 → 동일 출력.
 * - `cloud-only` → `backend === "cloud"` 항상.
 * - `local-only` → `backend === "local"` 항상.
 * - `auto` + (no-credentials | offline) → `backend === "local"` + `preflightFallbackReason !== undefined`.
 * - `auto` + 통과 → `backend === "cloud"` + `preflightFallbackReason === undefined`.
 */

import type {
	Backend_Decision,
	Network_Probe,
	TranscribeSettings,
} from "../types/settings";

/**
 * `selectBackend` 가 필요로 하는 `TranscribeSettings` 의 부분 집합.
 *
 * 본 함수는 `backendSelectionMode`, `accessKeyId`, `secretAccessKey` 만 참조하며 그 외
 * 필드(예: 모델 경로, 토글) 는 일절 사용하지 않는다. 호출 측(`main.ts`) 이 전체
 * `TranscribeSettings` 를 그대로 전달해도 형 호환을 위해 `Pick` 으로 좁힌 형태로 받는다.
 *
 * 본 시그니처는 `design.md §4.10` 의 `selectBackend` 정의와 정확히 일치한다.
 */
export type SelectBackendSettings = Pick<
	TranscribeSettings,
	"backendSelectionMode" | "accessKeyId" | "secretAccessKey"
>;

/**
 * 사용자 설정과 네트워크 사전 감지 결과를 입력받아 사용할 백엔드를 결정한다.
 *
 * 본 함수는 외부 효과 없는 순수 함수이며 동일 입력에 대해 항상 동일한 결과를 반환한다.
 * 호출 측이 `navigator.onLine` 과 `accessKeyId` / `secretAccessKey` 를 평가하여 만든
 * `networkProbe` 를 주입해야 한다 — 본 함수 내부에서는 `navigator` 또는 AWS SDK 등
 * 어떠한 전역도 참조하지 않는다.
 *
 * 분기 우선순위(Requirement 3.1 ~ 3.4):
 * 1. `cloud-only` → `{ backend: "cloud" }` (Requirement 3.2).
 * 2. `local-only` → `{ backend: "local" }` (Requirement 3.3).
 * 3. `auto` 의 사전 감지(pre-flight check) — `hasCredentials === false` 가 우선
 *    평가되며 그 다음 `isOnline === false` 가 평가된다(Requirement 3.4 (a), (b)).
 *    두 조건 중 하나라도 만족하면 `{ backend: "local", preflightFallbackReason }`.
 * 4. `auto` 의 사전 감지 통과 → `{ backend: "cloud" }`. 클라우드 세션 수립 도중에
 *    발생하는 폴백(Requirement 3.4 후반부) 은 본 함수의 책임이 아니다.
 *
 * @param settings - `TranscribeSettings` 의 백엔드 결정 관련 필드만 포함한 부분 집합.
 * @param networkProbe - 호출 측이 평가한 자격증명 / 네트워크 상태.
 * @returns 결정된 백엔드와 사전 감지 폴백 사유.
 */
export function selectBackend(
	settings: SelectBackendSettings,
	networkProbe: Network_Probe,
): Backend_Decision {
	switch (settings.backendSelectionMode) {
		case "cloud-only":
			// Requirement 3.2: 항상 cloud, 폴백 사유 없음.
			return { backend: "cloud" };

		case "local-only":
			// Requirement 3.3: 항상 local, 폴백 사유 없음.
			return { backend: "local" };

		case "auto": {
			// Requirement 3.4 (a): 자격 증명 누락은 네트워크 가용성보다 먼저 평가한다.
			// 자격 증명이 없으면 클라우드 호출 자체가 무의미하므로 사유를 명확히 분리해
			// 사용자에게 노출하기 위함이다.
			if (!networkProbe.hasCredentials) {
				return {
					backend: "local",
					preflightFallbackReason: "no-credentials",
				};
			}
			// Requirement 3.4 (b): `navigator.onLine === false` 인 경우 오프라인 폴백.
			if (!networkProbe.isOnline) {
				return {
					backend: "local",
					preflightFallbackReason: "offline",
				};
			}
			// 사전 감지 통과 — 활성 세션 수립을 시도하되, 실제 시도/폴백은 호출 측에서 처리한다.
			return { backend: "cloud" };
		}
	}
}
