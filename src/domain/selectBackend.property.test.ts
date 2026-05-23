/**
 * `selectBackend` 속성 테스트 (Property-Based Tests).
 *
 * 본 파일은 `design.md` 의 정확성 속성(Correctness Property) Property 2 를 검증한다.
 *
 * **Validates: Requirements 3.1, 3.2, 3.3, 3.4, 12.2** (Property 2)
 *
 * Property 2 는 다음 5 개 invariant 으로 분리 검증한다:
 * 1. **결정성** — 동일 `(settings, networkProbe)` 입력에 대해 두 번 호출하면 항상 동일한
 *    `Backend_Decision` 을 반환한다.
 * 2. **`cloud-only` 분기** — `backendSelectionMode === "cloud-only"` 면 임의의
 *    `networkProbe` 와 자격 증명 조합에서 항상 `backend === "cloud"`.
 * 3. **`local-only` 분기** — `backendSelectionMode === "local-only"` 면 임의의
 *    `networkProbe` 와 자격 증명 조합에서 항상 `backend === "local"`.
 * 4. **`auto` 폴백 분기** — `backendSelectionMode === "auto"` 이고 사전 감지 폴백 조건
 *    (자격 증명 누락 또는 `isOnline === false`) 중 하나라도 만족하면 항상 `backend === "local"`
 *    이고 `preflightFallbackReason !== undefined`.
 * 5. **`auto` 통과 분기** — `backendSelectionMode === "auto"` 이고 사전 감지가 모두 통과하면
 *    (`hasCredentials === true && isOnline === true`) 항상 `backend === "cloud"` 이고
 *    `preflightFallbackReason === undefined`.
 *
 * `fast-check` 3.x API 를 사용하며, 각 `fc.assert` 는 `numRuns: 200` 으로 충분한 샘플을 확보한다.
 */

import { describe, test, expect } from "vitest";
import fc from "fast-check";
import { selectBackend, type SelectBackendSettings } from "./selectBackend";
import type {
	Backend_Selection_Mode,
	Network_Probe,
} from "../types/settings";

/**
 * `Backend_Selection_Mode` 의 모든 리터럴 값.
 *
 * 결정성 테스트는 세 모드 모두에서 검증되어야 한다.
 */
const ALL_MODES: ReadonlyArray<Backend_Selection_Mode> = [
	"cloud-only",
	"local-only",
	"auto",
];

/**
 * `SelectBackendSettings` 임의 생성기.
 *
 * `accessKeyId` / `secretAccessKey` 는 빈 문자열을 포함한 임의 문자열을 생성하며,
 * `backendSelectionMode` 는 세 리터럴 값 중 하나를 균등 확률로 선택한다.
 */
function arbSettings(): fc.Arbitrary<SelectBackendSettings> {
	return fc.record({
		backendSelectionMode: fc.constantFrom(...ALL_MODES),
		accessKeyId: fc.string({ maxLength: 64 }),
		secretAccessKey: fc.string({ maxLength: 128 }),
	});
}

/**
 * `Network_Probe` 임의 생성기.
 *
 * `hasCredentials` / `isOnline` 의 모든 4 가지 조합을 균등 확률로 생성한다.
 */
function arbNetworkProbe(): fc.Arbitrary<Network_Probe> {
	return fc.record({
		hasCredentials: fc.boolean(),
		isOnline: fc.boolean(),
	});
}

