/**
 * `selectTargetLanguage` 속성 테스트 (Property-Based Tests).
 *
 * 본 파일은 `design.md` 의 다음 정확성 속성(Correctness Property) 을 검증한다.
 *
 * - Property 4: 번역 대상 언어 결정 (Validates Requirements 13.13)
 *
 * 검증 항목(spec 의 6 가지 invariant 을 1:1 매핑):
 * 1. **결정성** — 동일 입력에 대해 두 번 호출하면 항상 동일한 결과를 반환한다.
 * 2. **화이트리스트 override 보존** — override 가 `Curated_Target_Language_List` 에 포함되면
 *    `languageCode` 와 무관하게 그대로 반환된다.
 * 3. **화이트리스트 외 / undefined override 무시** — override 가 화이트리스트에 포함되지 않거나
 *    `undefined` 이면 기본 규칙이 적용된다.
 * 4. **`ko-KR` + override 미지정 → `"en"`** — 기본 규칙의 한국어 분기.
 * 5. **`en-US` + override 미지정 → `"ko"`** — 기본 규칙의 비-한국어 분기.
 * 6. **결과 도메인 봉쇄** — 결과는 항상 7 개 화이트리스트 값 중 하나.
 *
 * `fast-check` 3.x API 를 사용하며, 각 `fc.assert` 는 `numRuns: 200` 으로 충분한 샘플을 확보한다.
 */

import { describe, test, expect } from "vitest";
import fc from "fast-check";
import type {
	Curated_Target_Language,
	LanguageCode,
} from "../types/settings";
import { selectTargetLanguage } from "./selectTargetLanguage";

/**
 * `Curated_Target_Language` 화이트리스트의 모든 항목.
 *
 * 본 테스트의 generator 와 결과 도메인 검증에 사용되는 정적 배열이다.
 * 구현 모듈의 file-local `CURATED_TARGET_LANGUAGES` `Set` 과 의미상 동일해야 하며, 두 곳이
 * 서로 다른 7 개를 가지면 본 PBT 가 즉시 실패한다(회귀 게이트).
 */
const CURATED_TARGET_LANGUAGES: readonly Curated_Target_Language[] = [
	"en",
	"ko",
	"ja",
	"zh",
	"es",
	"fr",
	"de",
] as const;

/**
 * `LanguageCode` 유니온("ko-KR" | "en-US") 을 무작위 생성하는 arbitrary.
 */
const languageCodeArb: fc.Arbitrary<LanguageCode> = fc.constantFrom<LanguageCode>(
	"ko-KR",
	"en-US",
);

/**
 * 화이트리스트에 포함된 `Curated_Target_Language` 값을 무작위 생성하는 arbitrary.
 */
const curatedOverrideArb: fc.Arbitrary<Curated_Target_Language> =
	fc.constantFrom<Curated_Target_Language>(...CURATED_TARGET_LANGUAGES);

/**
 * 화이트리스트에 포함되지 않은 임의 문자열을 무작위 생성하는 arbitrary.
 *
 * 빈 문자열, 공백, 임의 ISO 639-1 코드 외의 값(예: `"xx"`, `"english"`, `"한국어"`) 을 모두
 * 포함시키되, 화이트리스트 7 개 값과 정확히 일치하는 경우는 `filter` 로 제외한다.
 */
const nonCuratedStringArb: fc.Arbitrary<string> = fc
	.string({ maxLength: 50 })
	.filter((s) => !(CURATED_TARGET_LANGUAGES as readonly string[]).includes(s));

/**
 * override 자리에 들어올 수 있는 모든 입력(undefined 포함) 을 생성하는 arbitrary.
 */
const anyOverrideArb: fc.Arbitrary<string | undefined> = fc.oneof(
	fc.constant(undefined),
	curatedOverrideArb,
	nonCuratedStringArb,
);

describe("selectTargetLanguage — Property 4: 번역 대상 언어 결정 (Validates Requirements 13.13)", () => {
	test("결정성 — 동일 입력에 대해 두 번 호출하면 항상 동일한 결과를 반환한다", () => {
		fc.assert(
			fc.property(languageCodeArb, anyOverrideArb, (languageCode, override) => {
				const first = selectTargetLanguage(languageCode, override);
				const second = selectTargetLanguage(languageCode, override);
				expect(first).toBe(second);
			}),
			{ numRuns: 200 },
		);
	});

	test("override 가 화이트리스트에 포함되면 languageCode 와 무관하게 그대로 반환한다", () => {
		fc.assert(
			fc.property(languageCodeArb, curatedOverrideArb, (languageCode, override) => {
				expect(selectTargetLanguage(languageCode, override)).toBe(override);
			}),
			{ numRuns: 200 },
		);
	});

	test("override 가 화이트리스트 외 값이면 기본 규칙(ko-KR → en, 그 외 → ko) 을 적용한다", () => {
		fc.assert(
			fc.property(languageCodeArb, nonCuratedStringArb, (languageCode, override) => {
				const expected: Curated_Target_Language =
					languageCode === "ko-KR" ? "en" : "ko";
				expect(selectTargetLanguage(languageCode, override)).toBe(expected);
			}),
			{ numRuns: 200 },
		);
	});

	test("override 가 undefined 이면 기본 규칙(ko-KR → en, 그 외 → ko) 을 적용한다", () => {
		fc.assert(
			fc.property(languageCodeArb, (languageCode) => {
				const expected: Curated_Target_Language =
					languageCode === "ko-KR" ? "en" : "ko";
				expect(selectTargetLanguage(languageCode, undefined)).toBe(expected);
			}),
			{ numRuns: 200 },
		);
	});

	test("ko-KR + override 미지정(undefined 또는 화이트리스트 외) → 'en'", () => {
		const nonCuratedOrUndefinedArb: fc.Arbitrary<string | undefined> = fc.oneof(
			fc.constant(undefined),
			nonCuratedStringArb,
		);

		fc.assert(
			fc.property(nonCuratedOrUndefinedArb, (override) => {
				expect(selectTargetLanguage("ko-KR", override)).toBe("en");
			}),
			{ numRuns: 200 },
		);
	});

	test("en-US + override 미지정(undefined 또는 화이트리스트 외) → 'ko'", () => {
		const nonCuratedOrUndefinedArb: fc.Arbitrary<string | undefined> = fc.oneof(
			fc.constant(undefined),
			nonCuratedStringArb,
		);

		fc.assert(
			fc.property(nonCuratedOrUndefinedArb, (override) => {
				expect(selectTargetLanguage("en-US", override)).toBe("ko");
			}),
			{ numRuns: 200 },
		);
	});

	test("결과는 항상 7 개 화이트리스트 값 중 하나이다", () => {
		const allowed: ReadonlySet<string> = new Set(CURATED_TARGET_LANGUAGES);

		fc.assert(
			fc.property(languageCodeArb, anyOverrideArb, (languageCode, override) => {
				const result = selectTargetLanguage(languageCode, override);
				expect(allowed.has(result)).toBe(true);
			}),
			{ numRuns: 200 },
		);
	});
});
