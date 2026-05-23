/**
 * `Sentence_Formatter` 속성 테스트 (Property-Based Tests).
 *
 * 본 파일은 `design.md` 의 다음 정확성 속성(Correctness Property) 을 검증한다.
 *
 * - Property 6: 타임스탬프 형식 불변식 (Validates Requirements 5.4)
 *
 * 후속 태스크(8, 9) 에서 `splitIntoSentences`, `format`, `parse` 에 대한 Property 5/7/8 이
 * 본 파일에 점진적으로 추가된다. 이 태스크에서는 `formatTimestamp` 만 다룬다.
 *
 * `fast-check` 3.x API 를 사용하며, 각 `fc.assert` 는 `numRuns: 200` 으로 충분한 샘플을 확보한다.
 */

import { describe, test, expect } from "vitest";
import fc from "fast-check";
import { formatTimestamp, splitIntoSentences } from "./Sentence_Formatter";

/**
 * Property 6 가 요구하는 형식 불변식 정규식.
 *
 * 형태:
 *   - `[mm:ss]`     (시 부분 없음, 분/초는 정확히 2자리)
 *   - `[h+:mm:ss]`  (시 부분 1자리 이상, 분/초는 정확히 2자리)
 */
const TIMESTAMP_FORMAT_REGEX = /^\[(\d+:)?\d{2}:\d{2}\]$/;

describe("Sentence_Formatter — Property 6: 타임스탬프 형식 불변식", () => {
	test("임의의 startSeconds >= 0 에 대해 결과가 형식 정규식과 매치한다 (Validates Requirements 5.4)", () => {
		fc.assert(
			fc.property(
				// 0 이상의 임의 실수 (소수점/큰 값 포함). NaN/Infinity 는 도메인 외이므로 제외.
				fc.double({
					min: 0,
					max: 100_000_000, // 충분히 큰 상한 (약 3년 이상의 초 단위)
					noNaN: true,
					noDefaultInfinity: true,
				}),
				(startSeconds) => {
					const result = formatTimestamp(startSeconds);
					expect(result).toMatch(TIMESTAMP_FORMAT_REGEX);
				},
			),
			{ numRuns: 200 },
		);
	});

	test("startSeconds < 3600 이면 결과는 [mm:ss] 형식 (Validates Requirements 5.4)", () => {
		fc.assert(
			fc.property(
				fc.double({
					min: 0,
					max: 3599.9999,
					noNaN: true,
					noDefaultInfinity: true,
				}),
				(startSeconds) => {
					const result = formatTimestamp(startSeconds);
					// 시 부분이 없는 [mm:ss] 형식이어야 한다. 콜론은 정확히 1개.
					expect(result).toMatch(/^\[\d{2}:\d{2}\]$/);
				},
			),
			{ numRuns: 200 },
		);
	});

	test("startSeconds >= 3600 이면 결과는 [hh:mm:ss] 형식이며 hh 는 자릿수 무제한 (Validates Requirements 5.4)", () => {
		fc.assert(
			fc.property(
				fc.double({
					min: 3600,
					max: 100_000_000,
					noNaN: true,
					noDefaultInfinity: true,
				}),
				(startSeconds) => {
					const result = formatTimestamp(startSeconds);
					// 시 부분이 있는 [hh:mm:ss] 형식. mm/ss 는 정확히 2자리, hh 는 1자리 이상.
					expect(result).toMatch(/^\[\d+:\d{2}:\d{2}\]$/);
				},
			),
			{ numRuns: 200 },
		);
	});

	test("음수 입력은 0 으로 클램프되어 [00:00] 을 반환한다 (Validates Requirements 5.4)", () => {
		fc.assert(
			fc.property(
				fc.double({
					min: -100_000_000,
					max: -Number.MIN_VALUE,
					noNaN: true,
					noDefaultInfinity: true,
				}),
				(startSeconds) => {
					const result = formatTimestamp(startSeconds);
					expect(result).toBe("[00:00]");
				},
			),
			{ numRuns: 100 },
		);
	});
});

