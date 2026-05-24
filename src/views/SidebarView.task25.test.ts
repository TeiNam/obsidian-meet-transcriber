/**
 * `SidebarView` TASK 25 신규 공개 API 검증 (jsdom).
 *
 * 검증 목표 (요구 매핑):
 * - `appendFinalLine(segment, { translationEnabled: true })` 시 화자 색상 클래스
 *   `.speaker-1` 부여 + `.translation-line` placeholder 미리 생성 (Requirement 4.4, 6.2, 13.2).
 * - `updateCostCounter(100)` 호출 시 status row 의 비용 카운터 텍스트 갱신 + 표시 활성화
 *   (Requirement 13.9).
 * - `showThrottleIndicator(true)` 후 인디케이터 가시화, `false` 후 숨김 (Requirement 10.2).
 * - `showSpeakerCapacityNotice(true)` 시 안내 라벨 노출, `false` 시 숨김 (Requirement 6.8).
 * - 기존 `commitFinal(text)` 경로는 그대로 동작하여 v1.0 호환성 회귀 없음.
 *
 * 본 파일은 `SidebarView.example.test.ts` 의 헬퍼(가짜 플러그인 + mountView)를 그대로
 * 재현해 의존성을 분리한다 (테스트 격리 — 한 파일이 깨져도 다른 파일에 영향 없음).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { App, WorkspaceLeaf } from "obsidian";
import type { Transcript_Segment } from "../domain/segments";
import { createI18n } from "../i18n";
import {
	SidebarView,
	type SidebarEnvironmentInputs,
	type TranscribePluginLike,
} from "./SidebarView";

function defaultEnv(): SidebarEnvironmentInputs {
	return {
		hasTranscriptNote: false,
		transcriptLength: 0,
		hasCredentials: false,
		hasBedrockModel: false,
	};
}

function createFakePlugin(
	locale: "en" | "ko" = "en",
): TranscribePluginLike {
	const env = defaultEnv();
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
		getCurrentLanguage: vi.fn(() => "ko-KR" as const),
		getCurrentModelId: vi.fn(() => ""),
		setLanguage: vi.fn().mockResolvedValue(undefined),
		setModelId: vi.fn().mockResolvedValue(undefined),
		getAvailableModels: vi.fn(() => []),
		refreshAvailableModels: vi.fn().mockResolvedValue([]),
		// task 24 가 host 계약에 추가한 미러 컨트롤 stub. task 25 의 검증 범위는
		// 라인/위젯 토글이므로 본 메서드들의 동작 자체는 noop 으로 충분하다.
		getCurrentSpeakerDiarizationEnabled: vi.fn(() => false),
		setSpeakerDiarizationEnabled: vi.fn().mockResolvedValue(undefined),
		getCurrentTranslationEnabled: vi.fn(() => false),
		setTranslationEnabled: vi.fn().mockResolvedValue(undefined),
		getCurrentTranslationTargetLanguage: vi.fn(() => "en" as const),
		setTranslationTargetLanguage: vi.fn().mockResolvedValue(undefined),
		// v1.1 정리 — outputFormat 도 사이드바로 이전됨 (task 28 사후정리).
		getCurrentTranslationOutputFormat: vi.fn(() => "inline" as const),
		setTranslationOutputFormat: vi.fn().mockResolvedValue(undefined),
		getCurrentBackendSelectionMode: vi.fn(() => "cloud-only" as const),
		// task 33 — 사이드바 백엔드 드롭다운 + activeEngine 라벨에 사용되는 신규 stub.
		setBackendSelectionMode: vi.fn().mockResolvedValue(undefined),
		getCurrentLocalModelId: vi.fn(() => ""),
		// 마이크 선택 — 본 테스트군은 디바이스 동작을 검증하지 않으므로 no-op 스텁.
		getCurrentAudioInputDeviceId: vi.fn(() => ""),
		setAudioInputDeviceId: vi.fn().mockResolvedValue(undefined),
		listAudioInputDevices: vi.fn().mockResolvedValue([]),
	};
	return plugin as unknown as TranscribePluginLike;
}

async function mountView(
	plugin: TranscribePluginLike,
): Promise<SidebarView> {
	const leaf = new WorkspaceLeaf();
	const view = new SidebarView(leaf, plugin);
	await view.onOpen();
	return view;
}

function makeSegment(
	overrides: Partial<Transcript_Segment> = {},
): Transcript_Segment {
	return {
		segmentId: 1,
		startSeconds: 0,
		endSeconds: 1,
		text: "안녕하세요",
		...overrides,
	};
}

describe("SidebarView — appendFinalLine (TASK 25)", () => {
	it("화자 라벨 + translationEnabled 시 .speaker-1 색상 + .translation-line placeholder 가 생성된다 (Requirements 6.2, 13.2)", async () => {
		const plugin = createFakePlugin("ko");
		const view = await mountView(plugin);

		const segment = makeSegment({
			segmentId: 42,
			speakerLabel: "Speaker 1",
			text: "안녕",
		});
		const lineEl = view.appendFinalLine(segment, {
			translationEnabled: true,
		});

		expect(lineEl.classList.contains("line")).toBe(true);
		expect(lineEl.getAttribute("data-segment-id")).toBe("42");

		const speakerSpan = lineEl.querySelector(".speaker-label");
		expect(speakerSpan).not.toBeNull();
		expect(speakerSpan!.classList.contains("speaker-1")).toBe(true);
		expect(speakerSpan!.textContent).toBe("Speaker 1: ");

		const lineText = lineEl.querySelector(".line-text");
		expect(lineText?.textContent).toBe("안녕");

		const placeholder = lineEl.querySelector(".translation-line");
		expect(placeholder).not.toBeNull();
		expect(placeholder!.textContent).toBe("");

		// 컨테이너 자식으로 정확히 1개의 라인이 부착되어 있어야 한다.
		const container = view.contentEl.querySelector(".line-container");
		expect(container?.children.length).toBe(1);
	});

	it("translationEnabled = false 인 경우 placeholder 가 생성되지 않는다", async () => {
		const plugin = createFakePlugin("en");
		const view = await mountView(plugin);

		const lineEl = view.appendFinalLine(makeSegment({ segmentId: 1 }), {
			translationEnabled: false,
		});

		expect(lineEl.querySelector(".translation-line")).toBeNull();
	});

	it("화자 라벨이 없는 segment 는 .speaker-label 자체를 만들지 않는다 (Requirement 6.7)", async () => {
		const plugin = createFakePlugin("en");
		const view = await mountView(plugin);

		const lineEl = view.appendFinalLine(
			makeSegment({ segmentId: 7, speakerLabel: undefined }),
			{ translationEnabled: false },
		);

		expect(lineEl.querySelector(".speaker-label")).toBeNull();
		expect(lineEl.querySelector(".line-text")?.textContent).toBe("안녕하세요");
	});

	it("Speaker 3 라벨은 .speaker-3 색상 클래스로 매핑된다", async () => {
		const plugin = createFakePlugin("en");
		const view = await mountView(plugin);

		const lineEl = view.appendFinalLine(
			makeSegment({ segmentId: 3, speakerLabel: "Speaker 3" }),
			{ translationEnabled: false },
		);

		const speakerSpan = lineEl.querySelector(".speaker-label");
		expect(speakerSpan?.classList.contains("speaker-3")).toBe(true);
	});
});

describe("SidebarView — updateCostCounter (TASK 25)", () => {
	it("호출 시 status row 의 비용 카운터 텍스트가 갱신되고 노출된다 (Requirement 13.9)", async () => {
		const plugin = createFakePlugin("en");
		const view = await mountView(plugin);

		const counter = view.contentEl.querySelector(
			".transcribe-cost-counter",
		);
		expect(counter).not.toBeNull();
		// 초기에는 hidden.
		expect(counter!.classList.contains("is-hidden")).toBe(true);

		view.updateCostCounter(100);

		expect(counter!.classList.contains("is-hidden")).toBe(false);
		expect(counter!.textContent).toBe(plugin.t.sidebar.costCounter(100));
	});

	it("연속 호출 시 텍스트만 단조 갱신된다", async () => {
		const plugin = createFakePlugin("en");
		const view = await mountView(plugin);

		view.updateCostCounter(50);
		view.updateCostCounter(120);

		const counter = view.contentEl.querySelector(
			".transcribe-cost-counter",
		);
		expect(counter!.textContent).toBe(plugin.t.sidebar.costCounter(120));
	});
});

describe("SidebarView — showThrottleIndicator (TASK 25)", () => {
	it("active=true 시 노출, false 시 숨김 (Requirement 10.2)", async () => {
		const plugin = createFakePlugin("en");
		const view = await mountView(plugin);

		const indicator = view.contentEl.querySelector(
			".transcribe-throttle-indicator",
		);
		expect(indicator).not.toBeNull();
		expect(indicator!.classList.contains("is-hidden")).toBe(true);
		expect(indicator!.textContent).toBe(plugin.t.sidebar.throttleIndicator);

		view.showThrottleIndicator(true);
		expect(indicator!.classList.contains("is-hidden")).toBe(false);

		view.showThrottleIndicator(false);
		expect(indicator!.classList.contains("is-hidden")).toBe(true);
	});
});

describe("SidebarView — showSpeakerCapacityNotice (TASK 25)", () => {
	it("visible=true 시 라벨 노출, false 시 제거 (Requirement 6.8)", async () => {
		const plugin = createFakePlugin("ko");
		const view = await mountView(plugin);

		const notice = view.contentEl.querySelector(
			".transcribe-speaker-capacity",
		);
		expect(notice).not.toBeNull();
		expect(notice!.classList.contains("is-hidden")).toBe(true);
		expect(notice!.textContent).toBe(plugin.t.sidebar.speakerCapacityNotice);

		view.showSpeakerCapacityNotice(true);
		expect(notice!.classList.contains("is-hidden")).toBe(false);

		view.showSpeakerCapacityNotice(false);
		expect(notice!.classList.contains("is-hidden")).toBe(true);
	});
});

describe("SidebarView — v1.0 호환 회귀 (TASK 25)", () => {
	it("commitFinal 은 기존처럼 committed span 을 갱신한다", async () => {
		const plugin = createFakePlugin("ko");
		const view = await mountView(plugin);

		view.commitFinal("회의를 시작합니다.");

		const committed = view.contentEl.querySelector(".committed");
		expect(committed?.textContent).toBe("회의를 시작합니다.");
		// appendFinalLine 경로의 컨테이너는 비어 있어야 한다.
		const lineContainer = view.contentEl.querySelector(".line-container");
		expect(lineContainer?.children.length ?? 0).toBe(0);
	});
});

beforeEach(() => {
	document.body.replaceChildren();
});
