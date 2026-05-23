/**
 * `DownloadConfirmModal` 의 4 개 핵심 시나리오 검증.
 *
 * 검증 시나리오:
 * - Agree 클릭 게이트 (Requirement 2.3): 모달이 열린 직후에는 download 호출 0 회,
 *   "Agree and download" 버튼 클릭 후에 정확히 1 회.
 * - Cancel 동작 (Requirement 2.9): downloading 상태에서 Cancel 클릭 시 매니저가 반환한
 *   AbortController 의 abort() 가 호출된다.
 * - 진행률 갱신 (Requirement 2.5): `onProgress` 콜백 호출 시 모달 DOM 의 percent /
 *   bytes 텍스트가 갱신된다.
 * - 완료 시 close (Requirement 2.10): `onCompleted` 통지 시 모달이 close 되어
 *   `containerEl` 이 document.body 에서 분리된다.
 *
 * 테스트 전략:
 * - `Model_Download_Manager` 인터페이스를 만족하는 spy 객체를 직접 만든다 (실제 매니저
 *   인스턴스를 만들지 않아 HTTP/fs 의존성을 회피).
 * - spy 의 `download(...)` 는 호출 횟수와 인자를 기록하고, 호출 시점에 받은 콜백을
 *   테스트 코드가 직접 invoke 할 수 있도록 노출한다.
 * - 모달이 사용하는 obsidian Modal 은 `tests/mocks/obsidian.ts` 의 mock 으로 치환된다
 *   (`vitest.config.ts` 의 alias).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "obsidian";
import {
	DownloadConfirmModal,
	type DownloadConfirmCallbacks,
} from "./DownloadConfirmModal";
import type {
	DownloadProgress,
	LocalModelCatalogEntry,
	Local_Model_Installation_Record,
	ModelDownloadCallbacks,
	ModelDownloadError,
	Model_Download_Manager,
} from "../services/Model_Download_Manager";

// -----------------------------------------------------------------------------
// 테스트 헬퍼
// -----------------------------------------------------------------------------

/**
 * 테스트에서 사용하는 표준 카탈로그 엔트리. `Local_Model_Catalog` 의 첫 항목과 같은
 * 모양이며 sha256 은 placeholder 그대로 유지한다.
 */
function makeEntry(): LocalModelCatalogEntry {
	return {
		id: "whisper-large-v3-turbo",
		displayName: "Whisper Large V3 Turbo",
		downloadUrl:
			"https://huggingface.co/onnx-community/whisper-large-v3-turbo/resolve/main/onnx/model.onnx",
		sha256: "0".repeat(64),
		sizeMb: 1700,
		transformersJsId: "onnx-community/whisper-large-v3-turbo",
	};
}

/**
 * spy 매니저 — `Model_Download_Manager` 의 공개 인터페이스(download) 만 흉내낸다.
 *
 * 호출 시:
 * - `downloadCalls` 에 인자 묶음 push.
 * - 직전에 받은 callbacks 를 `lastCallbacks` 에 보관해 테스트가 진행률/완료/오류를
 *   임의 시점에 발사할 수 있게 한다.
 * - `nextController` 가 사전에 설정되어 있으면 그 controller 를, 아니면 새 AbortController
 *   를 반환한다 — Cancel 시나리오에서 controller.abort 를 spy 한 인스턴스를 주입하기 위함.
 */
interface SpyManager {
	downloadCalls: Array<{
		entry: LocalModelCatalogEntry;
		modelFolder: string;
		callbacks: ModelDownloadCallbacks;
	}>;
	lastCallbacks: ModelDownloadCallbacks | null;
	lastController: AbortController | null;
	nextController: AbortController | null;
	manager: Model_Download_Manager;
}

function createSpyManager(): SpyManager {
	const spy: SpyManager = {
		downloadCalls: [],
		lastCallbacks: null,
		lastController: null,
		nextController: null,
		// 캐스팅: 실제 메서드는 download 만 사용되므로 최소 인터페이스만 구현한다.
		manager: {} as Model_Download_Manager,
	};
	(spy.manager as unknown as {
		download: Model_Download_Manager["download"];
	}).download = (entry, modelFolder, callbacks) => {
		spy.downloadCalls.push({ entry, modelFolder, callbacks });
		spy.lastCallbacks = callbacks;
		const controller = spy.nextController ?? new AbortController();
		spy.lastController = controller;
		return controller;
	};
	return spy;
}

/**
 * 테스트용 모달 콜백 묶음. vi.fn 으로 호출 횟수를 기록한다.
 */
