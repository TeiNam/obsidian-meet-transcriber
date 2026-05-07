/**
 * `NoteStore` 속성 기반 테스트(PBT).
 *
 * design.md §9의 아래 다섯 속성을 검증한다:
 * - Property 6:  파일명 충돌 회피 규칙 — **Validates: Requirement 4.4**
 * - Property 7:  프론트매터 직렬화 보존 — **Validates: Requirement 4.6**
 * - Property 8:  편집 덮어쓰기 본문 보존 규칙 — **Validates: Requirements 5.5, 9.9**
 * - Property 9:  분석 결과 부착 규칙 — **Validates: Requirements 6.8, 6.9, 6.10**
 * - Property 15: 경로 정규화 안전성 — **Validates: Requirement 9.8**
 *
 * 전략:
 * - `resolveUniqueFilename`은 순수 함수이므로 Vault 모킹 없이 검증한다(Property 6).
 * - 그 외 속성은 `vi.spyOn`으로 Vault 메서드를 가로채 호출 인자를 캡처한다.
 * - `Notice` 생성 호출은 `vi.mock("obsidian", ...)`의 SpyNotice로 관찰만 하고,
 *   프로덕션 코드(`NoteStore.ts`)는 수정하지 않는다.
 */

import { beforeEach, describe, expect, test, vi } from "vitest";
import fc from "fast-check";

