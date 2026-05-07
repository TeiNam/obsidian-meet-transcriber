/**
 * `NoteStore`의 Vault 모킹 예시 테스트 (Task 8.3).
 *
 * 검증 목표:
 * - 폴더 부재 + `createFolder` 실패 시 vault 루트(`""`)로 fallback 하고 `Notice`를 표시한다.
 *   (Requirement 4.5)
 * - `saveTranscript` 중 `Vault.create` I/O 오류는 호출 측으로 전파되어
 *   Transcript_Buffer를 유지할 수 있도록 한다(NoteStore가 에러를 삼키지 않는다).
 *   (Requirement 4.8)
 *
 * 추가로 NoteStore의 주요 I/O 경로(`ensureFolder`, `saveTranscript`의 충돌 회피,
 * `overwriteTranscript`의 프론트매터 보존, `appendAnalysis`의 로케일별 헤더,
 * `readTranscriptBody`의 프론트매터 제거)에 대한 Vault 모킹 예시를 포함한다.
 *
 * 테스트 전략:
 * - `vi.mock("obsidian", ...)`로 `Notice` 생성자를 스파이 클래스로 치환하여
 *   `new Notice(message)` 호출을 관측한다. 그 외 심볼(TFile, TFolder, Vault, normalizePath)은
 *   `tests/mocks/obsidian.ts`의 원본을 그대로 재사용한다.
 * - 각 테스트는 신규 `Vault` 인스턴스를 만들고 필요한 메서드만 `vi.spyOn`으로 대체한다.
 *   (프로덕션 코드는 수정하지 않는다.)
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// Notice 생성 호출을 관측하기 위해 obsidian 모듈을 재래핑한다.
// factory 내부에서 SpyNotice 클래스를 정의하고 정적 필드로 호출 로그를 노출한다.
vi.mock("obsidian", async () => {
	const actual =
		await vi.importActual<typeof import("obsidian")>("obsidian");

	const calls: (string | DocumentFragment)[] = [];

	class SpyNotice {
		/** 최근 테스트의 Notice 호출 로그. `beforeEach`에서 비운다. */
		static calls: (string | DocumentFragment)[] = calls;
		message: string | DocumentFragment;
		noticeEl: HTMLElement;
		constructor(message: string | DocumentFragment, _timeout?: number) {
			this.message = message;
			this.noticeEl = document.createElement("div");
			calls.push(message);
		}
		hide(): void {
			/* noop */
		}
		setMessage(message: string | DocumentFragment): this {
			this.message = message;
			return this;
		}
	}

	return { ...actual, Notice: SpyNotice };
});

// 모킹 이후의 obsidian 심볼을 import.
import { Notice, TFile, TFolder, Vault } from "obsidian";

import type { TranscriptNoteMeta } from "./NoteStore";
import { NoteStore } from "./NoteStore";

// -----------------------------------------------------------------------------
// 테스트 헬퍼
// -----------------------------------------------------------------------------

/** SpyNotice 정적 필드 접근용 타입 좁히기 헬퍼. */
function getNoticeCalls(): (string | DocumentFragment)[] {
	return (Notice as unknown as { calls: (string | DocumentFragment)[] }).calls;
}

function resetNoticeCalls(): void {
	getNoticeCalls().length = 0;
}

/** 테스트에서 반복 사용하는 샘플 메타데이터. */
function sampleMeta(): TranscriptNoteMeta {
	return {
		startedAt: "2025-01-15T09:30:00+09:00",
		endedAt: "2025-01-15T09:45:00+09:00",
		language: "ko-KR",
	};
}

/** 결정론적 파일명 타임스탬프를 위한 고정 시각. */
const FIXED_NOW = new Date(2025, 0, 15, 9, 30, 0); // 2025-01-15 09:30:00 local
const FIXED_BASENAME = "Transcribe-20250115-093000";

/** TFile 모사 인스턴스 생성 헬퍼. */
function makeTFile(name: string): TFile {
	const f = new TFile();
	f.name = name;
	f.path = name;
	f.basename = name.replace(/\.md$/, "");
	f.extension = "md";
	return f;
}

