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

import { TranscriptBuffer } from "../domain/TranscriptBuffer";
import { mergeWithDefaults } from "../settings/mergeWithDefaults";
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
const FIXED_BASENAME = "2025-01-15 09-30";

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

// -----------------------------------------------------------------------------
// v1.1 신규 frontmatter 키 — Task 22 (Requirement 3.9, 6.9, 8.3, 13)
// -----------------------------------------------------------------------------
//
// 검증 목표:
// 1. 모두 없는 경우(예시 1, v1.0 동치): meta = { startedAt, endedAt, language }
//    → frontmatter 가 v1.0 과 비트 단위 동치로 직렬화 (Requirement 8.3, 8.2).
// 2. 모두 있는 경우(예시 2, cloud + diarization + translation):
//    meta = { ..., backend: "cloud", speakerDiarization: true, speakerCount: 3,
//             translationTargetLanguage: "en" }
//    → 4 개 신규 키가 모두 출력에 포함, 키 순서 일관성 검증.
// 3. 일부만 있는 경우(예시 3, 로컬 모드):
//    meta = { ..., backend: "local" }
//    → backend 만 추가되고 speakerDiarization/speakerCount/
//      translationTargetLanguage 는 출력에서 누락.

describe("NoteStore.saveTranscript — v1.1 신규 frontmatter 키 (Task 22)", () => {
	let vault: Vault;
	let store: NoteStore;

	beforeEach(() => {
		resetNoticeCalls();
		vault = new Vault();
		store = new NoteStore(vault);
		vi.spyOn(console, "error").mockImplementation(() => undefined);

		// 빈 루트로 충돌 검사를 단순화한다.
		const root = new TFolder();
		root.path = "";
		root.children = [];
		vi.spyOn(vault, "getRoot").mockReturnValue(root);
	});

	it("시나리오 1 — 모두 없는 경우: v1.0 과 비트 단위 동치인 frontmatter 를 생성한다 (Requirement 8.3)", async () => {
		const created = makeTFile(`${FIXED_BASENAME}.md`);
		const createSpy = vi.spyOn(vault, "create").mockResolvedValue(created);

		// 신규 필드를 일절 지정하지 않은 v1.0 동치 메타.
		const meta: TranscriptNoteMeta = sampleMeta();

		await store.saveTranscript("본문", meta, "", FIXED_NOW);

		const [, content] = createSpy.mock.calls[0];
		// design §Backward Compatibility / 예시 1 의 v1.0 동치 frontmatter.
		// 신규 키 4 개(`backend`, `speaker_diarization`, `speaker_count`,
		// `translation_target_language`) 는 어느 것도 출력에 등장해서는 안 된다.
		expect(content).toBe(
			[
				"---",
				'startedAt: "2025-01-15T09:30:00+09:00"',
				'endedAt: "2025-01-15T09:45:00+09:00"',
				'language: "ko-KR"',
				"---",
				"",
				"본문",
			].join("\n"),
		);
		// 회귀 게이트: 신규 키 4 종이 출력 어디에도 등장하지 않아야 한다.
		const written = content as string;
		expect(written).not.toContain("backend:");
		expect(written).not.toContain("speaker_diarization:");
		expect(written).not.toContain("speaker_count:");
		expect(written).not.toContain("translation_target_language:");
	});

	it("시나리오 2 — 모두 있는 경우: 4 개 신규 키가 정해진 순서로 모두 직렬화된다 (Requirement 6.9, 13)", async () => {
		const created = makeTFile(`${FIXED_BASENAME}.md`);
		const createSpy = vi.spyOn(vault, "create").mockResolvedValue(created);

		// design §Frontmatter Schema Changes 의 예시 2 (cloud + diarization + translation).
		const meta: TranscriptNoteMeta = {
			...sampleMeta(),
			backend: "cloud",
			speakerDiarization: true,
			speakerCount: 3,
			translationTargetLanguage: "en",
		};

		await store.saveTranscript("본문", meta, "", FIXED_NOW);

		const [, content] = createSpy.mock.calls[0];
		// 키 순서: startedAt → endedAt → language → backend
		//          → speaker_diarization → speaker_count → translation_target_language
		// 문자열 값은 큰따옴표, boolean / number 는 plain scalar.
		expect(content).toBe(
			[
				"---",
				'startedAt: "2025-01-15T09:30:00+09:00"',
				'endedAt: "2025-01-15T09:45:00+09:00"',
				'language: "ko-KR"',
				'backend: "cloud"',
				"speaker_diarization: true",
				"speaker_count: 3",
				'translation_target_language: "en"',
				"---",
				"",
				"본문",
			].join("\n"),
		);
	});

	it("시나리오 3 — 일부만 있는 경우(로컬 모드): backend 만 추가되고 나머지 신규 키는 누락된다 (Requirement 8.3)", async () => {
		const created = makeTFile(`${FIXED_BASENAME}.md`);
		const createSpy = vi.spyOn(vault, "create").mockResolvedValue(created);

		// design §Frontmatter Schema Changes 의 예시 3 (로컬 모드, 화자 분리 v1 미지원).
		const meta: TranscriptNoteMeta = {
			...sampleMeta(),
			backend: "local",
		};

		await store.saveTranscript("본문", meta, "", FIXED_NOW);

		const [, content] = createSpy.mock.calls[0];
		// backend 라인만 추가되고 speaker_diarization / speaker_count /
		// translation_target_language 는 출력에 등장해서는 안 된다.
		expect(content).toBe(
			[
				"---",
				'startedAt: "2025-01-15T09:30:00+09:00"',
				'endedAt: "2025-01-15T09:45:00+09:00"',
				'language: "ko-KR"',
				'backend: "local"',
				"---",
				"",
				"본문",
			].join("\n"),
		);
		const written = content as string;
		expect(written).not.toContain("speaker_diarization:");
		expect(written).not.toContain("speaker_count:");
		expect(written).not.toContain("translation_target_language:");
	});

	it("speakerDiarization=false 도 명시 지정 시에는 출력에 포함된다 (undefined vs false 구분)", async () => {
		const created = makeTFile(`${FIXED_BASENAME}.md`);
		const createSpy = vi.spyOn(vault, "create").mockResolvedValue(created);

		// undefined 와 false 를 동등하게 취급하면 v1.0 호환이 손상되지는 않지만,
		// 호출 측이 의도적으로 false 를 기록하려는 케이스(예: 화자 분리를 시도했으나 실패) 를
		// 위해 false 도 직렬화한다. v1.0 호환은 호출 측에서 undefined 로 두는 것이 책임이다.
		const meta: TranscriptNoteMeta = {
			...sampleMeta(),
			backend: "cloud",
			speakerDiarization: false,
		};

		await store.saveTranscript("본문", meta, "", FIXED_NOW);

		const [, content] = createSpy.mock.calls[0];
		expect(content).toContain("speaker_diarization: false");
		// false 인 경우 speaker_count 는 함께 기록되지 않는다(호출 측이 키를 생략함으로써).
		expect((content as string)).not.toContain("speaker_count:");
	});
});

