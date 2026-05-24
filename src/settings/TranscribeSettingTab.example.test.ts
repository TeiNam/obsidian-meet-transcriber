/**
 * `TranscribeSettingTab`의 렌더 예시 테스트 (task 14.3).
 *
 * 검증 목표:
 * 1. 설정 탭의 **첫 항목**이 UI Locale 드롭다운이다 (Requirement 2.2).
 * 2. AWS credentials / Transcription / Analysis / About 네 섹션 헤딩이
 *    `setHeading()` 패턴(= `<h2>` 미사용)으로 존재한다 (Requirement 2.4).
 * 3. secret access key 입력에 `type="password"` 마스킹이 적용된다 (Requirement 2.6).
 * 4. 길이 초과 입력 시:
 *    - 해당 필드 아래 인라인 에러 메시지가 표시된다.
 *    - `saveIfValid`가 `plugin.saveData`를 호출하지 않는다 (= "저장 버튼 비활성화"의
 *      Obsidian Setting 패턴상 의미, Requirement 2.16).
 *
 * 테스트 전략:
 * - jsdom 환경에서 Obsidian이 `HTMLElement.prototype`에 붙인 확장 메서드
 *   (`empty`, `createDiv`, `setText`)를 최소 폴리필한다.
 * - `Plugin` 모의 클래스를 상속한 `TestPlugin`으로 `TranscribePluginLike` 계약을 구현한다.
 * - 실제 `SettingsStore`를 주입하여 validate 로직을 리얼하게 검증한다.
 * - `plugin.saveData`를 `vi.spyOn`으로 감시해 저장 호출 여부를 확인한다.
 */

import { App, Plugin, type PluginManifest } from "obsidian";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createI18n, type Translations } from "../i18n";
import { en } from "../i18n/en";
import {
	DEFAULT_SETTINGS,
	type SupportedLocale,
	type TranscribeSettings,
} from "../types/settings";

import { SettingsStore } from "./SettingsStore";
import {
	TranscribeSettingTab,
	type TranscribePluginLike,
} from "./TranscribeSettingTab";

// 영문 레이블 상수 — 테스트에서 직접 리터럴을 참조하면 유지보수가 어려우므로
// i18n의 `en` 번역 객체를 그대로 사용한다.
const T = en;

// ---------------------------------------------------------------------------
// jsdom 폴리필 — Obsidian이 HTMLElement.prototype에 확장한 DOM 헬퍼들.
// `TranscribeSettingTab.display()` 내부에서 `containerEl.empty()`,
// `parentEl.createDiv({ cls })`, `errorEl.setText(...)`를 사용한다.
// ---------------------------------------------------------------------------

beforeAll(() => {
	interface ElementOpts {
		cls?: string;
		text?: string;
	}
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const proto = HTMLElement.prototype as any;

	if (typeof proto.empty !== "function") {
		proto.empty = function (this: HTMLElement): void {
			while (this.firstChild) this.removeChild(this.firstChild);
		};
	}
	if (typeof proto.createDiv !== "function") {
		proto.createDiv = function (
			this: HTMLElement,
			opts?: ElementOpts,
		): HTMLDivElement {
			const div = document.createElement("div");
			if (opts?.cls) div.className = opts.cls;
			if (opts?.text) div.textContent = opts.text;
			this.appendChild(div);
			return div;
		};
	}
	if (typeof proto.setText !== "function") {
		proto.setText = function (this: HTMLElement, text: string): void {
			this.textContent = text;
		};
	}
});

// ---------------------------------------------------------------------------
// 테스트용 Plugin 구현 — TranscribePluginLike 계약을 만족하는 최소 클래스
// ---------------------------------------------------------------------------

class TestPlugin extends Plugin implements TranscribePluginLike {
	settings: TranscribeSettings;
	settingsStore: SettingsStore;
	t: Translations;
	changeLocale: (locale: SupportedLocale) => Promise<void>;

	// task 24 인터페이스 구현 — 본 테스트에서는 mockImplementation 으로
	// settings 갱신까지 수행하여 미러 동기화 검증을 가능하게 한다.
	setSpeakerDiarizationEnabled = vi
		.fn<[boolean], Promise<void>>()
		.mockImplementation(async (v) => {
			this.settings.speakerDiarizationEnabled = v;
		});
	setTranslationEnabled = vi
		.fn<[boolean], Promise<void>>()
		.mockImplementation(async (v) => {
			this.settings.translationEnabled = v;
		});
	setTranslationTargetLanguage = vi
		.fn<
			[TranscribeSettings["translationTargetLanguage"]],
			Promise<void>
		>()
		.mockImplementation(async (v) => {
			this.settings.translationTargetLanguage = v;
		});
	setTranslationOutputFormat = vi
		.fn<
			[TranscribeSettings["translationOutputFormat"]],
			Promise<void>
		>()
		.mockImplementation(async (v) => {
			this.settings.translationOutputFormat = v;
		});

