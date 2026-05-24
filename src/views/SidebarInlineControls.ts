// Transcribe 사이드바 인라인 컨트롤 — 언어 / Bedrock 모델 빠른 선택.
//
// 설정 탭을 거치지 않고도 세션마다 자주 바뀌는 두 설정을 사이드바에서 즉시
// 변경할 수 있게 한다.
//
// 본 모듈은 DOM 렌더링 + 이벤트 바인딩만 담당하며, 실제 설정 저장/모델 목록
// 조회/설정 탭 동기화는 호출자가 주입하는 `SidebarInlineControlsHost` 에 위임한다.
//
// 심사 기준 준수:
// - `innerHTML` 금지 → `createEl` / `createSpan` / `setIcon` 사용.
// - 하드코딩 스타일 금지 → CSS 클래스만 부여(실제 스타일은 styles.css).
// - console.log 금지 → 오류만 `console.error`.

import { setIcon, type App } from "obsidian";

import type { Translations } from "../i18n";
import type { BedrockCatalogEntry } from "../services/BedrockModelCatalog";
import type {
	Curated_Target_Language,
	LanguageCode,
	Translation_Output_Format,
} from "../types/settings";

/**
 * 인라인 컨트롤이 호스트(`TranscribePlugin` 또는 stub)에게 요구하는 최소 계약.
 */
export interface SidebarInlineControlsHost {
	app: App;
	t: Translations;
	registerDomEvent(
		el: HTMLElement | Document | Window,
		type: string,
		cb: (evt: Event) => void,
	): void;
	/** 현재 설정에 저장된 전사 언어 코드. */
	getCurrentLanguage(): LanguageCode;
	/** 현재 설정에 저장된 Bedrock 모델 ID. */
	getCurrentModelId(): string;
	/** 언어 코드 변경을 설정에 반영한다. */
	setLanguage(code: LanguageCode): Promise<void> | void;
	/** 모델 ID 변경을 설정에 반영한다. */
	setModelId(modelId: string): Promise<void> | void;
	/** 현재 메모리에 캐시된 모델 카탈로그(앱 시작 직후에는 빈 배열). */
	getAvailableModels(): BedrockCatalogEntry[];
	/** 새로고침 아이콘 클릭 시 AWS 에서 카탈로그를 재조회한다. 실패 시 throw. */
	refreshAvailableModels(): Promise<BedrockCatalogEntry[]>;

	// ─── 미러 컨트롤 ───
	getCurrentSpeakerDiarizationEnabled(): boolean;
	setSpeakerDiarizationEnabled(enabled: boolean): Promise<void> | void;
	getCurrentTranslationEnabled(): boolean;
	setTranslationEnabled(enabled: boolean): Promise<void> | void;
	getCurrentTranslationTargetLanguage(): Curated_Target_Language;
	setTranslationTargetLanguage(
		lang: Curated_Target_Language,
	): Promise<void> | void;
	getCurrentTranslationOutputFormat(): Translation_Output_Format;
	setTranslationOutputFormat(
		format: Translation_Output_Format,
	): Promise<void> | void;

	// ─── 마이크 선택 ───
	getCurrentAudioInputDeviceId(): string;
	setAudioInputDeviceId(deviceId: string): Promise<void> | void;
	listAudioInputDevices(): Promise<MediaDeviceInfo[]>;
}

/** 전사 언어 드롭다운 옵션(설정 탭과 동일한 집합). */
const LANGUAGE_CODE_OPTIONS: readonly LanguageCode[] = ["ko-KR", "en-US"];

/**
 * 번역 대상 언어 드롭다운 옵션 (`Curated_Target_Language_List`).
 */
const CURATED_TARGET_LANGUAGE_OPTIONS: readonly Curated_Target_Language[] = [
	"en",
	"ko",
	"ja",
	"zh",
	"es",
	"fr",
	"de",
];

/**
 * 언어/모델 빠른 선택 영역을 그리는 헬퍼.
 */
