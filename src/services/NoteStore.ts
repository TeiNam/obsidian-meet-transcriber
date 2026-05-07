/**
 * `NoteStore` — Transcript_Note 파일 I/O 래퍼.
 *
 * Obsidian `Vault` API 위에 얇은 어댑터를 제공하여, 플러그인의 다른 계층
 * (`main.ts`, `SidebarView`, 버튼 핸들러)이 파일 경로 조립, 프론트매터 직렬화,
 * 동시 편집 안전성 등을 직접 다루지 않도록 한다.
 *
 * 설계 원칙:
 * - **모든 파일 수정은 `Vault.process(file, callback)`를 사용**한다(Requirements 9.9).
 *   `Vault.modify`는 동시 편집 충돌을 유발할 수 있으므로 사용하지 않는다.
 * - **사용자 입력 경로는 `normalizePath`로 정규화**한 뒤 Vault API에 전달한다
 *   (Requirements 9.8). 절대 경로나 `..` 경로 탐색이 Vault로 새어 나가지 않는다.
 * - **프론트매터는 Obsidian 관용 형식**(YAML 블록 `---` ... `---`)으로 직렬화하며,
 *   분석 결과 추가(`appendAnalysis`)와 편집 저장(`overwriteTranscript`)에서 값 변경 없이 보존한다
 *   (Requirements 4.6, 5.5, 6.9).
 * - `resolveUniqueFilename`은 **순수 함수**로 분리하여 PBT 대상으로 만든다
 *   (design.md Property 6).
 * - 로깅은 `console.error`만 사용한다(Requirements 9.6).
 *
 * ## 관련 요구사항
 * - Requirements 4.4 (파일명 충돌 회피 `-N` 접미사)
 * - Requirements 4.5 (폴더 부재 시 `createFolder` → 실패 시 루트 fallback + `Notice`)
 * - Requirements 4.6 (프론트매터 `startedAt`/`endedAt`/`language` ISO 8601)
 * - Requirements 4.7 (저장 후 Sidebar 본문 갱신 — 호출 측 책임)
 * - Requirements 4.8 (저장 I/O 오류 시 버퍼 유지 — 호출 측이 에러 처리)
 * - Requirements 5.5 (편집 저장은 `Vault.process` 사용)
 * - Requirements 6.8, 6.9, 6.10 (분석 결과 헤더 + 섹션 추가, 프론트매터/기존 본문 보존, 누적 허용)
 * - Requirements 9.8 (`normalizePath`)
 * - Requirements 9.9 (`Vault.process`)
 *
 * ## 관련 속성 (design.md)
 * - Property 6: 파일명 충돌 회피 규칙
 * - Property 7: 프론트매터 직렬화 보존
 * - Property 8: 편집 덮어쓰기 본문 보존
 * - Property 9: 분석 결과 부착 규칙
 * - Property 15: 경로 정규화 안전성
 */

import { Notice, TFile, TFolder, Vault, normalizePath } from "obsidian";

import type { SupportedLocale } from "../i18n";
import { createI18n } from "../i18n";
import type { LanguageCode } from "../types/settings";

/**
 * Transcript_Note 파일에 직렬화되는 메타데이터.
 *
 * 세 필드 모두 프론트매터의 단일 라인으로 기록된다.
 * `startedAt`/`endedAt`은 ISO 8601 문자열(로컬 타임존 오프셋 포함)이며,
 * 호출 측에서 이미 포맷팅된 값을 넘긴다는 것을 전제로 한다.
 *
 * Requirements 4.6.
 */
export interface TranscriptNoteMeta {
	/** 전사 시작 시각(ISO 8601, 예: `"2025-01-15T09:30:00+09:00"`). */
	startedAt: string;
	/** 전사 종료 시각(ISO 8601). */
	endedAt: string;
	/** 사용된 전사 언어 코드. `LanguageCode` 유니온으로 제한된다. */
	language: LanguageCode;
}

/**
 * 파일명 앞부분에 사용되는 접두어.
 *
 * 최종 파일명 형식: `<prefix>-YYYYMMDD-HHmmss.md`
 * 충돌 시: `<prefix>-YYYYMMDD-HHmmss-N.md` (N은 1부터 시작하는 정수).
 *
 * Requirements 4.4.
 */
const TRANSCRIPT_FILENAME_PREFIX = "Transcribe";

/** `.md` 확장자. 파일명 조립과 충돌 검사의 일관성 유지용 상수. */
const MARKDOWN_EXTENSION = ".md";

