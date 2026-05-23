// Transcribe 사이드바 인라인 컨트롤 — 언어 / Bedrock 모델 빠른 선택.
//
// 설정 탭을 거치지 않고도 세션마다 자주 바뀌는 두 설정을 사이드바에서 즉시
// 변경할 수 있게 한다(사용자 요구 — 2026-05, TASK 13).
//
// 본 모듈은 DOM 렌더링 + 이벤트 바인딩만 담당하며, 실제 설정 저장/모델 목록
// 조회/설정 탭 동기화는 호출자가 주입하는 `SidebarInlineControlsHost` 에 위임한다.
// 이렇게 분리한 이유는 `SidebarView` 파일 크기 제약(코딩 스타일 800라인) 때문이다.
//
// 심사 기준 준수:
// - `innerHTML` 금지 → `createEl` / `createSpan` / `setIcon` 사용.
// - 하드코딩 스타일 금지 → CSS 클래스만 부여(실제 스타일은 styles.css).
// - console.log 금지 → 오류만 `console.error`.

import { setIcon, type App } from "obsidian";

import type { Translations } from "../i18n";
import type { BedrockCatalogEntry } from "../services/BedrockModelCatalog";
import type {
	Backend_Selection_Mode,
	Curated_Target_Language,
	LanguageCode,
	Translation_Output_Format,
} from "../types/settings";

/**
 * 인라인 컨트롤이 호스트(`TranscribePlugin` 또는 stub)에게 요구하는 최소 계약.
 *
 * `SidebarView.TranscribePluginLike` 와 중복되는 필드도 있으나, 이 모듈이 직접
 * 필요로 하는 것만 추려 느슨한 결합을 유지한다.
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

	// ─── v1.1 신규 (task 24) — 미러 컨트롤 ───
	/** 현재 설정의 화자 분리 활성 여부 (Requirement 6.2). */
	getCurrentSpeakerDiarizationEnabled(): boolean;
	/** 화자 분리 토글 — 설정 탭 토글과 양방향 미러 동기화 (Requirement 6.2). */
	setSpeakerDiarizationEnabled(enabled: boolean): Promise<void> | void;
	/** 현재 설정의 실시간 번역 활성 여부 (Requirement 13.2). */
	getCurrentTranslationEnabled(): boolean;
	/** 번역 토글 — 설정 탭 토글과 양방향 미러 동기화 (Requirement 13.2). */
	setTranslationEnabled(enabled: boolean): Promise<void> | void;
	/** 현재 설정의 번역 대상 언어 (Requirement 13.3). */
	getCurrentTranslationTargetLanguage(): Curated_Target_Language;
	/** 번역 대상 언어 드롭다운 — 설정 탭과 양방향 미러 동기화. */
	setTranslationTargetLanguage(
		lang: Curated_Target_Language,
	): Promise<void> | void;
	/** 현재 설정의 번역 출력 형식 (Requirement 13.7). */
	getCurrentTranslationOutputFormat(): Translation_Output_Format;
	/** 번역 출력 형식 드롭다운 — inline / none. */
	setTranslationOutputFormat(
		format: Translation_Output_Format,
	): Promise<void> | void;
	/**
	 * 현재 설정의 백엔드 선택 모드 (Requirement 14.2, 14.3).
	 *
	 * `local-only` 일 때 사이드바 인라인 컨트롤은 idle 상태에서도 (a) 번역 토글,
	 * (b) 번역 대상 언어 드롭다운, (c) 화자 분리 토글 3 개 컨트롤을 disabled 로
	 * 렌더링하고 툴팁 `tooltipOnlineOnlyFeature` 를 부착한다. (d) AI 분석 버튼은
	 * `SidebarView.renderControls()` 가 따로 그리므로 본 모듈의 책임이 아니다.
	 *
	 * `auto` / `cloud-only` 에서는 자유 조작을 허용한다 (Requirement 14.3).
	 */
	getCurrentBackendSelectionMode(): Backend_Selection_Mode;
	/**
	 * 백엔드 선택 모드 변경을 설정에 반영하고 저장한다 (task 33).
	 *
	 * 사이드바 백엔드 드롭다운에서 즉시 모드를 전환할 수 있도록 host 가 노출하는
	 * setter 다. 설정 탭의 동일 드롭다운과 동일하게 인라인 컨트롤 disabled 상태가
	 * 즉시 갱신되어야 하므로 호출 측은 저장 직후 `SidebarView.render()` 를
	 * 트리거한다(또는 host 가 알아서 트리거).
	 */
	setBackendSelectionMode(mode: Backend_Selection_Mode): Promise<void> | void;
	/**
	 * 현재 설정의 로컬 Whisper 모델 식별자 (task 33).
	 *
	 * 활성 엔진 표시 라벨에서 local 백엔드일 때 모델명을 노출하기 위해 host 가
	 * 그대로 전달한다. 빈 문자열은 "미선택" 으로 간주한다.
	 */
	getCurrentLocalModelId(): string;
}