export function renderSidebarInlineControls(
	root: HTMLElement,
	host: SidebarInlineControlsHost,
): { refreshModelOptions: () => void } {
	const t = host.t;
	const container = root.createDiv({ cls: "transcribe-inline-controls" });

	const createGroup = (
		groupId: "input" | "engine" | "output",
		title: string,
	): HTMLElement => {
		const section = container.createEl("section", {
			cls: "transcribe-inline-group",
			attr: { "data-group": groupId },
		});
		section.createDiv({
			cls: "transcribe-inline-group-title",
			text: title,
		});
		return section;
	};

	const inputGroup = createGroup("input", t.sidebar.groupInput);
	const engineGroup = createGroup("engine", t.sidebar.groupEngine);
	const outputGroup = createGroup("output", t.sidebar.groupOutput);

	// ─── 입력 그룹 ──────────────────────────────────────────────
	const langRow = inputGroup.createDiv({ cls: "transcribe-inline-row" });
	langRow.createSpan({
		cls: "transcribe-inline-label",
		text: t.sidebar.language,
	});
	const langSelect = langRow.createEl("select", {
		cls: "dropdown transcribe-inline-select",
	});
	for (const code of LANGUAGE_CODE_OPTIONS) {
		langSelect.createEl("option", { value: code, text: code });
	}
	langSelect.value = host.getCurrentLanguage();
	host.registerDomEvent(langSelect, "change", () => {
		const next = langSelect.value as LanguageCode;
		void Promise.resolve(host.setLanguage(next)).catch((err) => {
			console.error("[SidebarInlineControls] setLanguage failed:", err);
		});
	});

	const micRow = inputGroup.createDiv({ cls: "transcribe-inline-row" });
	micRow.createSpan({
		cls: "transcribe-inline-label",
		text: t.sidebar.microphone,
	});
	const micSelect = micRow.createEl("select", {
		cls: "dropdown transcribe-inline-select transcribe-inline-select--mic",
		attr: { "data-control": "audio-input-device" },
	});
	let cachedDevices: MediaDeviceInfo[] = [];
	populateMicSelect(micSelect, cachedDevices, host);
	host.registerDomEvent(micSelect, "change", () => {
		const next = micSelect.value;
		void Promise.resolve(host.setAudioInputDeviceId(next)).catch((err) => {
			console.error(
				"[SidebarInlineControls] setAudioInputDeviceId failed:",
				err,
			);
		});
	});

	const micRefreshBtn = micRow.createEl("button", {
		cls: "transcribe-inline-refresh",
		attr: {
			type: "button",
			"aria-label": t.sidebar.refreshMicrophones,
			title: t.sidebar.refreshMicrophones,
		},
	});
	setIcon(micRefreshBtn, "refresh-cw");
	host.registerDomEvent(micRefreshBtn, "click", () => {
		if (micRefreshBtn.hasAttribute("data-loading")) return;
		micRefreshBtn.setAttribute("data-loading", "true");
		micRefreshBtn.addClass("is-loading");
		void host
			.listAudioInputDevices()
			.then((devices) => {
				cachedDevices = devices;
				populateMicSelect(micSelect, cachedDevices, host);
			})
			.catch((err) => {
				console.error(
					"[SidebarInlineControls] listAudioInputDevices failed:",
					err,
				);
			})
			.finally(() => {
				micRefreshBtn.removeAttribute("data-loading");
				micRefreshBtn.removeClass("is-loading");
			});
	});

	void host
		.listAudioInputDevices()
		.then((devices) => {
			cachedDevices = devices;
			populateMicSelect(micSelect, cachedDevices, host);
		})
		.catch((err) => {
			console.error(
				"[SidebarInlineControls] initial listAudioInputDevices failed:",
				err,
			);
		});

	// ─── 엔진 그룹 ──────────────────────────────────────────────
	const modelRow = engineGroup.createDiv({ cls: "transcribe-inline-row" });
	modelRow.createSpan({
		cls: "transcribe-inline-label",
		text: t.sidebar.model,
	});
	const modelSelect = modelRow.createEl("select", {
		cls: "dropdown transcribe-inline-select transcribe-inline-select--model",
	});
	populateModelSelect(modelSelect, host);
	host.registerDomEvent(modelSelect, "change", () => {
		const next = modelSelect.value;
		if (next.length === 0) return;
		void Promise.resolve(host.setModelId(next)).catch((err) => {
			console.error("[SidebarInlineControls] setModelId failed:", err);
		});
	});
	const refreshBtn = modelRow.createEl("button", {
		cls: "transcribe-inline-refresh",
		attr: {
			type: "button",
			"aria-label": t.sidebar.refreshModels,
			title: t.sidebar.refreshModels,
		},
	});
	setIcon(refreshBtn, "refresh-cw");
	host.registerDomEvent(refreshBtn, "click", () => {
		if (refreshBtn.hasAttribute("data-loading")) return;
		refreshBtn.setAttribute("data-loading", "true");
		refreshBtn.addClass("is-loading");
		void host
			.refreshAvailableModels()
			.then(() => {
				populateModelSelect(modelSelect, host);
			})
			.catch((err) => {
				console.error(
					"[SidebarInlineControls] refreshAvailableModels failed:",
					err,
				);
			})
			.finally(() => {
				refreshBtn.removeAttribute("data-loading");
				refreshBtn.removeClass("is-loading");
			});
	});

	// ─── 출력 그룹 ──────────────────────────────────────────────
	const speakerRow = outputGroup.createDiv({ cls: "transcribe-inline-row" });
	speakerRow.createSpan({
		cls: "transcribe-inline-label",
		text: t.sidebar.speaker,
	});
	const speakerToggle = speakerRow.createEl("input", {
		cls: "transcribe-inline-toggle",
		attr: {
			type: "checkbox",
			"data-control": "speaker-diarization",
			"aria-label": t.sidebar.speaker,
		},
	});
	speakerToggle.checked = host.getCurrentSpeakerDiarizationEnabled();
	host.registerDomEvent(speakerToggle, "change", () => {
		void Promise.resolve(
			host.setSpeakerDiarizationEnabled(speakerToggle.checked),
		).catch((err) => {
			console.error(
				"[SidebarInlineControls] setSpeakerDiarizationEnabled failed:",
				err,
			);
		});
	});

	const translationRow = outputGroup.createDiv({
		cls: "transcribe-inline-row",
	});
	translationRow.createSpan({
		cls: "transcribe-inline-label",
		text: t.sidebar.translation,
	});
	const translationToggle = translationRow.createEl("input", {
		cls: "transcribe-inline-toggle",
		attr: {
			type: "checkbox",
			"data-control": "translation-enabled",
			"aria-label": t.sidebar.translation,
		},
	});
	translationToggle.checked = host.getCurrentTranslationEnabled();
	host.registerDomEvent(translationToggle, "change", () => {
		void Promise.resolve(
			host.setTranslationEnabled(translationToggle.checked),
		).catch((err) => {
			console.error(
				"[SidebarInlineControls] setTranslationEnabled failed:",
				err,
			);
		});
	});

	const targetLangRow = outputGroup.createDiv({
		cls: "transcribe-inline-row",
	});
	targetLangRow.createSpan({
		cls: "transcribe-inline-label",
		text: t.sidebar.targetLanguage,
	});
	const targetLangSelect = targetLangRow.createEl("select", {
		cls: "dropdown transcribe-inline-select",
		attr: { "data-control": "translation-target-language" },
	});
	for (const code of CURATED_TARGET_LANGUAGE_OPTIONS) {
		targetLangSelect.createEl("option", { value: code, text: code });
	}
	targetLangSelect.value = host.getCurrentTranslationTargetLanguage();
	host.registerDomEvent(targetLangSelect, "change", () => {
		const next = targetLangSelect.value as Curated_Target_Language;
		void Promise.resolve(host.setTranslationTargetLanguage(next)).catch(
			(err) => {
				console.error(
					"[SidebarInlineControls] setTranslationTargetLanguage failed:",
					err,
				);
			},
		);
	});

	const outputFormatRow = outputGroup.createDiv({
		cls: "transcribe-inline-row",
	});
	outputFormatRow.createSpan({
		cls: "transcribe-inline-label",
		text: t.settings.translation.outputFormat.name,
	});
	const outputFormatSelect = outputFormatRow.createEl("select", {
		cls: "dropdown transcribe-inline-select",
		attr: { "data-control": "translation-output-format" },
	});
	outputFormatSelect.createEl("option", {
		value: "inline",
		text: t.settings.translation.outputFormat.options.inline,
	});
	outputFormatSelect.createEl("option", {
		value: "none",
		text: t.settings.translation.outputFormat.options.none,
	});
	outputFormatSelect.value = host.getCurrentTranslationOutputFormat();
	host.registerDomEvent(outputFormatSelect, "change", () => {
		const next = outputFormatSelect.value as Translation_Output_Format;
		void Promise.resolve(host.setTranslationOutputFormat(next)).catch(
			(err) => {
				console.error(
					"[SidebarInlineControls] setTranslationOutputFormat failed:",
					err,
				);
			},
		);
	});

	return {
		refreshModelOptions: () => populateModelSelect(modelSelect, host),
	};
}