/** 프론트매터 블록의 경계 구분자. */
const FRONTMATTER_FENCE = "---";

/** 허용된 전사 언어 코드 집합. 런타임 검증에 사용한다(Property 7). */
const ALLOWED_LANGUAGE_CODES: readonly LanguageCode[] = ["ko-KR", "en-US"];

/**
 * Transcript_Note 파일의 I/O 래퍼.
 *
 * `Vault` 인스턴스만 주입받아 작성되어, 테스트 시 최소한의 목(mock) Vault로
 * 단위 테스트가 가능하다(`getRoot`, `getAbstractFileByPath`, `create`, `createFolder`,
 * `process`, `read` 정도만 목업하면 된다).
 */
export class NoteStore {
	/**
	 * @param vault - Obsidian `Vault` 인스턴스. `app.vault` 그대로 전달한다.
	 */
	constructor(private readonly vault: Vault) {}

	/**
	 * 파일명 충돌을 회피하여 최종 마크다운 파일명을 결정하는 **순수 함수**.
	 *
	 * 규칙(Requirements 4.4 / design.md Property 6):
	 * 1. `{base}.md`가 `existing`에 없으면 그대로 반환.
	 * 2. 존재하면 `{base}-1.md`, `{base}-2.md`, ... 순으로 검사하여 비어 있는 첫 N을 사용.
	 *
	 * 본 메서드는 `vault`에 접근하지 않는다. 호출 측이 후보 경로 집합을 `existing`으로 넘긴다.
	 *
	 * @param base - `.md` 확장자를 제외한 파일명 본체(예: `"Transcribe-20250115-093000"`).
	 * @param existing - 이미 존재하는 파일명(확장자 포함)의 Set.
	 * @returns 충돌하지 않는 최종 파일명(확장자 포함).
	 */
	resolveUniqueFilename(base: string, existing: Set<string>): string {
		const primary = `${base}${MARKDOWN_EXTENSION}`;
		if (!existing.has(primary)) {
			return primary;
		}
		let n = 1;
		// 상한은 두지 않는다. 현실적으로 동일 초(second) 내에 수만 건 충돌이 발생하는 시나리오는 없다.
		// 무한 루프 방지는 Set의 유한성으로 자연스럽게 보장된다.
		while (existing.has(`${base}-${n}${MARKDOWN_EXTENSION}`)) {
			n++;
		}
		return `${base}-${n}${MARKDOWN_EXTENSION}`;
	}

	/**
	 * 전사 폴더 경로를 정규화하고, 필요 시 폴더를 생성한다.
	 *
	 * 처리 흐름(Requirements 4.5, 9.8):
	 * 1. 입력이 빈 문자열이거나 `normalizePath` 결과가 `"/"`이면 vault 루트(`""`)를 반환한다.
	 * 2. 정규화된 경로에 이미 폴더가 존재하면 그 경로를 반환한다.
	 * 3. 존재하지 않으면 `Vault.createFolder`를 시도한다.
	 * 4. 생성 실패 시 vault 루트(`""`)를 반환하고 `Notice`로 fallback을 알린다.
	 *
	 * 동일 경로에 폴더가 아닌 파일이 존재하는 경우에도 루트로 fallback 한다.
	 *
	 * @param folder - 사용자가 설정에서 입력한 Transcript_Folder 경로(미정규화 가능).
	 * @param fallbackNoticeMessage - 선택적으로 전달하는 fallback 시 표시 메시지.
	 *   UI 계층이 i18n 번역 문자열을 넘길 수 있도록 주입 가능하며, 생략 시 영어 기본 문구를 사용한다.
	 * @returns 최종적으로 노트 저장에 사용할 폴더 경로(`""`이면 vault 루트).
	 */
	async ensureFolder(folder: string, fallbackNoticeMessage?: string): Promise<string> {
		// 빈 문자열은 vault 루트를 의미하므로 정규화 없이 바로 반환 (Requirements 2.10).
		if (folder === "") {
			return "";
		}

		// normalizePath는 절대 경로(`/foo`)를 상대 경로(`foo`)로, 경로 탐색(`..`)을 제거한다
		// (Requirements 9.8 / Property 15).
		const normalized = normalizePath(folder);

		// Obsidian은 vault 루트를 `"/"`로 표현할 때도 있어 방어적으로 처리한다.
		if (normalized === "" || normalized === "/") {
			return "";
		}

		// 이미 존재하고 폴더이면 그대로 사용.
		const existing = this.vault.getAbstractFileByPath(normalized);
		if (existing instanceof TFolder) {
			return normalized;
		}

		// 동일 경로에 파일이 점유하고 있는 경우: 폴더 생성이 불가능하므로 fallback.
		if (existing !== null) {
			this.notifyFolderFallback(fallbackNoticeMessage);
			return "";
		}

		// 폴더 부재 시 생성 시도. 실패 시 루트로 fallback (Requirements 4.5).
		try {
			await this.vault.createFolder(normalized);
			return normalized;
		} catch (err) {
			// 심사 기준상 로깅은 console.error만 허용된다 (Requirements 9.6).
			console.error("[Transcribe] Failed to create transcript folder:", err);
			this.notifyFolderFallback(fallbackNoticeMessage);
			return "";
		}
	}