function createCallbacks(): DownloadConfirmCallbacks & {
	onCompleted: ReturnType<typeof vi.fn>;
	onError: ReturnType<typeof vi.fn>;
	onCancelled: ReturnType<typeof vi.fn>;
} {
	return {
		onCompleted: vi.fn(),
		onError: vi.fn(),
		onCancelled: vi.fn(),
	} as unknown as DownloadConfirmCallbacks & {
		onCompleted: ReturnType<typeof vi.fn>;
		onError: ReturnType<typeof vi.fn>;
		onCancelled: ReturnType<typeof vi.fn>;
	};
}

/**
 * 모달을 열고 (onOpen 호출되어 DOM 렌더 완료) 인스턴스를 반환한다.
 */
function openModal(
	spy: SpyManager,
	callbacks: DownloadConfirmCallbacks,
	overrides?: { modelFolder?: string },
): DownloadConfirmModal {
	const modal = new DownloadConfirmModal({
		app: new App(),
		entry: makeEntry(),
		modelFolder: overrides?.modelFolder ?? "/Users/test/models",
		downloadManager: spy.manager,
		callbacks,
	});
	modal.open();
	return modal;
}

/**
 * 모달 contentEl 안에서 텍스트가 일치하는 첫 버튼을 찾는다.
 *
 * 셀렉터는 클래스 변경에 취약하지 않도록 라벨 기반으로 매칭한다.
 */
function findButton(
	modal: DownloadConfirmModal,
	label: string,
): HTMLButtonElement {
	const buttons = modal.contentEl.querySelectorAll("button");
	for (const btn of Array.from(buttons)) {
		if (btn.textContent?.trim() === label) {
			return btn as HTMLButtonElement;
		}
	}
	throw new Error(`Button not found: ${label}`);
}

// -----------------------------------------------------------------------------
// 테스트
// -----------------------------------------------------------------------------

