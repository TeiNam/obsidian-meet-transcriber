/**
 * `LocalModelSettingsSection` 의 렌더 예시 테스트 (task 23).
 *
 * 검증 목표 (Acceptance Criteria 매핑):
 * - AC 1.2: `Backend_Selection_Mode` 드롭다운에 정확히 3 개 옵션이 있고 기본값이 `cloud-only`.
 * - AC 1.3: `Local_Model_Id` 드롭다운에 빈 값 + `LOCAL_MODEL_CATALOG` 의 모든 항목이 옵션으로 등장.
 * - AC 1.4: `Model_Folder` 입력에 절대 경로가 아닌 값을 넣으면 인라인 에러 메시지가 표시되고
 *           절대 경로면 메시지가 비워진다.
 * - AC 1.5: 빈 `Model_Folder` 로 렌더 → OS 별 기본값으로 prefill 된다.
 * - AC 1.6: `local-only` / `auto` 로 변경하면 `Local_Model_Id` / `Model_Folder` 누락 시
 *           누락 항목명을 포함한 인라인 메시지가 표시된다.
 * - AC 2.1: 다운로드 버튼 — `localModelId` + `modelFolder` 가 모두 valid 하고
 *           `modelDownloadManager` 가 주입되어 있을 때만 활성. 클릭 시 `DownloadConfirmModal`
 *           이 열린다.
 *
 * 테스트 전략:
 * - 본 모듈은 `LocalModelSectionHost` 추상화 의존이므로 `TranscribeSettingTab` 전체를
 *   띄울 필요 없이 fake host 를 직접 구성해 단위 검증한다.
 * - jsdom + tests/setup.ts 의 Obsidian DOM 폴리필을 그대로 재사용한다.
 * - `Model_Download_Manager` 는 spy 객체로 대체 — `download()` 호출 여부만 관찰한다.
 */

import { App } from "obsidian";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";

import { createI18n, type Translations } from "../i18n";
import { LOCAL_MODEL_CATALOG } from "../services/Local_Model_Catalog";
import type { Model_Download_Manager } from "../services/Model_Download_Manager";
import { DEFAULT_SETTINGS, type TranscribeSettings } from "../types/settings";

import {
	computeDefaultModelFolder,
	renderLocalModelSection,
	type LocalModelSectionHost,
} from "./LocalModelSettingsSection";

// ---------------------------------------------------------------------------
// 헬퍼 — fake host 와 DOM 컨테이너를 매 테스트마다 새로 생성한다.
// ---------------------------------------------------------------------------

interface TestContext {
	containerEl: HTMLElement;
	host: LocalModelSectionHost;
	saveSpy: ReturnType<typeof vi.fn>;
	// vi.fn(() => new AbortController()) 의 반환 타입은 Mock<[], AbortController> 이며,
	// 일반 ReturnType<typeof vi.fn>(=Mock<any[], unknown>) 와 공변성이 맞지 않으므로
	// 명시적으로 Mock<any[], unknown> 으로 폭을 넓혀 보관한다.
	downloadSpy: Mock<unknown[], unknown>;
}

/**
 * fake host 와 컨테이너를 새로 만든 뒤 본 섹션을 1 회 렌더링한다.
 *
 * `modelDownloadManager` 옵션은 `null` 을 명시적으로 전달하면 host 에 `undefined` 를
 * 주입(미주입 케이스 검증) 하고, 미지정 시 fake manager 를 주입한다.
 */