	/**
	 * 전사 본문과 메타데이터를 Transcript_Note 파일로 저장한다.
	 *
	 * 수행 단계:
	 * 1. `meta.language`가 허용값인지 런타임 검증(Property 7의 불변식 보장).
	 * 2. `ensureFolder(folder)`로 저장 폴더 확정.
	 * 3. `now` 기준 로컬 시각으로 `Transcribe-YYYYMMDD-HHmmss` 기본명 생성.
	 * 4. 대상 폴더 내 기존 파일명과 충돌 검사 후 `resolveUniqueFilename` 적용(Requirements 4.4).
	 * 5. `normalizePath`로 최종 경로 정규화 후 프론트매터 + 본문을 단일 문자열로 조립.
	 * 6. `Vault.create`로 새 파일 생성.
	 *
	 * I/O 오류는 호출 측에서 처리할 수 있도록 그대로 throw 한다(Requirements 4.8).
	 *
	 * @param body - Final_Result 누적 본문 텍스트.
	 * @param meta - 프론트매터에 직렬화될 전사 메타데이터.
	 * @param folder - 사용자 설정상 Transcript_Folder 경로(미정규화 가능).
	 * @param now - 파일명 타임스탬프 기준 시각. 테스트 결정론성을 위해 주입 가능(기본값 `new Date()`).
	 * @param fallbackNoticeMessage - 폴더 생성 실패 시 표시할 i18n 메시지(선택).
	 * @returns 생성된 `TFile` 인스턴스.
	 */
	async saveTranscript(
		body: string,
		meta: TranscriptNoteMeta,
		folder: string,
		now: Date = new Date(),
		fallbackNoticeMessage?: string,
	): Promise<TFile> {
		// 허용된 language 값만 프론트매터에 직렬화되도록 런타임 방어선 추가 (Property 7).
		if (!ALLOWED_LANGUAGE_CODES.includes(meta.language)) {
			throw new Error(
				`Invalid transcript language code: ${meta.language}. Expected one of: ${ALLOWED_LANGUAGE_CODES.join(", ")}`,
			);
		}

		const resolvedFolder = await this.ensureFolder(folder, fallbackNoticeMessage);

		// 파일명 본체 생성 (Requirements 4.4 — `Transcribe-YYYYMMDD-HHmmss`).
		const base = `${TRANSCRIPT_FILENAME_PREFIX}-${formatLocalTimestamp(now)}`;

		// 충돌 검사용 기존 파일명 집합을 수집.
		const existing = this.collectExistingFilenames(resolvedFolder);
		const filename = this.resolveUniqueFilename(base, existing);

		// 최종 경로 조립 후 다시 정규화(Requirements 9.8 / Property 15).
		const fullPath = normalizePath(
			resolvedFolder === "" ? filename : `${resolvedFolder}/${filename}`,
		);

		const content = serializeFrontmatter(meta) + body;
		return this.vault.create(fullPath, content);
	}

	/**
	 * 편집된 본문으로 Transcript_Note를 덮어쓴다.
	 *
	 * `Vault.process`를 사용하여 동시 편집 충돌을 방지하며, 기존 프론트매터는 원본 문자열
	 * 그대로 보존한다(Requirements 5.5, 9.9 / Property 8).
	 *
	 * 프론트매터가 없는 파일에 대해서는 본문만 교체한다.
	 *
	 * @param file - 대상 마크다운 파일.
	 * @param newBody - 새 본문 텍스트. 프론트매터를 포함하지 않는다.
	 */
	async overwriteTranscript(file: TFile, newBody: string): Promise<void> {
		await this.vault.process(file, (content) => {
			const frontmatter = extractFrontmatterBlock(content);
			return frontmatter + newBody;
		});
	}

