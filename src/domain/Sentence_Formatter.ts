/**
 * `Sentence_Formatter` — `Transcript_Segment` 시퀀스를 문장 단위로 직렬화/역직렬화하는
 * 외부 I/O 가 없는 순수 함수 모듈 (design §Sentence_Formatter, Requirement 12.1).
 *
 * 본 파일은 점진적으로 확장되며, 태스크 7 에서 `formatTimestamp`, 태스크 8 에서
 * `splitIntoSentences` 가 추가되었다. 후속 태스크(9) 에서 `format` / `parse` 가 추가된다.
 */

/**
 * 문장 종결 부호 정규식 (design §Sentence_Formatter 의사코드).
 *
 * 캡처 그룹 형태로 정의되어 `String.prototype.split` 호출 시 종결 부호 자체가
 * 결과 배열의 별도 토큰으로 보존된다. 이 보존 동작은 `splitIntoSentences` 의 종결 부호
 * 보존 불변식(Property 7)을 직접 만족시킨다.
 *
 * 매칭 대상: `.`, `!`, `?`, `。` (한국어/일본어/중국어 마침표).
 */
const SENTENCE_TERMINATORS = /([.!?。])/;

/**
 * 단일 `Sentence_Segment` 의 `startSeconds` 를 표시용 `Timestamp_String` 으로 변환한다.
 *
 * 규칙 (Requirement 5.4, design §타임스탬프 포맷터):
 * - 음수 입력은 `Math.max(0, ...)` 로 0 으로 클램프한다.
 * - `total < 3600` (1 시간 미만) → `[mm:ss]` 형식. mm/ss 는 각각 2 자리 0 패딩.
 *   예: `[00:00]`, `[00:12]`, `[59:59]`.
 * - `total >= 3600` (1 시간 이상) → `[hh:mm:ss]` 형식. hh 는 자릿수 무제한 (0 패딩 없음),
 *   mm/ss 는 각각 2 자리 0 패딩.
 *   예: `[1:00:00]`, `[12:34:56]`, `[100:00:00]`.
 *
 * 본 함수는 외부 I/O 에 의존하지 않으며 (Requirement 7.5), 동일 입력에 대해 항상 동일한
 * 결과를 반환한다 (결정성). 결과는 항상 정규식 `^\[(\d+:)?\d{2}:\d{2}\]$` 와 매치한다.
 *
 * @param startSeconds 세션 시작 후 경과 초. 음수면 0 으로 클램프된다.
 * @returns 대괄호로 감싼 타임스탬프 문자열.
 */
export function formatTimestamp(startSeconds: number): string {
	const total = Math.max(0, Math.floor(startSeconds));
	const ss = String(total % 60).padStart(2, "0");
	const mm = String(Math.floor(total / 60) % 60).padStart(2, "0");
	if (total < 3600) {
		return `[${mm}:${ss}]`;
	}
	const hh = String(Math.floor(total / 3600));
	return `[${hh}:${mm}:${ss}]`;
}

/**
 * 입력 텍스트를 문장 종결 부호(`.`, `!`, `?`, `。`) 기준으로 분할한다
 * (design §Sentence_Formatter 의사코드, Requirement 5.2, 5.3).
 *
 * 동작 규칙:
 * - 빈 입력 또는 공백 전용 입력은 빈 배열 `[]` 을 반환한다.
 * - 종결 부호는 `SENTENCE_TERMINATORS` 캡처 그룹에 의해 분할 결과에 보존되어,
 *   각 문장의 끝에 그대로 붙어 출력된다.
 * - 출력 배열의 모든 원소는 `trim()` 된 비공백 문자열임이 보장된다.
 * - 종결 부호 없이 끝나는 마지막 텍스트(tail) 는 별도 문장으로 보존된다.
 *
 * 본 함수는 외부 I/O 에 의존하지 않으며 (Requirement 7.5, 12.1), 동일 입력에 대해
 * 항상 동일한 결과를 반환한다 (결정성, Property 7).
 *
 * @param text 분할 대상 원본 문자열.
 * @returns 종결 부호가 보존된 문장 배열. 비공백 원소만 포함.
 */
export function splitIntoSentences(text: string): string[] {
	if (text.trim().length === 0) return [];
	// 캡처 그룹 정규식으로 split 하면 종결 부호 자체가 결과 배열에 별도 토큰으로 포함된다.
	const tokens = text.split(SENTENCE_TERMINATORS);
	const sentences: string[] = [];
	let buf = "";
	for (const token of tokens) {
		// 종결 부호 토큰은 정확히 1글자이며 SENTENCE_TERMINATORS 와 매치한다.
		if (SENTENCE_TERMINATORS.test(token) && token.length === 1) {
			const sentence = (buf + token).trim();
			if (sentence.length > 0) sentences.push(sentence);
			buf = "";
		} else {
			buf += token;
		}
	}
	// 종결 부호 없이 끝나는 꼬리(tail) 문자열도 비공백이면 마지막 문장으로 보존한다.
	const tail = buf.trim();
	if (tail.length > 0) sentences.push(tail);
	return sentences;
}