// -----------------------------------------------------------------------------
// ensureFolder
// -----------------------------------------------------------------------------

describe("NoteStore.ensureFolder", () => {
	let vault: Vault;
	let store: NoteStore;
	// `vi.spyOn(console, "error").mockImplementation(...)`의 정확한 반환 타입은 Vitest 버전에 따라
	// 제네릭 기본형이 달라진다. 변수 선언 시점에는 타입을 고정하지 않고 추론에 맡겨
	// TS2322/TS2344 호환성 문제를 회피한다.
	let consoleErrorSpy!: ReturnType<typeof vi.spyOn> & {
		mock: { calls: unknown[][] };
	};

	beforeEach(() => {
		resetNoticeCalls();
		vault = new Vault();
		store = new NoteStore(vault);
		// console.error는 fallback 경로에서 호출되므로 테스트 출력을 조용하게 하고 스파이도 겸한다.
		consoleErrorSpy = vi
			.spyOn(console, "error")
			.mockImplementation(() => undefined) as typeof consoleErrorSpy;
	});

	it("빈 문자열 입력 시 Vault API를 호출하지 않고 루트(\"\")를 반환한다", async () => {
		const getAbsSpy = vi.spyOn(vault, "getAbstractFileByPath");
		const createSpy = vi.spyOn(vault, "createFolder");

		const result = await store.ensureFolder("");

		expect(result).toBe("");
		expect(getAbsSpy).not.toHaveBeenCalled();
		expect(createSpy).not.toHaveBeenCalled();
		expect(getNoticeCalls()).toHaveLength(0);
	});

	it("'/' 또는 정규화 결과가 빈 문자열이면 루트(\"\")를 반환한다", async () => {
		const getAbsSpy = vi.spyOn(vault, "getAbstractFileByPath");
		const createSpy = vi.spyOn(vault, "createFolder");

		expect(await store.ensureFolder("/")).toBe("");
		// `..`만 있는 경로는 normalizePath 후 빈 문자열이 된다.
		expect(await store.ensureFolder("..")).toBe("");

		expect(getAbsSpy).not.toHaveBeenCalled();
		expect(createSpy).not.toHaveBeenCalled();
		expect(getNoticeCalls()).toHaveLength(0);
	});

	it("이미 존재하는 폴더 경로면 정규화된 경로를 그대로 반환한다", async () => {
		const existing = new TFolder();
		existing.path = "Meetings";
		vi.spyOn(vault, "getAbstractFileByPath").mockReturnValue(existing);
		const createSpy = vi.spyOn(vault, "createFolder");

		const result = await store.ensureFolder("Meetings");

		expect(result).toBe("Meetings");
		expect(createSpy).not.toHaveBeenCalled();
		expect(getNoticeCalls()).toHaveLength(0);
	});

	it("폴더 부재 시 createFolder에 정규화된 경로를 전달하고 그 경로를 반환한다", async () => {
		vi.spyOn(vault, "getAbstractFileByPath").mockReturnValue(null);
		const createSpy = vi
			.spyOn(vault, "createFolder")
			.mockResolvedValue(new TFolder());

		// 절대 경로(`/`)와 중복 슬래시를 섞은 입력 → `Notes/Transcribe`로 정규화되어야 한다.
		const result = await store.ensureFolder("/Notes//Transcribe/");

		expect(result).toBe("Notes/Transcribe");
		expect(createSpy).toHaveBeenCalledTimes(1);
		expect(createSpy).toHaveBeenCalledWith("Notes/Transcribe");
		expect(getNoticeCalls()).toHaveLength(0);
	});

	it("createFolder 실패 시 루트(\"\")로 fallback 하고 Notice를 발생시킨다 (Requirement 4.5)", async () => {
		vi.spyOn(vault, "getAbstractFileByPath").mockReturnValue(null);
		const fsError = new Error("EACCES: permission denied");
		vi.spyOn(vault, "createFolder").mockRejectedValue(fsError);

		const result = await store.ensureFolder("forbidden/path");

		// 루트 fallback 확인.
		expect(result).toBe("");

		// Notice가 정확히 1회 발생하고 기본 영어 fallback 문구를 사용한다.
		const noticeCalls = getNoticeCalls();
		expect(noticeCalls).toHaveLength(1);
		expect(noticeCalls[0]).toBe(
			"Could not create the transcript folder. Saving to the vault root instead.",
		);

		// 실패 원인은 console.error로 로깅되어야 한다(Requirement 9.6).
		expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
		expect(consoleErrorSpy).toHaveBeenCalledWith(
			"[Transcribe] Failed to create transcript folder:",
			fsError,
		);
	});

	it("fallback Notice 메시지는 호출 측이 주입한 i18n 문구로 대체 가능하다", async () => {
		vi.spyOn(vault, "getAbstractFileByPath").mockReturnValue(null);
		vi.spyOn(vault, "createFolder").mockRejectedValue(new Error("boom"));

		const koMessage = "전사 폴더를 생성하지 못했습니다. 볼트 루트에 저장합니다.";
		const result = await store.ensureFolder("무권한폴더", koMessage);

		expect(result).toBe("");
		expect(getNoticeCalls()).toEqual([koMessage]);
	});

	it("경로에 파일이 점유 중이면 createFolder를 호출하지 않고 루트로 fallback 한다", async () => {
		// TFile은 TFolder가 아니므로 createFolder 없이 바로 fallback 경로로 진입.
		vi.spyOn(vault, "getAbstractFileByPath").mockReturnValue(
			makeTFile("Notes.md"),
		);
		const createSpy = vi.spyOn(vault, "createFolder");

		const result = await store.ensureFolder("Notes.md");

		expect(result).toBe("");
		expect(createSpy).not.toHaveBeenCalled();
		expect(getNoticeCalls()).toHaveLength(1);
	});
});