// Notice 생성 호출을 관측하기 위해 obsidian 모듈을 재래핑한다.
// (프로퍼티 테스트에서 직접 확인하지는 않지만, NoteStore 내부에서 Notice를 생성하는 경로를
// 안전하게 실행하기 위해 SpyNotice를 주입한다.)
vi.mock("obsidian", async () => {
	const actual =
		await vi.importActual<typeof import("obsidian")>("obsidian");

	class SpyNotice {
		message: string | DocumentFragment;
		noticeEl: HTMLElement;
		constructor(message: string | DocumentFragment, _timeout?: number) {
			this.message = message;
			this.noticeEl = document.createElement("div");
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
import { TFile, TFolder, Vault, normalizePath } from "obsidian";

import type { TranscriptNoteMeta } from "./NoteStore";
import { NoteStore } from "./NoteStore";
import type { LanguageCode, SupportedLocale } from "../types/settings";

// ---------------------------------------------------------------------------
// 공통 상수 — `NoteStore.ts`의 구현 상세와 동일한 경계값/포맷
// ---------------------------------------------------------------------------

const MARKDOWN_EXTENSION = ".md";
const ALLOWED_LANGUAGE_CODES: readonly LanguageCode[] = ["ko-KR", "en-US"];

/** locale별 분석 섹션 헤더(`i18n/en.ts`, `i18n/ko.ts`와 동일). */
const ANALYSIS_HEADER: Record<SupportedLocale, string> = {
	en: "## Analysis result",
	ko: "## 분석 결과",
};

/** 결정론적 파일명 타임스탬프를 위한 고정 시각(로컬). */
const FIXED_NOW = new Date(2025, 0, 15, 9, 30, 0);
const FIXED_BASENAME = "Transcribe-20250115-093000";

// ---------------------------------------------------------------------------
// 헬퍼
// ---------------------------------------------------------------------------

/** TFile 모사 인스턴스 생성. */
function makeTFile(pathAndName: string): TFile {
	const f = new TFile();
	f.path = pathAndName;
	const lastSlash = pathAndName.lastIndexOf("/");
	f.name = lastSlash === -1 ? pathAndName : pathAndName.slice(lastSlash + 1);
	f.basename = f.name.replace(/\.md$/, "");
	f.extension = "md";
	return f;
}

/** 빈 children을 갖는 TFolder 생성. */
function makeEmptyFolder(path = ""): TFolder {
	const folder = new TFolder();
	folder.path = path;
	folder.name = path === "" ? "" : (path.split("/").pop() ?? "");
	folder.children = [];
	return folder;
}

/** RegExp 특수문자를 이스케이프해 literal string으로 안전하게 사용. */
function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * `serializeFrontmatter`(`NoteStore.ts`)가 사용하는 YAML 문자열 이스케이프의 역함수.
 *
 * 구현 세부:
 * 1. `\\` → `\\\\`, `"` → `\\"` 순으로 이스케이프 → 역방향으로는 단일 패스 문자 단위 파싱으로
 *    `\\\\` → `\\`, `\\"` → `"` 를 복원한다.
 */
function unescapeYamlQuoted(s: string): string {
	let out = "";
	for (let i = 0; i < s.length; i++) {
		if (s[i] === "\\" && i + 1 < s.length) {
			const next = s[i + 1];
			if (next === "\\") {
				out += "\\";
				i++;
				continue;
			}
			if (next === '"') {
				out += '"';
				i++;
				continue;
			}
		}
		out += s[i];
	}
	return out;
}

/**
 * `saveTranscript`가 `Vault.create`에 전달한 최종 content를 파싱한다.
 *
 * NoteStore의 직렬화 포맷:
 * ```
 * ---\n
 * startedAt: "<escaped>"\n
 * endedAt: "<escaped>"\n
 * language: "<code>"\n
 * ---\n
 * \n
 * <body>
 * ```
 *
 * @returns frontmatter 필드 맵과 body 문자열. 파싱 실패 시 `null`.
 */
function parseSerializedNote(content: string): {
	frontmatter: Record<string, string>;
	body: string;
} | null {
	const match = /^---\n([\s\S]*?)\n---\n(\n?)([\s\S]*)$/.exec(content);
	if (match === null) return null;

	const [, yamlBody, , body] = match;
	const frontmatter: Record<string, string> = {};
	for (const line of yamlBody.split("\n")) {
		const kv = /^([A-Za-z_][A-Za-z0-9_]*):\s"((?:[^"\\]|\\.)*)"$/.exec(line);
		if (kv === null) return null;
		frontmatter[kv[1]] = unescapeYamlQuoted(kv[2]);
	}
	return { frontmatter, body };
}

/** 문자열 내 부분문자열 출현 횟수. 빈 부분문자열은 0으로 정의. */
function countOccurrences(s: string, sub: string): number {
	if (sub === "") return 0;
	return s.split(sub).length - 1;
}

// ---------------------------------------------------------------------------
// Property 6: 파일명 충돌 회피 규칙
// ---------------------------------------------------------------------------

describe("NoteStore.resolveUniqueFilename — Property 6: 파일명 충돌 회피 규칙", () => {
	/**
	 * 설계 §9의 불변식:
	 * - 결과는 `existing`에 포함되지 않는다.
	 * - 결과는 `{base}.md` 또는 `{base}-N.md`(N은 양의 정수) 형태를 갖는다.
	 * - `{base}.md` ∉ existing → 결과 === `{base}.md`.
	 * - `{base}.md` ∈ existing 이고 `{base}-1.md`..`{base}-(N-1).md` 가 모두 existing 이며
	 *   `{base}-N.md` ∉ existing → 결과 === `{base}-N.md`.
	 *
	 * 생성기 설계:
	 * - `base`: 임의 문자열(순수 함수 관심사에서는 경로 분리자 유무와 무관).
	 * - `k`: 0 이상의 정수. `k === 0`이면 `{base}.md` 미점유, `k >= 1`이면
	 *   `{base}.md, {base}-1.md, ..., {base}-(k-1).md`가 점유되고 `{base}-k.md`가 비어있다.
	 * - `noise`: 위 패턴과 겹치지 않는 임의의 `.md` 파일명 집합.
	 *
	 * 이 구성으로 기대 결과는 항상 다음과 같이 결정된다:
	 *   `k === 0 ⇒ {base}.md`,  `k >= 1 ⇒ {base}-{k}.md`.
	 *
	 * **Validates: Requirement 4.4**
	 */
	test("결과는 existing에 없고 base.md 또는 base-N.md 형태이며 최소 N이 선택된다", () => {
		const store = new NoteStore(new Vault());

		const scenarioArb = fc
			.record({
				base: fc.string({ maxLength: 30 }),
				k: fc.integer({ min: 0, max: 10 }),
				noise: fc.array(fc.string({ maxLength: 20 }), { maxLength: 10 }),
			})
			.map(({ base, k, noise }) => {
				const existing = new Set<string>();
				// `{base}.md` ~ `{base}-(k-1).md`를 점유 상태로 삽입.
				for (let i = 0; i < k; i++) {
					const name =
						i === 0
							? `${base}${MARKDOWN_EXTENSION}`
							: `${base}-${i}${MARKDOWN_EXTENSION}`;
					existing.add(name);
				}
				// noise 파일명은 `{base}.md`와 `{base}-<정수>.md` 패턴에 충돌하지 않는
				// 것만 추가한다(기대 결과가 결정론적으로 `{base}-{k}.md`가 되도록 보호).
				const collisionRegex = new RegExp(
					`^${escapeRegex(base)}(?:-\\d+)?${escapeRegex(MARKDOWN_EXTENSION)}$`,
				);
				for (const n of noise) {
					const candidate = `${n}${MARKDOWN_EXTENSION}`;
					if (collisionRegex.test(candidate)) continue;
					existing.add(candidate);
				}
				const expected =
					k === 0
						? `${base}${MARKDOWN_EXTENSION}`
						: `${base}-${k}${MARKDOWN_EXTENSION}`;
				return { base, existing, expected };
			});

		fc.assert(
			fc.property(scenarioArb, ({ base, existing, expected }) => {
				const result = store.resolveUniqueFilename(base, existing);

				// (1) 결과는 existing에 포함되지 않는다.
				expect(existing.has(result)).toBe(false);
				// (2) 결과는 허용된 형태를 갖는다.
				const shape = new RegExp(
					`^${escapeRegex(base)}(?:-[1-9]\\d*)?${escapeRegex(MARKDOWN_EXTENSION)}$`,
				);
				expect(shape.test(result)).toBe(true);
				// (3) 최소 N 규칙: 기대 결과와 일치한다.
				expect(result).toBe(expected);
			}),
			{ numRuns: 300 },
		);
	});
});

// ---------------------------------------------------------------------------
// Property 7: 프론트매터 직렬화 보존
// ---------------------------------------------------------------------------

describe("NoteStore.saveTranscript — Property 7: 프론트매터 직렬화 보존", () => {
	let vault: Vault;
	let store: NoteStore;

	beforeEach(() => {
		vault = new Vault();
		store = new NoteStore(vault);
		// 로그 잡음 방지.
		vi.spyOn(console, "error").mockImplementation(() => undefined);
	});

	/**
	 * 임의의 `TranscriptNoteMeta`와 본문 `body`에 대해 `saveTranscript`가 생성한 content를
	 * 파싱하면 메타데이터 세 필드와 본문이 값 변경 없이 재구성된다.
	 * `language`는 항상 허용된 코드 중 하나다.
	 *
	 * **Validates: Requirement 4.6**
	 */
	test("임의의 meta/body가 프론트매터 + 본문 포맷으로 라운드트립된다", async () => {
		// YAML 라인 기반 파싱이 깨지지 않도록 개행 없는 문자열만 생성한다
		// (직렬화의 현실적 입력은 ISO8601 타임스탬프이므로 충분히 포괄적).
		const noNewlineStr = (maxLength = 60) =>
			fc.string({ maxLength }).filter((s) => !/[\r\n]/.test(s));

		const metaArb: fc.Arbitrary<TranscriptNoteMeta> = fc.record({
			startedAt: noNewlineStr(),
			endedAt: noNewlineStr(),
			language: fc.constantFrom<LanguageCode>(...ALLOWED_LANGUAGE_CODES),
		});

		await fc.assert(
			fc.asyncProperty(
				metaArb,
				fc.string({ maxLength: 500 }),
				async (meta, body) => {
					// 루트 폴더의 기존 파일이 없는 상태를 고정한다 → 파일명 충돌 회피가 개입하지 않는다.
					vi.spyOn(vault, "getRoot").mockReturnValue(makeEmptyFolder(""));
					const createSpy = vi
						.spyOn(vault, "create")
						.mockImplementation(async (path: string) => makeTFile(path));

					await store.saveTranscript(body, meta, "", FIXED_NOW);

					expect(createSpy).toHaveBeenCalledTimes(1);
					const [path, content] = createSpy.mock.calls[0];

					// 경로는 정규화된 파일명(루트이므로 파일명만).
					expect(path).toBe(`${FIXED_BASENAME}${MARKDOWN_EXTENSION}`);

					// 라운드트립: 직렬화된 content를 파싱해 원본 meta와 body를 복원한다.
					const parsed = parseSerializedNote(content);
					expect(parsed).not.toBeNull();
					if (parsed === null) return; // 타입 가드용(실제로는 도달하지 않음)

					expect(parsed.frontmatter.startedAt).toBe(meta.startedAt);
					expect(parsed.frontmatter.endedAt).toBe(meta.endedAt);
					expect(parsed.frontmatter.language).toBe(meta.language);
					expect(parsed.body).toBe(body);

					// language는 언제나 허용된 코드만 기록된다.
					expect(ALLOWED_LANGUAGE_CODES).toContain(
						parsed.frontmatter.language as LanguageCode,
					);
				},
			),
			{ numRuns: 100 },
		);
	});
});

// ---------------------------------------------------------------------------
// Property 8: 편집 덮어쓰기 본문 보존 규칙
// ---------------------------------------------------------------------------

describe("NoteStore.overwriteTranscript — Property 8: 편집 덮어쓰기 본문 보존", () => {
	let vault: Vault;
	let store: NoteStore;

	beforeEach(() => {
		vault = new Vault();
		store = new NoteStore(vault);
	});

	/**
	 * 임의의 프론트매터 블록(LF 기반)과 기존 본문, 새 본문에 대해 `overwriteTranscript` 후:
	 * - 결과는 정확히 `<원본 프론트매터 블록> + <새 본문>`.
	 * - 프론트매터 필드(`startedAt`, `endedAt`, `language`)는 덮어쓰기 전 값과 동일하다.
	 * - `Vault.process`가 정확히 1회 호출된다(Requirement 9.9).
	 *
	 * 주의: `extractFrontmatterBlock`은 닫는 `---\n`까지만 프론트매터로 인식하므로,
	 * 원본의 "---\n\n" 이후 빈 라인은 기존 본문의 일부로 간주되어 덮어쓰기 시 제거된다.
	 * 본 속성은 "프론트매터(닫는 fence의 줄바꿈까지) 접두사가 보존됨"을 기준으로 정의한다.
	 *
	 * **Validates: Requirements 5.5, 9.9**
	 */
	test("기존 프론트매터 접두사가 유지된 채 본문만 교체된다", async () => {
		const noNewlineStr = (maxLength = 50) =>
			fc.string({ maxLength }).filter((s) => !/[\r\n]/.test(s));

		// 원본 프론트매터 블록 생성기 — `extractFrontmatterBlock` 결과와 동일한 포맷.
		const frontmatterBlockArb = fc
			.record({
				startedAt: noNewlineStr(),
				endedAt: noNewlineStr(),
				language: fc.constantFrom<LanguageCode>(...ALLOWED_LANGUAGE_CODES),
			})
			.map((meta) => {
				const esc = (v: string) =>
					v.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
				// `---\n...\n---\n` 까지가 프론트매터 접두사(닫는 fence + 그 뒤 LF 하나).
				const block =
					[
						"---",
						`startedAt: "${esc(meta.startedAt)}"`,
						`endedAt: "${esc(meta.endedAt)}"`,
						`language: "${meta.language}"`,
						"---",
					].join("\n") + "\n";
				return { meta, block };
			});

		// `overwriteTranscript`는 공백-전용 본문도 그대로 기록하므로 빈 문자열 포함 허용.
		const newBodyArb = fc.string({ maxLength: 300 });
		const oldBodyArb = fc.string({ maxLength: 300 });

		await fc.assert(
			fc.asyncProperty(
				frontmatterBlockArb,
				oldBodyArb,
				newBodyArb,
				async ({ meta, block }, oldBody, newBody) => {
					const original = `${block}${oldBody}`;
					const file = makeTFile("Notes/note.md");

					vi.spyOn(vault, "read").mockResolvedValue(original);
					const modifySpy = vi
						.spyOn(vault, "modify")
						.mockResolvedValue();
					const processSpy = vi.spyOn(vault, "process");

					await store.overwriteTranscript(file, newBody);

					// (1) Vault.process를 정확히 1회 호출한다 (Requirement 9.9).
					expect(processSpy).toHaveBeenCalledTimes(1);
					expect(processSpy.mock.calls[0][0]).toBe(file);

					// (2) 최종 기록된 data는 프론트매터 접두사 + 새 본문.
					expect(modifySpy).toHaveBeenCalledTimes(1);
					const [, written] = modifySpy.mock.calls[0];
					expect(written).toBe(`${block}${newBody}`);

					// (3) 원본의 프론트매터 블록은 그대로 접두사로 유지된다.
					expect((written as string).startsWith(block)).toBe(true);

					// (4) 접두사 이후를 잘라내면 정확히 새 본문과 일치한다.
					expect((written as string).slice(block.length)).toBe(newBody);

					// (5) 프론트매터 YAML 라인에서 meta 값이 변하지 않았는지 직접 검증.
					const headerPart = block.slice(0, -1); // 마지막 LF 제외
					expect(
						headerPart.includes(
							`startedAt: "${meta.startedAt
								.replace(/\\/g, "\\\\")
								.replace(/"/g, '\\"')}"`,
						),
					).toBe(true);
					expect(
						headerPart.includes(`language: "${meta.language}"`),
					).toBe(true);
				},
			),
			{ numRuns: 80 },
		);
	});
});

// ---------------------------------------------------------------------------
// Property 9: 분석 결과 부착 규칙
// ---------------------------------------------------------------------------

describe("NoteStore.appendAnalysis — Property 9: 분석 결과 부착 규칙", () => {
	let vault: Vault;
	let store: NoteStore;

	beforeEach(() => {
		vault = new Vault();
		store = new NoteStore(vault);
	});

	/**
	 * 임의의 기존 본문(content), analysis 텍스트, locale에 대해:
	 * - `result.startsWith(content)` (기존 콘텐츠 보존).
	 * - locale별 헤더와 analysis 본문이 결과에 포함된다.
	 * - 기존 콘텐츠/analysis 내부의 우연한 헤더 출현을 제외하고, 결과는 헤더를
	 *   **정확히 1회** 더 포함한다(누적 규칙).
	 *
	 * **Validates: Requirements 6.8, 6.9, 6.10**
	 */
	test("기존 콘텐츠는 보존되고 locale별 헤더 + analysis가 한 번 더 추가된다", async () => {
		const localeArb = fc.constantFrom<SupportedLocale>("en", "ko");
		const textArb = fc.string({ maxLength: 300 });

		await fc.assert(
			fc.asyncProperty(
				textArb,
				textArb,
				localeArb,
				async (existingContent, analysis, locale) => {
					const file = makeTFile("n.md");
					vi.spyOn(vault, "read").mockResolvedValue(existingContent);
					const modifySpy = vi
						.spyOn(vault, "modify")
						.mockResolvedValue();

					await store.appendAnalysis(file, analysis, locale);

					expect(modifySpy).toHaveBeenCalledTimes(1);
					const [, rawWritten] = modifySpy.mock.calls[0];
					const written = rawWritten as string;
					const header = ANALYSIS_HEADER[locale];

					// (1) 기존 콘텐츠가 접두사로 보존된다 (Requirement 6.9).
					expect(written.startsWith(existingContent)).toBe(true);

					// (2) 결과는 `${header}\n\n${analysis}\n`로 끝난다 (Requirement 6.8).
					const expectedSuffix = `${header}\n\n${analysis}\n`;
					expect(written.endsWith(expectedSuffix)).toBe(true);

					// (3) 접두사/접미사로 분해했을 때 "separator"는 "\n" 또는 "\n\n" 중 하나이며,
					//     그 외 문자가 삽입되지 않는다.
					const middle = written.slice(
						existingContent.length,
						written.length - expectedSuffix.length,
					);
					expect(middle === "\n" || middle === "\n\n").toBe(true);

					// (4) 누적 규칙: 헤더 출현 횟수 증가분은 정확히 1.
					//     (기존 content와 analysis 내부 우연 출현을 보정한다.) — Requirement 6.10
					const before = countOccurrences(existingContent, header);
					const inAnalysis = countOccurrences(analysis, header);
					const after = countOccurrences(written, header);
					expect(after).toBe(before + inAnalysis + 1);
				},
			),
			{ numRuns: 100 },
		);
	});
});

// ---------------------------------------------------------------------------
// Property 15: 경로 정규화 안전성
// ---------------------------------------------------------------------------

describe("NoteStore.saveTranscript — Property 15: 경로 정규화 안전성", () => {
	let vault: Vault;
	let store: NoteStore;

	beforeEach(() => {
		vault = new Vault();
		store = new NoteStore(vault);
		vi.spyOn(console, "error").mockImplementation(() => undefined);
	});

	/**
	 * 임의의 사용자 입력 `folder`에 대해, NoteStore가 Vault API(`createFolder`, `create`)에
	 * 전달하는 모든 경로는:
	 * - `..` 세그먼트를 포함하지 않는다.
	 * - 선행 슬래시(`/`)로 시작하지 않는다.
	 * - `create` 경로의 폴더 접두사는 `normalizePath(folder)` 결과와 일치한다
	 *   (루트 저장 시 접두사 없음).
	 *
	 * **Validates: Requirement 9.8**
	 */
	test("Vault API로 전달되는 모든 경로는 `..`/절대경로 없이 정규화되어 있다", async () => {
		// 정규화 규칙의 경계를 넓게 탐색하기 위해 다양한 입력 후보를 섞는다.
		const folderArb = fc.oneof(
			fc.string({ maxLength: 50 }),
			// 상위 탐색/중복 슬래시/백슬래시를 포함하도록 힌트를 준 생성기도 함께 섞는다.
			fc
				.array(
					fc.oneof(
						fc.string({ maxLength: 8 }),
						fc.constantFrom("..", ".", "", "/", "\\", "a", "b"),
					),
					{ maxLength: 8 },
				)
				.map((segs) => segs.join("/")),
		);

		const meta: TranscriptNoteMeta = {
			startedAt: "2025-01-15T09:30:00+09:00",
			endedAt: "2025-01-15T09:45:00+09:00",
			language: "ko-KR",
		};

		await fc.assert(
			fc.asyncProperty(folderArb, async (folder) => {
				const capturedPaths: string[] = [];

				// 폴더가 vault에 존재하지 않는 상태로 강제 → createFolder 경로를 통과.
				vi.spyOn(vault, "getAbstractFileByPath").mockReturnValue(null);
				vi.spyOn(vault, "getRoot").mockReturnValue(makeEmptyFolder(""));
				vi.spyOn(vault, "createFolder").mockImplementation(
					async (path: string) => {
						capturedPaths.push(path);
						return makeEmptyFolder(path);
					},
				);
				vi.spyOn(vault, "create").mockImplementation(
					async (path: string) => {
						capturedPaths.push(path);
						return makeTFile(path);
					},
				);

				await store.saveTranscript("body", meta, folder, FIXED_NOW);

				// (1)/(2) Vault API에 전달된 모든 경로는 `..` 세그먼트와 선행 슬래시가 없다.
				for (const p of capturedPaths) {
					expect(p.split("/")).not.toContain("..");
					expect(p.startsWith("/")).toBe(false);
				}

				// (3) `create` 경로의 폴더 접두사는 normalizePath(folder)와 일치해야 한다.
				//     루트 저장이면 접두사 없이 파일명만 전달된다.
				const normalized = normalizePath(folder);
				const expectedFolder =
					normalized === "" || normalized === "/" ? "" : normalized;

				// 마지막으로 추가된 경로가 `create` 호출의 파일 경로(파일명 포함)이다.
				const filePath = capturedPaths[capturedPaths.length - 1];
				if (expectedFolder === "") {
					expect(filePath.includes("/")).toBe(false);
				} else {
					expect(filePath.startsWith(`${expectedFolder}/`)).toBe(true);
					// 접두사 이후는 파일명 한 개 뿐이다(추가 슬래시 없음).
					const rest = filePath.slice(expectedFolder.length + 1);
					expect(rest.includes("/")).toBe(false);
				}
			}),
			{ numRuns: 150 },
		);
	});
});
