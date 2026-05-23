// i18n 로더 예시 테스트.
//
// 검증 대상:
// - `detectLocale`의 3단계 우선순위(설정 > navigator.language > "en" fallback).
// - `createI18n`이 지정된 로케일에 해당하는 번역 객체를 반환하는지, 그리고
//   잘못된 로케일(타입 캐스트 누수 등 방어적 케이스)에서 영어 기본값으로 떨어지는지.
// - 영어/한국어 번역 테이블의 shape(최상위 키 집합)이 동일한지.
//
// 관련 요구사항: Requirements 10.3

import { afterEach, describe, expect, it, vi } from "vitest";
import { createI18n, detectLocale, type SupportedLocale } from "./index";
import { en } from "./en";
import { ko } from "./ko";

/**
 * 테스트 중 `navigator.language`를 원하는 값으로 강제하는 헬퍼.
 *
 * jsdom 환경에서는 `navigator`가 이미 정의되어 있으므로 `vi.stubGlobal`로
 * 최소 필드만 갖춘 객체로 교체한다. `afterEach`에서 `vi.unstubAllGlobals`로 원상 복구한다.
 */
function stubNavigatorLanguage(language: string): void {
	vi.stubGlobal("navigator", { language });
}

/**
 * `navigator`가 아예 정의되지 않은 환경(SSR/Node 러너)을 흉내 내기 위해
 * `undefined`로 덮어쓴다.
 */
function stubNavigatorUndefined(): void {
	vi.stubGlobal("navigator", undefined);
}

afterEach(() => {
	// 각 테스트가 독립적으로 동작하도록 stub을 항상 해제한다.
	vi.unstubAllGlobals();
});

describe("detectLocale", () => {
	describe("1순위: 사용자 설정", () => {
		it("설정이 \"en\"이면 시스템 언어와 무관하게 \"en\"을 반환한다", () => {
			// Arrange: 시스템 언어를 한국어로 세팅해 설정값이 우선임을 드러낸다.
			stubNavigatorLanguage("ko-KR");

			// Act
			const result = detectLocale("en");

			// Assert
			expect(result).toBe("en");
		});

		it("설정이 \"ko\"이면 시스템 언어가 영어여도 \"ko\"를 반환한다", () => {
			stubNavigatorLanguage("en-US");

			const result = detectLocale("ko");

			expect(result).toBe("ko");
		});
	});

	describe("2순위: navigator.language 기반 시스템 언어 감지", () => {
		it("설정이 undefined이면 navigator.language 앞부분을 파싱해 사용한다 (\"ko-KR\" → \"ko\")", () => {
			stubNavigatorLanguage("ko-KR");

			const result = detectLocale(undefined);

			expect(result).toBe("ko");
		});

		it("설정이 빈 문자열이어도 navigator.language로 fallback한다 (\"en-US\" → \"en\")", () => {
			stubNavigatorLanguage("en-US");

			const result = detectLocale("");

			expect(result).toBe("en");
		});

		it("설정이 지원하지 않는 로케일이면 navigator.language로 fallback한다", () => {
			// 지원하지 않는 설정 "fr" → 시스템 언어 "ko-KR"로 대체
			stubNavigatorLanguage("ko-KR");

			const result = detectLocale("fr");

			expect(result).toBe("ko");
		});

		it("국가 코드가 없는 순수 언어 코드(\"ko\")도 정상 감지한다", () => {
			stubNavigatorLanguage("ko");

			const result = detectLocale(undefined);

			expect(result).toBe("ko");
		});
	});

	describe("3순위: \"en\" 최종 fallback", () => {
		it("설정과 시스템 언어 모두 지원하지 않으면 \"en\"을 반환한다", () => {
			stubNavigatorLanguage("fr-FR");

			const result = detectLocale(undefined);

			expect(result).toBe("en");
		});

		it("설정이 지원 불가능하고 시스템 언어도 지원 불가능하면 \"en\"을 반환한다", () => {
			stubNavigatorLanguage("ja-JP");

			const result = detectLocale("de");

			expect(result).toBe("en");
		});

		it("navigator가 undefined이면(SSR/Node 러너) \"en\"을 반환한다", () => {
			stubNavigatorUndefined();

			const result = detectLocale(undefined);

			expect(result).toBe("en");
		});

		it("navigator가 undefined이고 설정이 유효하면 설정이 우선한다", () => {
			// navigator 미정의 환경에서도 설정이 유효하면 그대로 채택되어야 한다.
			stubNavigatorUndefined();

			const result = detectLocale("ko");

			expect(result).toBe("ko");
		});
	});
});