	constructor(app: App) {
		// vitest alias 로 mock 이 치환되지만 tsc 에서는 실제 obsidian 타입이 적용되므로
		// manifest 는 타입 우회를 위해 unknown 경유 캐스팅한다.
		super(app, {
			id: "test-plugin",
			name: "Test Plugin",
			author: "test",
			version: "0.0.1",
			minAppVersion: "1.4.0",
			description: "test",
		} as unknown as PluginManifest);
		// DEFAULT_SETTINGS의 복사본 (평면 구조라 spread로 충분).
		this.settings = { ...DEFAULT_SETTINGS };
		// 실제 SettingsStore를 주입 — validate 로직을 리얼하게 동작시킨다.
		this.settingsStore = new SettingsStore(this as unknown as Plugin);
		this.t = createI18n("en");
		this.changeLocale = vi
			.fn<[SupportedLocale], Promise<void>>()
			.mockResolvedValue(undefined);
	}
}

// ---------------------------------------------------------------------------
// 테스트 헬퍼 — 설정 탭의 의미 있는 Setting 노드를 찾는 유틸.
// ---------------------------------------------------------------------------

/**
 * 설정 탭 컨테이너에서 "의미 있는" 설정 항목(`<div>` 직계 자식)을 순서대로 반환한다.
 *
 * Mock `Setting`이 만드는 구조: `containerEl > settingEl(div) > [nameEl, descEl, controlEl]`.
 * 따라서 `containerEl.children`의 각 원소가 곧 하나의 Setting 이다.
 */
function getSettingEls(container: HTMLElement): HTMLElement[] {
	return Array.from(container.children).filter(
		(c): c is HTMLElement => c instanceof HTMLElement,
	);
}

/** 주어진 이름의 Setting 항목을 찾는다. 없으면 undefined. */
function findSettingByName(
	container: HTMLElement,
	name: string,
): HTMLElement | undefined {
	return getSettingEls(container).find((el) => {
		const nameEl = el.firstElementChild;
		return nameEl?.textContent === name;
	});
}

// ---------------------------------------------------------------------------
// 테스트
// ---------------------------------------------------------------------------