describe("selectBackend — Property 2: 백엔드 선택 결정성과 모드별 분기 (Validates Requirements 3.1, 3.2, 3.3, 3.4, 12.2)", () => {
	test("결정성 — 동일 (settings, networkProbe) 입력에 대해 두 번 호출하면 항상 동일한 결과를 반환한다", () => {
		fc.assert(
			fc.property(arbSettings(), arbNetworkProbe(), (settings, probe) => {
				const first = selectBackend(settings, probe);
				const second = selectBackend(settings, probe);
				expect(first).toEqual(second);
			}),
			{ numRuns: 200 },
		);
	});

	test("`cloud-only` 분기 — 임의의 networkProbe / 자격증명 조합에서 항상 backend === 'cloud'", () => {
		fc.assert(
			fc.property(
				fc.string({ maxLength: 64 }),
				fc.string({ maxLength: 128 }),
				arbNetworkProbe(),
				(accessKeyId, secretAccessKey, probe) => {
					const settings: SelectBackendSettings = {
						backendSelectionMode: "cloud-only",
						accessKeyId,
						secretAccessKey,
					};
					const decision = selectBackend(settings, probe);
					expect(decision.backend).toBe("cloud");
					// Requirement 3.2: 사전 감지 폴백은 cloud-only 모드에서 발생하지 않는다.
					expect(decision.preflightFallbackReason).toBeUndefined();
				},
			),
			{ numRuns: 200 },
		);
	});

	test("`local-only` 분기 — 임의의 networkProbe / 자격증명 조합에서 항상 backend === 'local'", () => {
		fc.assert(
			fc.property(
				fc.string({ maxLength: 64 }),
				fc.string({ maxLength: 128 }),
				arbNetworkProbe(),
				(accessKeyId, secretAccessKey, probe) => {
					const settings: SelectBackendSettings = {
						backendSelectionMode: "local-only",
						accessKeyId,
						secretAccessKey,
					};
					const decision = selectBackend(settings, probe);
					expect(decision.backend).toBe("local");
					// Requirement 3.3: 사전 감지 폴백은 local-only 모드에서 발생하지 않는다.
					expect(decision.preflightFallbackReason).toBeUndefined();
				},
			),
			{ numRuns: 200 },
		);
	});

	test("`auto` + 폴백 조건 (자격 증명 누락 또는 오프라인) — backend === 'local' + preflightFallbackReason !== undefined", () => {
		// 폴백 트리거: hasCredentials === false 이거나 isOnline === false 인 경우.
		const fallbackProbeArb: fc.Arbitrary<Network_Probe> = arbNetworkProbe()
			.filter((p) => !p.hasCredentials || !p.isOnline);

		fc.assert(
			fc.property(
				fc.string({ maxLength: 64 }),
				fc.string({ maxLength: 128 }),
				fallbackProbeArb,
				(accessKeyId, secretAccessKey, probe) => {
					const settings: SelectBackendSettings = {
						backendSelectionMode: "auto",
						accessKeyId,
						secretAccessKey,
					};
					const decision = selectBackend(settings, probe);
					// Requirement 3.4: auto 폴백 시 backend = local + 폴백 사유 표면화.
					expect(decision.backend).toBe("local");
					expect(decision.preflightFallbackReason).toBeDefined();
					// 폴백 사유는 두 정의된 리터럴 값 중 하나여야 한다.
					expect([
						"no-credentials",
						"offline",
					]).toContain(decision.preflightFallbackReason);
				},
			),
			{ numRuns: 200 },
		);
	});

	test("`auto` + 사전 감지 통과 (hasCredentials && isOnline) — backend === 'cloud' + preflightFallbackReason === undefined", () => {
		// 사전 감지 통과 조건: hasCredentials === true && isOnline === true.
		const passProbe: Network_Probe = {
			hasCredentials: true,
			isOnline: true,
		};

		fc.assert(
			fc.property(
				fc.string({ maxLength: 64 }),
				fc.string({ maxLength: 128 }),
				(accessKeyId, secretAccessKey) => {
					const settings: SelectBackendSettings = {
						backendSelectionMode: "auto",
						accessKeyId,
						secretAccessKey,
					};
					const decision = selectBackend(settings, passProbe);
					// Requirement 3.4 후반부: 사전 감지 통과 시 cloud 시도 (활성 세션 폴백은 본 함수 책임 외).
					expect(decision.backend).toBe("cloud");
					expect(decision.preflightFallbackReason).toBeUndefined();
				},
			),
			{ numRuns: 200 },
		);
	});
});
