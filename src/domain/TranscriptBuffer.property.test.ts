/**
 * `TranscriptBuffer` 속성 테스트 (Property-Based Tests).
 *
 * 본 파일은 `design.md`의 다음 정확성 속성(Correctness Property)을 검증한다.
 *
 * - Property 3 (v1.0): 누적 및 치환 규칙 (Validates Requirements 3.6, 3.7)
 * - Property 4 (v1.0): 공백 전용 검출 (Validates Requirements 4.9, 5.8)
 * - v1.1 추가 (Task 10, design §4.7): segment 시퀀스 불변식 3개
 *   - `appendSegment` 호출 시 `segmentId` 단조 증가 보존 (Validates Requirement 13.5)
 *   - `appendSegment(s)` 후 `getCommittedText()` 길이 단조 증가 (Validates Requirement 13.4)
 *   - `clear()` 후 segments 와 committed text 모두 비어 있음 (Validates Requirement 8.5)
 *
 * `fast-check` 3.x API를 사용하며, 각 `fc.assert`는 `numRuns: 200`으로 충분한 샘플을 확보한다.
 */

import { describe, test, expect } from "vitest";
import fc from "fast-check";
import { TranscriptBuffer, type Transcript_Segment } from "./TranscriptBuffer";

/**
 * `TranscriptBuffer.isEmpty()`가 공백으로 간주하는 문자의 집합.
 *
 * 구현부(`/^[\s\u3000]*$/`)와 일관되게, `\s`로 매칭되는 공백과 전각 공백을
 * 명시적으로 대표하는 문자들을 수집한다. 이 목록은 "공백 전용" 생성기의
 * 기저 문자 집합이 되며, 동시에 "비공백" 문자열 생성기의 제외 기준으로 활용된다.
 */
const WHITESPACE_CHARS = [
	" ",        // 일반 스페이스 (U+0020)
	"\t",       // 탭 (U+0009)
	"\n",       // 개행 (U+000A)
	"\r",       // 캐리지 리턴 (U+000D)
	"\u3000",   // 전각 공백 (ideographic space)
	"\u00A0",   // non-breaking space
	"\u2028",   // line separator
	"\u2029",   // paragraph separator
] as const;

/**
 * 입력 문자열이 유니코드 공백 문자만으로 이루어졌는지 여부.
 *
 * 구현부 regex와 **동일한** 판정 로직을 사용하여, 테스트가 구현부의 검출 범위를
 * 일관되게 검증하도록 한다.
 */
function isOnlyWhitespace(s: string): boolean {
	return /^[\s\u3000]*$/.test(s);
}

/**
 * 공백 문자들을 임의 개수 조합해 만든 "공백 전용" 문자열 생성기.
 *
 * `fc.array(...).map(join)` 패턴으로, 빈 문자열 `""`도 생성 대상에 포함한다.
 */
const whitespaceOnlyArb: fc.Arbitrary<string> = fc
	.array(fc.constantFrom(...WHITESPACE_CHARS), { maxLength: 40 })
	.map((arr) => arr.join(""));

/**
 * 비공백 문자를 최소 1자 이상 포함하는 임의 문자열 생성기.
 *
 * `fc.string()`으로 기본 임의 문자열을 얻은 뒤, 구현부와 동일한 regex로
 * "순수 공백"을 걸러내는 precondition을 건다. fast-check가 자동으로 해당
 * 샘플을 건너뛰고 다음 샘플을 시도한다.
 */
const withNonWhitespaceArb: fc.Arbitrary<string> = fc
	.string({ maxLength: 50 })
	.filter((s) => !isOnlyWhitespace(s));

/**
 * 임의의 `Transcript_Segment` 시퀀스 생성기 (Task 10).
 *
 * `segmentId` 단조 증가 불변식(Requirement 13.5)을 보장하기 위해 양의 정수 증분을
 * 누적하여 단조 증가 ID 를 생성한다. `endSeconds >= startSeconds` 만 만족하도록
 * 구성한다 (text 길이 단조 증가 검증과 무관하므로 단순 형태로 충분).
 */
const segmentSequenceArb: fc.Arbitrary<Transcript_Segment[]> = fc
	.array(
		fc.record({
			idIncrement: fc.integer({ min: 1, max: 5 }),
			startSeconds: fc.integer({ min: 0, max: 7200 }),
			durationSeconds: fc.integer({ min: 0, max: 60 }),
			text: fc.string({ maxLength: 30 }),
			speakerLabel: fc.option(
				fc.constantFrom("Speaker 1", "Speaker 2", "Speaker 3"),
				{ nil: undefined },
			),
		}),
		{ maxLength: 15 },
	)
	.map((rawSegments) => {
		// idIncrement 의 누적 합으로 단조 증가 segmentId 를 만들고, startSeconds 와
		// duration 으로 endSeconds 를 정렬하여 의미상 안정적인 segment 객체를 생성한다.
		let cumulativeId = 0;
		return rawSegments.map((s) => {
			cumulativeId += s.idIncrement;
			return {
				segmentId: cumulativeId,
				startSeconds: s.startSeconds,
				endSeconds: s.startSeconds + s.durationSeconds,
				text: s.text,
				speakerLabel: s.speakerLabel,
			} satisfies Transcript_Segment;
		});
	});