describe("TranscribeSettingTab.display — 렌더 예시", () => {
	let app: App;
	let plugin: TestPlugin;
	let tab: TranscribeSettingTab;

	beforeEach(() => {
		app = new App();
		plugin = new TestPlugin(app);
		tab = new TranscribeSettingTab(app, plugin);
		tab.display();
	});

	it("첫 항목이 UI Locale 드롭다운이다 (Requirement 2.2)", () => {
		const settingEls = getSettingEls(tab.containerEl);
		expect(settingEls.length).toBeGreaterThan(0);

		const first = settingEls[0];
		const nameEl = first.firstElementChild;

		// 이름이 영문 UI Locale 레이블과 일치해야 한다.
		expect(nameEl?.textContent).toBe(T.settings.language.name);

		// controlEl 내부에 `<select>`가 있고, `en`/`ko` 옵션이 모두 존재한다.
		const select = first.querySelector("select");
		expect(select).not.toBeNull();
		const optionValues = Array.from(select!.options).map((o) => o.value);
		expect(optionValues).toEqual(expect.arrayContaining(["en", "ko"]));
	});

	it("섹션 헤딩이 setHeading() 패턴으로 존재한다 (Requirement 2.4, task 23, v1.1 정리)", () => {
		const settingEls = getSettingEls(tab.containerEl);

		// Mock `Setting.setHeading()`은 `settingEl.dataset.heading = "true"`를 설정한다.
		const headings = settingEls
			.filter((el) => el.dataset.heading === "true")
			.map((el) => el.firstElementChild?.textContent ?? "");

		// v1.1 정리 — Translation/Local model 섹션은 제거되었다.
		expect(headings).toEqual([
			T.settings.awsHeading, // "AWS credentials"
			T.settings.transcriptionHeading, // "Transcription"
			T.settings.analysisHeading, // "Analysis"
			T.settings.vocabularyHeading, // "Vocabulary"
			T.settings.outputHeading, // "Output"
			T.settings.aboutHeading, // "About"
		]);

		// setHeading 패턴이 강제하는 불변식: `<h2>`를 사용해서는 안 된다.
		expect(tab.containerEl.querySelectorAll("h2").length).toBe(0);
	});

	it("secret access key 입력에 password 마스킹이 적용된다 (Requirement 2.6)", () => {
		const setting = findSettingByName(
			tab.containerEl,
			T.settings.secretAccessKey.name,
		);
		expect(setting).toBeDefined();

		const input = setting!.querySelector("input");
		expect(input).not.toBeNull();
		expect(input!.type).toBe("password");
	});

	describe("길이 초과 입력 시 (Requirement 2.16)", () => {
		it("accessKeyId 128자 초과 시 인라인 에러가 표시되고 saveData가 호출되지 않는다", async () => {
			const saveSpy = vi
				.spyOn(plugin, "saveData")
				.mockResolvedValue(undefined);

			const setting = findSettingByName(
				tab.containerEl,
				T.settings.accessKeyId.name,
			);
			expect(setting).toBeDefined();

			const input = setting!.querySelector(
				"input",
			) as HTMLInputElement | null;
			expect(input).not.toBeNull();

			// 런타임 검증 경로를 확인하려면 HTML maxlength가 DOM을 차단하기 전에
			// 프로그래밍적으로 값을 강제해야 한다. `dispatchEvent`는 mock
			// `TextComponent`가 붙인 "input" 리스너를 동기적으로 실행하고,
			// 내부에서 `onChange → validateAndSave` 체인을 트리거한다.
			input!.value = "a".repeat(129);
			input!.dispatchEvent(new Event("input"));

			// 비동기 핸들러 완료를 기다린다 (validateAndSave는 async).
			await Promise.resolve();
			await Promise.resolve();

			// 해당 Setting 내부의 `transcribe-setting-error` 엘리먼트에 에러 메시지.
			const errorEl = setting!.querySelector(".transcribe-setting-error");
			expect(errorEl).not.toBeNull();
			expect(errorEl!.textContent).not.toBe("");
			expect(errorEl!.textContent).toContain("128");

			// 부적합한 상태는 영속화되어서는 안 된다.
			expect(saveSpy).not.toHaveBeenCalled();
		});

		it("secretAccessKey 256자 초과 시도 동일하게 차단된다", async () => {
			const saveSpy = vi
				.spyOn(plugin, "saveData")
				.mockResolvedValue(undefined);

			const setting = findSettingByName(
				tab.containerEl,
				T.settings.secretAccessKey.name,
			);
			expect(setting).toBeDefined();

			const input = setting!.querySelector(
				"input",
			) as HTMLInputElement | null;
			expect(input).not.toBeNull();

			input!.value = "s".repeat(257);
			input!.dispatchEvent(new Event("input"));
			await Promise.resolve();
			await Promise.resolve();

			const errorEl = setting!.querySelector(".transcribe-setting-error");
			expect(errorEl?.textContent).toContain("256");
			expect(saveSpy).not.toHaveBeenCalled();
		});
	});

	it("유효한 길이 범위 입력은 정상적으로 saveData를 호출한다 (대조군)", async () => {
		const saveSpy = vi
			.spyOn(plugin, "saveData")
			.mockResolvedValue(undefined);

		const setting = findSettingByName(
			tab.containerEl,
			T.settings.accessKeyId.name,
		);
		const input = setting!.querySelector(
			"input",
		) as HTMLInputElement | null;

		input!.value = "TEST_VALID_PLACEHOLDER";
		input!.dispatchEvent(new Event("input"));
		await Promise.resolve();
		await Promise.resolve();

		// 유효 입력이므로 인라인 에러는 비어 있고 saveData가 호출된다.
		const errorEl = setting!.querySelector(".transcribe-setting-error");
		expect(errorEl?.textContent ?? "").toBe("");
		expect(saveSpy).toHaveBeenCalledTimes(1);
		expect(plugin.settings.accessKeyId).toBe("TEST_VALID_PLACEHOLDER");
	});
});

// ===========================================================================
// v1.1 정리 — 사이드바 인라인 미러 컨트롤 검증
// ===========================================================================
//
// 화자 분리 / 번역 / 대상 언어 / 출력 형식 컨트롤은 v1.1 정리 단계에서 설정 탭에서
// 사이드바 인라인 컨트롤로 이전되었다. 본 파일에서는 사이드바 측 검증만 수행하며,
// 설정 탭 측의 동일 컨트롤 테스트는 함께 삭제되었다.

