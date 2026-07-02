/**
 * `mergeWithDefaults` — `data.json` 으로부터 로드한 부분 설정을 완전한 `TranscribeSettings`
 * 로 즉시 채워 반환하는 순수 함수.
 *
 * 본 함수의 책임:
 * 1. `null` / `undefined` / 부분 객체 / 완전한 객체 어느 입력이든 `TranscribeSettings` 로 변환.
 * 2. saved 의 값은 그대로 보존하되, 화이트리스트 외 값은 안전한 기본값으로 강제 복귀.
 * 3. `translationTargetLanguage` 의 컨텍스트 의존 기본값 적용:
 *    `languageCode === "ko-KR"` → `"en"`, 그 외 → `"ko"`.
 *    saved 에 명시적으로 포함되지 않은 경우와 화이트리스트 위반 양쪽 모두에 적용된다.
 *
 * 본 함수는 외부 I/O 에 의존하지 않으며, 입력 객체를 변형하지 않는다.
 */

import {
	DEFAULT_SETTINGS,
	type Curated_Target_Language,
	type TranscribeSettings,
	type Translation_Output_Format,
} from "../types/settings";

const ALLOWED_TARGET_LANGS: ReadonlySet<Curated_Target_Language> = new Set([
	"en",
	"ko",
	"ja",
	"zh",
	"es",
	"fr",
	"de",
]);

function isTranslationOutputFormat(
	v: unknown,
): v is Translation_Output_Format {
	return v === "inline" || v === "none";
}

function isCuratedTargetLanguage(v: unknown): v is Curated_Target_Language {
	return (
		typeof v === "string" &&
		ALLOWED_TARGET_LANGS.has(v as Curated_Target_Language)
	);
}

/**
 * `languageCode` 기반 컨텍스트 의존 번역 대상 언어 기본값 결정.
 *
 * - `ko-KR` 발화 → 영어로 번역(`"en"`).
 * - 그 외(예: `en-US`) 발화 → 한국어로 번역(`"ko"`).
 *
 * 본 헬퍼는 `selectTargetLanguage`(task 5) 의 기본값 분기와 동일한 규칙이다.
 */
function resolveContextualTargetLanguage(
	languageCode: string,
): Curated_Target_Language {
	return languageCode === "ko-KR" ? "en" : "ko";
}

/**
 * 저장된 부분 설정을 기본값과 머지하여 완전한 `TranscribeSettings` 를 반환한다.
 *
 * 머지 순서:
 * 1. `DEFAULT_SETTINGS` 의 모든 필드를 기준으로 시작.
 * 2. saved 의 명시적 값으로 덮어씀(v1.0 필드는 그대로 보존, Requirement 8.5).
 * 3. v1.1 신규 필드 중 화이트리스트 위반 값은 안전한 기본값으로 강제 복귀.
 * 4. `translationTargetLanguage` 는 saved 에 명시적으로 포함되지 않은 경우와
 *    화이트리스트 위반 양쪽 모두에 컨텍스트 의존 기본값을 적용.
 *
 * 본 함수는 입력을 변형하지 않으며, 매 호출마다 새 객체를 반환한다.
 *
 * @param saved - `Plugin.loadData()` 가 반환한 값. `null` / `undefined` / 빈 객체 /
 *                부분 객체 / 완전한 객체 모두 안전하게 처리한다.
 * @returns 모든 필드가 정의된 `TranscribeSettings`.
 */
export function mergeWithDefaults(
	saved: Partial<TranscribeSettings> | null | undefined,
): TranscribeSettings {
	// `null` / `undefined` 가드. 빈 객체로 통일하여 spread 시 안전성 확보.
	const safe: Partial<TranscribeSettings> = saved ?? {};

	const base: TranscribeSettings = {
		...DEFAULT_SETTINGS,
		...safe,
	};

	if (!isTranslationOutputFormat(base.translationOutputFormat)) {
		base.translationOutputFormat = "inline";
	}

	const savedTargetLang = safe.translationTargetLanguage;
	const hasExplicitTargetLang = isCuratedTargetLanguage(savedTargetLang);

	if (!hasExplicitTargetLang) {
		base.translationTargetLanguage = resolveContextualTargetLanguage(
			base.languageCode,
		);
	}

	if (typeof base.timestampOutputEnabled !== "boolean") {
		base.timestampOutputEnabled = false;
	}
	if (typeof base.speakerDiarizationEnabled !== "boolean") {
		base.speakerDiarizationEnabled = false;
	}
	if (typeof base.translationEnabled !== "boolean") {
		base.translationEnabled = false;
	}

	if (typeof base.audioInputDeviceId !== "string") {
		base.audioInputDeviceId = "";
	}

	return base;
}