	/**
	 * 분석 결과를 Transcript_Note 본문 끝에 새 섹션으로 추가한다.
	 *
	 * `Vault.process`를 사용하여 기존 콘텐츠를 100% 보존하면서 뒤에 이어 붙인다
	 * (Requirements 6.8, 6.9, 6.10 / Property 9).
	 *
	 * 추가 포맷:
	 * ```
	 * <기존 내용>
	 *
	 * ## Analysis result  (또는 "## 분석 결과")
	 *
	 * <analysis>
	 * ```
	 *
	 * 기존 본문에 이미 분석 결과 섹션이 있더라도 **제거하지 않고** 새 섹션을 추가한다
	 * (Requirements 6.10 / Property 9).
	 *
	 * @param file - 대상 마크다운 파일.
	 * @param analysis - Bedrock이 반환한 분석 결과 본문.
	 * @param locale - UI 로케일. 헤더 문자열 선택에 사용(`"## Analysis result"` vs `"## 분석 결과"`).
	 */
	async appendAnalysis(file: TFile, analysis: string, locale: SupportedLocale): Promise<void> {
		const header = createI18n(locale).analysisHeader;
		await this.vault.process(file, (content) => {
			// 기존 내용이 줄바꿈으로 끝나지 않을 수도 있으므로 경계 라인을 보정한다.
			const separator = content.endsWith("\n") ? "\n" : "\n\n";
			return `${content}${separator}${header}\n\n${analysis}\n`;
		});
	}

	/**
	 * 프론트매터를 제외한 Transcript_Note의 본문만 읽어 반환한다.
	 *
	 * Sidebar_View의 텍스트 영역 로드, 편집 모드 초기값 주입, 분석 요청 본문 구성 등에서 사용한다.
	 * 읽기 중 I/O 오류는 호출 측에서 처리하도록 그대로 전파한다.
	 *
	 * @param file - 대상 마크다운 파일.
	 * @returns 프론트매터를 제외한 본문 문자열. 프론트매터가 없으면 전체 내용 반환.
	 */
	async readTranscriptBody(file: TFile): Promise<string> {
		const raw = await this.vault.read(file);
		return stripFrontmatter(raw);
	}

	/**
	 * 지정 폴더 바로 아래의 마크다운 파일명 집합을 수집한다(확장자 포함).
	 *
	 * `resolveUniqueFilename`에 넘길 `existing` 인자를 구축하기 위한 내부 헬퍼.
	 * 하위 폴더의 파일은 포함하지 않으며, 폴더 이름은 제외한다.
	 *
	 * @param folderPath - 검사 대상 폴더 경로. 빈 문자열이면 vault 루트.
	 */
	private collectExistingFilenames(folderPath: string): Set<string> {
		const folder: TFolder =
			folderPath === ""
				? this.vault.getRoot()
				: (() => {
						const abs = this.vault.getAbstractFileByPath(folderPath);
						return abs instanceof TFolder ? abs : this.vault.getRoot();
					})();

		const names = new Set<string>();
		for (const child of folder.children) {
			if (child instanceof TFile) {
				names.add(child.name);
			}
		}
		return names;
	}

	/**
	 * 폴더 생성 실패 시 사용자에게 루트 fallback을 알리는 `Notice`를 표시한다.
	 *
	 * i18n 메시지가 주입되지 않은 경우 영어 기본 문구로 대체하여, 테스트 및 초기화 시점에도
	 * 안전하게 호출 가능하도록 한다.
	 */
	private notifyFolderFallback(message?: string): void {
		// 호출 측이 번역된 문구를 제공하는 것이 원칙이나, 방어적으로 영어 기본값을 둔다.
		new Notice(
			message ?? "Could not create the transcript folder. Saving to the vault root instead.",
		);
	}
}

// -----------------------------------------------------------------------------
// Pure helper functions
// -----------------------------------------------------------------------------

/**
 * 로컬 타임존 기준의 `YYYYMMDD-HHmmss` 타임스탬프 문자열을 생성한다.
 *
 * Requirements 4.4에 명시된 `Transcribe-YYYYMMDD-HHmmss.md` 파일명 포맷의 시각 부분이다.
 * `Date.toISOString`은 UTC를 반환하므로 사용하지 않는다.
 *
 * @param date - 기준 시각(로컬 시각으로 해석된다).
 * @returns 예: `"20250115-093000"`.
 */
