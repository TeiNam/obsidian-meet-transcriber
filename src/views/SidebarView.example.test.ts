/**
 * `SidebarView` 렌더 예시 테스트 (Task 15.2).
 *
 * 검증 목표:
 * - 상태 레이블이 UI_Locale에 맞게 표시되고, 빈 상태 안내 문구가 올바르게 전환되며,
 *   편집 모드 토글과 분석 스피너 표시/숨김이 의도대로 동작한다
 *   (Requirements 1.9, 1.10, 3.5, 5.3, 5.4, 6.6).
 * - `onLocaleChange` 호출 시 500ms 이내에 버튼/레이블이 새 로케일로 재렌더링된다
 *   (Requirement 10.5).
 * - 뷰 구현이 `innerHTML`/`outerHTML`/`insertAdjacentHTML`를 코드상에서 사용하지
 *   않고 Obsidian의 `createEl` 계열만 사용한다(Requirement 9.5).
 *
 * 테스트 전략:
 * - `TranscribePluginLike` 계약을 만족하는 가짜 플러그인 객체를 만든다.
 *   `registerDomEvent`는 실제로 `el.addEventListener`를 호출해 클릭 테스트가 가능하도록 한다.
 *   (기본 `vi.fn()`만으로는 클릭 이벤트가 핸들러로 전달되지 않는다.)
 * - `new SidebarView(leaf, plugin)`을 만들고 `await view.onOpen()`으로 초기 렌더를 트리거한다.
 * - DOM 단언은 `view.contentEl`를 루트로 `querySelector`로 수행한다.
 *
 * 모든 테스트는 `tests/setup.ts`가 `HTMLElement.prototype`에 심어둔 Obsidian DOM
 * 확장 폴리필(createEl, createDiv, createSpan, setText, setAttr, addClass,
 * toggleClass, empty)에 의존한다.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { App, WorkspaceLeaf } from "obsidian";
import { createI18n, type Translations } from "../i18n";
import {
	SidebarView,
	VIEW_TYPE_TRANSCRIBE,
	type SidebarEnvironmentInputs,
	type TranscribePluginLike,
} from "./SidebarView";

// -----------------------------------------------------------------------------
// 테스트 헬퍼
// -----------------------------------------------------------------------------

/**
 * 테스트에서 반복 사용할 기본 환경 입력.
 *
 * 개별 테스트는 필요한 필드만 덮어쓰도록 spread 한다(예: `{ ...defaultEnv(),
 * hasTranscriptNote: true, transcriptLength: 10 }`).
 */
function defaultEnv(): SidebarEnvironmentInputs {
	return {
		hasTranscriptNote: false,
		transcriptLength: 0,
		hasCredentials: false,
		hasBedrockModel: false,
	};
}

/**
 * `TranscribePluginLike`를 만족하는 가짜 플러그인 객체를 생성한다.
 *
 * - `t`는 기본적으로 영어 번역으로 초기화된다. 로케일 전환 테스트는 이 필드에
 *   새 번역 객체를 직접 할당한다(실제 플러그인의 `changeLocale` 동작 모사).
 * - `registerDomEvent`는 리스너 누수 방지를 위해 `el.addEventListener`에 위임한다.
 *   테스트 종료 시점에 명시적 해제는 하지 않는다(뷰 인스턴스가 테스트별로 폐기됨).
 * - 핸들러들은 `vi.fn()`으로 스파이 구성한다.
 */
