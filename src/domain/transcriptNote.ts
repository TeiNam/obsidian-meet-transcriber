/**
 * Transcript_Note 본문 양식 모델 (순수 함수).
 *
 * 노트 본문을 다음 고정 양식으로 조립/파싱한다:
 *
 * ```
 * ## 분석 결과                  ← 분석 (있을 때만, 항상 맨 위, 평문 헤더 — 박스 없음)
 * ...
 *
 * > [!quote]- 원본              ← 원본 전사 (접힘)
 * > ...
 *
 * > [!tip]- 교정본              ← AI 교정본 (교정 켜졌을 때만, 접힘)
 * > ...
 * ```
 *
 * ## 식별 전략
 * 원본/교정본 섹션은 콜아웃 **타입**(`quote`/`tip`)으로 식별한다. 제목 문자열은
 * 로케일에 따라 다르므로(원본/Original) 파싱 기준으로 쓰지 않는다.
 * 분석 섹션은 박스(콜아웃) 없이 평문이며, "본문 맨 위 ~ 첫 콜아웃 직전" 영역으로 본다.
 *
 * 본 모듈은 외부 I/O / SDK 의존성이 없어 단위 테스트가 쉽다.
 */

/** 원본 전사 콜아웃 타입. */
export const CALLOUT_ORIGINAL = "quote";
/** AI 교정본 콜아웃 타입. */
export const CALLOUT_REFINED = "tip";

/** 콜아웃 섹션 제목(로케일별 표시 문자열). */
export interface CalloutTitles {
	analysis: string;
	original: string;
	refined: string;
}

/**
 * 본문을 Obsidian 콜아웃으로 감싼다.
 *
 * 각 줄 앞에 `> ` 를 붙이고, 빈 줄은 `>` 로 이어 콜아웃이 중간에 끊기지 않게 한다.
 *
 * @param type   콜아웃 타입(`quote`/`tip`).
 * @param title  콜아웃 제목(표시용).
 * @param folded 기본 접힘 여부(`true` → 제목 뒤 `-`).
 * @param body   감쌀 본문.
 */
export function wrapInCallout(
	type: string,
	title: string,
	folded: boolean,
	body: string,
): string {
	const foldMark = folded ? "-" : "";
	const header = `> [!${type}]${foldMark} ${title}`;
	const lines = body.split("\n").map((l) => (l.length > 0 ? `> ${l}` : ">"));
	return [header, ...lines].join("\n");
}

/**
 * 저장용 본문을 조립한다(분석 없음): 원본 콜아웃 + (교정본 콜아웃).
 *
 * @param params.original 원본 전사 본문.
 * @param params.refined  교정본(교정 비활성/실패 시 `null`).
 * @param params.titles   섹션 제목.
 */
export function buildTranscriptNoteBody(params: {
	original: string;
	refined: string | null;
	titles: CalloutTitles;
}): string {
	const { original, refined, titles } = params;
	const blocks: string[] = [
		wrapInCallout(CALLOUT_ORIGINAL, titles.original, true, original.trimEnd()),
	];
	if (refined !== null && refined.trim().length > 0) {
		blocks.push(
			wrapInCallout(CALLOUT_REFINED, titles.refined, true, refined.trimEnd()),
		);
	}
	return blocks.join("\n\n");
}

/**
 * 지정 타입 콜아웃 블록의 라인 범위 `[start, end)` 를 찾는다. 없으면 `null`.
 *
 * 블록은 `> [!type]` 헤더 줄에서 시작해 연속된 `>` 줄까지로 본다.
 */
function findCalloutRange(
	lines: string[],
	type: string,
): { start: number; end: number } | null {
	const headerRe = new RegExp(`^>\\s*\\[!${type}\\]`, "i");
	let start = -1;
	for (let i = 0; i < lines.length; i++) {
		if (headerRe.test(lines[i])) {
			start = i;
			break;
		}
	}
	if (start === -1) return null;
	let end = start + 1;
	while (end < lines.length && /^>/.test(lines[end])) {
		end += 1;
	}
	return { start, end };
}

/**
 * 지정 타입 콜아웃의 내부 본문 텍스트를 추출한다(`> ` prefix 제거). 없으면 `null`.
 */
export function extractCalloutBody(noteBody: string, type: string): string | null {
	const lines = noteBody.split("\n");
	const range = findCalloutRange(lines, type);
	if (!range) return null;
	const bodyLines = lines
		.slice(range.start + 1, range.end)
		.map((l) => l.replace(/^>\s?/, ""));
	return bodyLines.join("\n").replace(/^\n+|\n+$/g, "");
}

