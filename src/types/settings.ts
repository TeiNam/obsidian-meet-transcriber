/**
 * 플러그인 설정과 AWS 자격 증명 관련 공통 타입 정의.
 *
 * 본 모듈은 Obsidian Plugin API 또는 AWS SDK에 의존하지 않는 순수 타입/상수만 포함한다.
 * `i18n/index.ts`, `settings/SettingsStore.ts`, `services/*` 등 여러 계층에서 import 하여
 * 단일 소스 오브 트루스(Single Source of Truth)로 사용한다.
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
 * 번역 결과 직렬화 방식(Translation_Output_Format) 리터럴 유니온.
 *
 * - `"inline"`: 노트에 두 줄로(원문 + 들여쓴 번역) 저장. 기본값.
 * - `"none"`: 사이드바에만 표시, 노트에는 저장하지 않음.
 */
export type Translation_Output_Format = "inline" | "none";

/**
 * AWS Translate가 지원하는 ISO 639-1 언어 코드 화이트리스트(Curated_Target_Language).
 *
 * - `"en"` English
 * - `"ko"` 한국어
 * - `"ja"` 日本語
 * - `"zh"` 中文
 * - `"es"` Español
 * - `"fr"` Français
 * - `"de"` Deutsch
 */
export type Curated_Target_Language =
	| "en"
	| "ko"
	| "ja"
	| "zh"
	| "es"
	| "fr"
	| "de";

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
 * vault 내부의 마크다운 노트나 별도 평문 파일로 기록해서는 안 된다.
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

	/**
	 * AWS Transcribe **커스텀 어휘** 이름(자동 관리).
	 *
	 * `VocabularyManager.syncVocabulary()` 가 생성/갱신한 Vocabulary 의 이름이 저장된다.
	 * 사용자가 직접 입력하는 것이 아니라 플러그인이 자동으로 관리한다.
	 * 빈 문자열이면 전사 시 VocabularyName 을 전달하지 않는다.
	 */
	transcribeVocabularyName: string;

	/**
	 * 사용자가 설정에 입력한 **단어 목록** 원본(한 줄에 하나).
	 *
	 * "AWS에 동기화" 버튼을 누르면 이 내용이 `VocabularyManager` 를 통해
	 * AWS Custom Vocabulary 로 등록된다. 등록 성공 시 `transcribeVocabularyName` 에
	 * 자동 생성된 이름이 저장되어 전사 시 사용된다.
	 *
	 * 예)
	 * ```
	 * 쿠버네티스
	 * Obsidian
	 * 김철수 팀장
	 * ```
	 */
	vocabularyPhrases: string;

	/**
	 * 분석 단계에서 Bedrock 모델에 전달할 **용어 사전**(선택).
	 *
	 * 각 항목은 `단어: 설명` 형태로 저장되어 분석 프롬프트의 "용어집" 섹션에
	 * 자동 삽입된다. 모델은 이 정의를 참고해 약자/은어/조직 고유 용어를 풀어 요약한다.
	 *
	 * 예)
	 * ```
	 * KPI: Key Performance Indicator (핵심 성과 지표)
	 * OKR: Objectives and Key Results (목표 및 핵심 결과)
	 * ```
	 *
	 * 빈 문자열이면 프롬프트에 용어집 섹션을 삽입하지 않는다.
	 */
	analysisGlossary: string;

	/**
	 * 문장 단위 타임스탬프 출력 활성화 여부.
	 *
	 * `true`면 `Sentence_Formatter`가 `[mm:ss]` 또는 `[hh:mm:ss]` prefix를
	 * 부여한 라인별 본문을 생성한다.
	 */
	timestampOutputEnabled: boolean;

	/**
	 * 화자 분리 활성화 여부.
	 *
	 * `true`면 AWS Transcribe Streaming의 `ShowSpeakerLabel` 옵션이 활성화된다.
	 */
	speakerDiarizationEnabled: boolean;

	/**
	 * 실시간 자막 번역 활성화 여부.
	 *
	 * `true`면 Final 결과 1건마다 AWS Translate `TranslateText`를 비동기
	 * 호출해 사이드바와(옵션에 따라) 노트에 번역 라인을 부착한다.
	 */
	translationEnabled: boolean;

	/**
	 * 번역 대상 언어 코드.
	 *
	 * `Curated_Target_Language` 화이트리스트의 항목 중 하나만 허용한다.
	 * 컨텍스트 의존 기본값은 `mergeWithDefaults`가 적용한다
	 * (`languageCode === "ko-KR"` → `"en"`, 그 외 → `"ko"`).
	 * 본 객체 리터럴 기본값은 `"en"`이다.
	 */
	translationTargetLanguage: Curated_Target_Language;

	/**
	 * 번역 결과 직렬화 방식.
	 *
	 * `"inline"`은 노트에 원문 라인 아래 들여쓴 번역 라인을 부착하고,
	 * `"none"`은 노트에 번역을 저장하지 않는다. 기본값 `"inline"`.
	 */
	translationOutputFormat: Translation_Output_Format;

	/**
	 * 노트 저장 직전 Bedrock 모델로 전사 본문을 **교정**할지 여부.
	 *
	 * `true` 면 `saveBufferAsTranscript` 가 `BedrockService.refineTranscript` 를 호출해
	 * 맞춤법·띄어쓰기·문장부호만 다듬은 교정본을 만든 뒤, 노트에 `## 교정본` 과
	 * `## 원본` 두 섹션으로 모두 기록한다 (원본 보존 정책).
	 *
	 * 기본값 `false`. 자격 증명 / 모델 / 리전이 비어 있으면 토글이 켜져 있어도
	 * 교정 단계는 건너뛰고 원본만 저장한다.
	 */
	refineEnabled: boolean;

	/**
	 * 교정 모델에 전달할 추가 지시문(선택, 자유 입력).
	 *
	 * 비어 있으면 기본 프롬프트(맞춤법·띄어쓰기·문장부호만)만 사용한다. 값이 있으면
	 * 프롬프트 하단에 `--- additional instructions ---` 블록으로 삽입되어 모델이
	 * 추가 컨텍스트(예: "회사명 'Obsidian' 표기 유지", "존댓말로 통일") 를 반영한다.
	 *
	 * 단, 시스템 프롬프트는 어떤 경우에도 단어 변경/요약/의역을 금지하므로
	 * 사용자가 의역 지시를 적어도 모델은 표면 표기 교정 범위를 벗어나지 않는다.
	 */
	refinementInstruction: string;

	/**
	 * 사용할 마이크(오디오 입력 장치) `MediaDeviceInfo.deviceId`.
	 *
	 * 빈 문자열이면 OS / 브라우저의 기본 입력 장치를 사용한다(기존 동작).
	 * 사이드바 인라인 컨트롤의 "Microphone" 드롭다운에서 즉시 변경 가능하며,
	 * 저장된 deviceId 가 더 이상 존재하지 않으면 `getUserMedia` 가
	 * `OverconstrainedError` 를 던지므로 `AudioCapture` 가 자동으로 기본 장치로
	 * 폴백한다(`AudioCapture.requestPermission` 의 fallback 흐름).
	 */
	audioInputDeviceId: string;
}

/**
 * `TranscribeSettings`의 기본값.
 *
 * `SettingsStore.load()`에서 `mergeWithDefaults(saved)`로 사용자가 저장한 값과
 * 머지하여 최종 설정을 구성한다.
 */
export const DEFAULT_SETTINGS: TranscribeSettings = {
	uiLocale: "en",
	accessKeyId: "",
	secretAccessKey: "",
	region: "us-east-1",
	bedrockModelId: "",
	languageCode: "ko-KR",
	transcriptFolder: "",
	transcribeVocabularyName: "",
	vocabularyPhrases: "",
	analysisGlossary: "",
	timestampOutputEnabled: false,
	speakerDiarizationEnabled: false,
	translationEnabled: false,
	translationTargetLanguage: "en",
	translationOutputFormat: "inline",
	refineEnabled: false,
	refinementInstruction: "",
	audioInputDeviceId: "",
};