function createFakePlugin(
	locale: "en" | "ko" = "en",
	envOverride?: Partial<SidebarEnvironmentInputs>,
): TranscribePluginLike & {
	handleStartStopClick: ReturnType<typeof vi.fn>;
	handleEditClick: ReturnType<typeof vi.fn>;
	handleAnalyzeClick: ReturnType<typeof vi.fn>;
	handleSaveEditClick: ReturnType<typeof vi.fn>;
	handleCancelEditClick: ReturnType<typeof vi.fn>;
	registerDomEvent: ReturnType<typeof vi.fn>;
	getEnvironmentInputs: ReturnType<typeof vi.fn>;
} {
	const env: SidebarEnvironmentInputs = { ...defaultEnv(), ...envOverride };
	const plugin = {
		app: new App(),
		t: createI18n(locale),
		registerDomEvent: vi.fn(
			(
				el: HTMLElement | Document | Window,
				type: string,
				cb: (evt: Event) => void,
			) => {
				(el as HTMLElement).addEventListener(type, cb);
			},
		),
		getEnvironmentInputs: vi.fn(() => env),
		handleStartStopClick: vi.fn(),
		handleEditClick: vi.fn(),
		handleAnalyzeClick: vi.fn(),
		handleSaveEditClick: vi.fn().mockResolvedValue(undefined),
		handleCancelEditClick: vi.fn(),
		// 사이드바 인라인 컨트롤 계약(TASK 13) — stub 기본값.
		getCurrentLanguage: vi.fn(() => "ko-KR" as const),
		getCurrentModelId: vi.fn(() => ""),
		setLanguage: vi.fn().mockResolvedValue(undefined),
		setModelId: vi.fn().mockResolvedValue(undefined),
		getAvailableModels: vi.fn(() => []),
		refreshAvailableModels: vi.fn().mockResolvedValue([]),
	};
	// vi.fn 구체 타입과 `Mock<any[], unknown>` 사이의 공변성 차이를 우회한다.
	// 런타임 동작은 동일하며, 테스트는 반환값의 `.mock.calls` 를 확인할 뿐이다.
	return plugin as unknown as TranscribePluginLike & {
		handleStartStopClick: ReturnType<typeof vi.fn>;
		handleEditClick: ReturnType<typeof vi.fn>;
		handleAnalyzeClick: ReturnType<typeof vi.fn>;
		handleSaveEditClick: ReturnType<typeof vi.fn>;
		handleCancelEditClick: ReturnType<typeof vi.fn>;
		registerDomEvent: ReturnType<typeof vi.fn>;
		getEnvironmentInputs: ReturnType<typeof vi.fn>;
	};
}

/**
 * 열린 `SidebarView` 인스턴스를 생성하고 `onOpen()`으로 초기 렌더까지 완료한다.
 */
async function mountView(
	plugin: ReturnType<typeof createFakePlugin>,
): Promise<SidebarView> {
	const leaf = new WorkspaceLeaf();
	const view = new SidebarView(leaf, plugin);
	await view.onOpen();
	return view;
}

/** DOM 루트에서 CSS 선택자로 단일 엘리먼트를 조회한다(없으면 테스트 실패). */
function q<T extends Element = HTMLElement>(
	root: ParentNode,
	selector: string,
): T {
	const el = root.querySelector<T>(selector);
	if (!el) {
		throw new Error(`Element not found: ${selector}`);
	}
	return el;
}

/**
 * 단일 라인/멀티라인 주석을 제거한 소스 문자열을 반환한다.
 *
 * 구현의 독스트링/주석에 `innerHTML`이 "금지 API"로 언급될 수 있으므로,
 * 심사 대상은 "실행되는 코드"이며 주석은 제외하고 검사한다.
 * 문자열 리터럴 내부는 현재 소스에 없으므로 별도 처리하지 않는다(단순 휴리스틱).
 */