import type {
	Sentence_Segment,
	Transcript_Segment,
	Translated_Segment,
} from "./segments";
import type { Translation_Output_Format } from "../types/settings";

/**
 * `format` 함수의 옵션. design §Sentence_Formatter `FormatOptions` 와 1:1 일치.
 *
 * - `speakerDiarizationEnabled`: `true` 이고 segment 에 `speakerLabel` 이 존재하면
 *   라인 prefix 가 `"[mm:ss] Speaker N: text"` 형태가 된다 (Requirement 5.5).
 * - `timestampOutputEnabled`: `false` 면 v1.0 통짜 본문 분기로 `segments.map(s => s.text).join(" ")`
 *   + 단일 trailing newline 을 반환한다 (Requirement 5.1, 8.2).
 * - `translationOutputFormat`: `"inline"` 이고 segment 가 `Translated_Segment` 이며
 *   `translatedText` 가 정의되어 있으면 라인 바로 아래 두 칸 들여쓴 `"  → translated"`
 *   라인을 추가한다 (Requirement 13.7).
 */
export interface FormatOptions {
	readonly speakerDiarizationEnabled: boolean;
	readonly timestampOutputEnabled: boolean;
	readonly translationOutputFormat: Translation_Output_Format;
}

/**
 * `parse` 가 사용하는 라인 정규식.
 *
 * 캡처 그룹:
 * 1. `(\d+):` (옵션) — 시 부분. `[hh:mm:ss]` 형식의 hh.
 * 2. `(\d{2})` — 분.
 * 3. `(\d{2})` — 초.
 * 4. `(Speaker \d+)` (옵션) — 화자 라벨.
 * 5. `(.*)` — 본문 텍스트.
 *
 * 분/초 위치는 정확히 2 자리이며, 60 이상 값은 본 정규식 차원에서는 통과시키되
 * `parse` 가 후처리에서 거부 + `console.error` 로 기록한다 (Requirement 7.4).
 */
const TIMESTAMP_LINE_REGEX =
	/^\[(?:(\d+):)?(\d{2}):(\d{2})\]\s*(?:(Speaker \d+):\s*)?(.*)$/;

/**
 * 번역 inline 라인 prefix. `format` 이 두 칸 들여쓴 `"  → "` 를 사용하므로
 * `parse` 는 동일 prefix 를 가진 라인을 그대로 무시한다 (Requirement 13.7, design 라운드트립 절).
 */
const TRANSLATION_LINE_PREFIX = "  → ";

/**
 * `Transcript_Segment` 또는 `Translated_Segment` 시퀀스를 단일 문자열로 직렬화한다
 * (design §Sentence_Formatter `format` 의사코드 + Requirement 5.1, 5.5, 5.6, 5.10, 13.7).
 *
 * 동작 분기:
 * - `options.timestampOutputEnabled === false`:
 *   v1.0 호환 통짜 본문 (`segments.map(s => s.text).join(" ")`). 결과가 trim 후
 *   비공백이면 단일 trailing newline 을 부착하고, 그렇지 않으면 빈 문자열을 반환한다
 *   (Requirement 5.7, 8.2).
 * - `options.timestampOutputEnabled === true`:
 *   각 segment 를 `splitIntoSentences` 로 분할 후 라인별로 직렬화한다.
 *   - 형식: `"[mm:ss] text"` 또는 1 시간 이상은 `"[hh:mm:ss] text"` (Requirement 5.4).
 *   - `options.speakerDiarizationEnabled === true` 이고 segment 에 `speakerLabel` 이
 *     존재하면 형식이 `"[mm:ss] Speaker N: text"` 가 된다 (Requirement 5.5).
 *   - `seg.startSeconds < prevStart` (단조 증가 위반) 인 segment 는 출력에서
 *     제외하고 `console.error` 로 기록한다 (Requirement 5.10).
 *   - `options.translationOutputFormat === "inline"` 이고 segment 가
 *     `Translated_Segment` 이며 `translatedText` 가 정의되면, 매 sentence 라인
 *     바로 아래에 `"  → translated"` 두 번째 라인을 추가한다 (Requirement 13.7).
 *   - 최종 결과는 라인을 `"\n"` 으로 join 후 단일 trailing newline 부착.
 *     입력이 모두 공백이거나 빈 배열인 경우 빈 문자열 반환 (Requirement 5.7).
 *
 * 본 함수는 외부 I/O 에 의존하지 않으며 (Requirement 7.5, 12.1), 동일 입력에 대해
 * 항상 동일 출력을 반환한다 (결정성, Property 8).
 */
