/**
 * `SettingsStore.validate` 속성 테스트 (Property 5).
 *
 * Property 5: 설정 길이 검증 규칙
 * **Validates: Requirements 2.5, 2.6, 2.8, 2.16, 10.3**
 *
 * 속성 명세(design.md § 9):
 * - 임의의 `TranscribeSettings` 입력에 대해,
 *   `validate(settings).errors`가 비어 있을 필요충분조건은 아래 **모두** 만족이다.
 *     - `accessKeyId.length <= 128`
 *     - `secretAccessKey.length <= 256`
 *     - `bedrockModelId.length <= 256`
 *     - `languageCode ∈ {"ko-KR", "en-US"}`
 *     - `uiLocale ∈ {"en", "ko"}`
 *     - `region`은 공백을 제외하고 비어 있지 않다(non-empty).
 * - 어느 하나라도 위반되면 `errors`에는 해당 필드명이 포함된다.
 *
 * 설계 전략:
 * - 유효 설정 생성기(`validSettingsArb`)에서 모든 필드를 규칙 내에서 생성한다.
 * - 변이 생성기(`invalidateFieldArb`)에서 **정확히 한 필드**만 규칙을 위반하도록 변형한다.
 * - 순수 속성(`valid → empty errors`)과 변이 속성(`invalidated → errors contains field`)을
 *   각각 `{ numRuns: 200 }`로 검증한다.
 */

import { describe, test, expect } from "vitest";
import fc from "fast-check";

import { SettingsStore, type ValidationResult } from "./SettingsStore";
import type {
	Backend_Selection_Mode,
	Curated_Target_Language,
	LanguageCode,
	Streaming_Display_Mode,
	SupportedLocale,
	TranscribeSettings,
	Translation_Output_Format,
} from "../types/settings";

// ---------------------------------------------------------------------------
// 공통 상수 — `SettingsStore.ts`의 검증 규칙과 동일한 경계값
// ---------------------------------------------------------------------------

const MAX_ACCESS_KEY_ID_LENGTH = 128;
const MAX_SECRET_ACCESS_KEY_LENGTH = 256;
const MAX_BEDROCK_MODEL_ID_LENGTH = 256;
const ALLOWED_LANGUAGE_CODES: readonly LanguageCode[] = ["ko-KR", "en-US"];
const ALLOWED_UI_LOCALES: readonly SupportedLocale[] = ["en", "ko"];

/**
 * `Plugin.loadData` / `saveData`에 의존하지 않는 `validate` 단독 테스트용 인스턴스.
 *
 * `validate`는 순수 함수이므로 `plugin` 필드가 전혀 사용되지 않는다.
 * 임의의 캐스트로 최소 객체를 주입해도 안전하다.
 */
function createStore(): SettingsStore {
	return new SettingsStore(
		{} as unknown as ConstructorParameters<typeof SettingsStore>[0],
	);
}

// ---------------------------------------------------------------------------
// 유효 설정 생성기
// ---------------------------------------------------------------------------

/**
 * 모든 필드가 `validate` 규칙을 만족하는 `TranscribeSettings` 생성기.
 *
 * - 문자열 길이는 규칙 상한까지 포함하여 다양화한다.
 * - `region`은 `trim()` 후 비어있지 않아야 하므로 최소 길이 1의 문자열에서 공백만 있는 값을 걸러낸다.
 * - `transcriptFolder`는 `validate`가 검증하지 않으므로 임의 문자열을 그대로 사용한다.
 */
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

const validSettingsArb: fc.Arbitrary<TranscribeSettings> = fc.record({
	uiLocale: fc.constantFrom<SupportedLocale>(...ALLOWED_UI_LOCALES),
	accessKeyId: fc.string({ maxLength: MAX_ACCESS_KEY_ID_LENGTH }),
	secretAccessKey: fc.string({ maxLength: MAX_SECRET_ACCESS_KEY_LENGTH }),
	region: fc
		.string({ minLength: 1, maxLength: 64 })
		.filter((s) => s.trim() !== ""),
	bedrockModelId: fc.string({ maxLength: MAX_BEDROCK_MODEL_ID_LENGTH }),
	languageCode: fc.constantFrom<LanguageCode>(...ALLOWED_LANGUAGE_CODES),
	transcriptFolder: fc.string(),
	transcribeVocabularyName: fc.string({ maxLength: 200 }),
	vocabularyPhrases: fc.string(),
	analysisGlossary: fc.string(),
	audioInputDeviceId: fc.string({ maxLength: 128 }),
	// v1.1 신규 필드 — `validate`가 검증하지 않으므로 화이트리스트 내에서 임의 선택.
	backendSelectionMode: fc.constantFrom<Backend_Selection_Mode>(
		...ALLOWED_BACKEND_MODES,
	),
	localModelId: fc.string({ maxLength: 64 }),
	modelFolder: fc.string(),
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
});