function stripComments(src: string): string {
	// /* ... */ 블록 주석 제거 (비탐욕 매칭)
	let out = src.replace(/\/\*[\s\S]*?\*\//g, "");
	// // ... 라인 주석 제거 (문자열 리터럴 내부가 아니라고 가정)
	out = out.replace(/^[ \t]*\/\/.*$/gm, "");
	out = out.replace(/\/\/[^\n]*/g, "");
	return out;
}

// -----------------------------------------------------------------------------
// 테스트 suite
// -----------------------------------------------------------------------------

describe("SidebarView — 초기 렌더", () => {
	it("뷰 타입과 디스플레이 텍스트/아이콘이 노출된다", async () => {
		const plugin = createFakePlugin("en");
		const view = await mountView(plugin);

		expect(view.getViewType()).toBe(VIEW_TYPE_TRANSCRIBE);
		expect(view.getDisplayText()).toBe(plugin.t.view.displayText);
		expect(view.getIcon()).toBe("mic");
	});

	it("초기 상태는 idle이며 영어 레이블이 표시된다 (Requirement 1.9)", async () => {
		const plugin = createFakePlugin("en");
		const view = await mountView(plugin);

		const status = q(view.contentEl, ".transcribe-status");
		expect(status.getAttribute("data-state")).toBe("idle");

		const label = q(view.contentEl, ".state-label");
		expect(label.textContent).toBe(plugin.t.states.idle); // "Idle"

		// 재연결 라벨은 숨김
		const reconnect = q(view.contentEl, ".reconnect-label");
		expect(reconnect.classList.contains("is-hidden")).toBe(true);

		// 3개 버튼과 레이블 확인
		const startStopBtn = q<HTMLButtonElement>(
			view.contentEl,
			".start-stop-btn",
		);
		expect(startStopBtn.textContent).toBe(plugin.t.buttons.start);
		expect(startStopBtn.disabled).toBe(false);

		const editBtn = q<HTMLButtonElement>(view.contentEl, ".edit-btn");
		expect(editBtn.disabled).toBe(true);

		const analyzeBtn = q<HTMLButtonElement>(view.contentEl, ".analyze-btn");
		expect(analyzeBtn.disabled).toBe(true);
	});

	it("빈 상태 안내 문구가 표시되고 transcript-text는 is-empty 클래스를 가진다 (Requirement 1.10)", async () => {
		const plugin = createFakePlugin("en");
		const view = await mountView(plugin);

		const textArea = q(view.contentEl, ".transcript-text");
		expect(textArea.classList.contains("is-empty")).toBe(true);

		const hint = q(view.contentEl, ".empty-hint");
		expect(hint.textContent).toBe(plugin.t.ui.empty); // "No transcript available."
		expect(hint.classList.contains("is-hidden")).toBe(false);
	});

	it("스피너는 기본적으로 숨겨져 있다", async () => {
		const plugin = createFakePlugin("en");
		const view = await mountView(plugin);

		const spinner = q(view.contentEl, ".transcribe-spinner");
		expect(spinner.classList.contains("is-hidden")).toBe(true);
		expect(spinner.textContent).toBe(plugin.t.ui.analyzing);
	});
});

describe("SidebarView — 로케일 전환", () => {
	it("onLocaleChange 호출 시 버튼/레이블이 한국어로 재렌더된다 (Requirement 10.5)", async () => {
		const plugin = createFakePlugin("en");
		const view = await mountView(plugin);

		// 초기: 영어
		expect(q(view.contentEl, ".state-label").textContent).toBe(
			plugin.t.states.idle,
		);
		expect(
			q<HTMLButtonElement>(view.contentEl, ".start-stop-btn").textContent,
		).toBe(plugin.t.buttons.start);

		// 로케일 교체 — plugin.t를 먼저 업데이트한 뒤 뷰에 알린다(실제 플러그인 동선).
		const started = performance.now();
		const koT: Translations = createI18n("ko");
		plugin.t = koT;
		view.onLocaleChange(koT);
		const elapsed = performance.now() - started;

		// 재렌더 완료는 동기적이며 500ms 내에 반영되어야 한다.
		expect(elapsed).toBeLessThan(500);

		// DOM 재조회 — render() 이후 참조가 교체됨
		expect(q(view.contentEl, ".state-label").textContent).toBe(koT.states.idle); // "대기"
		expect(
			q<HTMLButtonElement>(view.contentEl, ".start-stop-btn").textContent,
		).toBe(koT.buttons.start); // "스트리밍 시작"
		expect(q(view.contentEl, ".empty-hint").textContent).toBe(koT.ui.empty);
		expect(q(view.contentEl, ".transcribe-spinner").textContent).toBe(
			koT.ui.analyzing,
		);
	});
});

describe("SidebarView — updateState (Requirement 1.9)", () => {
	it("streaming 상태는 data-state와 레이블을 갱신하고 재연결 라벨은 숨긴다", async () => {
		const plugin = createFakePlugin("en");
		const view = await mountView(plugin);

		view.updateState("streaming", false);

		const status = q(view.contentEl, ".transcribe-status");
		expect(status.getAttribute("data-state")).toBe("streaming");
		expect(q(view.contentEl, ".state-label").textContent).toBe(
			plugin.t.states.streaming,
		);
		expect(
			q(view.contentEl, ".reconnect-label").classList.contains("is-hidden"),
		).toBe(true);

		// 스트리밍 중에는 시작/중지 레이블이 stop으로 바뀌어야 한다.
		expect(
			q<HTMLButtonElement>(view.contentEl, ".start-stop-btn").textContent,
		).toBe(plugin.t.buttons.stop);
	});

	it("재연결 중이면 보조 라벨이 노출된다", async () => {
		const plugin = createFakePlugin("en");
		const view = await mountView(plugin);

		view.updateState("streaming", true);

		const reconnect = q(view.contentEl, ".reconnect-label");
		expect(reconnect.classList.contains("is-hidden")).toBe(false);
		expect(reconnect.textContent).toBe(plugin.t.states.reconnecting);
	});
});

describe("SidebarView — partial/final 표시 (Requirement 3.5)", () => {
	it("appendPartial은 partial span에 텍스트를 반영하고 빈 상태를 해제한다", async () => {
		const plugin = createFakePlugin("ko");
		const view = await mountView(plugin);

		view.appendPartial("안녕");

		const partial = q(view.contentEl, ".partial");
		expect(partial.textContent).toBe("안녕"); // committed가 비었으므로 prefix 공백 없음
		expect(
			q(view.contentEl, ".transcript-text").classList.contains("is-empty"),
		).toBe(false);
		expect(
			q(view.contentEl, ".empty-hint").classList.contains("is-hidden"),
		).toBe(true);
	});

	it("commitFinal은 committed span을 갱신하고 partial을 비운다", async () => {
		const plugin = createFakePlugin("ko");
		const view = await mountView(plugin);

		view.appendPartial("안녕");
		view.commitFinal("안녕하세요");

		expect(q(view.contentEl, ".committed").textContent).toBe("안녕하세요");
		expect(q(view.contentEl, ".partial").textContent).toBe("");
	});

	it("loadNoteContent('')로 빈 상태가 복원된다 (Requirement 1.10)", async () => {
		const plugin = createFakePlugin("en");
		const view = await mountView(plugin);

		view.appendPartial("x");
		expect(
			q(view.contentEl, ".transcript-text").classList.contains("is-empty"),
		).toBe(false);

		view.loadNoteContent("");
		expect(
			q(view.contentEl, ".transcript-text").classList.contains("is-empty"),
		).toBe(true);
		expect(
			q(view.contentEl, ".empty-hint").classList.contains("is-hidden"),
		).toBe(false);
	});
});

describe("SidebarView — 편집 모드 (Requirements 5.3, 5.4)", () => {
	it("enterEditMode는 textarea와 저장/취소 버튼을 렌더링하고 현재 본문을 채운다", async () => {
		const plugin = createFakePlugin("en", {
			hasTranscriptNote: true,
			transcriptLength: 13,
		});
		const view = await mountView(plugin);

		view.loadNoteContent("original body");
		view.enterEditMode();

		const textarea = q<HTMLTextAreaElement>(
			view.contentEl,
			"textarea.transcribe-editor",
		);
		expect(textarea.value).toBe("original body");

		const saveBtn = q<HTMLButtonElement>(view.contentEl, ".save-btn");
		expect(saveBtn.textContent).toBe(plugin.t.buttons.save);

		const cancelBtn = q<HTMLButtonElement>(view.contentEl, ".cancel-btn");
		expect(cancelBtn.textContent).toBe(plugin.t.buttons.cancel);

		// 편집 모드에서는 읽기 모드 DOM이 제거된다.
		expect(view.contentEl.querySelector(".transcript-text")).toBeNull();
	});

	it("저장 버튼 클릭 시 handleSaveEditClick을 textarea 값으로 호출하고 읽기 모드로 복귀한다", async () => {
		const plugin = createFakePlugin("en", {
			hasTranscriptNote: true,
			transcriptLength: 5,
		});
		const view = await mountView(plugin);

		view.loadNoteContent("hello");
		view.enterEditMode();

		const textarea = q<HTMLTextAreaElement>(
			view.contentEl,
			"textarea.transcribe-editor",
		);
		textarea.value = "hello edited";

		const saveBtn = q<HTMLButtonElement>(view.contentEl, ".save-btn");
		saveBtn.dispatchEvent(new Event("click"));

		// 클릭 리스너는 `void view.exitEditMode(true)`를 호출하므로 await 가능한 참조가 없다.
		// async 함수 내부에서 `await handleSaveEditClick(...)`까지 완료되고 `renderReadMode()`가
		// 돌아올 때까지 이벤트 루프를 한 틱 돌려 준다.
		await new Promise((r) => setTimeout(r, 0));
		await Promise.resolve();

		expect(plugin.handleSaveEditClick).toHaveBeenCalledWith("hello edited");
		expect(
			view.contentEl.querySelector("textarea.transcribe-editor"),
		).toBeNull();
		expect(q(view.contentEl, ".transcript-text")).not.toBeNull();
	});

	it("취소 버튼은 handleCancelEditClick을 호출하고 편집 모드에서 빠져나온다", async () => {
		const plugin = createFakePlugin("en", {
			hasTranscriptNote: true,
			transcriptLength: 5,
		});
		const view = await mountView(plugin);

		view.loadNoteContent("hello");
		view.enterEditMode();

		const cancelBtn = q<HTMLButtonElement>(view.contentEl, ".cancel-btn");
		cancelBtn.dispatchEvent(new Event("click"));

		await Promise.resolve();

		expect(plugin.handleCancelEditClick).toHaveBeenCalledTimes(1);
		expect(
			view.contentEl.querySelector("textarea.transcribe-editor"),
		).toBeNull();
	});

	it("저장 핸들러가 예외를 던지면 편집 모드를 유지한다 (Requirement 5.8)", async () => {
		const plugin = createFakePlugin("en", {
			hasTranscriptNote: true,
			transcriptLength: 5,
		});
		plugin.handleSaveEditClick.mockRejectedValueOnce(new Error("empty"));

		// 핸들러가 의도적으로 reject 하므로 console.error 노이즈를 억제한다.
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		const view = await mountView(plugin);
		view.loadNoteContent("hello");
		view.enterEditMode();

		await view.exitEditMode(true);

		expect(plugin.handleSaveEditClick).toHaveBeenCalled();
		// 편집 textarea가 여전히 존재해야 한다.
		expect(
			view.contentEl.querySelector("textarea.transcribe-editor"),
		).not.toBeNull();

		errSpy.mockRestore();
	});
});

describe("SidebarView — 분석 스피너 (Requirements 6.6, 6.16)", () => {
	it("showAnalyzeSpinner(true)는 스피너를 노출하고 모든 버튼을 비활성화한다", async () => {
		const plugin = createFakePlugin("en", {
			hasTranscriptNote: true,
			transcriptLength: 100,
			hasCredentials: true,
			hasBedrockModel: true,
		});
		const view = await mountView(plugin);

		view.showAnalyzeSpinner(true);

		const spinner = q(view.contentEl, ".transcribe-spinner");
		expect(spinner.classList.contains("is-hidden")).toBe(false);

		expect(
			q<HTMLButtonElement>(view.contentEl, ".start-stop-btn").disabled,
		).toBe(true);
		expect(q<HTMLButtonElement>(view.contentEl, ".edit-btn").disabled).toBe(
			true,
		);
		expect(q<HTMLButtonElement>(view.contentEl, ".analyze-btn").disabled).toBe(
			true,
		);
	});

	it("showAnalyzeSpinner(false)는 스피너를 숨긴다", async () => {
		const plugin = createFakePlugin("en");
		const view = await mountView(plugin);

		view.showAnalyzeSpinner(true);
		view.showAnalyzeSpinner(false);

		expect(
			q(view.contentEl, ".transcribe-spinner").classList.contains("is-hidden"),
		).toBe(true);
	});
});

describe("SidebarView — 클릭 이벤트 (registerDomEvent)", () => {
	it("시작 버튼 클릭은 handleStartStopClick으로 라우팅된다", async () => {
		const plugin = createFakePlugin("en");
		const view = await mountView(plugin);

		q<HTMLButtonElement>(view.contentEl, ".start-stop-btn").dispatchEvent(
			new Event("click"),
		);

		expect(plugin.handleStartStopClick).toHaveBeenCalledTimes(1);
		expect(plugin.registerDomEvent).toHaveBeenCalled();
	});
});

describe("SidebarView — 심사 준수 (Requirement 9.5)", () => {
	it("SidebarView 실행 코드는 innerHTML/outerHTML/insertAdjacentHTML를 사용하지 않는다", () => {
		const raw = readFileSync(resolve(__dirname, "SidebarView.ts"), "utf8");
		// 주석에서 "금지 API"로 언급되는 것은 허용하되, 실제 코드 경로에는 등장하지 않아야 한다.
		const code = stripComments(raw);

		expect(code).not.toMatch(/\binnerHTML\b/);
		expect(code).not.toMatch(/\bouterHTML\b/);
		expect(code).not.toMatch(/\binsertAdjacentHTML\b/);
	});
});

// 각 테스트 사이에서 DOM을 완전히 격리한다.
beforeEach(() => {
	document.body.replaceChildren();
});
