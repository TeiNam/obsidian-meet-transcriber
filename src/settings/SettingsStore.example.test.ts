/**
 * `SettingsStore`의 `load`/`save` 예시 테스트.
 *
 * 검증 목표:
 * - `load`: `Plugin.loadData()`가 `null`/`undefined`/`{}`인 경우 기본값 복사본을 반환한다.
 *   부분 값은 기본값 위에 머지되어 나머지 필드는 기본값을 유지한다(Requirement 2.11).
 * - `save`: `Plugin.saveData()`에 동일한 설정 객체를 전달한다.
 *   저장 실패(rejected promise) 시 에러가 호출 측으로 전파되어,
 *   상위 UI 계층에서 Notice를 띄우고 이전 값을 유지할 수 있게 한다(Requirement 2.15).
 *
 * 테스트 전략:
 * - 실제 `obsidian.Plugin`을 생성하지 않고, `loadData`/`saveData` 메서드만 갖춘
 *   최소 fake 객체를 `vi.fn()`으로 구성한다. `SettingsStore`는 이 두 메서드만 의존한다.
 * - 타입 검사를 우회하기 위해 `as unknown as Plugin`으로 캐스팅한다.
 */

import type { Plugin } from "obsidian";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_SETTINGS, type TranscribeSettings } from "../types/settings";
import { SettingsStore } from "./SettingsStore";

/**
 * 테스트용 Plugin-like fake 객체.
 * `SettingsStore`가 의존하는 `loadData`/`saveData`만 vi.fn()으로 제공한다.
 */
interface FakePlugin {
	loadData: ReturnType<typeof vi.fn>;
	saveData: ReturnType<typeof vi.fn>;
}

function createFakePlugin(): FakePlugin {
	return {
		loadData: vi.fn(),
		saveData: vi.fn(),
	};
}

describe("SettingsStore.load — 기본값 머지 (Requirement 2.11)", () => {
	let fakePlugin: FakePlugin;
	let store: SettingsStore;

	beforeEach(() => {
		fakePlugin = createFakePlugin();
		store = new SettingsStore(fakePlugin as unknown as Plugin);
	});

	it("loadData가 null을 반환하면 DEFAULT_SETTINGS 복사본을 반환한다", async () => {
		fakePlugin.loadData.mockResolvedValue(null);

		const result = await store.load();

		expect(result).toEqual(DEFAULT_SETTINGS);
	});

	it("loadData가 undefined를 반환하면 DEFAULT_SETTINGS 복사본을 반환한다", async () => {
		fakePlugin.loadData.mockResolvedValue(undefined);

		const result = await store.load();

		expect(result).toEqual(DEFAULT_SETTINGS);
	});

	it("loadData가 빈 객체를 반환하면 DEFAULT_SETTINGS 복사본을 반환한다", async () => {
		fakePlugin.loadData.mockResolvedValue({});

		const result = await store.load();

		expect(result).toEqual(DEFAULT_SETTINGS);
	});

	it("loadData가 null일 때 반환된 객체는 DEFAULT_SETTINGS의 참조가 아닌 별도 복사본이다", async () => {
		fakePlugin.loadData.mockResolvedValue(null);

		const result = await store.load();

		// 값은 같되, 참조는 달라야 후속 변형이 모듈 상수를 오염시키지 않는다.
		expect(result).not.toBe(DEFAULT_SETTINGS);
		expect(result).toEqual(DEFAULT_SETTINGS);
	});

	it("부분 데이터가 있을 때 지정된 필드만 덮어쓰고 나머지는 기본값을 유지한다", async () => {
		fakePlugin.loadData.mockResolvedValue({ region: "eu-west-1" });

		const result = await store.load();

		expect(result.region).toBe("eu-west-1");
		// 그 외 필드는 DEFAULT_SETTINGS 그대로여야 한다.
		expect(result.uiLocale).toBe(DEFAULT_SETTINGS.uiLocale);
		expect(result.accessKeyId).toBe(DEFAULT_SETTINGS.accessKeyId);
		expect(result.secretAccessKey).toBe(DEFAULT_SETTINGS.secretAccessKey);
		expect(result.bedrockModelId).toBe(DEFAULT_SETTINGS.bedrockModelId);
		expect(result.languageCode).toBe(DEFAULT_SETTINGS.languageCode);
		expect(result.transcriptFolder).toBe(DEFAULT_SETTINGS.transcriptFolder);
	});

	it("완전한 설정 객체가 저장되어 있으면 해당 값을 그대로 반환한다", async () => {
		const saved: TranscribeSettings = {
			uiLocale: "ko",
			accessKeyId: "TEST_DUMMY_KEY",
			secretAccessKey: "SECRET_FAKE",
			region: "ap-northeast-2",
			bedrockModelId: "anthropic.claude-3-sonnet-20240229-v1:0",
			languageCode: "en-US",
			transcriptFolder: "Transcripts/Meetings",
			transcribeVocabularyName: "",
			analysisGlossary: "",
		};
		fakePlugin.loadData.mockResolvedValue(saved);

		const result = await store.load();

		expect(result).toEqual(saved);
	});

	it("여러 필드를 부분 덮어쓰기 할 때 나머지는 기본값으로 머지된다", async () => {
		fakePlugin.loadData.mockResolvedValue({
			uiLocale: "ko",
			languageCode: "en-US",
		});

		const result = await store.load();

		expect(result.uiLocale).toBe("ko");
		expect(result.languageCode).toBe("en-US");
		expect(result.region).toBe(DEFAULT_SETTINGS.region);
		expect(result.accessKeyId).toBe(DEFAULT_SETTINGS.accessKeyId);
	});

	it("loadData는 정확히 한 번만 호출된다", async () => {
		fakePlugin.loadData.mockResolvedValue(null);

		await store.load();

		expect(fakePlugin.loadData).toHaveBeenCalledTimes(1);
		expect(fakePlugin.loadData).toHaveBeenCalledWith();
	});
});