// -----------------------------------------------------------------------------
// saveTranscript
// -----------------------------------------------------------------------------

describe("NoteStore.saveTranscript", () => {
	let vault: Vault;
	let store: NoteStore;

	beforeEach(() => {
		resetNoticeCalls();
		vault = new Vault();
		store = new NoteStore(vault);
		vi.spyOn(console, "error").mockImplementation(() => undefined);
	});

	it("허용되지 않은 language 값이 들어오면 throw 하고 Vault를 변경하지 않는다 (Property 7)", async () => {
		const createSpy = vi.spyOn(vault, "create");
		const createFolderSpy = vi.spyOn(vault, "createFolder");

		const badMeta = { ...sampleMeta(), language: "fr-FR" as unknown as "ko-KR" };

		await expect(
			store.saveTranscript("hello", badMeta, ""),
		).rejects.toThrow(/Invalid transcript language code/);

		expect(createSpy).not.toHaveBeenCalled();
		expect(createFolderSpy).not.toHaveBeenCalled();
	});

	it("충돌이 없으면 기본 파일명으로 생성하고 프론트매터 + 본문을 기록한다", async () => {
		// 빈 폴더 루트 설정: 기존 파일 없음 → 기본명 그대로 사용.
		const root = new TFolder();
		root.path = "";
		root.children = [];
		vi.spyOn(vault, "getRoot").mockReturnValue(root);

		const created = makeTFile(`${FIXED_BASENAME}.md`);
		const createSpy = vi
			.spyOn(vault, "create")
			.mockResolvedValue(created);

		const result = await store.saveTranscript(
			"본문 내용",
			sampleMeta(),
			"",
			FIXED_NOW,
		);

		expect(result).toBe(created);
		expect(createSpy).toHaveBeenCalledTimes(1);

		const [path, content] = createSpy.mock.calls[0];
		expect(path).toBe(`${FIXED_BASENAME}.md`);
		// 프론트매터와 본문이 예상대로 조합되었는지 확인(Property 7).
		expect(content).toBe(
			[
				"---",
				'startedAt: "2025-01-15T09:30:00+09:00"',
				'endedAt: "2025-01-15T09:45:00+09:00"',
				'language: "ko-KR"',
				"---",
				"",
				"본문 내용",
			].join("\n"),
		);
	});

	it("동일 기본 파일명이 이미 존재하면 `-1` 접미사로 충돌을 회피한다 (Requirement 4.4)", async () => {
		// 폴더에 기존 전사 파일이 하나 존재하도록 모의.
		const folder = new TFolder();
		folder.path = "Meetings";
		folder.children = [makeTFile(`${FIXED_BASENAME}.md`)];

		vi.spyOn(vault, "getAbstractFileByPath").mockReturnValue(folder);
		const createSpy = vi
			.spyOn(vault, "create")
			.mockResolvedValue(makeTFile(`${FIXED_BASENAME}-1.md`));

		await store.saveTranscript("b", sampleMeta(), "Meetings", FIXED_NOW);

		const [path] = createSpy.mock.calls[0];
		expect(path).toBe(`Meetings/${FIXED_BASENAME}-1.md`);
	});

	it("Vault.create가 reject 하면 에러가 호출 측으로 그대로 전파된다 (Requirement 4.8)", async () => {
		const root = new TFolder();
		root.children = [];
		vi.spyOn(vault, "getRoot").mockReturnValue(root);

		const ioError = new Error("EIO: disk full");
		vi.spyOn(vault, "create").mockRejectedValue(ioError);

		// NoteStore가 에러를 삼키지 않아야 호출 측(main.ts)이
		// Transcript_Buffer를 유지하고 재시도 UX를 제공할 수 있다.
		await expect(
			store.saveTranscript("body", sampleMeta(), "", FIXED_NOW),
		).rejects.toBe(ioError);
	});
});