function setup(
	settingsOverride: Partial<TranscribeSettings> = {},
	hostOverride: { modelDownloadManager?: Model_Download_Manager | null } = {},
): TestContext {
	const containerEl = document.createElement("div");
	const settings: TranscribeSettings = {
		...DEFAULT_SETTINGS,
		...settingsOverride,
	};
	const t: Translations = createI18n(settings.uiLocale);

	const saveSpy = vi.fn().mockResolvedValue(undefined);

	const downloadSpy = vi.fn(() => new AbortController());
	const fakeManager: Model_Download_Manager = {
		download: downloadSpy,
	} as unknown as Model_Download_Manager;

	// hostOverride 에 키 자체가 없으면(`{}`) fake manager 주입,
	// 키가 있고 값이 null 이면 미주입 케이스(undefined) 로 사용.
	const managerToInject =
		"modelDownloadManager" in hostOverride
			? hostOverride.modelDownloadManager === null
				? undefined
				: hostOverride.modelDownloadManager
			: fakeManager;

	const host: LocalModelSectionHost = {
		app: new App(),
		settings,
		t,
		modelDownloadManager: managerToInject,
		onLocalModelDownloaded: undefined,
		saveIfValid: saveSpy,
	};

	renderLocalModelSection(containerEl, host);

	return {
		containerEl,
		host,
		saveSpy,
		downloadSpy: downloadSpy as unknown as Mock<unknown[], unknown>,
	};
}

/**
 * 컨테이너에서 직계 자식(=하나의 Setting) 들을 순서대로 반환한다.
 */
function getSettingEls(container: HTMLElement): HTMLElement[] {
	return Array.from(container.children).filter(
		(c): c is HTMLElement => c instanceof HTMLElement,
	);
}

// ---------------------------------------------------------------------------
// 본 테스트
// ---------------------------------------------------------------------------