function formatLocalTimestamp(date: Date): string {
	const year = date.getFullYear().toString().padStart(4, "0");
	const month = (date.getMonth() + 1).toString().padStart(2, "0");
	const day = date.getDate().toString().padStart(2, "0");
	const hour = date.getHours().toString().padStart(2, "0");
	const minute = date.getMinutes().toString().padStart(2, "0");
	const second = date.getSeconds().toString().padStart(2, "0");
	return `${year}${month}${day}-${hour}${minute}${second}`;
}

/**
 * 프론트매터 블록 문자열을 직렬화한다.
 *
 * Requirements 4.6에 명시된 3개 필드(`startedAt`, `endedAt`, `language`)를
 * Obsidian 관용 포맷으로 작성한다. 값에 YAML 특수 문자가 포함될 가능성을 고려해
 * 기본적으로 큰따옴표로 래핑하고 내부 큰따옴표/백슬래시를 이스케이프한다.
 *
 * 반환값은 `---\n...\n---\n\n` 형태이며, 본문 문자열 앞에 바로 concat 할 수 있다.
 */
function serializeFrontmatter(meta: TranscriptNoteMeta): string {
	const lines = [
		FRONTMATTER_FENCE,
		`startedAt: ${quoteYamlString(meta.startedAt)}`,
		`endedAt: ${quoteYamlString(meta.endedAt)}`,
		`language: ${quoteYamlString(meta.language)}`,
		FRONTMATTER_FENCE,
		"",
	];
	return `${lines.join("\n")}\n`;
}

/**
 * YAML 플레인 스칼라에서 문제가 될 수 있는 문자를 피하기 위해
 * 문자열을 큰따옴표로 감싸고 내부 큰따옴표/백슬래시를 이스케이프한다.
 */
function quoteYamlString(value: string): string {
	const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
	return `"${escaped}"`;
}

/**
 * 파일 내용에서 선행 프론트매터 블록만 문자열 그대로 추출한다.
 *
 * 블록이 없거나 파일이 프론트매터로 시작하지 않으면 빈 문자열을 반환한다.
 * 반환값은 뒤따르는 줄바꿈을 포함하여, 본문 문자열과 바로 concat 가능하도록 한다.
 */
function extractFrontmatterBlock(content: string): string {
	if (
		!content.startsWith(`${FRONTMATTER_FENCE}\n`) &&
		!content.startsWith(`${FRONTMATTER_FENCE}\r\n`)
	) {
		return "";
	}

	// 두 번째 `---` 경계선 검색. 프론트매터는 파일 시작 이후 단일 YAML 블록으로만 허용된다.
	const boundary = findFrontmatterBoundary(content);
	if (boundary === -1) {
		return "";
	}

	// boundary는 두 번째 `---` 라인이 끝나는 바로 다음 위치(줄바꿈 포함)를 가리킨다.
	return content.slice(0, boundary);
}

/**
 * 프론트매터를 제외한 본문만 반환한다. 프론트매터가 없으면 원본을 그대로 반환한다.
 */
function stripFrontmatter(content: string): string {
	const front = extractFrontmatterBlock(content);
	return front === "" ? content : content.slice(front.length);
}

/**
 * 프론트매터 종료 경계(`---` 라인 뒤 줄바꿈 포함)의 인덱스를 찾는다.
 *
 * @returns 종료 라인 직후 위치(포함하지 않는 끝 인덱스). 경계가 없으면 `-1`.
 */
function findFrontmatterBoundary(content: string): number {
	// 첫 번째 `---` 다음부터 검색 시작.
	const firstFenceLength = content.startsWith(`${FRONTMATTER_FENCE}\r\n`)
		? `${FRONTMATTER_FENCE}\r\n`.length
		: `${FRONTMATTER_FENCE}\n`.length;

	const searchFrom = firstFenceLength;
	// 줄 단위로 검사하여 정확히 `---`만 있는 라인을 찾는다.
	let cursor = searchFrom;
	while (cursor < content.length) {
		const newlineIdx = content.indexOf("\n", cursor);
		const lineEnd = newlineIdx === -1 ? content.length : newlineIdx;
		// `\r\n` 개행을 허용하기 위해 trim 하지 않고 정확 비교한다.
		const line = content.slice(cursor, lineEnd).replace(/\r$/, "");
		if (line === FRONTMATTER_FENCE) {
			// 라인 끝 이후(줄바꿈 포함) 위치를 반환. 줄바꿈이 없으면 파일 끝.
			return newlineIdx === -1 ? content.length : newlineIdx + 1;
		}
		if (newlineIdx === -1) {
			return -1;
		}
		cursor = newlineIdx + 1;
	}
	return -1;
}
