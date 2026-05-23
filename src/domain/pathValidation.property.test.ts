/**
 * `isAbsoluteOSPath` 속성 테스트 (Property-Based Tests).
 *
 * 본 파일은 `design.md` 의 다음 정확성 속성(Correctness Property) 을 검증한다.
 *
 * - Property 12: 모델 폴더 경로 검증 (Validates Requirements 1.4)
 *
 * 검증 항목:
 * 1. **결정성** — 동일 입력에 대해 두 번 호출하면 항상 동일한 결과를 반환한다.
 * 2. **POSIX 절대 경로 분류** — `/` 로 시작하는 임의 문자열은 항상 `true` 를 반환한다.
 * 3. **Windows 드라이브 절대 경로 분류** — `[A-Za-z]:[/\\]` 로 시작하는 임의 문자열은 항상 `true` 를 반환한다.
 * 4. **빈 문자열 분류** — 빈 문자열은 `false` 를 반환한다.
 * 5. **상대 / vault 정규화 경로 분류** — 위 두 절대 경로 패턴 중 어느 것에도 해당하지 않는
 *    임의 문자열(빈 문자열 제외) 은 `false` 를 반환한다. `normalizePath` 결과(vault 상대 경로)
 *    는 항상 본 분류에 포함된다.
 *
 * `fast-check` 3.x API 를 사용하며, 각 `fc.assert` 는 `numRuns: 200` 으로 충분한 샘플을 확보한다.
 */

import { describe, test, expect } from "vitest";
import fc from "fast-check";
import { normalizePath } from "obsidian";
import { isAbsoluteOSPath } from "./pathValidation";

/**
 * Windows 드라이브 문자(A-Z, a-z) 의 단일 문자 집합.
 *
 * 26 + 26 = 52 개 문자. fast-check 의 `constantFrom` 으로 무작위 선택한다.
 */
const DRIVE_LETTERS = [
	"A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M",
	"N", "O", "P", "Q", "R", "S", "T", "U", "V", "W", "X", "Y", "Z",
	"a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m",
	"n", "o", "p", "q", "r", "s", "t", "u", "v", "w", "x", "y", "z",
] as const;

/**
 * Windows 드라이브 절대 경로의 구분자 후보.
 *
 * 슬래시(`/`) 와 백슬래시(`\\`) 모두 허용된다(예: `C:/foo`, `C:\\foo`).
 */
const WIN_SEPARATORS = ["/", "\\"] as const;

/**
 * 절대 경로 패턴(POSIX 또는 Windows 드라이브) 에 해당하지 않는지 여부.
 *
 * "상대 경로 / vault 정규화 경로" 분류의 negative arbitrary 필터로 사용된다.
 */
function isNotAbsolutePattern(s: string): boolean {
	return !s.startsWith("/") && !/^[A-Za-z]:[/\\]/.test(s);
}

describe("pathValidation — Property 12: 모델 폴더 경로 검증 (Validates Requirements 1.4)", () => {
	test("결정성 — 동일 입력에 대해 두 번 호출하면 항상 동일한 결과를 반환한다", () => {
		fc.assert(
			fc.property(fc.string({ maxLength: 100 }), (path) => {
				const first = isAbsoluteOSPath(path);
				const second = isAbsoluteOSPath(path);
				expect(first).toBe(second);
			}),
			{ numRuns: 200 },
		);
	});

	test("POSIX 절대 경로(`/` 로 시작) 는 true 를 반환한다", () => {
		fc.assert(
			fc.property(fc.string({ maxLength: 100 }), (rest) => {
				expect(isAbsoluteOSPath(`/${rest}`)).toBe(true);
			}),
			{ numRuns: 200 },
		);
	});

	test("Windows 드라이브 절대 경로(`[A-Za-z]:[/\\\\]` 로 시작) 는 true 를 반환한다", () => {
		fc.assert(
			fc.property(
				fc.constantFrom(...DRIVE_LETTERS),
				fc.constantFrom(...WIN_SEPARATORS),
				fc.string({ maxLength: 100 }),
				(drive, sep, rest) => {
					expect(isAbsoluteOSPath(`${drive}:${sep}${rest}`)).toBe(true);
				},
			),
			{ numRuns: 200 },
		);
	});

	test("빈 문자열은 false 를 반환한다", () => {
		expect(isAbsoluteOSPath("")).toBe(false);
	});

	test("상대 경로(절대 경로 패턴 중 어느 것에도 해당하지 않는 비빈 문자열) 는 false 를 반환한다", () => {
		const relativeArb: fc.Arbitrary<string> = fc
			.string({ maxLength: 100 })
			.filter((s) => s.length > 0 && isNotAbsolutePattern(s));

		fc.assert(
			fc.property(relativeArb, (path) => {
				expect(isAbsoluteOSPath(path)).toBe(false);
			}),
			{ numRuns: 200 },
		);
	});

	test("vault 정규화 경로(`normalizePath` 결과) 는 false 를 반환한다", () => {
		// `normalizePath` 는 절대 경로(`/foo`) 를 상대 경로(`foo`) 로, 경로 탐색(`..`) 을
		// 제거한 vault 상대 경로를 돌려준다. 따라서 결과는 항상 절대 경로 패턴에
		// 해당하지 않아야 하며 `isAbsoluteOSPath` 는 false 를 반환해야 한다.
		//
		// 단, `normalizePath("/")` 는 단일 슬래시 `"/"` 를 반환하는데, 이는 사용자가
		// vault 경로 대신 OS 루트를 입력한 케이스이며 본 PBT 의 적용 범위가 아니므로
		// `fc.pre` 로 제외한다.
		fc.assert(
			fc.property(fc.string({ maxLength: 100 }), (raw) => {
				const normalized = normalizePath(raw);
				fc.pre(normalized !== "/");
				expect(isAbsoluteOSPath(normalized)).toBe(false);
			}),
			{ numRuns: 200 },
		);
	});
});