// ---------------------------------------------------------------------------
// 필드별 무효값 생성기 — 정확히 해당 필드만 규칙을 위반한다
// ---------------------------------------------------------------------------

/** `accessKeyId.length > 128` */
const invalidAccessKeyIdArb: fc.Arbitrary<string> = fc.string({
	minLength: MAX_ACCESS_KEY_ID_LENGTH + 1,
	maxLength: MAX_ACCESS_KEY_ID_LENGTH + 64,
});

/** `secretAccessKey.length > 256` */
const invalidSecretAccessKeyArb: fc.Arbitrary<string> = fc.string({
	minLength: MAX_SECRET_ACCESS_KEY_LENGTH + 1,
	maxLength: MAX_SECRET_ACCESS_KEY_LENGTH + 64,
});

/** `bedrockModelId.length > 256` */
const invalidBedrockModelIdArb: fc.Arbitrary<string> = fc.string({
	minLength: MAX_BEDROCK_MODEL_ID_LENGTH + 1,
	maxLength: MAX_BEDROCK_MODEL_ID_LENGTH + 64,
});

/** 허용되지 않는 언어 코드 — 허용 집합과 겹치지 않는 임의 문자열 */
const invalidLanguageCodeArb: fc.Arbitrary<string> = fc
	.string()
	.filter((s) => !(ALLOWED_LANGUAGE_CODES as readonly string[]).includes(s));

/** 허용되지 않는 UI 로케일 — 허용 집합과 겹치지 않는 임의 문자열 */
const invalidUiLocaleArb: fc.Arbitrary<string> = fc
	.string()
	.filter((s) => !(ALLOWED_UI_LOCALES as readonly string[]).includes(s));

/**
 * 공백을 제외하고 비어 있는 `region` 생성기.
 *
 * `validate`는 `region.trim() === ""`를 빈 값으로 간주하므로,
 * 빈 문자열과 공백만으로 구성된 문자열 모두 "region 위반" 범주에 포함된다.
 */
const invalidRegionArb: fc.Arbitrary<string> = fc.oneof(
	fc.constant(""),
	fc
		.integer({ min: 1, max: 16 })
		.chain((n) =>
			fc.constantFrom(" ", "\t", "\n", "\r").map((ch) => ch.repeat(n)),
		),
);

/**
 * 검증 대상 필드명과, 해당 필드만 위반시키는 무효값 생성기를 묶은 표.
 *
 * 필드명(`keyof TranscribeSettings`)을 그대로 `errors` 배열에 등장하는 식별자로 사용한다.
 */
const fieldMutators: ReadonlyArray<{
	field: keyof TranscribeSettings;
	invalidValueArb: fc.Arbitrary<string>;
}> = [
	{ field: "accessKeyId", invalidValueArb: invalidAccessKeyIdArb },
	{ field: "secretAccessKey", invalidValueArb: invalidSecretAccessKeyArb },
	{ field: "bedrockModelId", invalidValueArb: invalidBedrockModelIdArb },
	{ field: "languageCode", invalidValueArb: invalidLanguageCodeArb },
	{ field: "uiLocale", invalidValueArb: invalidUiLocaleArb },
	{ field: "region", invalidValueArb: invalidRegionArb },
];

// ---------------------------------------------------------------------------
// 테스트
// ---------------------------------------------------------------------------

describe("SettingsStore.validate — Property 5: 설정 길이 검증 규칙", () => {
	/**
	 * 순수 속성: 유효한 설정 → `errors`는 빈 배열.
	 *
	 * **Validates: Requirements 2.5, 2.6, 2.8, 2.16, 10.3**
	 */
	test("valid settings produce empty errors", () => {
		const store = createStore();
		fc.assert(
			fc.property(validSettingsArb, (settings) => {
				const result: ValidationResult = store.validate(settings);
				expect(result.errors).toEqual([]);
			}),
			{ numRuns: 200 },
		);
	});

	/**
	 * 변이 속성: 한 필드만 규칙을 위반시키면 `errors`에 해당 필드명이 포함된다.
	 *
	 * 각 필드에 대해 독립적인 `fc.assert` 호출로 실패 시 어느 규칙이 깨졌는지 명확히 드러낸다.
	 *
	 * **Validates: Requirements 2.5, 2.6, 2.8, 2.16, 10.3**
	 */
	for (const { field, invalidValueArb } of fieldMutators) {
		test(`violating only '${field}' causes errors to contain '${field}'`, () => {
			const store = createStore();
			fc.assert(
				fc.property(
					validSettingsArb,
					invalidValueArb,
					(baseSettings, invalidValue) => {
						// 해당 필드 한 개만 무효값으로 교체한 복사본 생성 (불변)
						const mutated: TranscribeSettings = {
							...baseSettings,
							[field]: invalidValue,
						} as TranscribeSettings;

						const result = store.validate(mutated);
						expect(result.errors).toContain(field);
					},
				),
				{ numRuns: 200 },
			);
		});
	}
});