// -----------------------------------------------------------------------------
// overwriteTranscript
// -----------------------------------------------------------------------------

describe("NoteStore.overwriteTranscript", () => {
	let vault: Vault;
	let store: NoteStore;

	beforeEach(() => {
		resetNoticeCalls();
		vault = new Vault();
		store = new NoteStore(vault);
	});

	it("Vault.process를 한 번 호출하고 프론트매터는 보존하며 본문만 교체한다 (Requirement 5.5, 9.9)", async () => {
		const file = makeTFile("note.md");
		const original =
			[
				"---",
				'startedAt: "2025-01-15T09:30:00+09:00"',
				'endedAt: "2025-01-15T09:45:00+09:00"',
				'language: "ko-KR"',
				"---",
				"",
				"old body content",
			].join("\n");

		// mock Vault.process의 기본 구현이 read → callback → modify 순으로 동작하므로,
		// read에 원본 내용을 주입하고 modify 호출을 관찰한다.
		vi.spyOn(vault, "read").mockResolvedValue(original);
		const modifySpy = vi.spyOn(vault, "modify").mockResolvedValue();
		const processSpy = vi.spyOn(vault, "process");

		await store.overwriteTranscript(file, "new body content");

		expect(processSpy).toHaveBeenCalledTimes(1);
		expect(processSpy.mock.calls[0][0]).toBe(file);

		// modify로 넘어간 최종 문자열에서 프론트매터가 보존되고 본문만 바뀌었는지 확인.
		// NoteStore의 `extractFrontmatterBlock`은 닫는 `---` 라인까지만 프론트매터로 인식하고,
		// 그 뒤의 빈 라인은 본문의 일부로 간주한다(본문 교체 시 함께 제거된다).
		expect(modifySpy).toHaveBeenCalledTimes(1);
		const [, written] = modifySpy.mock.calls[0];
		expect(written).toBe(
			[
				"---",
				'startedAt: "2025-01-15T09:30:00+09:00"',
				'endedAt: "2025-01-15T09:45:00+09:00"',
				'language: "ko-KR"',
				"---",
				"new body content",
			].join("\n"),
		);
	});

	it("프론트매터가 없는 파일은 본문 전체가 교체된다", async () => {
		const file = makeTFile("plain.md");
		vi.spyOn(vault, "read").mockResolvedValue("just plain text");
		const modifySpy = vi.spyOn(vault, "modify").mockResolvedValue();

		await store.overwriteTranscript(file, "replacement");

		const [, written] = modifySpy.mock.calls[0];
		expect(written).toBe("replacement");
	});
});