// ─── Property 7 ─────────────────────────────────────────────────────────────
// `splitIntoSentences` 의 분할/공백 제거/종결 부호 보존/결정성 불변식 검증.
// design §Sentence_Formatter 의사코드 + Requirement 5.2, 5.3 를 추적.

/**
 * 종결 부호 집합 (design §Sentence_Formatter 의사코드의 `[.!?。]` 와 1:1 대응).
 *
 * 입력 문자열에 등장하는 본 집합 원소의 총 개수가 출력의 마지막 문자(들) 로
 * 보존되는지를 검증하기 위한 카운팅 헬퍼에 사용된다.
 */
const TERMINATOR_CHARS = new Set([".", "!", "?", "。"]);

function countTerminators(text: string): number {
	let n = 0;
	for (const ch of text) {
		if (TERMINATOR_CHARS.has(ch)) n += 1;
	}
	return n;
}

describe("Sentence_Formatter — Property 7: splitIntoSentences 불변식", () => {
	test("출력 배열의 모든 원소는 trim().length > 0 (Validates Requirements 5.2, 5.3)", () => {
		fc.assert(
			fc.property(fc.string({ maxLength: 200 }), (text) => {
				const result = splitIntoSentences(text);
				for (const sentence of result) {
					expect(sentence.trim().length).toBeGreaterThan(0);
					// 양쪽 공백이 미리 제거되어 있어야 함 (이미 trim 된 결과).
					expect(sentence).toBe(sentence.trim());
				}
			}),
			{ numRuns: 200 },
		);
	});

	test("입력의 종결 부호 총 개수가 출력에 그대로 보존된다 (Validates Requirements 5.2)", () => {
		fc.assert(
			fc.property(fc.string({ maxLength: 200 }), (text) => {
				const result = splitIntoSentences(text);
				const inputCount = countTerminators(text);
				const outputCount = result.reduce(
					(sum, s) => sum + countTerminators(s),
					0,
				);
				expect(outputCount).toBe(inputCount);
			}),
			{ numRuns: 200 },
		);
	});

	test("종결 부호로 닫힌 문장은 마지막 글자가 종결 부호 (Validates Requirements 5.2)", () => {
		// 마지막이 항상 종결 부호로 끝나도록 입력을 구성하면, 출력의 모든 문장은
		// 꼬리(tail) 분기를 거치지 않으므로 마지막 글자가 반드시 종결 부호여야 한다.
		fc.assert(
			fc.property(
				fc.array(
					fc.tuple(
						// 본문(공백/알파벳/한글 일부) — 종결 부호 자체는 제외하여 카운팅 단순화.
						fc.stringMatching(/^[ a-zA-Z가-힣]{0,15}$/),
						fc.constantFrom(".", "!", "?", "。"),
					),
					{ minLength: 1, maxLength: 6 },
				),
				(parts) => {
					const text = parts
						.map(([body, term]) => `${body}${term}`)
						.join(" ");
					if (text.trim().length === 0) return; // 본문이 모두 공백이면 종결 부호만 남는 케이스 회피.
					const result = splitIntoSentences(text);
					for (const sentence of result) {
						const last = sentence[sentence.length - 1];
						expect(TERMINATOR_CHARS.has(last)).toBe(true);
					}
				},
			),
			{ numRuns: 200 },
		);
	});

	test("빈 입력 / 공백 전용 입력은 빈 배열을 반환한다 (Validates Requirements 5.3)", () => {
		fc.assert(
			fc.property(
				fc.stringMatching(/^[ \t\n\r]*$/),
				(whitespaceOnly) => {
					const result = splitIntoSentences(whitespaceOnly);
					expect(result).toEqual([]);
				},
			),
			{ numRuns: 100 },
		);
	});

	test("결정성: 동일 입력은 항상 동일 출력 (Validates Requirements 5.3)", () => {
		fc.assert(
			fc.property(fc.string({ maxLength: 200 }), (text) => {
				const a = splitIntoSentences(text);
				const b = splitIntoSentences(text);
				expect(a).toEqual(b);
			}),
			{ numRuns: 200 },
		);
	});
});

