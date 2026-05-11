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
import type { LanguageCode } from "../types/settings";

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
}

/** 전사 언어 드롭다운 옵션(설정 탭과 동일한 집합). */
const LANGUAGE_CODE_OPTIONS: readonly LanguageCode[] = ["ko-KR", "en-US"];

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