describe("TranscriptBuffer — Property 3: 누적 및 치환 규칙", () => {
	test("appendFinal/setPartial 시퀀스 적용 후 누적·치환 불변식이 유지된다 (Validates Requirements 3.6, 3.7)", () => {
		fc.assert(
			fc.property(
				// 중간 Partial_Result로 적용될 문자열 시퀀스
				fc.array(fc.string(), { maxLength: 20 }),
				// 최종 Final_Result로 누적될 문자열 시퀀스
				fc.array(fc.string(), { maxLength: 20 }),
				(partials, finals) => {
					const buf = new TranscriptBuffer();

					// 모든 partial을 순서대로 적용 — 마지막 것만 pendingPartial에 남는다.
					for (const p of partials) {
						buf.setPartial(p);
					}

					// 모든 final을 순서대로 appendFinal — 각 호출이 pendingPartial을 비운다.
					for (const f of finals) {
						buf.appendFinal(f);
					}

					const snapshot = buf.getSnapshot();
					const committed = buf.getCommittedText();

					// (1) getCommittedText() 는 finals의 모든 원소를 입력 순서대로 포함한다.
					//     즉, 각 final이 committed 내에서 단조 증가하는 위치에 등장한다.
					let cursor = 0;
					for (const f of finals) {
						const idx = committed.indexOf(f, cursor);
						expect(idx).toBeGreaterThanOrEqual(cursor);
						// indexOf("", fromIndex)는 fromIndex를 반환하므로 빈 문자열도 안전하게 처리된다.
						cursor = idx + f.length;
					}

					// (2) 마지막 appendFinal 이후 pendingPartial 은 빈 문자열이다.
					//     finals가 비어 있으면 이 조항은 공허하게 성립(vacuously true).
					if (finals.length > 0) {
						expect(snapshot.partial).toBe("");
					}

					// (3) length() === getCommittedText().length.
					expect(buf.length()).toBe(committed.length);

					// (4) 중간 partial 값들은 chunks 에 누적되지 않는다.
					//     구현상 chunks.join(" ") 이 getCommittedText() 이므로
					//     finals.join(" ") 와 정확히 일치해야 한다.
					expect(committed).toBe(finals.join(" "));
				},
			),
			{ numRuns: 200 },
		);
	});
});

describe("TranscriptBuffer — Property 4: 공백 전용 검출", () => {
	test("공백 문자로만 구성된 문자열을 appendFinal 한 뒤 isEmpty() === true (Validates Requirements 4.9, 5.8)", () => {
		fc.assert(
			fc.property(whitespaceOnlyArb, (s) => {
				const buf = new TranscriptBuffer();
				buf.appendFinal(s);
				expect(buf.isEmpty()).toBe(true);
			}),
			{ numRuns: 200 },
		);
	});

	test("비공백 문자를 하나라도 포함하면 isEmpty() === false (Validates Requirements 4.9, 5.8)", () => {
		fc.assert(
			fc.property(withNonWhitespaceArb, (s) => {
				const buf = new TranscriptBuffer();
				buf.appendFinal(s);
				expect(buf.isEmpty()).toBe(false);
			}),
			{ numRuns: 200 },
		);
	});
});

describe("TranscriptBuffer — v1.1 segment 시퀀스 불변식 (Task 10, design §4.7)", () => {
	test("appendSegment 시퀀스 적용 후 getSegments() 의 segmentId 는 단조 증가한다 (Validates Requirement 13.5)", () => {
		fc.assert(
			fc.property(segmentSequenceArb, (segments) => {
				const buf = new TranscriptBuffer();
				for (const s of segments) {
					buf.appendSegment(s);
				}

				const stored = buf.getSegments();

				// 입력 시퀀스 길이 보존 — push 만 하므로 1:1 대응.
				expect(stored.length).toBe(segments.length);

				// 단조 증가 검증: 0 번째는 비교 대상이 없으므로 건너뛰고, 그 외 모든 i 에서
				// stored[i].segmentId > stored[i-1].segmentId 이어야 한다.
				for (let i = 1; i < stored.length; i++) {
					expect(stored[i].segmentId).toBeGreaterThan(
						stored[i - 1].segmentId,
					);
				}
			}),
			{ numRuns: 200 },
		);
	});

	test("appendSegment(s) 호출 후 getCommittedText() 길이가 s.text.length 이상 증가한다 (Validates Requirement 13.4)", () => {
		fc.assert(
			fc.property(segmentSequenceArb, (segments) => {
				const buf = new TranscriptBuffer();

				for (const s of segments) {
					const before = buf.getCommittedText().length;
					buf.appendSegment(s);
					const after = buf.getCommittedText().length;

					// 길이 단조성: chunks.join(" ") 는 구분자 1 글자를 더할 수 있으므로
					// 정확히 s.text.length 이상 증가해야 한다.
					expect(after - before).toBeGreaterThanOrEqual(s.text.length);

					// length() 는 getCommittedText().length 와 항상 동일.
					expect(buf.length()).toBe(after);
				}
			}),
			{ numRuns: 200 },
		);
	});

	test("clear() 호출 후 getSegments() 와 getCommittedText() 가 모두 비어 있다 (Validates Requirement 8.5)", () => {
		fc.assert(
			fc.property(
				segmentSequenceArb,
				fc.array(fc.string(), { maxLength: 5 }),
				(segments, partials) => {
					const buf = new TranscriptBuffer();

					// 임의 segment + partial 혼합 적용으로 모든 내부 필드를 채운다.
					for (const s of segments) {
						buf.appendSegment(s);
					}
					for (const p of partials) {
						buf.setPartial(p);
					}

					buf.clear();

					expect(buf.getSegments().length).toBe(0);
					expect(buf.getCommittedText()).toBe("");
					expect(buf.length()).toBe(0);
					expect(buf.isEmpty()).toBe(true);
					expect(buf.getSnapshot()).toEqual({
						committed: "",
						partial: "",
					});
				},
			),
			{ numRuns: 200 },
		);
	});
});
