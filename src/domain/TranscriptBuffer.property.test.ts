/**
 * `TranscriptBuffer` 속성 테스트 (Property-Based Tests).
 *
 * 본 파일은 `design.md`의 다음 두 가지 정확성 속성(Correctness Property)을 검증한다.
 *
 * - Property 3: 누적 및 치환 규칙 (Validates Requirements 3.6, 3.7)
 * - Property 4: 공백 전용 검출 (Validates Requirements 4.9, 5.8)
 *
 * `fast-check` 3.x API를 사용하며, 각 `fc.assert`는 `numRuns: 200`으로 충분한 샘플을 확보한다.
 */

import { describe, test, expect } from "vitest";
import fc from "fast-check";
import { TranscriptBuffer } from "./TranscriptBuffer";

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