describe("createI18n", () => {
	it("\"en\"을 전달하면 영어 번역 테이블을 반환한다", () => {
		const table = createI18n("en");

		// 동일 참조가 반환되는지로 LOCALES 맵 경유를 확인.
		expect(table).toBe(en);
		expect(table.buttons.start).toBe("Start streaming");
	});

	it("\"ko\"를 전달하면 한국어 번역 테이블을 반환한다", () => {
		const table = createI18n("ko");

		expect(table).toBe(ko);
		expect(table.buttons.start).toBe("스트리밍 시작");
	});

	it("영어와 한국어 테이블의 최상위 키 집합이 동일하다", () => {
		// 번역 누락이 런타임에 나타나지 않도록 shape 일치를 보장한다.
		const enKeys = Object.keys(en).sort();
		const koKeys = Object.keys(ko).sort();

		expect(koKeys).toEqual(enKeys);
	});

	it("settings, notices 등 중첩 객체의 키 집합도 동일하다", () => {
		// 주요 중첩 섹션에 대해 한 단계 더 shape 검증.
		expect(Object.keys(ko.settings).sort()).toEqual(
			Object.keys(en.settings).sort(),
		);
		expect(Object.keys(ko.notices).sort()).toEqual(
			Object.keys(en.notices).sort(),
		);
		expect(Object.keys(ko.buttons).sort()).toEqual(
			Object.keys(en.buttons).sort(),
		);
		expect(Object.keys(ko.states).sort()).toEqual(
			Object.keys(en.states).sort(),
		);
	});

	it("LOCALES에 존재하지 않는 로케일이 전달되면 영어 fallback을 반환한다", () => {
		// 타입 캐스팅 누수 등으로 예상치 못한 값이 도달한 경우에 대비한 방어 로직 검증.
		// `SupportedLocale`에는 없는 값을 강제 캐스팅해 `?? en` 경로를 커버한다.
		const invalid = "fr" as unknown as SupportedLocale;

		const table = createI18n(invalid);

		expect(table).toBe(en);
	});
});

// -----------------------------------------------------------------------------
// task 28 — 키 셋 정합성 / 회귀 게이트
// -----------------------------------------------------------------------------

/**
 * 두 객체가 정확히 같은 키 트리(중첩 포함) 를 갖는지 재귀적으로 비교하기 위해
 * 모든 leaf 의 dot-notation 경로를 수집한다.
 *
 * - 함수 값 (예: `notices.missingSettings`, `sidebar.costCounter`) 은 leaf 로 간주하여
 *   하위 키를 비교하지 않는다 (런타임 호출 시그니처는 `Translations` 타입이 보장).
 * - 두 쪽 모두 plain object 인 경우에만 한 단계 더 내려간다.
 *
 * 실패 시 어떤 경로(예: `settings.translation.targetLanguage.options.fr`) 에서 어긋났는지
 * dot-notation 으로 나타내어 디버깅을 쉽게 한다.
 */
function collectKeyPaths(
	value: unknown,
	prefix: ReadonlyArray<string> = [],
): string[] {
	if (
		value === null ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		typeof value === "function"
	) {
		return [prefix.join(".")];
	}

	const obj = value as Record<string, unknown>;
	const paths: string[] = [];
	for (const key of Object.keys(obj)) {
		paths.push(...collectKeyPaths(obj[key], [...prefix, key]));
	}
	return paths;
}

describe("task 28 — i18n 키 셋 정합성", () => {
	it("en.ts 와 ko.ts 가 정확히 동일한 키 트리를 갖는다 (재귀 비교)", () => {
		// 단순 최상위 비교만으로는 `settings.translation.targetLanguage.options.fr` 같은
		// 깊은 누락을 잡을 수 없다. `Translations` 타입이 컴파일 타임에 누락을 차단하지만,
		// 런타임에서도 한 번 더 회귀 게이트를 둔다 (Requirement 1.9, 13.14, 14.8).
		const enPaths = collectKeyPaths(en).sort();
		const koPaths = collectKeyPaths(ko).sort();

		expect(koPaths).toEqual(enPaths);
	});

	it("구 키 `notices.translationLocalNeedsNetwork` 는 두 로케일 모두에서 제거되었다", () => {
		// v1.1 에서 의미가 `translationOfflineUnsupported` 로 교체되었으므로, 구 키가
		// 실수로 다시 추가되지 않도록 회귀 게이트를 둔다 (Requirement 14.8, task 28).
		// 타입 시스템상 존재하지 않는 키이므로 `as` 로 우회하여 런타임 부재를 검증한다.
		const enNotices = en.notices as Record<string, unknown>;
		const koNotices = ko.notices as Record<string, unknown>;

		expect(enNotices.translationLocalNeedsNetwork).toBeUndefined();
		expect(koNotices.translationLocalNeedsNetwork).toBeUndefined();
		expect("translationLocalNeedsNetwork" in en.notices).toBe(false);
		expect("translationLocalNeedsNetwork" in ko.notices).toBe(false);
	});

	it("v1.1 신규 모드 게이트 키 4종이 두 로케일 모두에 존재한다", () => {
		// Requirement 14.8 에 정의된 신규 키들의 존재를 양 로케일에서 명시 검증.
		// 컴파일 타임 누락 검출 외에, 키 이름의 회귀(rename 등) 도 잡는다.
		const requiredKeys = [
			"translationOfflineUnsupported",
			"analysisOfflineUnsupported",
			"tooltipOnlineOnlyFeature",
			"tooltipAnalysisOfflineDisabled",
		] as const;

		for (const key of requiredKeys) {
			expect(en.notices[key]).toBeDefined();
			expect(typeof en.notices[key]).toBe("string");
			expect(ko.notices[key]).toBeDefined();
			expect(typeof ko.notices[key]).toBe("string");
		}
	});
});