describe("LocalModelSettingsSection — task 23 (Local model 섹션)", () => {
	afterEach(() => {
		// 모달이 document.body 에 부착된 상태로 남으면 후속 테스트가 영향받으므로 정리.
		document.body.querySelectorAll(".modal-container").forEach((el) => {
			el.remove();
		});
		vi.restoreAllMocks();
	});

	describe("AC 1.2 — Backend selection mode 드롭다운", () => {
		it("드롭다운에 정확히 3 개 옵션 (cloud-only / local-only / auto) 이 있다", () => {
			const { containerEl } = setup();
			const setting = getSettingEls(containerEl)[0];
			const select = setting.querySelector("select");
			expect(select).not.toBeNull();
			const optionValues = Array.from(select!.options).map((o) => o.value);
			expect(optionValues).toEqual([
				"cloud-only",
				"local-only",
				"auto",
			]);
		});

		it("기본값이 cloud-only 이다", () => {
			const { containerEl } = setup();
			const setting = getSettingEls(containerEl)[0];
			const select = setting.querySelector("select") as HTMLSelectElement;
			expect(select.value).toBe("cloud-only");
		});
	});

	describe("AC 1.3 — Local model 드롭다운 옵션 구성", () => {
		it("빈 값 + 카탈로그 항목 전체가 옵션으로 등장한다", () => {
			const { containerEl } = setup();
			const setting = getSettingEls(containerEl)[1];
			const select = setting.querySelector("select") as HTMLSelectElement;
			const optionValues = Array.from(select.options).map((o) => o.value);

			// 빈 값이 항상 첫 번째.
			expect(optionValues[0]).toBe("");
			// 카탈로그 항목이 모두 포함됨.
			for (const entry of LOCAL_MODEL_CATALOG) {
				expect(optionValues).toContain(entry.id);
			}
			// 옵션 개수 = 빈 값 1 + 카탈로그 N.
			expect(optionValues.length).toBe(1 + LOCAL_MODEL_CATALOG.length);
		});
	});

	describe("AC 1.4 — Model folder 절대 경로 검증", () => {
		it("상대 경로 입력 시 인라인 에러 메시지가 표시된다", async () => {
			const { containerEl } = setup({ modelFolder: "" });
			const setting = getSettingEls(containerEl)[2];
			const input = setting.querySelector("input") as HTMLInputElement;

			input.value = "relative/path";
			input.dispatchEvent(new Event("input"));
			await Promise.resolve();
			await Promise.resolve();

			const errorEl = setting.querySelector(".transcribe-setting-error");
			expect(errorEl).not.toBeNull();
			expect(errorEl!.textContent ?? "").not.toBe("");
		});

		it("절대 경로 입력 시 인라인 에러가 비워진다", async () => {
			const { containerEl } = setup({ modelFolder: "" });
			const setting = getSettingEls(containerEl)[2];
			const input = setting.querySelector("input") as HTMLInputElement;

			input.value = "/Users/me/models";
			input.dispatchEvent(new Event("input"));
			await Promise.resolve();
			await Promise.resolve();

			const errorEl = setting.querySelector(".transcribe-setting-error");
			expect(errorEl?.textContent ?? "").toBe("");
		});
	});

	describe("AC 1.5 — OS 별 기본값 prefill", () => {
		it("빈 modelFolder 로 렌더 시 OS 기본 경로로 prefill 된다", () => {
			const { host } = setup({ modelFolder: "" });
			const expected = computeDefaultModelFolder();
			// computeDefaultModelFolder 가 빈 문자열을 반환하는 환경(HOME 미설정 등)
			// 이라면 prefill 도 빈 문자열이므로 그 경우는 검증을 분기한다.
			if (expected.length > 0) {
				expect(host.settings.modelFolder).toBe(expected);
			} else {
				expect(host.settings.modelFolder).toBe("");
			}
		});

		it("기존 사용자 입력값은 prefill 로 덮어쓰지 않는다", () => {
			const userPath = "/custom/user/path/models";
			const { host } = setup({ modelFolder: userPath });
			expect(host.settings.modelFolder).toBe(userPath);
		});
	});

	describe("AC 1.6 — local-only / auto 누락 인라인 안내", () => {
		it("local-only + 빈 localModelId 인 경우 누락 메시지에 'Local model' 이 포함된다", () => {
			const { containerEl } = setup({
				backendSelectionMode: "local-only",
				localModelId: "",
				modelFolder: "/tmp/forced",
			});
			// backend selection mode setting 의 errorEl 이 누락 안내를 표시한다.
			const setting = getSettingEls(containerEl)[0];
			const errorEl = setting.querySelector(".transcribe-setting-error");
			expect(errorEl).not.toBeNull();
			expect(errorEl!.textContent ?? "").toContain("Local model");
		});

		it("auto + 빈 modelFolder 인 경우 누락 메시지에 'Model folder' 가 포함된다", async () => {
			const { containerEl, host } = setup({
				backendSelectionMode: "auto",
				localModelId: "whisper-large-v3-turbo",
			});
			// prefill 결과를 빈 문자열로 덮어쓴 뒤 backend mode 변경 이벤트로 errorEl 갱신.
			host.settings.modelFolder = "";
			const setting = getSettingEls(containerEl)[0];
			const select = setting.querySelector("select") as HTMLSelectElement;
			select.value = "auto";
			select.dispatchEvent(new Event("change"));
			await Promise.resolve();
			await Promise.resolve();

			const errorEl = setting.querySelector(".transcribe-setting-error");
			expect(errorEl).not.toBeNull();
			expect(errorEl!.textContent ?? "").toContain("Model folder");
		});

		it("cloud-only 모드에서는 누락 안내가 표시되지 않는다", () => {
			const { containerEl } = setup({
				backendSelectionMode: "cloud-only",
				localModelId: "",
				modelFolder: "",
			});
			const setting = getSettingEls(containerEl)[0];
			const errorEl = setting.querySelector(".transcribe-setting-error");
			expect(errorEl?.textContent ?? "").toBe("");
		});
	});

	describe("AC 2.1 — Download model 버튼", () => {
		it("localModelId 가 비어 있으면 disabled 이다", () => {
			const { containerEl } = setup({
				localModelId: "",
				modelFolder: "/tmp/models",
			});
			const setting = getSettingEls(containerEl)[3];
			const btn = setting.querySelector("button") as HTMLButtonElement;
			expect(btn).not.toBeNull();
			expect(btn.disabled).toBe(true);
		});

		it("modelFolder 가 절대 경로가 아니면 disabled 이다", () => {
			const { containerEl } = setup({
				localModelId: "whisper-large-v3-turbo",
				modelFolder: "relative/path",
			});
			const setting = getSettingEls(containerEl)[3];
			const btn = setting.querySelector("button") as HTMLButtonElement;
			expect(btn.disabled).toBe(true);
		});

		it("downloadManager 가 주입되어 있지 않으면 disabled 이다", () => {
			const { containerEl } = setup(
				{
					localModelId: "whisper-large-v3-turbo",
					modelFolder: "/tmp/models",
				},
				{ modelDownloadManager: null },
			);
			const setting = getSettingEls(containerEl)[3];
			const btn = setting.querySelector("button") as HTMLButtonElement;
			expect(btn.disabled).toBe(true);
		});

		it("모든 조건이 충족되면 활성화되고, 클릭 시 DownloadConfirmModal 이 열린다", () => {
			const { containerEl, downloadSpy } = setup({
				localModelId: "whisper-large-v3-turbo",
				modelFolder: "/tmp/models",
			});
			const setting = getSettingEls(containerEl)[3];
			const btn = setting.querySelector("button") as HTMLButtonElement;
			expect(btn.disabled).toBe(false);

			btn.dispatchEvent(new Event("click"));

			// Modal 이 document.body 에 부착되었는지 확인 — tests/mocks/obsidian.ts 의
			// Modal 스텁이 open() 시점에 containerEl 을 body 에 append 한다.
			const modalContainer = document.body.querySelector(".modal-container");
			expect(modalContainer).not.toBeNull();
			// 동의 버튼을 누르기 전에는 download() 호출이 발생하지 않아야 한다 (Requirement 2.3).
			expect(downloadSpy).not.toHaveBeenCalled();
		});
	});

	describe("예상 크기 표시", () => {
		it("선택된 모델의 예상 크기 MB 가 download 섹션 desc 에 노출된다", () => {
			const { containerEl } = setup({
				localModelId: "whisper-large-v3-turbo",
				modelFolder: "/tmp/models",
			});
			const setting = getSettingEls(containerEl)[3];
			const desc = setting.children[1] as HTMLElement; // descEl
			const expectedMb = LOCAL_MODEL_CATALOG.find(
				(e) => e.id === "whisper-large-v3-turbo",
			)?.sizeMb;
			expect(expectedMb).toBeDefined();
			expect(desc.textContent ?? "").toContain(String(expectedMb));
		});
	});
});