export function format(
	segments: ReadonlyArray<Transcript_Segment | Translated_Segment>,
	options: FormatOptions,
): string {
	if (!options.timestampOutputEnabled) {
		// v1.0 통짜 본문 호환 분기 (Requirement 5.1 후반부, 8.2).
		// 모든 text 가 공백이면 빈 문자열을 반환해 Requirement 5.7 을 만족한다.
		const joined = segments.map((s) => s.text).join(" ");
		return joined.trim().length > 0 ? `${joined}\n` : "";
	}

	const lines: string[] = [];
	let prevStart = -Infinity;

	for (const seg of segments) {
		// 단조 증가 위반 방어 (Requirement 5.10).
		if (seg.startSeconds < prevStart) {
			console.error(
				"[Sentence_Formatter] non-monotonic segment dropped",
				seg.segmentId,
			);
			continue;
		}
		prevStart = seg.startSeconds;

		const sentences = splitIntoSentences(seg.text);
		for (const sentence of sentences) {
			const ts = formatTimestamp(seg.startSeconds);
			const speakerPrefix =
				options.speakerDiarizationEnabled && seg.speakerLabel
					? `${seg.speakerLabel}: `
					: "";
			lines.push(`${ts} ${speakerPrefix}${sentence}`);

			// `Translated_Segment` 의 inline 직렬화 (Requirement 13.7).
			// `Transcript_Segment` 만 들어오는 경우 `translatedText` 키가 부재하므로 분기를 건너뛴다.
			if (
				options.translationOutputFormat === "inline" &&
				"translatedText" in seg &&
				(seg as Translated_Segment).translatedText !== undefined
			) {
				lines.push(
					`${TRANSLATION_LINE_PREFIX}${(seg as Translated_Segment).translatedText}`,
				);
			}
		}
	}

	return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

/**
 * `format` 으로 직렬화된 문자열을 다시 `Sentence_Segment[]` 로 복원한다
 * (design §Sentence_Formatter `parse` 의사코드 + Requirement 7.1, 7.3, 7.4).
 *
 * 라인별 동작:
 * - 빈 라인은 무시한다.
 * - 두 칸 들여쓴 번역 라인 (`"  → ..."`) 은 무시한다 (라운드트립 비교에서 제외).
 * - `TIMESTAMP_LINE_REGEX` 에 매치되지 않는 라인은 직전 `startSeconds` 를 부여하고
 *   본문 텍스트만 보존한다 (Requirement 7.3).
 * - 매치되더라도 분 또는 초가 60 이상이면 해당 라인을 무시하고 `console.error` 로
 *   기록한다 (Requirement 7.4).
 * - 매치된 라인은 `(hh, mm, ss)` 를 초 단위로 환산해 `startSeconds` 를 부여하고,
 *   화자 라벨이 캡처되면 `speakerLabel` 에 부여한다.
 *
 * `endSeconds` 는 `format` 단계에서 직렬화되지 않으므로 라운드트립 비교에서
 * 제외되며, 본 함수는 편의상 `endSeconds = startSeconds` 로 둔다.
 *
 * 본 함수는 외부 I/O 에 의존하지 않으며 (Requirement 7.5), 동일 입력에 대해
 * 항상 동일 결과를 반환한다 (결정성, Property 5/8 의 한 축).
 */
export function parse(text: string): Sentence_Segment[] {
	const out: Sentence_Segment[] = [];
	let prevStart = 0;

	for (const rawLine of text.split("\n")) {
		// `format` 이 단일 trailing newline 을 부착하므로 마지막 빈 라인이 발생한다.
		// 줄바꿈 문자만 제거하고 들여쓰기 두 칸은 그대로 두어 번역 라인 검출이 가능하게 한다.
		const line = rawLine.replace(/[\r\n]+$/u, "");
		if (line.length === 0) continue;
		// 번역 라인은 라운드트립 비교 대상이 아니므로 무시한다 (Requirement 13.7, 7.2).
		if (line.startsWith(TRANSLATION_LINE_PREFIX)) continue;

		const m = line.match(TIMESTAMP_LINE_REGEX);
		if (!m) {
			// 타임스탬프 없는 라인 (Requirement 7.3).
			out.push({
				startSeconds: prevStart,
				endSeconds: prevStart,
				text: line,
			});
			continue;
		}

		const hh = m[1] !== undefined ? Number(m[1]) : 0;
		const mm = Number(m[2]);
		const ss = Number(m[3]);

		// 분/초 60 이상은 무효 (Requirement 7.4).
		if (mm >= 60 || ss >= 60) {
			console.error(
				"[Sentence_Formatter] invalid timestamp dropped",
				line,
			);
			continue;
		}

		const startSeconds = hh * 3600 + mm * 60 + ss;
		prevStart = startSeconds;
		const speakerLabel = m[4];
		const body = m[5] ?? "";

		out.push({
			startSeconds,
			endSeconds: startSeconds, // 라운드트립 비교 대상에서 제외 (design §라운드트립 속성).
			text: body,
			speakerLabel: speakerLabel ?? undefined,
		});
	}

	return out;
}
