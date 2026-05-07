// i18n 로더: 지원 로케일 맵핑과 로케일 감지/번역 객체 생성 유틸.
//
// - `SupportedLocale`은 `../types/settings`에서 정의된 단일 소스 오브 트루스를 재-export 한다.
// - `Translations` 구조 타입은 기본(en) 번역 객체로부터 파생되어 다른 로케일 파일이 컴파일 타임에
//   키 누락을 검출하도록 보장한다.
// - `detectLocale`은 테스트 환경(navigator 미정의)에서도 안전하게 동작한다.
//
// 관련 요구사항: Requirements 10.3

import { en, type Translations } from "./en";
import { ko } from "./ko";
import type { SupportedLocale } from "../types/settings";

/**
 * 로케일 파일 간 키 구조의 단일 소스 오브 트루스 타입.
 *
 * 재-export 목적: settings-tab, views, main 등 상위 계층에서 `Translations` 타입을
 * `../types/settings`이 아니라 `../i18n` 한 경로로만 import 하도록 하여 결합도를 낮춘다.
 */
export type { Translations } from "./en";

/**
 * 플러그인 UI 표시 언어 리터럴 유니온.
 *
 * `../types/settings`에 정의된 원본을 그대로 재-export 한다. 플러그인 설정 스키마와
 * 번역 로더가 동일한 타입을 참조하여 불일치로 인한 런타임 오류를 방지한다.
 */
export type { SupportedLocale } from "../types/settings";

/**
 * 지원되는 로케일 → 번역 객체 맵.
 *
 * `Record<SupportedLocale, Translations>`로 선언하여 새 로케일이 추가될 때
 * 컴파일 타임에 누락을 강제 검출한다.
 */
const LOCALES: Record<SupportedLocale, Translations> = { en, ko };

/**
 * 사용자 설정 > 브라우저/Electron 시스템 언어 > `"en"` fallback 순으로 로케일을 결정한다.
 *
 * 우선순위(Requirements 10.3):
 * 1. `setting`이 truthy이고 `LOCALES` 키에 존재하면 그대로 반환한다.
 * 2. 그렇지 않으면 `navigator.language`의 앞부분(`"ko-KR"` → `"ko"`)을 검사하여
 *    `LOCALES`에 존재하면 반환한다.
 * 3. 두 단계 모두 해당하지 않거나 `navigator`가 정의되어 있지 않은 환경(SSR/테스트)이면
 *    기본값 `"en"`을 반환한다.
 *
 * @param setting `TranscribeSettings.uiLocale`에서 전달되는 사용자 선택 값. 미지정 가능.
 * @returns 확정된 `SupportedLocale`.
 */
export function detectLocale(setting?: string): SupportedLocale {
	// 1순위: 사용자 설정이 유효 로케일이면 그대로 채택.
	if (setting && setting in LOCALES) {
		return setting as SupportedLocale;
	}

	// navigator 미정의 환경(예: jsdom 외 Node 테스트 러너)은 시스템 언어 감지를 건너뛴다.
	if (typeof navigator === "undefined") {
		return "en";
	}

	// 2순위: `navigator.language` 기반 시스템 언어 감지.
	const sys = navigator.language.split("-")[0];
	if (sys in LOCALES) {
		return sys as SupportedLocale;
	}

	// 3순위: 안전 fallback.
	return "en";
}

/**
 * 주어진 로케일에 해당하는 번역 객체를 반환한다.
 *
 * `LOCALES[locale]`이 정의되어 있지 않은 예외 케이스(타입 캐스팅 누수 등)에 대비하여
 * `?? en`으로 안전 fallback 한다(Requirements 10.3).
 *
 * @param locale 번역을 가져올 `SupportedLocale`.
 * @returns 해당 로케일의 `Translations` 객체(없으면 영어 기본값).
 */
export function createI18n(locale: SupportedLocale): Translations {
	return LOCALES[locale] ?? en;
}
