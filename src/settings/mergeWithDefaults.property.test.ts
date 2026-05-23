/**
 * `mergeWithDefaults` 속성 테스트 (Property 1).
 *
 * Property 1: 설정 자동 채움 보존성
 * **Validates: Requirements 1.8, 8.5, 13.1**
 *
 * 속성 명세(design §Correctness Properties Property 1):
 * *For any* `Partial<TranscribeSettings>` 입력(`null`, `undefined`, 빈 객체, 일부 필드만
 * 포함된 객체 등) 에 대해, `mergeWithDefaults(saved)` 의 결과는 다음을 만족한다.
 *
 * 1. v1.1 의 모든 신규 필드(`backendSelectionMode`, `localModelId`, `modelFolder`,
 *    `streamingDisplayMode`, `timestampOutputEnabled`, `speakerDiarizationEnabled`,
 *    `translationEnabled`, `translationTargetLanguage`, `translationOutputFormat`) 가
 *    정의된 타입의 값으로 존재한다.
 * 2. `saved` 에 포함된 v1.0 필드(`accessKeyId`, `region` 등) 는 변경 없이 보존된다.
 * 3. 화이트리스트 외 값(예: `backendSelectionMode = "invalid"`) 은 기본값으로 강제 복귀된다.
 *
 * 본 PBT 는 위 3가지 invariant 을 각각 별도의 `it` 블록으로 분리하여 검증한다
 * (fast-check `it` 1개 = property 1개 규약, design §Property-Based Testing).
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
	DEFAULT_SETTINGS,
	type Backend_Selection_Mode,
	type Curated_Target_Language,
	type LanguageCode,
	type Streaming_Display_Mode,
	type SupportedLocale,
	type TranscribeSettings,
	type Translation_Output_Format,
} from "../types/settings";
import { mergeWithDefaults } from "./mergeWithDefaults";

// ---------------------------------------------------------------------------
// 화이트리스트 상수 — `mergeWithDefaults` 의 검증 규칙과 동일해야 한다
// ---------------------------------------------------------------------------

const ALLOWED_BACKEND_MODES: readonly Backend_Selection_Mode[] = [
	"cloud-only",
	"local-only",
	"auto",
];
const ALLOWED_STREAMING_DISPLAY_MODES: readonly Streaming_Display_Mode[] = [
	"progress-only",
	"chunked-streaming",
];
const ALLOWED_TRANSLATION_OUTPUT_FORMATS: readonly Translation_Output_Format[] =
	["inline", "none"];
const ALLOWED_TARGET_LANGUAGES: readonly Curated_Target_Language[] = [
	"en",
	"ko",
	"ja",
	"zh",
	"es",
	"fr",
	"de",
];
const ALLOWED_LANGUAGE_CODES: readonly LanguageCode[] = ["ko-KR", "en-US"];
const ALLOWED_UI_LOCALES: readonly SupportedLocale[] = ["en", "ko"];

// v1.0 필드 키 목록 — 보존 검증 시 사용한다(Requirement 8.5).
const V1_0_FIELD_KEYS = [
	"uiLocale",
	"accessKeyId",
	"secretAccessKey",
	"region",
	"bedrockModelId",
	"languageCode",
	"transcriptFolder",
	"transcribeVocabularyName",
	"vocabularyPhrases",
	"analysisGlossary",
] as const satisfies readonly (keyof TranscribeSettings)[];

// v1.1 신규 필드 키 목록 — 존재 검증 시 사용한다(Requirement 1.8, 13.1).
const V1_1_FIELD_KEYS = [
	"backendSelectionMode",
	"localModelId",
	"modelFolder",
	"streamingDisplayMode",
	"timestampOutputEnabled",
	"speakerDiarizationEnabled",
	"translationEnabled",
	"translationTargetLanguage",
	"translationOutputFormat",
] as const satisfies readonly (keyof TranscribeSettings)[];

// ---------------------------------------------------------------------------
// 공통 생성기
// ---------------------------------------------------------------------------

/**
 * v1.0 필드 부분(또는 전체)을 생성하는 arbitrary.
 *
 * 모든 키는 `requiredKeys: []` 옵션으로 누락 가능하게 한다 — saved 에 키 자체가 포함되지
 * 않은 케이스(`undefined` 가 아닌 누락) 를 시뮬레이션한다.
 */
const partialV1_0Arb = fc.record(
	{
		uiLocale: fc.constantFrom<SupportedLocale>(...ALLOWED_UI_LOCALES),
		accessKeyId: fc.string({ maxLength: 128 }),
		secretAccessKey: fc.string({ maxLength: 256 }),
		region: fc.string({ minLength: 1, maxLength: 64 }),
		bedrockModelId: fc.string({ maxLength: 256 }),
		languageCode: fc.constantFrom<LanguageCode>(...ALLOWED_LANGUAGE_CODES),
		transcriptFolder: fc.string({ maxLength: 200 }),
		transcribeVocabularyName: fc.string({ maxLength: 200 }),
		vocabularyPhrases: fc.string({ maxLength: 500 }),
		analysisGlossary: fc.string({ maxLength: 500 }),
	},
	{ requiredKeys: [] },
);