// ─── Property 5 / Property 8 ────────────────────────────────────────────────
// `format` / `parse` 의 라운드트립 + 결정성 + 라인 단조성 + 빈 입력 불변식 검증.
// design §Sentence_Formatter 의 라운드트립 속성 + Requirement 7.2, 5.6~5.9 추적.

import { format, parse, type FormatOptions } from "./Sentence_Formatter";
import type { Transcript_Segment } from "./segments";

/**
 * 정상 입력의 정의 (design Property 5 의 "정상 입력 조건"):
 * - 모든 segment 의 `startSeconds` 는 단조 비감소.
 * - 모든 segment 의 `text` 는 trim 후 비공백.
 * - `speakerLabel` 은 `undefined` 또는 `"Speaker " + 양의 정수`.
 *
 * 라운드트립 비교에서는 `endSeconds` 와 `translatedText` 를 비교 대상에서 제외한다.
 * `format` 의 단조 증가 위반 방어 분기를 회피하기 위해, 본 generator 는 `startSeconds`
 * 가 단조 비감소가 되도록 자동 정렬한다.
 *
 * 본문 텍스트는 종결 부호 (`.`, `!`, `?`, `。`) 가 한 번 이상 등장하도록 강제한다.
 * `splitIntoSentences` 가 종결 부호를 기준으로 분할하므로, 각 segment 의 text 는
 * 정확히 하나의 문장이 되도록 단순화한다 (Requirement 5.9 의 다중 sentence 분기는
 * 본 라운드트립 property 에서는 다루지 않으며, parse 측이 sentence 단위로 segment
 * 를 복원하는 비대칭 때문이다).
 */
const SAFE_TEXT_BODY = fc
	.string({ minLength: 1, maxLength: 30 })
	// 종결 부호 / 줄바꿈 / 대괄호 / 콜론 / 두 칸 들여쓰기 prefix 가 본문에 끼어들면
	// `parse` 의 라인 분기와 충돌할 수 있으므로 최소 단위로 회피한다.
	.filter((s) => !/[.!?。\n\r\[\]]/u.test(s))
	.filter((s) => !s.startsWith("  → "))
	// 화자 라벨 prefix 가 본문에 끼어들면 parse 가 본문을 화자 라벨로 오인하므로 회피.
	.filter((s) => !/^Speaker \d+:/.test(s))
	.filter((s) => s.trim().length > 0);

const ARB_TERMINATOR = fc.constantFrom(".", "!", "?", "。");

const ARB_SPEAKER_LABEL = fc.option(
	fc.integer({ min: 1, max: 10 }).map((n) => `Speaker ${n}`),
	{ nil: undefined },
);

interface NormalizedSegment {
	startSeconds: number;
	text: string; // trim 후 비공백, 종결 부호 1 개로 종료.
	speakerLabel: string | undefined;
}

/** Property 5/8 비교 대상 추출. `endSeconds` / `translatedText` 는 비교 제외. */
function projectForRoundtrip(seg: {
	startSeconds: number;
	text: string;
	speakerLabel?: string;
}): NormalizedSegment {
	return {
		startSeconds: seg.startSeconds,
		text: seg.text.trim(),
		speakerLabel: seg.speakerLabel,
	};
}

/** 정상 입력 조건을 만족하는 `Transcript_Segment[]` generator. */
const ARB_NORMAL_SEGMENTS = fc
	.array(
		fc.tuple(
			fc.integer({ min: 0, max: 86_399 }), // 0~24h, hh:mm:ss 범위 내.
			SAFE_TEXT_BODY,
			ARB_TERMINATOR,
			ARB_SPEAKER_LABEL,
		),
		{ minLength: 0, maxLength: 8 },
	)
	.map((rows) => {
		// startSeconds 단조 비감소를 위해 정렬.
		const sorted = [...rows].sort((a, b) => a[0] - b[0]);
		return sorted.map(
			([startSeconds, body, term, speakerLabel], idx): Transcript_Segment => ({
				segmentId: idx + 1,
				startSeconds,
				endSeconds: startSeconds,
				text: `${body.trim()}${term}`,
				speakerLabel,
			}),
		);
	});