/**
 * 모델 드롭다운 옵션을 호스트의 현재 카탈로그 + 저장된 값 기준으로 재구성한다.
 */
function populateModelSelect(
	selectEl: HTMLSelectElement,
	host: SidebarInlineControlsHost,
): void {
	selectEl.empty();
	const current = host.getCurrentModelId().trim();
	const catalog = host.getAvailableModels();
	const known = new Set(catalog.map((m) => m.id));

	if (current.length > 0 && !known.has(current)) {
		const opt = selectEl.createEl("option", {
			value: current,
			text: current,
		});
		opt.selected = true;
	}

	const byProvider = new Map<string, BedrockCatalogEntry[]>();
	for (const entry of catalog) {
		const list = byProvider.get(entry.provider) ?? [];
		list.push(entry);
		byProvider.set(entry.provider, list);
	}

	for (const [provider, entries] of byProvider) {
		const group = selectEl.createEl("optgroup", {
			attr: { label: provider },
		});
		for (const entry of entries) {
			const prefix = entry.kind === "inference-profile" ? "⚡ " : "";
			const opt = group.createEl("option", {
				value: entry.id,
				text: `${prefix}${entry.label}`,
			});
			if (entry.id === current) {
				opt.selected = true;
			}
		}
	}

	if (selectEl.options.length === 0) {
		selectEl.createEl("option", {
			value: "",
			text: host.t.sidebar.noModelsHint,
		});
	}
}

/**
 * 마이크 드롭다운 옵션을 enumerate 결과 + 저장된 deviceId 기준으로 재구성한다.
 */
function populateMicSelect(
	selectEl: HTMLSelectElement,
	devices: readonly MediaDeviceInfo[],
	host: SidebarInlineControlsHost,
): void {
	selectEl.empty();
	const current = host.getCurrentAudioInputDeviceId();

	const defaultOpt = selectEl.createEl("option", {
		value: "",
		text: host.t.sidebar.microphoneDefault,
	});
	if (current.length === 0) {
		defaultOpt.selected = true;
	}

	const knownIds = new Set<string>();
	devices.forEach((device, idx) => {
		const id = device.deviceId;
		if (id.length === 0 || id === "default") {
			return;
		}
		knownIds.add(id);
		const label =
			device.label.length > 0
				? device.label
				: host.t.sidebar.microphoneUnknown(idx + 1);
		const opt = selectEl.createEl("option", { value: id, text: label });
		if (id === current) {
			opt.selected = true;
		}
	});

	if (current.length > 0 && !knownIds.has(current)) {
		const opt = selectEl.createEl("option", {
			value: current,
			text: current,
		});
		opt.selected = true;
	}
}