/**
 * v1.1 신규 필드의 *유효한* 값(화이트리스트 내) 부분을 생성하는 arbitrary.
 */
const partialV1_1ValidArb = fc.record(
	{
		backendSelectionMode: fc.constantFrom<Backend_Selection_Mode>(
			...ALLOWED_BACKEND_MODES,
		),
		localModelId: fc.string({ maxLength: 64 }),
		modelFolder: fc.string({ maxLength: 200 }),
		streamingDisplayMode: fc.constantFrom<Streaming_Display_Mode>(
			...ALLOWED_STREAMING_DISPLAY_MODES,
		),
		timestampOutputEnabled: fc.boolean(),
		speakerDiarizationEnabled: fc.boolean(),
		translationEnabled: fc.boolean(),
		translationTargetLanguage: fc.constantFrom<Curated_Target_Language>(
			...ALLOWED_TARGET_LANGUAGES,
		),
		translationOutputFormat: fc.constantFrom<Translation_Output_Format>(
			...ALLOWED_TRANSLATION_OUTPUT_FORMATS,
		),
	},
	{ requiredKeys: [] },
);

/**
 * `null` / `undefined` / 부분 객체 / 완전한 객체를 모두 포함하는 saved 입력 arbitrary.
 * 유효 값만 다루며 invariant 1, 2 검증에 사용한다.
 */
const validPartialSavedArb: fc.Arbitrary<
	Partial<TranscribeSettings> | null | undefined
> = fc.oneof(
	fc.constant(null),
	fc.constant(undefined),
	fc.constant({}),
	partialV1_0Arb,
	partialV1_1ValidArb,
	fc
		.tuple(partialV1_0Arb, partialV1_1ValidArb)
		.map(([v0, v1]) => ({ ...v0, ...v1 })),
);

// ---------------------------------------------------------------------------
// 테스트
// ---------------------------------------------------------------------------

