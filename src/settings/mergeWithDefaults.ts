/**
 * `mergeWithDefaults` — `data.json` 으로부터 로드한 부분 설정을 완전한 `TranscribeSettings`
 * 로 즉시 채워 반환하는 순수 함수.
 *
 * `Requirement 1.8`, `Requirement 13.1` 은 `loadData()` 시점에 신규 필드를 즉시 기본값으로
 * 채워 단일 객체를 반환할 것을 요구한다. 지연 채움(lazy fill, getter 에서 default 처리) 은
 * 명시적으로 금지된다.
 *
 * 본 함수의 책임:
 * 1. `null` / `undefined` / 부분 객체 / 완전한 객체 어느 입력이든 `TranscribeSettings` 로 변환.
 * 2. v1.0 필드(`accessKeyId`, `region` 등) 는 saved 의 값을 그대로 보존(Requirement 8.5).
 * 3. v1.1 신규 필드의 화이트리스트 외 값(예: `backendSelectionMode = "invalid"`,
 *    `translationOutputFormat = "xml"`, 화이트리스트 밖 `translationTargetLanguage`) 은
 *    안전한 기본값으로 강제 복귀(Requirement 1.8).
 * 4. `translationTargetLanguage` 의 컨텍스트 의존 기본값 적용:
 *    `languageCode === "ko-KR"` → `"en"`, 그 외 → `"ko"` (Requirement 13.1.b).
 *    saved 에 명시적으로 포함되지 않은 경우와 화이트리스트 위반 양쪽 모두에 적용된다.
 *
 * 본 함수는 외부 I/O(파일, 네트워크, Obsidian API) 에 의존하지 않으며, 입력 객체를 변형하지
 * 않는다(immutable in / immutable out). PBT 의 1차 대상이다(design §Correctness Properties
 * Property 1).
 *
 * 관련 요구사항: Requirement 1.8, 8.5, 13.1
 * 관련 설계: design §Settings Auto-fill on Load, Property 1
 */

import {
	DEFAULT_SETTINGS,
	type Backend_Selection_Mode,
	type Curated_Target_Language,
	type Streaming_Display_Mode,
	type TranscribeSettings,
	type Translation_Output_Format,
} from "../types/settings";

/**
 * AWS Translate 가 지원하는 ISO 639-1 언어 코드 화이트리스트(Curated_Target_Language).
 * Requirement 13 Glossary 의 7개 항목과 일치해야 한다.
 */
const ALLOWED_TARGET_LANGS: ReadonlySet<Curated_Target_Language> = new Set([
	"en",
	"ko",
	"ja",
	"zh",
	"es",
	"fr",
	"de",
]);

/**
 * `Backend_Selection_Mode` 화이트리스트 가드.
 * Requirement 1.7, 3.1 에 정의된 3 개 값만 허용한다.
 */
function isBackendMode(v: unknown): v is Backend_Selection_Mode {
	return v === "cloud-only" || v === "local-only" || v === "auto";
}

/**
 * `Streaming_Display_Mode` 화이트리스트 가드.
 * Requirement 4.2, 4.3 에 정의된 2 개 값만 허용한다.
 */
function isStreamingDisplayMode(v: unknown): v is Streaming_Display_Mode {
	return v === "progress-only" || v === "chunked-streaming";
}

/**
 * `Translation_Output_Format` 화이트리스트 가드.
 * Requirement 13.7 에 정의된 2 개 값만 허용한다.
 */
function isTranslationOutputFormat(
	v: unknown,
): v is Translation_Output_Format {
	return v === "inline" || v === "none";
}

/**
 * `Curated_Target_Language` 화이트리스트 가드.
 */
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

	// ─── v1.1 신규 필드 화이트리스트 검증 ─────────────────────────────────
	// 사용자가 직접 `data.json` 을 편집했거나 다른 버전에서 저장한 무효값을
	// 안전한 기본값으로 강제 복귀시켜 런타임 안전성을 보장한다(Requirement 1.8).

	if (!isBackendMode(base.backendSelectionMode)) {
		base.backendSelectionMode = "cloud-only";
	}

	if (!isStreamingDisplayMode(base.streamingDisplayMode)) {
		base.streamingDisplayMode = "chunked-streaming";
	}

	if (!isTranslationOutputFormat(base.translationOutputFormat)) {
		base.translationOutputFormat = "inline";
	}

	// `translationTargetLanguage` 의 컨텍스트 의존 기본값 적용(Requirement 13.1.b).
	// saved 에 명시적으로 포함되지 않은 경우(undefined) 와 화이트리스트 위반 양쪽
	// 모두에 동일한 분기 규칙을 적용한다. saved 의 명시값이 화이트리스트에 포함되면
	// 그대로 보존한다.
	const savedTargetLang = safe.translationTargetLanguage;
	const hasExplicitTargetLang = isCuratedTargetLanguage(savedTargetLang);

	if (!hasExplicitTargetLang) {
		base.translationTargetLanguage = resolveContextualTargetLanguage(
			base.languageCode,
		);
	}

	// boolean 필드는 spread 시 saved 의 값을 그대로 사용해도 type system 이 보장한다.
	// 그러나 `data.json` 을 외부에서 편집해 비정상 타입(문자열 "true" 등) 이 들어올
	// 가능성을 고려해 명시적 타입 강제를 수행한다.
	if (typeof base.timestampOutputEnabled !== "boolean") {
		base.timestampOutputEnabled = false;
	}
	if (typeof base.speakerDiarizationEnabled !== "boolean") {
		base.speakerDiarizationEnabled = false;
	}
	if (typeof base.translationEnabled !== "boolean") {
		base.translationEnabled = false;
	}

	// 문자열 필드는 saved 의 값을 그대로 보존하되, 비정상 타입을 방어한다.
	if (typeof base.localModelId !== "string") {
		base.localModelId = "";
	}
	if (typeof base.modelFolder !== "string") {
		base.modelFolder = "";
	}

	return base;
}