/** Property 5 / 8 의 모든 분기를 커버하는 옵션 generator. */
const ARB_OPTIONS: fc.Arbitrary<FormatOptions> = fc.record({
	speakerDiarizationEnabled: fc.boolean(),
	timestampOutputEnabled: fc.constant(true), // 라운드트립은 timestamp on 분기에서만 의미.
	translationOutputFormat: fc.constantFrom("inline", "none"),
});

describe("Sentence_Formatter — Property 5: 라운드트립 (Validates Requirements 7.2)", () => {
	test("정상 입력 S 에 대해 parse(format(S, opts)) 가 startSeconds/text/speakerLabel 을 보존", () => {
		fc.assert(
			fc.property(ARB_NORMAL_SEGMENTS, ARB_OPTIONS, (segments, options) => {
				const serialized = format(segments, options);
				const parsed = parse(serialized);

				const expected = segments.map(projectForRoundtrip);
				const actual = parsed.map(projectForRoundtrip);

				// `speakerDiarizationEnabled === false` 면 format 이 화자 라벨을 직렬화하지 않으므로
				// parse 후 speakerLabel 은 undefined 가 된다. 이 경우 입력측도 undefined 로 정규화해
				// 비교한다.
				if (!options.speakerDiarizationEnabled) {
					for (const e of expected) e.speakerLabel = undefined;
				}

				expect(actual).toEqual(expected);
			}),
			{ numRuns: 200 },
		);
	});
});

describe("Sentence_Formatter — Property 8: format 결정성 + 라인 단조성 + 빈 입력 (Validates Requirements 5.6, 5.7, 5.8, 5.9)", () => {
	test("동일 입력은 항상 동일 출력을 반환한다 (결정성)", () => {
		fc.assert(
			fc.property(ARB_NORMAL_SEGMENTS, ARB_OPTIONS, (segments, options) => {
				const a = format(segments, options);
				const b = format(segments, options);
				expect(a).toBe(b);
			}),
			{ numRuns: 200 },
		);
	});

	test("출력 라인 수는 비공백 문장 수 × (1 + 번역 라인 발생 여부) 이하 (라인 단조성)", () => {
		fc.assert(
			fc.property(ARB_NORMAL_SEGMENTS, ARB_OPTIONS, (segments, options) => {
				const result = format(segments, options);

				// 단일 trailing newline 부착으로 인한 마지막 빈 라인은 제외.
				const lineCount = result.length === 0
					? 0
					: result.split("\n").filter((l) => l.length > 0).length;

				// 비공백 문장 수: 본 generator 는 segment 당 1 문장 보장.
				const nonEmptySentenceCount = segments.filter(
					(s) => s.text.trim().length > 0,
				).length;

				// 본 property test 는 `Transcript_Segment` 만 사용하므로 번역 라인은 발생하지 않는다.
				// 따라서 상한은 `nonEmptySentenceCount × 1` 이다.
				expect(lineCount).toBeLessThanOrEqual(nonEmptySentenceCount);
			}),
			{ numRuns: 200 },
		);
	});

	test('빈 입력은 정확히 "" 를 반환한다', () => {
		const out = format([], {
			speakerDiarizationEnabled: false,
			timestampOutputEnabled: true,
			translationOutputFormat: "inline",
		});
		expect(out).toBe("");
	});

	test('모든 segment 의 text 가 공백 전용이면 정확히 "" 를 반환한다 (Requirement 5.7)', () => {
		fc.assert(
			fc.property(
				fc.array(
					fc.record({
						segmentId: fc.integer({ min: 1, max: 1000 }),
						startSeconds: fc.integer({ min: 0, max: 86_399 }),
						endSeconds: fc.integer({ min: 0, max: 86_399 }),
						text: fc.stringMatching(/^[ \t]*$/),
					}),
					{ minLength: 1, maxLength: 5 },
				),
				ARB_OPTIONS,
				(segments, options) => {
					// startSeconds 단조 비감소 정렬 후 호출.
					const sorted = [...segments]
						.sort((a, b) => a.startSeconds - b.startSeconds)
						.map((s, i) => ({ ...s, segmentId: i + 1 }));
					const out = format(sorted, options);
					expect(out).toBe("");
				},
			),
			{ numRuns: 100 },
		);
	});
});