/** 전사 언어 드롭다운 옵션(설정 탭과 동일한 집합). */
const LANGUAGE_CODE_OPTIONS: readonly LanguageCode[] = ["ko-KR", "en-US"];

/**
 * 번역 대상 언어 드롭다운 옵션 (Requirement 13.3, `Curated_Target_Language_List`).
 *
 * 7 개 화이트리스트와 정확히 일치한다. 사이드바는 폭이 좁아 풀 표시명 대신 ISO 코드만
 * 노출한다(설정 탭에서 풀 표시명이 보이므로 사용자 인지 비용은 낮다).
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
 *
 * 반환값(`refreshModelOptions`)은 호스트가 모델 목록을 새로 받아왔을 때
 * 드롭다운 옵션만 다시 채우도록 하는 얇은 API 다. 전체 re-render 가 필요하면
 * `SidebarView.render()` 를 호출하면 된다.
 */
export function renderSidebarInlineControls(
	root: HTMLElement,
	host: SidebarInlineControlsHost,
): { refreshModelOptions: () => void } {
	const t = host.t;
	const container = root.createDiv({ cls: "transcribe-inline-controls" });

	// ── 언어 드롭다운 ────────────────────────────────────────────
	const langRow = container.createDiv({ cls: "transcribe-inline-row" });
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

	// ── 모델 드롭다운 + 새로고침 아이콘 ────────────────────────────
	const modelRow = container.createDiv({ cls: "transcribe-inline-row" });
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

	// 새로고침 아이콘 — 모델 카탈로그 재조회. 로딩 중에는 자신을 비활성화.
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

	// ── v1.1 task 33 — 백엔드 선택 드롭다운 ────────────────────────
	// 모델 항목 바로 아래에 배치하여 사용자가 "어떤 분석 모델로, 어떤 백엔드에서" 동작 중인지를
	// 한 시야에 확인할 수 있게 한다. 설정 탭의 백엔드 드롭다운과 양방향 미러 동기화된다.
	const backendRow = container.createDiv({ cls: "transcribe-inline-row" });
	backendRow.createSpan({
		cls: "transcribe-inline-label",
		text: t.sidebar.backend,
	});
	const backendSelect = backendRow.createEl("select", {
		cls: "dropdown transcribe-inline-select",
		attr: { "data-control": "backend-selection-mode" },
	});
	const BACKEND_OPTIONS: readonly Backend_Selection_Mode[] = [
		"cloud-only",
		"local-only",
		"auto",
	];
	for (const mode of BACKEND_OPTIONS) {
		backendSelect.createEl("option", {
			value: mode,
			text: t.sidebar.backendOptions[mode],
		});
	}
	backendSelect.value = host.getCurrentBackendSelectionMode();
	host.registerDomEvent(backendSelect, "change", () => {
		const next = backendSelect.value as Backend_Selection_Mode;
		void Promise.resolve(host.setBackendSelectionMode(next)).catch((err) => {
			console.error(
				"[SidebarInlineControls] setBackendSelectionMode failed:",
				err,
			);
		});
	});

	// ── v1.1 task 33 — 활성 전사 엔진 표시 (read-only) ─────────────
	// 백엔드별로 어떤 엔진이 사용되는지 사용자에게 명시적으로 노출한다.
	//   - cloud-only: "AWS Transcribe"
	//   - local-only: "Hugging Face 모델 (<localModelId>)"
	//   - auto: 두 엔진을 슬래시로 함께 표기
	const engineRow = container.createDiv({
		cls: "transcribe-inline-row transcribe-inline-row--engine",
	});
	engineRow.createSpan({
		cls: "transcribe-inline-label",
		text: t.sidebar.activeEngine,
	});
	engineRow.createSpan({
		cls: "transcribe-inline-engine",
		text: formatActiveEngineLabel(
			host.getCurrentBackendSelectionMode(),
			host.getCurrentLocalModelId(),
			t,
		),
	});

	// ── v1.1 신규 (task 24) — 화자 분리 / 번역 / 대상 언어 미러 컨트롤 ──

	// 모드 게이트 (Requirement 14.2, 14.3) — `local-only` 일 때 미러 컨트롤
	// 3 개를 disabled 로 렌더링하고 툴팁을 부착한다. 토글의 표시상 강제 OFF 는
	// 컨트롤 단위로 결정한다 — settings 값 자체는 변경하지 않으므로 클라우드
	// 모드 복귀 시 사용자가 저장해 둔 토글 상태가 그대로 살아난다.
	const isOfflineGated = host.getCurrentBackendSelectionMode() === "local-only";
	const offlineTooltip = t.notices.tooltipOnlineOnlyFeature;

	// 화자 분리 토글 — 설정 탭과 양방향 미러 (Requirement 6.2).
	const speakerRow = container.createDiv({ cls: "transcribe-inline-row" });
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
	// `local-only` 인 경우 표시상 강제 OFF (saved settings 는 변경하지 않음).
	speakerToggle.checked = isOfflineGated
		? false
		: host.getCurrentSpeakerDiarizationEnabled();
	if (isOfflineGated) {
		applyOfflineGate(speakerRow, speakerToggle, offlineTooltip);
	}
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

	// 실시간 번역 토글 — 설정 탭과 양방향 미러 (Requirement 13.2).
	const translationRow = container.createDiv({ cls: "transcribe-inline-row" });
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
	translationToggle.checked = isOfflineGated
		? false
		: host.getCurrentTranslationEnabled();
	if (isOfflineGated) {
		applyOfflineGate(translationRow, translationToggle, offlineTooltip);
	}
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

	// 번역 대상 언어 드롭다운 — 7 개 화이트리스트 (Requirement 13.3).
	const targetLangRow = container.createDiv({ cls: "transcribe-inline-row" });
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
	if (isOfflineGated) {
		applyOfflineGate(targetLangRow, targetLangSelect, offlineTooltip);
	}
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

	// 번역 출력 형식 드롭다운 (Requirement 13.7) — 노트 저장 시 inline / none.
	// 모드 게이트(Requirement 14.2) 와 동일한 패턴으로 `local-only` 시 disabled.
	const outputFormatRow = container.createDiv({
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
	if (isOfflineGated) {
		applyOfflineGate(outputFormatRow, outputFormatSelect, offlineTooltip);
	}
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
 *
 * 저장된 값이 카탈로그에 없으면 맨 위에 직접 옵션으로 추가해 "새로고침 전에도
 * 마지막 사용 모델이 선택된 상태로 보이도록" 한다(설정 탭과 동일한 동작).
 * 카탈로그가 비어 있고 저장된 값도 없으면 placeholder 안내 옵션을 둔다.
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
				// 사이드바는 폭이 좁으므로 id 는 생략하고 라벨만 노출한다.
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
 * 활성 전사 엔진 라벨을 백엔드 모드 + 로컬 모델 ID 기준으로 합성한다 (task 33).
 *
 * - `cloud-only`: "AWS Transcribe"
 * - `local-only`: "Hugging Face model (<localModelId>)"
 * - `auto`: 두 엔진을 슬래시로 표기 — 자동 폴백 시 양쪽 모두 사용될 수 있음을 시사.
 *
 * 외부에서도 단위 테스트 가능하도록 export 한다.
 */
export function formatActiveEngineLabel(
	mode: Backend_Selection_Mode,
	localModelId: string,
	t: Translations,
): string {
	const cloudLabel = t.sidebar.cloudEngineLabel;
	const localLabel = t.sidebar.localEngineLabel(localModelId);
	if (mode === "cloud-only") return cloudLabel;
	if (mode === "local-only") return localLabel;
	return `${cloudLabel} / ${localLabel}`;
}

/**
 * 모드 게이트 (Requirement 14.2) — 사이드바 인라인 컨트롤을 disabled 상태로
 * 렌더링하고 툴팁/데이터 속성을 부착한다.
 *
 * - 컨트롤(`<input>` / `<select>`)의 `disabled` 와 `aria-label` / `title` 을 설정.
 * - 행 컨테이너(`row`)에 `data-disabled-reason="offline-mode"` 데이터 속성을 부착.
 *   설정 탭의 `applyOnlineOnlyGate` 와 동일한 규칙을 따라 PBT/예제 테스트가 사유를
 *   검증할 수 있게 한다 (design §4.8).
 */
function applyOfflineGate(
	row: HTMLElement,
	control: HTMLInputElement | HTMLSelectElement,
	tooltip: string,
): void {
	control.disabled = true;
	control.setAttribute("aria-label", tooltip);
	control.setAttribute("title", tooltip);
	row.setAttribute("data-disabled-reason", "offline-mode");
	row.setAttribute("aria-label", tooltip);
	row.setAttribute("title", tooltip);
}