describe("mergeWithDefaults — Property 1: 설정 자동 채움 보존성", () => {
	/**
	 * Invariant 1: 모든 v1.1 신규 필드가 결과 객체에 정의된 타입 값으로 존재.
	 *
	 * 임의의 `Partial<TranscribeSettings>` 입력에 대해 `mergeWithDefaults` 결과의
	 * 9개 신규 필드가 모두 `undefined` 가 아닌 정의된 타입의 값을 가져야 한다
	 * (Requirement 1.8: 지연 채움 금지).
	 *
	 * **Validates: Requirements 1.8, 13.1**
	 */
	it("invariant 1 — 모든 v1.1 신규 필드가 정의된 타입 값으로 존재한다", () => {
		fc.assert(
			fc.property(validPartialSavedArb, (saved) => {
				const result = mergeWithDefaults(saved);

				// `backendSelectionMode`: 3개 화이트리스트 항목 중 하나.
				expect(ALLOWED_BACKEND_MODES).toContain(
					result.backendSelectionMode,
				);

				// `streamingDisplayMode`: 2개 화이트리스트 항목 중 하나.
				expect(ALLOWED_STREAMING_DISPLAY_MODES).toContain(
					result.streamingDisplayMode,
				);

				// `translationOutputFormat`: 2개 화이트리스트 항목 중 하나.
				expect(ALLOWED_TRANSLATION_OUTPUT_FORMATS).toContain(
					result.translationOutputFormat,
				);

				// `translationTargetLanguage`: 7개 화이트리스트 항목 중 하나.
				expect(ALLOWED_TARGET_LANGUAGES).toContain(
					result.translationTargetLanguage,
				);

				// 문자열 필드 — `string` 타입 보장.
				expect(typeof result.localModelId).toBe("string");
				expect(typeof result.modelFolder).toBe("string");

				// boolean 필드 — `boolean` 타입 보장.
				expect(typeof result.timestampOutputEnabled).toBe("boolean");
				expect(typeof result.speakerDiarizationEnabled).toBe("boolean");
				expect(typeof result.translationEnabled).toBe("boolean");

				// 모든 신규 필드 키가 결과 객체에 존재(`undefined` 가 아님).
				for (const key of V1_1_FIELD_KEYS) {
					expect(result[key]).toBeDefined();
				}
			}),
			{ numRuns: 200 },
		);
	});

	/**
	 * Invariant 2: saved 의 v1.0 필드가 그대로 보존됨.
	 *
	 * saved 에 명시적으로 포함된 v1.0 필드는 `mergeWithDefaults` 결과에서 동일한 값을
	 * 가져야 한다(Requirement 8.5: 기존 사용자 설정 보존).
	 *
	 * **Validates: Requirements 8.5**
	 */
	it("invariant 2 — saved 의 v1.0 필드가 그대로 보존된다", () => {
		fc.assert(
			fc.property(partialV1_0Arb, (savedV1_0) => {
				const result = mergeWithDefaults(savedV1_0);

				for (const key of V1_0_FIELD_KEYS) {
					if (key in savedV1_0) {
						// saved 에 명시된 필드는 결과에 그대로 보존되어야 한다.
						expect(result[key]).toBe(savedV1_0[key]);
					} else {
						// saved 에 명시되지 않은 필드는 `DEFAULT_SETTINGS` 의 값을 사용한다.
						expect(result[key]).toBe(DEFAULT_SETTINGS[key]);
					}
				}
			}),
			{ numRuns: 200 },
		);
	});

	/**
	 * Invariant 3: 화이트리스트 외 값은 기본값으로 강제 복귀.
	 *
	 * `backendSelectionMode`, `streamingDisplayMode`, `translationOutputFormat`,
	 * `translationTargetLanguage` 4개 필드의 화이트리스트 위반 값은 기본값으로
	 * 강제 복귀되어야 한다(Requirement 1.8: 사용자가 직접 편집한 무효값 방어).
	 *
	 * `translationTargetLanguage` 의 기본값은 `languageCode` 의존이므로, 검증 시
	 * 결과의 `languageCode` 를 기반으로 기대값을 계산한다.
	 *
	 * **Validates: Requirements 1.8, 13.1**
	 */
	it("invariant 3 — 화이트리스트 외 값은 기본값으로 강제 복귀한다", () => {
		// 화이트리스트 위반 값 arbitrary — 화이트리스트와 겹치지 않는 임의 문자열.
		const invalidBackendModeArb = fc
			.string({ minLength: 1, maxLength: 32 })
			.filter(
				(s) =>
					!(ALLOWED_BACKEND_MODES as readonly string[]).includes(s),
			);
		const invalidStreamingDisplayModeArb = fc
			.string({ minLength: 1, maxLength: 32 })
			.filter(
				(s) =>
					!(
						ALLOWED_STREAMING_DISPLAY_MODES as readonly string[]
					).includes(s),
			);
		const invalidTranslationOutputFormatArb = fc
			.string({ minLength: 1, maxLength: 32 })
			.filter(
				(s) =>
					!(
						ALLOWED_TRANSLATION_OUTPUT_FORMATS as readonly string[]
					).includes(s),
			);
		const invalidTargetLanguageArb = fc
			.string({ minLength: 1, maxLength: 32 })
			.filter(
				(s) =>
					!(ALLOWED_TARGET_LANGUAGES as readonly string[]).includes(
						s,
					),
			);

		const invalidPartialArb = fc.record(
			{
				backendSelectionMode: invalidBackendModeArb,
				streamingDisplayMode: invalidStreamingDisplayModeArb,
				translationOutputFormat: invalidTranslationOutputFormatArb,
				translationTargetLanguage: invalidTargetLanguageArb,
				languageCode: fc.constantFrom<LanguageCode>(
					...ALLOWED_LANGUAGE_CODES,
				),
			},
			{ requiredKeys: [] },
		);

		fc.assert(
			fc.property(invalidPartialArb, (savedInvalid) => {
				// 의도적으로 무효 타입 값을 주입하기 위해 캐스팅. 실제 사용자가
				// `data.json` 을 수동 편집한 경우를 시뮬레이션한다.
				const result = mergeWithDefaults(
					savedInvalid as unknown as Partial<TranscribeSettings>,
				);

				// 화이트리스트 위반 값은 모두 기본값으로 복귀.
				if ("backendSelectionMode" in savedInvalid) {
					expect(result.backendSelectionMode).toBe("cloud-only");
				}
				if ("streamingDisplayMode" in savedInvalid) {
					expect(result.streamingDisplayMode).toBe(
						"chunked-streaming",
					);
				}
				if ("translationOutputFormat" in savedInvalid) {
					expect(result.translationOutputFormat).toBe("inline");
				}
				if ("translationTargetLanguage" in savedInvalid) {
					// `translationTargetLanguage` 기본값은 `languageCode` 컨텍스트
					// 의존: `ko-KR` → `"en"`, 그 외 → `"ko"`.
					const expected =
						result.languageCode === "ko-KR" ? "en" : "ko";
					expect(result.translationTargetLanguage).toBe(expected);
				}
			}),
			{ numRuns: 200 },
		);
	});
});