// -----------------------------------------------------------------------------
// 후방 호환 snapshot — Task 29 (Requirement 8.2, 8.3)
// -----------------------------------------------------------------------------
//
// 회귀 게이트(REGRESSION GATE):
//
// 본 describe 블록은 design §Backward Compatibility 의 동등성 명제를 보호한다.
// 기본 설정(`DEFAULT_SETTINGS` = `mergeWithDefaults({})`) + `meta.backend: "cloud"` 만
// 추가된 시나리오에서 v1.1 가 v1.0 노트와 비트 단위로 동치인 본문을 생성하는지를
// snapshot 으로 고정한다.
//
// 본 snapshot 이 깨지면 즉시 빌드를 차단해야 한다 (Requirement 8.2 위반).
// 갱신이 필요한 경우 변경의 v1.0 호환성 영향을 design §Backward Compatibility 와
// 함께 PR 본문에 명시 후, `vitest -u` 가 아닌 직접 검토 후 갱신한다.

describe("NoteStore — 후방 호환 snapshot (Task 29, Requirement 8.2/8.3)", () => {
	let vault: Vault;
	let store: NoteStore;

	beforeEach(() => {
		resetNoticeCalls();
		vault = new Vault();
		store = new NoteStore(vault);
		vi.spyOn(console, "error").mockImplementation(() => undefined);

		// 빈 루트로 충돌 검사를 단순화하여 파일명 결정 결과를 결정론적으로 만든다.
		const root = new TFolder();
		root.path = "";
		root.children = [];
		vi.spyOn(vault, "getRoot").mockReturnValue(root);
	});

	it("v1.0 default settings produce v1.0-compatible transcript", async () => {
		// design §Backward Compatibility 검증 케이스의 정확한 재현.
		//
		// 입력 구성요소:
		// 1. `mergeWithDefaults({})` 결과는 `DEFAULT_SETTINGS` 와 비트 단위 동치이며,
		//    `timestampOutputEnabled === false` 이므로 v1.0 통짜 본문 분기로 진입한다.
		// 2. `TranscriptBuffer.appendFinal` 을 두 번 호출해 한국어 두 문장을 누적.
		//    `appendSegment` 가 아닌 `appendFinal` 을 쓰는 이유는 design 예시가
		//    Final 텍스트만 누적된 v1.0 동치 시나리오이기 때문이다.
		// 3. `meta` 는 v1.0 키 3 종 + v1.1 신규 키 중 `backend: "cloud"` 만 포함한다.
		//    다른 v1.1 신규 키는 default 가 false/empty 이므로 호출 측이 undefined 로
		//    두어 frontmatter 출력에서 제외된다 (Requirement 8.3).
		const settings = mergeWithDefaults({});

		const buffer = new TranscriptBuffer();
		buffer.appendFinal("안녕하세요.");
		buffer.appendFinal("회의를 시작합니다.");

		const meta: TranscriptNoteMeta = {
			startedAt: "2025-01-15T09:00:00+09:00",
			endedAt: "2025-01-15T09:05:00+09:00",
			language: "ko-KR",
			backend: "cloud",
		};

		// 시간 의존성 제거: 결정론적 파일명을 위해 `FIXED_NOW` 를 주입한다.
		const created = makeTFile(`${FIXED_BASENAME}.md`);
		const createSpy = vi.spyOn(vault, "create").mockResolvedValue(created);

		// 본문 직렬화는 v1.0 통짜 본문 분기로 진입한다.
		// 통짜 본문 = `chunks.join(" ")` + 단일 trailing newline = "안녕하세요. 회의를 시작합니다.\n".
		// (timestampOutputEnabled === false 분기, Sentence_Formatter.format)
		const body = settings.timestampOutputEnabled
			? // v1.1 의 timestamp 분기는 본 회귀 게이트의 대상이 아니므로 본 시나리오에서는
				// 도달 불가. 본 라인은 type narrowing 용 fallthrough 일 뿐이다.
				""
			: buffer.getCommittedText().trim().length > 0
				? `${buffer.getCommittedText()}\n`
				: "";

		await store.saveTranscript(body, meta, "", FIXED_NOW);

		// `Vault.create` 에 전달된 최종 콘텐츠 = serializeFrontmatter(meta) + body.
		// 본 콘텐츠가 design §Backward Compatibility 예시와 비트 단위 동치인지를
		// snapshot 으로 고정한다 (회귀 게이트).
		const [, content] = createSpy.mock.calls[0];
		expect(content).toMatchSnapshot();

		// 추가 방어선 — snapshot 갱신 시 실수로 회귀가 통과하지 않도록 핵심 불변식을
		// 명시 검증한다. 이 두 줄이 깨지면 snapshot 또한 반드시 깨진다.
		const written = content as string;
		expect(written).toContain('backend: "cloud"');
		expect(written).not.toContain("speaker_diarization:");
		expect(written).not.toContain("speaker_count:");
		expect(written).not.toContain("translation_target_language:");
		// v1.0 통짜 본문은 단순 텍스트 결합 (`안녕하세요. 회의를 시작합니다.\n`).
		expect(written.endsWith("안녕하세요. 회의를 시작합니다.\n")).toBe(true);
	});
});
