/**
 * 플러그인 설정과 AWS 자격 증명 관련 공통 타입 정의.
 *
 * 본 모듈은 Obsidian Plugin API 또는 AWS SDK에 의존하지 않는 순수 타입/상수만 포함한다.
 * `i18n/index.ts`, `settings/SettingsStore.ts`, `services/*` 등 여러 계층에서 import 하여
 * 단일 소스 오브 트루스(Single Source of Truth)로 사용한다.
 *
 * 관련 요구사항: Requirements 2.5, 2.6, 2.7, 2.8, 2.9, 2.10
 *
 * v1.1 확장:
 * - 백엔드 선택(Backend_Selection_Mode), 로컬 모델 식별자/폴더, 스트리밍 표시 모드,
 *   문장 타임스탬프/화자 분리/실시간 번역 관련 필드를 추가한다.
 * - 관련 요구사항: Requirements 1.7, 8.1, 8.5, 13.1 (design §Data Models 1)
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
 * 백엔드 선택 모드(Backend_Selection_Mode) 리터럴 유니온.
 *
 * 사용자가 클라우드(AWS Transcribe Streaming)와 로컬(Local_Whisper_Service) 중
 * 어느 것을 사용할지 결정하는 정책이다(Requirement 1.2, 3.1).
 *
 * - `"cloud-only"`: 항상 `Transcribe_Service` 사용. 기본값(기존 동작 보존).
 * - `"local-only"`: 항상 `Local_Whisper_Service` 사용.
 * - `"auto"`: pre-flight + 클라우드 시도 → 실패 시 로컬 폴백.
 */
export type Backend_Selection_Mode = "cloud-only" | "local-only" | "auto";

/**
 * 로컬 모드의 진행 표시 방식(Streaming_Display_Mode) 리터럴 유니온.
 *
 * 관련 요구사항: Requirements 4.2, 4.3.
 *
 * - `"progress-only"`: 녹음 중에는 누적 시간만 표시, stop 후 일괄 전사.
 * - `"chunked-streaming"`: 30~60초 청크 단위로 결과 표시. 기본값.
 */
export type Streaming_Display_Mode = "progress-only" | "chunked-streaming";

/**
 * 번역 결과 직렬화 방식(Translation_Output_Format) 리터럴 유니온.
 *
 * 관련 요구사항: Requirements 13.7.
 *
 * - `"inline"`: 노트에 두 줄로(원문 + 들여쓴 번역) 저장. 기본값.
 * - `"none"`: 사이드바에만 표시, 노트에는 저장하지 않음.
 */
export type Translation_Output_Format = "inline" | "none";

/**
 * AWS Translate가 지원하는 ISO 639-1 언어 코드 화이트리스트(Curated_Target_Language).
 *
 * Requirements 13 Glossary의 `Curated_Target_Language_List`에 정의된
 * 7개 항목으로 구성된 정적 화이트리스트이다.
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
 * 백엔드 결정 결과(Backend_Decision).
 *
 * `selectBackend(settings, networkProbe)` 순수 함수의 반환 타입이다.
 * 호출 직후 `main.ts` 가 `cloud` / `local` 분기로 흐름을 결정한다(Requirement 3.1).
 *
 * 관련 요구사항: Requirements 3.4, 12.2 (design §Data Models 7, §4.10)
 *
 * - `backend`: 사용할 `Transcription_Backend` 식별자.
 * - `preflightFallbackReason`: `auto` 모드에서 사전 감지(pre-flight check) 단계에 폴백이
 *   결정된 경우의 사유. `cloud-only` / `local-only` 또는 사전 감지 통과 시에는 `undefined`.
 *   사전 감지가 아닌 활성 세션 도중 발생하는 폴백(Requirement 3.4 후반부, 3.8 EXCEPT)
 *   은 `selectBackend` 의 책임이 아니므로 본 필드에 표현되지 않는다.
 */
export interface Backend_Decision {
	readonly backend: "cloud" | "local";
	readonly preflightFallbackReason?:
		| "no-credentials"
		| "offline"
		| undefined;
}

/**
 * 네트워크 / 자격증명 사전 감지 결과(Network_Probe).
 *
 * `selectBackend` 호출 측(예: `main.ts`)이 `navigator.onLine` 과 `TranscribeSettings`
 * 의 `accessKeyId` / `secretAccessKey` 를 평가한 후 본 구조체로 주입한다.
 * 본 구조체는 `selectBackend` 가 외부 효과(navigator 접근, AWS SDK 호출)를 수행하지 않게
 * 만드는 DI 경계이며, 테스트에서는 임의 조합을 직접 전달해 모든 분기를 커버할 수 있다.
 *
 * 관련 요구사항: Requirements 3.4, 12.2 (design §Data Models 7, §4.10)
 *
 * - `hasCredentials`: `accessKeyId.length > 0 && secretAccessKey.length > 0` 인 경우에만 `true`.
 * - `isOnline`: 호출 시점의 `navigator.onLine` 값(또는 테스트에서 주입한 mock 값).
 */
export interface Network_Probe {
	readonly hasCredentials: boolean;
	readonly isOnline: boolean;
}

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
 *
 * v1.1 신규 필드는 모두 "비활성" 측 기본값을 가지므로 업그레이드 직후
 * 기존 v1.0과 동작 호환성을 보장한다(Requirements 8.1, 8.2).
 */
export interface TranscribeSettings {
	// ─── 기존 v1.0 필드 (변경 없음, Requirements 8.5) ──────────────────

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

	// ─── v1.1 신규 필드 (Requirements 1.7, 8.1, 13.1) ───────────────────