describe("DownloadConfirmModal", () => {
	beforeEach(() => {
		// 이전 테스트가 document.body 에 남긴 잔여 모달 컨테이너를 비운다.
		document.body.replaceChildren();
	});

	afterEach(() => {
		document.body.replaceChildren();
		vi.restoreAllMocks();
	});

	it("Agree 클릭 시점에만 download 가 호출된다 (Requirement 2.3)", () => {
		const spy = createSpyManager();
		const callbacks = createCallbacks();
		const modal = openModal(spy, callbacks);

		// 모달이 열렸지만 아직 동의 전 — 어떤 다운로드도 시작되지 않아야 한다.
		expect(spy.downloadCalls).toHaveLength(0);

		// 모달 표시 항목이 Requirement 2.2 의 4 가지 핵심 정보를 포함하는지 확인.
		const text = modal.contentEl.textContent ?? "";
		expect(text).toContain("whisper-large-v3-turbo"); // 모델 ID
		expect(text).toContain("huggingface.co"); // 출처 도메인
		expect(text).toContain("1700 MB"); // 예상 크기
		expect(text).toContain("/Users/test/models"); // 저장 경로

		// 동의 버튼 클릭 — 정확히 1 회 download 호출.
		const agreeBtn = findButton(modal, "Agree and download");
		agreeBtn.click();

		expect(spy.downloadCalls).toHaveLength(1);
		expect(spy.downloadCalls[0]?.entry.id).toBe("whisper-large-v3-turbo");
		expect(spy.downloadCalls[0]?.modelFolder).toBe("/Users/test/models");

		// 중복 클릭 방어 — 한 번 더 눌러도 호출 횟수는 그대로 1.
		agreeBtn.click();
		expect(spy.downloadCalls).toHaveLength(1);

		modal.close();
	});

	it("downloading 상태에서 Cancel 클릭 시 controller.abort() 가 호출된다 (Requirement 2.9)", () => {
		const spy = createSpyManager();
		// 매니저가 반환할 controller 를 사전 주입해 abort 를 spy 한다.
		const controller = new AbortController();
		const abortSpy = vi.spyOn(controller, "abort");
		spy.nextController = controller;

		const callbacks = createCallbacks();
		const modal = openModal(spy, callbacks);

		// 동의 → downloading 상태로 진입.
		findButton(modal, "Agree and download").click();
		expect(spy.downloadCalls).toHaveLength(1);
		expect(abortSpy).not.toHaveBeenCalled();

		// 취소 클릭 — controller.abort 가 호출되어야 한다.
		findButton(modal, "Cancel").click();
		expect(abortSpy).toHaveBeenCalledTimes(1);

		// 매니저가 onError({code:"cancelled"}) 로 통지하면 모달은 close 되고 onCancelled 가
		// 호출된다 — 매니저 흐름을 시뮬레이션한다.
		spy.lastCallbacks?.onError({ code: "cancelled" });
		expect(callbacks.onCancelled).toHaveBeenCalledTimes(1);
		expect(callbacks.onError).not.toHaveBeenCalled();
		expect(document.body.contains(modal.containerEl)).toBe(false);
	});

	it("onProgress 콜백 호출 시 진행률 DOM 텍스트가 갱신된다 (Requirement 2.5)", () => {
		const spy = createSpyManager();
		const callbacks = createCallbacks();
		const modal = openModal(spy, callbacks);

		findButton(modal, "Agree and download").click();
		const onProgress = spy.lastCallbacks?.onProgress;
		expect(onProgress).toBeTypeOf("function");

		// 첫 번째 진행률 통지 — 25%, 25MB / 100MB.
		const progress1: DownloadProgress = {
			bytesDownloaded: 25 * 1024 * 1024,
			bytesTotal: 100 * 1024 * 1024,
			percent: 25,
		};
		onProgress?.(progress1);

		const percentEl = modal.contentEl.querySelector(
			".transcribe-download-confirm__progress-percent",
		);
		const bytesEl = modal.contentEl.querySelector(
			".transcribe-download-confirm__progress-bytes",
		);
		expect(percentEl?.textContent).toBe("25%");
		expect(bytesEl?.textContent).toBe("25.0 MB / 100.0 MB");

		// 두 번째 진행률 통지 — 텍스트가 새 값으로 교체되어야 한다 (1초 이내 반영).
		const progress2: DownloadProgress = {
			bytesDownloaded: 75 * 1024 * 1024,
			bytesTotal: 100 * 1024 * 1024,
			percent: 75,
		};
		onProgress?.(progress2);
		expect(percentEl?.textContent).toBe("75%");
		expect(bytesEl?.textContent).toBe("75.0 MB / 100.0 MB");

		modal.close();
	});

	it("onCompleted 통지 시 모달이 자동으로 닫히고 onCompleted 콜백이 호출된다", () => {
		const spy = createSpyManager();
		const callbacks = createCallbacks();
		const modal = openModal(spy, callbacks);

		findButton(modal, "Agree and download").click();
		expect(document.body.contains(modal.containerEl)).toBe(true);

		const record: Local_Model_Installation_Record = {
			modelId: "whisper-large-v3-turbo",
			filePath: "/Users/test/models/model.onnx",
			sha256: "a".repeat(64),
			installedAt: "2025-01-01T00:00:00.000Z",
			sizeBytes: 1_700_000_000,
		};
		spy.lastCallbacks?.onCompleted(record);

		expect(callbacks.onCompleted).toHaveBeenCalledTimes(1);
		expect(callbacks.onCompleted).toHaveBeenCalledWith(record);
		expect(callbacks.onError).not.toHaveBeenCalled();
		expect(callbacks.onCancelled).not.toHaveBeenCalled();
		expect(document.body.contains(modal.containerEl)).toBe(false);
	});

	it("network 오류 통지 시 모달이 닫히고 onError 가 호출된다 (Requirement 2.8)", () => {
		const spy = createSpyManager();
		const callbacks = createCallbacks();
		const modal = openModal(spy, callbacks);

		findButton(modal, "Agree and download").click();

		const reason: ModelDownloadError = { code: "network", httpStatus: 503 };
		spy.lastCallbacks?.onError(reason);

		expect(callbacks.onError).toHaveBeenCalledTimes(1);
		expect(callbacks.onError).toHaveBeenCalledWith(reason);
		expect(callbacks.onCancelled).not.toHaveBeenCalled();
		expect(document.body.contains(modal.containerEl)).toBe(false);
	});

	it("동의 전 Cancel 클릭은 download 를 호출하지 않고 onCancelled 만 통지한다 (Requirement 2.3)", () => {
		const spy = createSpyManager();
		const callbacks = createCallbacks();
		const modal = openModal(spy, callbacks);

		findButton(modal, "Cancel").click();

		expect(spy.downloadCalls).toHaveLength(0);
		expect(callbacks.onCancelled).toHaveBeenCalledTimes(1);
		expect(callbacks.onError).not.toHaveBeenCalled();
		expect(document.body.contains(modal.containerEl)).toBe(false);
	});
});
