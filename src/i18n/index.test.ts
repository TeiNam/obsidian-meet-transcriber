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