/**
 * 분석 입력으로 쓸 전사 텍스트를 추출한다.
 *
 * 우선순위: 교정본(tip) → 원본(quote) → 콜아웃이 없는 레거시 노트면 본문 전체.
 * 교정본이 더 정확하므로 분석 품질을 위해 우선한다.
 */
export function extractAnalysisSource(noteBody: string): string {
	const refined = extractCalloutBody(noteBody, CALLOUT_REFINED);
	if (refined !== null && refined.trim().length > 0) return refined;
	const original = extractCalloutBody(noteBody, CALLOUT_ORIGINAL);
	if (original !== null && original.trim().length > 0) return original;
	return noteBody.trim();
}

/**
 * 분석 결과를 본문 맨 위에 일반 마크다운 섹션(`## 제목` + 본문)으로 삽입한다.
 *
 * 분석은 콜아웃(박스)으로 감싸지 않는다 — 가독성을 위해 평문 헤더 + 본문으로 둔다.
 * 기존 분석 섹션(맨 위 ~ 첫 콜아웃 직전)이 있으면 제거 후 새 결과로 교체한다(최신만 유지).
 * 원본/교정본 콜아웃은 그대로 보존된다.
 *
 * @param noteBody 현재 노트 본문.
 * @param analysis 새 분석 결과 본문.
 * @param title    분석 섹션 제목(`## ` 없이 텍스트만).
 */
export function upsertAnalysisCallout(
	noteBody: string,
	analysis: string,
	title: string,
): string {
	const lines = noteBody.split("\n");

	// 본문에서 첫 콜아웃(`> [!...]`) 시작 줄을 찾는다. 그 앞쪽이 기존 분석 섹션 영역이다.
	let firstCalloutIdx = lines.findIndex((l) => /^>\s*\[!/.test(l));
	if (firstCalloutIdx === -1) {
		// 콜아웃이 전혀 없으면(레거시/비정상) 전체를 전사 본문으로 보고 분석만 위에 얹는다.
		firstCalloutIdx = lines.length;
	}

	// 첫 콜아웃 이후(원본/교정본)는 그대로 보존한다.
	const calloutsAndRest = lines
		.slice(firstCalloutIdx)
		.join("\n")
		.replace(/^\n+/, "");

	const analysisBlock = `## ${title}\n\n${analysis.trim()}`;
	return calloutsAndRest.length > 0
		? `${analysisBlock}\n\n${calloutsAndRest}`
		: `${analysisBlock}\n`;
}

/**
 * 이어하기 세션 결과를 기존 노트에 병합한다.
 *
 * 콜아웃을 새로 추가하지 않고, 기존 원본/교정본 콜아웃 **안쪽**에 세션 구분선과
 * 새 세션 본문을 이어 붙여 콜아웃이 각각 1개로 유지되게 한다.
 *
 * 기존 노트에 콜아웃이 없으면(레거시) 전체를 원본으로 간주해 새 콜아웃 양식으로
 * 재구성한다.
 *
 * @param params.existingBody 기존 노트 본문.
 * @param params.newOriginal  이번 세션의 원본 전사.
 * @param params.newRefined   이번 세션의 교정본(없으면 `null`).
 * @param params.divider      세션 구분선 텍스트.
 * @param params.titles       콜아웃 제목.
 */
export function mergeContinuedSession(params: {
	existingBody: string;
	newOriginal: string;
	newRefined: string | null;
	divider: string;
	titles: CalloutTitles;
}): string {
	const { existingBody, newOriginal, newRefined, divider, titles } = params;

	const prevOriginal = extractCalloutBody(existingBody, CALLOUT_ORIGINAL);
	const prevRefined = extractCalloutBody(existingBody, CALLOUT_REFINED);

	// 레거시(콜아웃 없음): 기존 본문 전체를 이전 원본으로 간주.
	const baseOriginal = prevOriginal ?? existingBody.trim();

	const mergedOriginal = `${baseOriginal.trimEnd()}\n\n${divider}\n\n${newOriginal.trimEnd()}`;

	let mergedRefined: string | null = null;
	if (newRefined !== null && newRefined.trim().length > 0) {
		mergedRefined =
			prevRefined !== null && prevRefined.trim().length > 0
				? `${prevRefined.trimEnd()}\n\n${divider}\n\n${newRefined.trimEnd()}`
				: newRefined.trimEnd();
	} else if (prevRefined !== null && prevRefined.trim().length > 0) {
		// 이번 세션엔 교정본이 없지만 기존 교정본은 보존한다.
		mergedRefined = prevRefined.trimEnd();
	}

	return buildTranscriptNoteBody({
		original: mergedOriginal,
		refined: mergedRefined,
		titles,
	});
}
