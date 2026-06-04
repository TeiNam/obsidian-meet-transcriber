/**
 * `refineChunking` 단위 테스트.
 *
 * 긴 전사를 줄 경계로 안전하게 분할하고(`splitTranscriptIntoChunks`),
 * 교정된 청크들을 원본 줄 구조로 합치는(`joinRefinedChunks`) 동작을 검증한다.
 */

import { describe, test, expect } from "vitest";
import {
	splitTranscriptIntoChunks,
	joinRefinedChunks,
} from "./refineChunking";

describe("splitTranscriptIntoChunks", () => {
	test("빈 문자열/공백 전용 입력은 빈 배열을 반환한다", () => {
		expect(splitTranscriptIntoChunks("", 100)).toEqual([]);
		expect(splitTranscriptIntoChunks("   \n  \n", 100)).toEqual([]);
	});

	test("임계치 이하 입력은 분할 없이 단일 청크로 반환한다", () => {
		const text = "첫째 줄\n둘째 줄";
		expect(splitTranscriptIntoChunks(text, 100)).toEqual([text]);
	});

	test("임계치를 넘으면 줄 경계로 여러 청크로 나눈다", () => {
		// 각 줄 5자("line1" 등). charLimit 12 → 한 청크에 2줄(5+1+5=11)까지만.
		const text = "line1\nline2\nline3\nline4";
		const chunks = splitTranscriptIntoChunks(text, 12);

		expect(chunks).toEqual(["line1\nline2", "line3\nline4"]);
		// 모든 청크는 임계치 이하여야 한다.
		for (const chunk of chunks) {
			expect(chunk.length).toBeLessThanOrEqual(12);
		}
	});

	test("줄 중간을 절대 쪼개지 않는다 — 모든 원본 줄이 정확히 한 청크에 속한다", () => {
		const lines = ["가나다라마", "바사아자차", "카타파하", "한 줄 더"];
		const text = lines.join("\n");
		const chunks = splitTranscriptIntoChunks(text, 8);

		// 청크들을 모두 줄 단위로 펼치면 원본 줄과 동일해야 한다(순서 보존).
		const flattened = chunks.flatMap((c) => c.split("\n"));
		expect(flattened).toEqual(lines);
	});

	test("단일 줄이 임계치보다 길면 그 줄을 단독 청크로 둔다", () => {
		const longLine = "x".repeat(50);
		const text = `짧은 줄\n${longLine}\n또 짧은 줄`;
		const chunks = splitTranscriptIntoChunks(text, 10);

		// 긴 줄은 쪼개지지 않고 통째로 한 청크에 들어간다.
		expect(chunks).toContain(longLine);
		// 펼친 줄 순서는 원본과 동일.
		const flattened = chunks.flatMap((c) => c.split("\n"));
		expect(flattened).toEqual(["짧은 줄", longLine, "또 짧은 줄"]);
	});
});

describe("joinRefinedChunks", () => {
	test("청크들을 개행으로 이어 원본 줄 구조를 복원한다", () => {
		const chunks = ["line1\nline2", "line3\nline4"];
		expect(joinRefinedChunks(chunks)).toBe("line1\nline2\nline3\nline4");
	});

	test("각 청크의 앞뒤 개행을 정리해 이중 빈 줄을 막는다", () => {
		const chunks = ["\nline1\nline2\n", "\n\nline3\n"];
		expect(joinRefinedChunks(chunks)).toBe("line1\nline2\nline3");
	});

	test("split → (교정 가정) → join 라운드트립이 줄 수/순서를 보존한다", () => {
		const lines = Array.from({ length: 20 }, (_, i) => `발화 ${i + 1}`);
		const text = lines.join("\n");

		const chunks = splitTranscriptIntoChunks(text, 15);
		// 교정이 내용을 바꾸지 않았다고 가정하고 그대로 합친다.
		const rejoined = joinRefinedChunks(chunks);

		expect(rejoined.split("\n")).toEqual(lines);
	});
});