import { renderSidebarInlineControls } from "../views/SidebarInlineControls";

/**
 * 사이드바 인라인 컨트롤 자체와의 양방향 동기화는 `renderSidebarInlineControls`
 * 를 직접 호출하여 host 에 plugin 객체를 주입하는 방식으로 검증한다.
 *
 * 미러 동기화의 핵심: 한쪽(설정 탭)에서 toggle 변경 → plugin setter 호출 →
 * 다른쪽(사이드바)을 다시 그려도 새 값이 반영되어야 한다 (Requirement 6.2, 13.2).
 */
describe("SidebarInlineControls — task 24 미러 컨트롤", () => {
	let app: App;
	let plugin: TestPlugin;
	let root: HTMLDivElement;

	// SidebarInlineControlsHost 의 모든 필드를 만족하도록 plugin 을 보강한 host.
	// 호스트 인터페이스에는 plugin 이 갖지 않는 sidebar 전용 메서드(getCurrentLanguage 등)
	// 도 포함되므로 별도 wrapper 객체를 구성한다.
	function buildHost() {
		return {
			app,
			t: plugin.t,
			// 본 테스트에서 DOM 이벤트 자동 정리는 필요 없으므로 직접 addEventListener 사용.
			registerDomEvent: (
				el: HTMLElement | Document | Window,
				type: string,
				cb: (evt: Event) => void,
			) => {
				el.addEventListener(type, cb);
			},
			getCurrentLanguage: () => plugin.settings.languageCode,
			getCurrentModelId: () => plugin.settings.bedrockModelId,
			setLanguage: async (code: TranscribeSettings["languageCode"]) => {
				plugin.settings.languageCode = code;
			},
			setModelId: async (id: string) => {
				plugin.settings.bedrockModelId = id;
			},
			getAvailableModels: () => [],
			refreshAvailableModels: async () => [],
			getCurrentSpeakerDiarizationEnabled: () =>
				plugin.settings.speakerDiarizationEnabled,
			setSpeakerDiarizationEnabled: plugin.setSpeakerDiarizationEnabled,
			getCurrentTranslationEnabled: () =>
				plugin.settings.translationEnabled,
			setTranslationEnabled: plugin.setTranslationEnabled,
			getCurrentTranslationTargetLanguage: () =>
				plugin.settings.translationTargetLanguage,
			setTranslationTargetLanguage: plugin.setTranslationTargetLanguage,
			getCurrentTranslationOutputFormat: () =>
				plugin.settings.translationOutputFormat,
			setTranslationOutputFormat: plugin.setTranslationOutputFormat,
			// 마이크 선택 — 본 테스트군은 디바이스 동작을 검증하지 않으므로 no-op 스텁.
			getCurrentAudioInputDeviceId: () => plugin.settings.audioInputDeviceId,
			setAudioInputDeviceId: async (deviceId: string) => {
				plugin.settings.audioInputDeviceId = deviceId;
			},
			listAudioInputDevices: async (): Promise<MediaDeviceInfo[]> => [],
		};
	}

	beforeEach(() => {
		app = new App();
		plugin = new TestPlugin(app);
		root = document.createElement("div");
		document.body.appendChild(root);
	});

	function getSpeakerToggle(): HTMLInputElement {
		const el = root.querySelector(
			'input[data-control="speaker-diarization"]',
		) as HTMLInputElement | null;
		if (el === null) {
			throw new Error("speaker diarization toggle not found in sidebar");
		}
		return el;
	}

	function getTranslationToggle(): HTMLInputElement {
		const el = root.querySelector(
			'input[data-control="translation-enabled"]',
		) as HTMLInputElement | null;
		if (el === null) {
			throw new Error("translation toggle not found in sidebar");
		}
		return el;
	}

	function getTargetLangSelect(): HTMLSelectElement {
		const el = root.querySelector(
			'select[data-control="translation-target-language"]',
		) as HTMLSelectElement | null;
		if (el === null) {
			throw new Error("target language select not found in sidebar");
		}
		return el;
	}

	it("AC 6.2 — 사이드바 인라인 토글에 화자 분리 미러 컨트롤이 존재한다", () => {
		// SidebarInlineControlsHost 는 plugin 의 메서드 일부만 요구하므로 plugin 을
		// 그대로 전달할 수 있다 (구조적 타입).
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		renderSidebarInlineControls(root, buildHost());

		expect(getSpeakerToggle().checked).toBe(false);
	});

	it("AC 13.2 — 사이드바 인라인 토글에 번역 미러 컨트롤이 존재한다", () => {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		renderSidebarInlineControls(root, buildHost());

		expect(getTranslationToggle().checked).toBe(false);
	});

	it("AC 13.3 — 사이드바 미러 드롭다운이 7 개 옵션을 노출한다", () => {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		renderSidebarInlineControls(root, buildHost());

		const optionValues = Array.from(getTargetLangSelect().options).map(
			(o) => o.value,
		);
		expect(optionValues).toEqual(["en", "ko", "ja", "zh", "es", "fr", "de"]);
	});

	it("사이드바에서 화자 분리 토글 → plugin.setSpeakerDiarizationEnabled 호출", async () => {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		renderSidebarInlineControls(root, buildHost());

		const toggle = getSpeakerToggle();
		toggle.checked = true;
		toggle.dispatchEvent(new Event("change"));
		await Promise.resolve();

		expect(plugin.setSpeakerDiarizationEnabled).toHaveBeenCalledWith(true);
		expect(plugin.settings.speakerDiarizationEnabled).toBe(true);
	});

	it("AC 6.2 미러 동기화 — 설정 탭에서 변경한 값이 사이드바 재렌더 시 반영된다", async () => {
		// 1) 사이드바 첫 렌더 — 기본값 (false).
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		renderSidebarInlineControls(root, buildHost());
		expect(getSpeakerToggle().checked).toBe(false);

		// 2) 설정 탭에서 토글 변경 (mock setter 가 settings 를 갱신).
		await plugin.setSpeakerDiarizationEnabled(true);
		expect(plugin.settings.speakerDiarizationEnabled).toBe(true);

		// 3) 사이드바 재렌더 — 새 값(true) 이 반영된다.
		root.innerHTML = "";
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		renderSidebarInlineControls(root, buildHost());
		expect(getSpeakerToggle().checked).toBe(true);
	});

	it("AC 13.2 — 사이드바에서 번역 토글 변경 시 plugin.setTranslationEnabled 호출", async () => {
		// v1.1 정리: 설정 탭 측 미러 컨트롤이 제거되어 "양쪽 반영" 검증은 사이드바 ↔
		// settings 값 갱신만 확인한다. plugin setter 의 `forEachSidebar` / 재렌더는
		// `main.ts` 측 통합 테스트가 검증한다.
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		renderSidebarInlineControls(root, buildHost());

		const toggle = getTranslationToggle();
		toggle.checked = true;
		toggle.dispatchEvent(new Event("change"));
		await Promise.resolve();

		expect(plugin.setTranslationEnabled).toHaveBeenCalledWith(true);
		expect(plugin.settings.translationEnabled).toBe(true);
	});

	it("AC 13.3 — 사이드바에서 대상 언어 변경 시 plugin.setTranslationTargetLanguage 호출", async () => {
		// 사이드바에서 ja 로 변경.
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		renderSidebarInlineControls(root, buildHost());
		const select = getTargetLangSelect();
		select.value = "ja";
		select.dispatchEvent(new Event("change"));
		await Promise.resolve();

		expect(plugin.setTranslationTargetLanguage).toHaveBeenCalledWith("ja");
		expect(plugin.settings.translationTargetLanguage).toBe("ja");
	});

	it("AC 13.7 — 사이드바 출력 형식 드롭다운이 inline / none 두 옵션을 노출한다", () => {
		// v1.1 정리에서 설정 탭의 outputFormat 드롭다운이 사이드바로 이전됨.
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		renderSidebarInlineControls(root, buildHost());

		const select = root.querySelector(
			'select[data-control="translation-output-format"]',
		) as HTMLSelectElement | null;
		expect(select).not.toBeNull();
		const optionValues = Array.from(select!.options).map((o) => o.value);
		expect(optionValues).toEqual(["inline", "none"]);
	});

	it("AC 13.7 — 사이드바 출력 형식 변경 시 plugin.setTranslationOutputFormat 호출", async () => {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		renderSidebarInlineControls(root, buildHost());

		const select = root.querySelector(
			'select[data-control="translation-output-format"]',
		) as HTMLSelectElement;
		select.value = "none";
		select.dispatchEvent(new Event("change"));
		await Promise.resolve();

		expect(plugin.setTranslationOutputFormat).toHaveBeenCalledWith("none");
		expect(plugin.settings.translationOutputFormat).toBe("none");
	});
});