describe("computeDefaultModelFolder — OS 별 분기 (task 23, AC 1.5)", () => {
	const originalPlatform = process.platform;
	const originalEnv = { ...process.env };

	afterEach(() => {
		Object.defineProperty(process, "platform", {
			value: originalPlatform,
		});
		process.env = { ...originalEnv };
	});

	it("macOS (darwin) → ~/Library/Application Support/obsidian-transcribe-plugin/models", () => {
		Object.defineProperty(process, "platform", { value: "darwin" });
		process.env.HOME = "/Users/example";
		expect(computeDefaultModelFolder()).toBe(
			"/Users/example/Library/Application Support/obsidian-transcribe-plugin/models",
		);
	});

	it("Windows (win32) → %APPDATA%/obsidian-transcribe-plugin/models", () => {
		Object.defineProperty(process, "platform", { value: "win32" });
		process.env.APPDATA = "C:\\Users\\example\\AppData\\Roaming";
		// 백슬래시 → 슬래시 정규화로 Windows 절대 경로 검증을 통과시킨다.
		expect(computeDefaultModelFolder()).toBe(
			"C:/Users/example/AppData/Roaming/obsidian-transcribe-plugin/models",
		);
	});

	it("Linux (linux) → ~/.local/share/obsidian-transcribe-plugin/models", () => {
		Object.defineProperty(process, "platform", { value: "linux" });
		process.env.HOME = "/home/example";
		expect(computeDefaultModelFolder()).toBe(
			"/home/example/.local/share/obsidian-transcribe-plugin/models",
		);
	});
});
