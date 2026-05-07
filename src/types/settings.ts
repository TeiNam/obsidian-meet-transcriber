/**
 * 플러그인 설정과 AWS 자격 증명 관련 공통 타입 정의.
 *
 * 본 모듈은 Obsidian Plugin API 또는 AWS SDK에 의존하지 않는 순수 타입/상수만 포함한다.
 * `i18n/index.ts`, `settings/SettingsStore.ts`, `services/*` 등 여러 계층에서 import 하여
 * 단일 소스 오브 트루스(Single Source of Truth)로 사용한다.
 *
 * 관련 요구사항: Requirements 2.5, 2.6, 2.7, 2.8, 2.9, 2.10
 */

/**
 * 플러그인 UI 표시 언어(UI_Locale) 리터럴 타입.
 *
 * - `"en"`: 영어(기본값).
 * - `"ko"`: 한국어.
 *
 * `navigator.language.split("-")[0]`로 감지한 시스템 언어가 이 집합에 포함되지 않으면
 * 자동 감지 단계에서 `"en"`으로 fallback 한다(Requirements 10.3).
 */
export type SupportedLocale = "en" | "ko";

/**
 * AWS Transcribe Streaming 세션에 전달할 전사 언어 코드 리터럴 타입.
 *
 * - `"ko-KR"`: 한국어(대한민국). 기본값.
 * - `"en-US"`: 영어(미국).
 *
 * 설정 UI의 언어 코드 드롭다운은 이 두 값만 허용한다(Requirements 2.9).
 */
export type LanguageCode = "ko-KR" | "en-US";

/**
 * AWS 자격 증명 구조체.
 *
 * `TranscribeSettings`에서 사용자가 입력한 access key / secret key를
 * AWS SDK 클라이언트 팩토리에 전달할 때 사용하는 전용 DTO 타입이다.
 * 민감 정보이므로 로깅하거나 vault 내부 노트에 기록하지 않는다(Requirements 9.6, 2.12).
 */
export interface AwsCredentials {
	/**
	 * AWS IAM access key id.
	 *
	 * 길이 제약: 0자 이상 128자 이하(Requirements 2.5, 2.16).
	 * 빈 문자열이면 버튼 핸들러에서 자격 증명 누락으로 판정한다(Requirements 2.14).
	 */
	accessKeyId: string;

	/**
	 * AWS IAM secret access key.
	 *
	 * 길이 제약: 0자 이상 256자 이하(Requirements 2.6, 2.16).
	 * 설정 UI에서는 `text.inputEl.type = "password"`로 마스킹 표시한다.
	 */
	secretAccessKey: string;
}

/**
 * 플러그인 전역 설정 구조체.
 *
 * Obsidian `Plugin.loadData()` / `Plugin.saveData()`를 통해
 * `.obsidian/plugins/obsidian-transcribe-plugin/data.json`에 평문으로 직렬화된다.
 * vault 내부의 마크다운 노트나 별도 평문 파일로 기록해서는 안 된다(Requirements 2.12).
 */
export interface TranscribeSettings {
	/**
	 * UI 표시 언어.
	 *
	 * 최초 로드 시 비어 있으면 `detectLocale()`이 `navigator.language`를 기반으로
	 * `"en"` 또는 `"ko"`를 자동 선택한다(Requirements 2.2, 10.3).
	 */
	uiLocale: SupportedLocale;

	/**
	 * AWS access key id.
	 *
	 * 길이 제약: 0자 이상 128자 이하(Requirements 2.5, 2.16).
	 */
	accessKeyId: string;

	/**
	 * AWS secret access key.
	 *
	 * 길이 제약: 0자 이상 256자 이하(Requirements 2.6, 2.16).
	 */
	secretAccessKey: string;

	/**
	 * AWS 리전 식별자(예: `"us-east-1"`, `"ap-northeast-2"`).
	 *
	 * `validate()`에서 빈 문자열을 허용하지 않는다(Requirements 2.7).
	 * Transcribe Streaming과 Bedrock Runtime 양쪽 클라이언트 생성 시 사용된다.
	 */
	region: string;

	/**
	 * AWS Bedrock 파운데이션 모델 식별자(예: `"anthropic.claude-3-sonnet-20240229-v1:0"`).
	 *
	 * 길이 제약: 0자 이상 256자 이하(Requirements 2.8).
	 * 빈 문자열이면 분석 버튼이 비활성화되고 분석 요청이 차단된다(Requirements 2.14, 6.3).
	 */
	bedrockModelId: string;

	/**
	 * Transcribe Streaming에 전달할 전사 언어 코드.
	 *
	 * 허용값: `"ko-KR"`(기본), `"en-US"`(Requirements 2.9).
	 */
	languageCode: LanguageCode;

	/**
	 * Transcript_Note가 생성되는 vault 내부 폴더 경로.
	 *
	 * 빈 문자열은 vault 루트를 의미한다(Requirements 2.10).
	 * 저장 시 `normalizePath`로 정규화되어 Vault API에 전달된다(Requirements 9.8).
	 */
	transcriptFolder: string;
}

/**
 * `TranscribeSettings`의 기본값.
 *
 * `SettingsStore.load()`에서 `Object.assign({}, DEFAULT_SETTINGS, await plugin.loadData())`로
 * 사용자가 저장한 값과 머지하여 최종 설정을 구성한다.
 *
 * - `uiLocale`: `"en"`(초기 감지 전 안전 기본값; 로드 시 `detectLocale`로 재평가된다).
 * - `region`: `"us-east-1"`(Requirements 2.7).
 * - `languageCode`: `"ko-KR"`(Requirements 2.9).
 * - 나머지 문자열 필드는 빈 문자열(Requirements 2.5, 2.6, 2.8, 2.10).
 */
export const DEFAULT_SETTINGS: TranscribeSettings = {
	uiLocale: "en",
	accessKeyId: "",
	secretAccessKey: "",
	region: "us-east-1",
	bedrockModelId: "",
	languageCode: "ko-KR",
	transcriptFolder: "",
};