	/**
	 * 백엔드 선택 모드.
	 *
	 * 클라우드/로컬/자동 폴백 중 하나를 사용자가 선택한다(Requirement 1.2, 3.1).
	 * 기본값 `"cloud-only"`는 v1.0 동작 호환성을 보장한다(Requirement 8.1).
	 */
	backendSelectionMode: Backend_Selection_Mode;

	/**
	 * 로컬 Whisper 모델 식별자.
	 *
	 * `LOCAL_MODEL_CATALOG`에 정의된 항목 중 하나(`"whisper-large-v3-turbo"`,
	 * `"distil-whisper-large-v3"`) 또는 빈 문자열(미선택)이다(Requirement 1.3).
	 * 기본값은 빈 문자열로 사용자가 명시 선택해야 한다.
	 */
	localModelId: string;

	/**
	 * 로컬 모델 가중치 파일이 저장되는 운영체제 절대 경로.
	 *
	 * vault 내부 경로는 거부되며 macOS/Linux의 `/`, Windows 드라이브 문자로
	 * 시작하는 경로만 허용한다(Requirement 1.4). 설정 탭에서 OS별 기본
	 * 경로(macOS `~/Library/Application Support/...`, Windows `%APPDATA%/...`,
	 * Linux `~/.local/share/...`)로 prefill된다(Requirement 1.5).
	 */
	modelFolder: string;

	/**
	 * 로컬 모드의 진행 표시 방식.
	 *
	 * `"progress-only"`는 stop 후 일괄 전사, `"chunked-streaming"`은
	 * 30~60초 청크 단위로 결과를 표시한다(Requirement 4.2, 4.3).
	 */
	streamingDisplayMode: Streaming_Display_Mode;

	/**
	 * 문장 단위 타임스탬프 출력 활성화 여부.
	 *
	 * `true`면 `Sentence_Formatter`가 `[mm:ss]` 또는 `[hh:mm:ss]` prefix를
	 * 부여한 라인별 본문을 생성한다(Requirement 5.1). 기본값 `false`는 v1.0의
	 * 통짜 본문 형식을 유지한다(Requirement 8.1, 8.2).
	 */
	timestampOutputEnabled: boolean;

	/**
	 * 화자 분리 활성화 여부.
	 *
	 * 클라우드 모드에서만 동작하며 `true`면 AWS Transcribe Streaming의
	 * `ShowSpeakerLabel` 옵션이 활성화된다(Requirement 6.1, 6.3).
	 * 로컬 모드 v1에서는 미지원이다(Requirement 6.6).
	 */
	speakerDiarizationEnabled: boolean;

	/**
	 * 실시간 자막 번역 활성화 여부.
	 *
	 * `true`면 Final 결과 1건마다 AWS Translate `TranslateText`를 비동기
	 * 호출해 사이드바와(옵션에 따라) 노트에 번역 라인을 부착한다(Requirement 13.1, 13.4).
	 */
	translationEnabled: boolean;

	/**
	 * 번역 대상 언어 코드.
	 *
	 * `Curated_Target_Language` 화이트리스트의 항목 중 하나만 허용한다
	 * (Requirement 13.3). 컨텍스트 의존 기본값은 `mergeWithDefaults`가
	 * 적용한다(`languageCode === "ko-KR"` → `"en"`, 그 외 → `"ko"`).
	 * 본 객체 리터럴 기본값은 `"en"`이다.
	 */
	translationTargetLanguage: Curated_Target_Language;

	/**
	 * 번역 결과 직렬화 방식.
	 *
	 * `"inline"`은 노트에 원문 라인 아래 들여쓴 번역 라인을 부착하고,
	 * `"none"`은 노트에 번역을 저장하지 않는다(Requirement 13.7). 기본값 `"inline"`.
	 */
	translationOutputFormat: Translation_Output_Format;

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
 * 머지하여 최종 설정을 구성한다(design §Settings Auto-fill on Load, task 2에서 도입).
 *
 * 기본값 정책:
 * - 기존 v1.0 필드는 한 글자도 변경하지 않는다(Requirement 8.5).
 * - 신규 v1.1 필드는 모두 "비활성" 측 값을 사용해 업그레이드 직후 v1.0과의
 *   동작 호환성을 보장한다(Requirement 8.1, 8.2).
 *   - `backendSelectionMode = "cloud-only"`: 기존 클라우드 흐름만 사용.
 *   - `localModelId = ""` / `modelFolder = ""`: 로컬 모델 미선택.
 *   - `streamingDisplayMode = "chunked-streaming"`: 로컬 모드 활성화 시 기본값.
 *   - `timestampOutputEnabled = false`: v1.0 통짜 본문 유지.
 *   - `speakerDiarizationEnabled = false`: 화자 분리 미사용.
 *   - `translationEnabled = false`: 실시간 번역 미사용.
 *   - `translationTargetLanguage = "en"`: `mergeWithDefaults`가
 *     `languageCode` 기반으로 컨텍스트 보정.
 *   - `translationOutputFormat = "inline"`: 활성화 시 기본 직렬화 방식.
 */
export const DEFAULT_SETTINGS: TranscribeSettings = {
	// 기존 v1.0 필드 — 변경 없음.
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

	// v1.1 신규 필드 — 모두 "비활성" 측 기본값.
	backendSelectionMode: "cloud-only",
	localModelId: "",
	modelFolder: "",
	streamingDisplayMode: "chunked-streaming",
	timestampOutputEnabled: false,
	speakerDiarizationEnabled: false,
	translationEnabled: false,
	translationTargetLanguage: "en",
	translationOutputFormat: "inline",
	audioInputDeviceId: "",
};
