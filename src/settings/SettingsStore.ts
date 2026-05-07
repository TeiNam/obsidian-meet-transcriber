/**
 * `SettingsStore` 모듈
 *
 * Obsidian `Plugin.loadData()` / `Plugin.saveData()` 위에서 동작하는
 * 플러그인 설정의 **로드 / 저장 / 검증** 책임을 담당한다.
 *
 * 설계 원칙:
 * - `load`, `save`는 Obsidian `Plugin` 인스턴스에 위임하는 얇은 래퍼이다.
 * - `validate`는 **순수 함수(pure function)** 로 구현한다. 어떤 I/O도 수행하지 않으며,
 *   입력 객체를 변경하지 않고 새로운 `ValidationResult` 객체만 반환한다.
 * - 검증 실패 시 `errors` 배열에는 **필드명 식별자**를 그대로 포함한다.
 *   i18n 메시지 매핑은 상위 UI 계층(`TranscribeSettingTab`)의 책임이다.
 *
 * 관련 요구사항: Requirements 2.5, 2.6, 2.7, 2.8, 2.9, 2.11, 2.12, 2.15, 2.16, 10.3
 * 관련 속성: design.md Property 5(설정 길이 검증 규칙)
 */

import type { Plugin } from "obsidian";

import { DEFAULT_SETTINGS, type TranscribeSettings } from "../types/settings";

/**
 * `validate()` 반환 타입.
 *
 * `errors`는 위반된 필드의 식별자 문자열 배열이다.
 * 빈 배열이면 모든 검증 규칙을 통과한 상태이다.
 *
 * 필드명 식별자 예: `"accessKeyId"`, `"secretAccessKey"`, `"region"`,
 * `"bedrockModelId"`, `"languageCode"`, `"uiLocale"`.
 */
export interface ValidationResult {
	/** 위반된 필드의 식별자 목록. 비어 있으면 유효한 설정이다. */
	errors: string[];
}

/**
 * `accessKeyId` 최대 길이(Requirements 2.5, 2.16).
 * AWS IAM access key id는 현실적으로 훨씬 짧지만, 확장 여지와 UX 방어선으로 128자를 상한으로 둔다.
 */
const MAX_ACCESS_KEY_ID_LENGTH = 128;

/**
 * `secretAccessKey` 최대 길이(Requirements 2.6, 2.16).
 */
const MAX_SECRET_ACCESS_KEY_LENGTH = 256;

/**
 * `bedrockModelId` 최대 길이(Requirements 2.8).
 * Bedrock 모델 식별자에는 버전 suffix 등이 포함될 수 있어 넉넉한 상한을 둔다.
 */
const MAX_BEDROCK_MODEL_ID_LENGTH = 256;

/**
 * `languageCode` 허용값 집합(Requirements 2.9).
 * `readonly` 튜플로 선언하여 타입 추론 및 포함 여부 검사 시 안전성을 확보한다.
 */
const ALLOWED_LANGUAGE_CODES = ["ko-KR", "en-US"] as const;

/**
 * `uiLocale` 허용값 집합(Requirements 2.2, 10.3).
 */
const ALLOWED_UI_LOCALES = ["en", "ko"] as const;

/**
 * 플러그인 설정의 로드/저장/검증을 담당하는 저장소.
 *
 * `Plugin.loadData()` / `Plugin.saveData()`를 통해
 * `.obsidian/plugins/<plugin-id>/data.json`에 평문으로 직렬화된다(Requirements 2.12).
 * vault 내부 노트나 별도 평문 파일로 자격 증명을 기록해서는 안 된다.
 */
export class SettingsStore {
	/**
	 * @param plugin - Obsidian `Plugin` 인스턴스. `loadData`/`saveData`의 위임 대상이다.
	 *   테스트 시에는 동일 시그니처를 구현하는 목 객체를 주입한다.
	 */
	constructor(private readonly plugin: Plugin) {}

	/**
	 * 저장된 설정을 불러와 기본값과 머지한다.
	 *
	 * 머지 순서: `DEFAULT_SETTINGS` → 저장된 값(후자가 우선).
	 * 저장된 데이터가 `null`/`undefined`여도 안전하게 `DEFAULT_SETTINGS` 복사본을 반환한다.
	 *
	 * 주의: 본 메서드는 값을 **검증하지 않는다**. 호출 측이 필요 시 `validate()`로 확인한다.
	 *
	 * @returns 기본값과 머지된 `TranscribeSettings` 인스턴스.
	 */
	async load(): Promise<TranscribeSettings> {
		const saved = (await this.plugin.loadData()) as Partial<TranscribeSettings> | null;
		return Object.assign({}, DEFAULT_SETTINGS, saved ?? {});
	}

	/**
	 * 설정을 영속화한다.
	 *
	 * Obsidian의 `saveData`가 JSON 직렬화를 수행한다.
	 *
	 * @param settings - 저장할 설정 객체.
	 */
	async save(settings: TranscribeSettings): Promise<void> {
		await this.plugin.saveData(settings);
	}

	/**
	 * 설정 값의 유효성을 검증한다. **순수 함수**로 구현되어 있다.
	 *
	 * 검증 규칙(design.md § 9 / Property 5):
	 * - `accessKeyId.length <= 128` → 위반 시 `"accessKeyId"` (Requirements 2.5, 2.16)
	 * - `secretAccessKey.length <= 256` → 위반 시 `"secretAccessKey"` (Requirements 2.6, 2.16)
	 * - `bedrockModelId.length <= 256` → 위반 시 `"bedrockModelId"` (Requirements 2.8)
	 * - `languageCode ∈ {"ko-KR", "en-US"}` → 위반 시 `"languageCode"` (Requirements 2.9)
	 * - `uiLocale ∈ {"en", "ko"}` → 위반 시 `"uiLocale"` (Requirements 2.2, 10.3)
	 * - `region.trim() !== ""` → 위반 시 `"region"` (Requirements 2.7)
	 *
	 * 여러 규칙을 동시에 위반한 경우 `errors`에는 위 순서대로 해당 필드명이 누적된다.
	 * 본 함수는 입력 `settings`를 변형하지 않으며 I/O를 수행하지 않는다.
	 *
	 * @param settings - 검증 대상 설정.
	 * @returns 위반된 필드명 목록을 담은 `ValidationResult`.
	 */
	validate(settings: TranscribeSettings): ValidationResult {
		const errors: string[] = [];

		// 길이 상한 검증 (Requirements 2.5, 2.6, 2.8, 2.16)
		if (settings.accessKeyId.length > MAX_ACCESS_KEY_ID_LENGTH) {
			errors.push("accessKeyId");
		}
		if (settings.secretAccessKey.length > MAX_SECRET_ACCESS_KEY_LENGTH) {
			errors.push("secretAccessKey");
		}
		if (settings.bedrockModelId.length > MAX_BEDROCK_MODEL_ID_LENGTH) {
			errors.push("bedrockModelId");
		}

		// 허용 집합 검증 (Requirements 2.9)
		if (!(ALLOWED_LANGUAGE_CODES as readonly string[]).includes(settings.languageCode)) {
			errors.push("languageCode");
		}

		// 허용 집합 검증 (Requirements 2.2, 10.3)
		if (!(ALLOWED_UI_LOCALES as readonly string[]).includes(settings.uiLocale)) {
			errors.push("uiLocale");
		}

		// 공백만 있는 경우도 빈 값으로 간주 (Requirements 2.7)
		if (settings.region.trim() === "") {
			errors.push("region");
		}

		return { errors };
	}
}