describe("SettingsStore.save — 저장 위임 및 에러 전파 (Requirement 2.15)", () => {
	let fakePlugin: FakePlugin;
	let store: SettingsStore;

	const sampleSettings: TranscribeSettings = {
		uiLocale: "ko",
		accessKeyId: "TEST_DUMMY",
		secretAccessKey: "SECRET_FAKE",
		region: "us-east-1",
		bedrockModelId: "anthropic.claude-3-haiku-20240307-v1:0",
		languageCode: "ko-KR",
		transcriptFolder: "Transcripts",
		transcribeVocabularyName: "",
		analysisGlossary: "",
	};

	beforeEach(() => {
		fakePlugin = createFakePlugin();
		store = new SettingsStore(fakePlugin as unknown as Plugin);
	});

	it("saveData에 전달받은 설정 객체를 그대로 넘긴다", async () => {
		fakePlugin.saveData.mockResolvedValue(undefined);

		await store.save(sampleSettings);

		expect(fakePlugin.saveData).toHaveBeenCalledTimes(1);
		expect(fakePlugin.saveData).toHaveBeenCalledWith(sampleSettings);
	});

	it("saveData가 성공적으로 완료되면 save는 undefined로 resolve 된다", async () => {
		fakePlugin.saveData.mockResolvedValue(undefined);

		const result = await store.save(sampleSettings);

		expect(result).toBeUndefined();
	});

	it("saveData가 reject 하면 save도 동일한 에러로 reject 한다 (호출 측에서 Notice/복원 처리 가능)", async () => {
		const ioError = new Error("disk full");
		fakePlugin.saveData.mockRejectedValue(ioError);

		// 에러가 호출 측으로 전파되어야 상위 UI가 Notice를 띄우고
		// 이전 값을 유지하는 롤백 로직을 수행할 수 있다(Requirement 2.15).
		await expect(store.save(sampleSettings)).rejects.toBe(ioError);
		expect(fakePlugin.saveData).toHaveBeenCalledTimes(1);
		expect(fakePlugin.saveData).toHaveBeenCalledWith(sampleSettings);
	});

	it("saveData 실패 후 다시 호출하면 재시도할 수 있다", async () => {
		fakePlugin.saveData
			.mockRejectedValueOnce(new Error("transient"))
			.mockResolvedValueOnce(undefined);

		await expect(store.save(sampleSettings)).rejects.toThrow("transient");
		await expect(store.save(sampleSettings)).resolves.toBeUndefined();

		expect(fakePlugin.saveData).toHaveBeenCalledTimes(2);
	});
});
