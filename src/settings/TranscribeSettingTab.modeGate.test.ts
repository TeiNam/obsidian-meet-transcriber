/**
 * task 24 — 모드 게이트 비활성화 (Requirement 14.2, 14.3) 검증.
 *
 * v1.1 정리 (2026-05): 화자 분리 / 번역 / 대상 언어 컨트롤이 설정 탭에서 사이드바
 * 인라인 컨트롤로 이전됨에 따라, 본 파일에서는 사이드바 미러 컨트롤의 모드 게이트만
 * 검증한다. 설정 탭 측 모드 게이트 describe 블록은 컨트롤 자체가 사라졌으므로 함께
 * 삭제되었다 (AC 14.2 / 14.3 의 사이드바 책임 부분만 남는다).
 *
 * 검증 범위:
 * - AC 14.2: `Backend_Selection_Mode === "local-only"` 일 때 사이드바의 (a) 번역 토글,
 *   (b) 번역 대상 언어 드롭다운, (c) 화자 분리 토글 3 개가 disabled 로 렌더링되며
 *   툴팁 `tooltipOnlineOnlyFeature` 가 부착된다. 토글은 표시상 강제 OFF 이지만
 *   settings 의 저장값은 변경되지 않는다.
 * - AC 14.3: `auto` / `cloud-only` 모드에서는 모드 게이트가 적용되지 않는다.
 *
 * AI 분석 버튼 (4 번째 컨트롤) 의 모드 게이트 검증은 `SidebarView` 의 책임이므로
 * 별도 `SidebarView.*.test.ts` 에서 수행한다.
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

import { renderSidebarInlineControls } from "../views/SidebarInlineControls";
import { SettingsStore } from "./SettingsStore";
import { type TranscribePluginLike } from "./TranscribeSettingTab";

const T = en;

// ---------------------------------------------------------------------------
// jsdom 폴리필 — `TranscribeSettingTab.example.test.ts` 와 동일한 최소 보강.
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
// 테스트용 Plugin — `TranscribePluginLike` 계약을 만족하는 최소 stub.
// ---------------------------------------------------------------------------

class TestPlugin extends Plugin implements TranscribePluginLike {
	settings: TranscribeSettings;
	settingsStore: SettingsStore;
	t: Translations;
	changeLocale: (locale: SupportedLocale) => Promise<void>;

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
		super(app, {
			id: "test-plugin",
			name: "Test Plugin",
			author: "test",
			version: "0.0.1",
			minAppVersion: "1.4.0",
			description: "test",
		} as unknown as PluginManifest);
		this.settings = { ...DEFAULT_SETTINGS };
		this.settingsStore = new SettingsStore(this as unknown as Plugin);
		this.t = createI18n("en");
		this.changeLocale = vi
			.fn<[SupportedLocale], Promise<void>>()
			.mockResolvedValue(undefined);
	}
}

// ===========================================================================
// 사이드바 인라인 컨트롤 — 모드 게이트
// ===========================================================================

describe("SidebarInlineControls — 모드 게이트 (Requirement 14.2 / 14.3)", () => {
	let app: App;
	let plugin: TestPlugin;
	let root: HTMLDivElement;

	function buildHost() {
		return {
			app,
			t: plugin.t,
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
			getCurrentBackendSelectionMode: () =>
				plugin.settings.backendSelectionMode,
			// task 33 — 사이드바 백엔드 드롭다운 + activeEngine 라벨에 사용되는 신규 stub.
			setBackendSelectionMode: async (
				mode: TranscribeSettings["backendSelectionMode"],
			) => {
				plugin.settings.backendSelectionMode = mode;
			},
			getCurrentLocalModelId: () => plugin.settings.localModelId,
		};
	}

	beforeEach(() => {
		app = new App();
		plugin = new TestPlugin(app);
		root = document.createElement("div");
		document.body.appendChild(root);
	});

	it("AC 14.2 — local-only 시 미러 컨트롤 3 개가 disabled + 툴팁 부착", () => {
		plugin.settings.backendSelectionMode = "local-only";
		renderSidebarInlineControls(root, buildHost());

		const speaker = root.querySelector(
			'input[data-control="speaker-diarization"]',
		) as HTMLInputElement;
		const translation = root.querySelector(
			'input[data-control="translation-enabled"]',
		) as HTMLInputElement;
		const targetLang = root.querySelector(
			'select[data-control="translation-target-language"]',
		) as HTMLSelectElement;

		expect(speaker.disabled).toBe(true);
		expect(translation.disabled).toBe(true);
		expect(targetLang.disabled).toBe(true);

		const tooltip = T.notices.tooltipOnlineOnlyFeature;
		expect(speaker.title).toBe(tooltip);
		expect(translation.title).toBe(tooltip);
		expect(targetLang.title).toBe(tooltip);

		// 행 컨테이너에 사유 데이터 속성이 부착된다.
		expect(
			speaker.parentElement!.getAttribute("data-disabled-reason"),
		).toBe("offline-mode");
		expect(
			translation.parentElement!.getAttribute("data-disabled-reason"),
		).toBe("offline-mode");
		expect(
			targetLang.parentElement!.getAttribute("data-disabled-reason"),
		).toBe("offline-mode");
	});

	it("AC 14.2 — local-only 시 토글 표시 OFF, settings 저장값은 보존", () => {
		plugin.settings.backendSelectionMode = "local-only";
		plugin.settings.speakerDiarizationEnabled = true;
		plugin.settings.translationEnabled = true;
		renderSidebarInlineControls(root, buildHost());

		const speaker = root.querySelector(
			'input[data-control="speaker-diarization"]',
		) as HTMLInputElement;
		const translation = root.querySelector(
			'input[data-control="translation-enabled"]',
		) as HTMLInputElement;

		// 표시상 OFF.
		expect(speaker.checked).toBe(false);
		expect(translation.checked).toBe(false);

		// settings 의 저장값은 사용자가 저장해 둔 ON 그대로.
		expect(plugin.settings.speakerDiarizationEnabled).toBe(true);
		expect(plugin.settings.translationEnabled).toBe(true);
	});

	it("AC 14.3 — auto 모드에서는 모드 게이트가 적용되지 않는다", () => {
		plugin.settings.backendSelectionMode = "auto";
		renderSidebarInlineControls(root, buildHost());

		const speaker = root.querySelector(
			'input[data-control="speaker-diarization"]',
		) as HTMLInputElement;
		const translation = root.querySelector(
			'input[data-control="translation-enabled"]',
		) as HTMLInputElement;
		const targetLang = root.querySelector(
			'select[data-control="translation-target-language"]',
		) as HTMLSelectElement;

		expect(speaker.disabled).toBe(false);
		expect(translation.disabled).toBe(false);
		expect(targetLang.disabled).toBe(false);
		expect(
			speaker.parentElement!.getAttribute("data-disabled-reason"),
		).toBeNull();
	});

	it("AC 14.3 — cloud-only 모드에서는 모드 게이트가 적용되지 않으며 settings 값이 그대로 반영", () => {
		plugin.settings.backendSelectionMode = "cloud-only";
		plugin.settings.speakerDiarizationEnabled = true;
		plugin.settings.translationEnabled = true;
		renderSidebarInlineControls(root, buildHost());

		const speaker = root.querySelector(
			'input[data-control="speaker-diarization"]',
		) as HTMLInputElement;
		const translation = root.querySelector(
			'input[data-control="translation-enabled"]',
		) as HTMLInputElement;

		expect(speaker.disabled).toBe(false);
		expect(translation.disabled).toBe(false);
		// cloud-only 에서는 settings 값이 컨트롤에 그대로 반영된다.
		expect(speaker.checked).toBe(true);
		expect(translation.checked).toBe(true);
	});
});