// -----------------------------------------------------------------------------
// appendAnalysis
// -----------------------------------------------------------------------------

describe("NoteStore.appendAnalysis", () => {
	let vault: Vault;
	let store: NoteStore;

	beforeEach(() => {
		resetNoticeCalls();
		vault = new Vault();
		store = new NoteStore(vault);
	});

	it("locale이 'en'이면 `## Analysis result` 헤더를 본문 끝에 부착한다 (Requirement 6.8)", async () => {
		const file = makeTFile("n.md");
		vi.spyOn(vault, "read").mockResolvedValue("existing body\n");
		const modifySpy = vi.spyOn(vault, "modify").mockResolvedValue();

		await store.appendAnalysis(file, "요약 결과", "en");

		const [, written] = modifySpy.mock.calls[0];
		expect(written).toBe(
			"existing body\n\n## Analysis result\n\n요약 결과\n",
		);
	});

	it("locale이 'ko'면 `## 분석 결과` 헤더를 부착한다 (Requirement 6.8)", async () => {
		const file = makeTFile("n.md");
		vi.spyOn(vault, "read").mockResolvedValue("기존 본문\n");
		const modifySpy = vi.spyOn(vault, "modify").mockResolvedValue();

		await store.appendAnalysis(file, "분석 결과 본문", "ko");

		const [, written] = modifySpy.mock.calls[0];
		expect(written).toBe("기존 본문\n\n## 분석 결과\n\n분석 결과 본문\n");
	});

	it("줄바꿈으로 끝나지 않는 본문에도 경계 라인을 보정하여 부착한다 (Requirement 6.9)", async () => {
		const file = makeTFile("n.md");
		vi.spyOn(vault, "read").mockResolvedValue("no-newline");
		const modifySpy = vi.spyOn(vault, "modify").mockResolvedValue();

		await store.appendAnalysis(file, "X", "en");

		const [, written] = modifySpy.mock.calls[0];
		expect(written).toBe("no-newline\n\n## Analysis result\n\nX\n");
	});
});

// -----------------------------------------------------------------------------
// readTranscriptBody
// -----------------------------------------------------------------------------

describe("NoteStore.readTranscriptBody", () => {
	let vault: Vault;
	let store: NoteStore;

	beforeEach(() => {
		resetNoticeCalls();
		vault = new Vault();
		store = new NoteStore(vault);
	});

	it("프론트매터를 제외한 본문만 반환한다", async () => {
		const file = makeTFile("n.md");
		vi.spyOn(vault, "read").mockResolvedValue(
			[
				"---",
				'startedAt: "2025-01-15T09:30:00+09:00"',
				'endedAt: "2025-01-15T09:45:00+09:00"',
				'language: "ko-KR"',
				"---",
				"",
				"body line 1",
				"body line 2",
			].join("\n"),
		);

		const result = await store.readTranscriptBody(file);

		// 닫는 `---` 라인 뒤의 빈 라인은 본문의 일부로 유지된다.
		expect(result).toBe("\nbody line 1\nbody line 2");
	});

	it("프론트매터가 없으면 원본 전체를 그대로 반환한다", async () => {
		const file = makeTFile("n.md");
		vi.spyOn(vault, "read").mockResolvedValue("raw content\nwith newline\n");

		const result = await store.readTranscriptBody(file);

		expect(result).toBe("raw content\nwith newline\n");
	});

	it("읽기 실패 시 에러를 호출 측으로 전파한다", async () => {
		const file = makeTFile("n.md");
		const err = new Error("ENOENT");
		vi.spyOn(vault, "read").mockRejectedValue(err);

		await expect(store.readTranscriptBody(file)).rejects.toBe(err);
	});
});
