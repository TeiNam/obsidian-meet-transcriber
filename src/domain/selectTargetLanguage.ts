/**
 * 번역 대상 언어 결정 순수 함수.
 *
 * 본 모듈은 `selectTargetLanguage(languageCode, override)` 단일 함수를 export 한다.
 * 외부 효과(AWS SDK 호출, Obsidian API 접근, 네트워크) 는 일체 수행하지 않으므로 단위 테스트와
 * fast-check 속성 테스트로 자유롭게 호출할 수 있다(Requirement 12.1, 13.13).
 *
 * 본 모듈은 `design.md §4.10` 와 `requirements.md` 의 Requirement 13.13 을 1:1 로 추적한다.
 *
 * - Property 4: 번역 대상 언어 결정 (Validates Requirements 13.13)
 *   - override 가 `Curated_Target_Language` 화이트리스트에 포함되면 그대로 반환.
 *   - override 가 화이트리스트 외(또는 `undefined`) 면 기본 규칙(`ko-KR` → `"en"`,
 *     그 외 → `"ko"`) 을 적용.
 *   - 결과는 항상 7 개 화이트리스트 값 중 하나.
 *   - 동일 입력에 대해 항상 동일 결과(결정성).
 */

import type {
	Curated_Target_Language,
	LanguageCode,
} from "../types/settings";

/**
 * `Curated_Target_Language` 화이트리스트.
 *
 * Requirement 13 Glossary 의 `Curated_Target_Language_List` 에 정의된 7 개 항목으로 구성된
 * 정적 화이트리스트이다. `Set` 으로 보관하여 O(1) 멤버십 검사를 보장한다.
 *
 * 본 상수는 `mergeWithDefaults`(task 2) 의 화이트리스트와 의미상 동일하지만, 본 모듈은 순수
 * 함수이므로 외부 의존성 없이 file-local 상수로 둔다(KISS / no over-abstraction).
 */
const CURATED_TARGET_LANGUAGES: ReadonlySet<Curated_Target_Language> = new Set([
	"en",
	"ko",
	"ja",
	"zh",
	"es",
	"fr",
	"de",
]);

/**
 * 입력값이 `Curated_Target_Language` 화이트리스트에 속하는지 검사하는 type guard.
 *
 * `Set.has` 의 인자 타입이 `Curated_Target_Language` 로 좁혀져 있으므로 임의 문자열을 안전하게
 * 검사하기 위해 명시적 type guard 를 정의한다.
 */
function isCuratedTargetLanguage(
	value: string,
): value is Curated_Target_Language {
	return (CURATED_TARGET_LANGUAGES as ReadonlySet<string>).has(value);
}

/**
 * 번역 대상 언어를 결정한다.
 *
 * @param languageCode - 전사 입력 언어 코드(예: `"ko-KR"`, `"en-US"`). `Source_Language` 추론에
 *   사용되며, 본 함수에서는 `override` 가 화이트리스트에 포함되지 않을 때 기본 규칙의 입력으로
 *   사용된다.
 * @param override - 사용자가 명시 지정한 번역 대상 언어. 일반적으로 `TranscribeSettings.translationTargetLanguage`
 *   에서 전달된다. `undefined` 또는 `Curated_Target_Language_List` 에 포함되지 않는 임의 문자열이
 *   들어오면 무시되고 기본 규칙이 적용된다(Requirement 13.13).
 * @returns `Curated_Target_Language_List` 의 항목 중 하나(`"en"`, `"ko"`, `"ja"`, `"zh"`, `"es"`,
 *   `"fr"`, `"de"`).
 *
 * 결정 규칙(Property 4):
 * - override 가 화이트리스트에 포함되면 override 그대로 반환.
 * - override 가 `undefined` 또는 화이트리스트 외 값이면 기본 규칙 적용:
 *   - `languageCode === "ko-KR"` → `"en"`(한국어 발화 회의에 영어 자막).
 *   - 그 외(`"en-US"` 등) → `"ko"`(영어 발화 회의에 한국어 자막).
 *
 * 본 함수는 외부 효과 없는 순수 함수이며, 동일 입력에 대해 항상 동일한 결과를 반환한다(결정성).
 */
export function selectTargetLanguage(
	languageCode: LanguageCode,
	override: string | undefined,
): Curated_Target_Language {
	// override 가 화이트리스트에 포함되면 그대로 반환.
	// `undefined` 는 본 분기 진입 전에 명시적으로 제외한다.
	if (override !== undefined && isCuratedTargetLanguage(override)) {
		return override;
	}

	// override 가 없거나 화이트리스트 외 값이면 기본 규칙 적용.
	// `languageCode` 는 LanguageCode 유니온("ko-KR" | "en-US") 이므로 두 분기로 충분하다.
	if (languageCode === "ko-KR") {
		return "en";
	}

	return "ko";
}
