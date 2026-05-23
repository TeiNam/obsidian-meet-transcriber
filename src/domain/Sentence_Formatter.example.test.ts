/**
 * `Sentence_Formatter` 예제 기반 테스트.
 *
 * 본 파일은 다음 acceptance criterion 을 1:1 시나리오로 검증한다:
 * - AC 5.5  화자 라벨 prefix
 * - AC 5.7  공백 전용 입력 → ""
 * - AC 5.10 단조 증가 위반 segment 제외 + console.error
 * - AC 7.3  타임스탬프 없는 라인 → 직전 startSeconds 부여
 * - AC 7.4  60 이상 분/초 라인 무시 + console.error
 * - AC 13.7 `Translated_Segment` inline 직렬화 / "none" / timestamp off 통짜 본문 분기
 *
 * 본 테스트는 외부 I/O (Obsidian / AWS / 파일시스템) 에 의존하지 않으며,
 * `Sentence_Formatter` 의 순수 함수 동작만 검증한다 (Requirement 12.1).
 */

import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { format, parse, type FormatOptions } from "./Sentence_Formatter";
import type { Transcript_Segment, Translated_Segment } from "./segments";

const TIMESTAMP_ON_NO_TRANSLATION: FormatOptions = {
	speakerDiarizationEnabled: false,
	timestampOutputEnabled: true,
	translationOutputFormat: "none",
};

const TIMESTAMP_ON_WITH_SPEAKER: FormatOptions = {
	speakerDiarizationEnabled: true,
	timestampOutputEnabled: true,
	translationOutputFormat: "none",
};

describe("Sentence_Formatter.format — AC 5.5: 화자 라벨 prefix", () => {
	test("speakerDiarizationEnabled=true 이고 speakerLabel 이 있으면 [mm:ss] Speaker N: text 형식으로 직렬화한다", () => {
		const segments: Transcript_Segment[] = [
			{
				segmentId: 1,
				startSeconds: 12,
				endSeconds: 12,
				text: "안녕하세요.",
				speakerLabel: "Speaker 1",
			},
			{
				segmentId: 2,
				startSeconds: 18,
				endSeconds: 18,
				text: "반갑습니다.",
				speakerLabel: "Speaker 2",
			},
		];

		const result = format(segments, TIMESTAMP_ON_WITH_SPEAKER);

		expect(result).toBe(
			"[00:12] Speaker 1: 안녕하세요.\n" +
				"[00:18] Speaker 2: 반갑습니다.\n",
		);
	});

	test("speakerDiarizationEnabled=true 이지만 speakerLabel 이 없으면 라벨 없이 직렬화한다 (Requirement 6.7)", () => {
		const segments: Transcript_Segment[] = [
			{
				segmentId: 1,
				startSeconds: 5,
				endSeconds: 5,
				text: "라벨 없음.",
			},
		];

		const result = format(segments, TIMESTAMP_ON_WITH_SPEAKER);

		expect(result).toBe("[00:05] 라벨 없음.\n");
	});

	test("speakerDiarizationEnabled=false 이면 speakerLabel 이 있어도 라벨을 출력하지 않는다", () => {
		const segments: Transcript_Segment[] = [
			{
				segmentId: 1,
				startSeconds: 30,
				endSeconds: 30,
				text: "라벨 있어도 무시.",
				speakerLabel: "Speaker 1",
			},
		];

		const result = format(segments, TIMESTAMP_ON_NO_TRANSLATION);

		expect(result).toBe("[00:30] 라벨 있어도 무시.\n");
	});
});

describe('Sentence_Formatter.format — AC 5.7: 공백 전용 입력 → ""', () => {
	test("빈 segment 배열은 빈 문자열을 반환한다", () => {
		expect(format([], TIMESTAMP_ON_NO_TRANSLATION)).toBe("");
	});

	test("모든 segment 의 text 가 공백뿐이면 빈 문자열을 반환한다 (timestamp on)", () => {
		const segments: Transcript_Segment[] = [
			{ segmentId: 1, startSeconds: 0, endSeconds: 0, text: "   " },
			{ segmentId: 2, startSeconds: 5, endSeconds: 5, text: "\t\t" },
			{ segmentId: 3, startSeconds: 10, endSeconds: 10, text: "" },
		];

		expect(format(segments, TIMESTAMP_ON_NO_TRANSLATION)).toBe("");
	});

	test("모든 segment 의 text 가 공백뿐이면 빈 문자열을 반환한다 (timestamp off, v1.0 통짜 본문)", () => {
		const segments: Transcript_Segment[] = [
			{ segmentId: 1, startSeconds: 0, endSeconds: 0, text: "   " },
			{ segmentId: 2, startSeconds: 5, endSeconds: 5, text: "" },
		];
		const opts: FormatOptions = {
			speakerDiarizationEnabled: false,
			timestampOutputEnabled: false,
			translationOutputFormat: "none",
		};

		expect(format(segments, opts)).toBe("");
	});
});

describe("Sentence_Formatter.format — AC 5.10: 단조 증가 위반 segment 제외", () => {
	// Vitest 의 `vi.spyOn(console, "error").mockImplementation(...)` 반환 타입은 버전에 따라
	// 제네릭 기본형이 달라져 직접 타입 어노테이션은 TS2322/TS2344 를 유발한다.
	// 다른 테스트 파일(AudioCapture, NoteStore) 과 동일하게 `ReturnType<typeof vi.spyOn>` +
	// 캐스트 패턴을 사용한다.
	let consoleErrorSpy!: ReturnType<typeof vi.spyOn> & {
		mock: { calls: unknown[][] };
	};

	beforeEach(() => {
		consoleErrorSpy = vi
			.spyOn(console, "error")
			.mockImplementation(() => undefined) as typeof consoleErrorSpy;
	});

	afterEach(() => {
		consoleErrorSpy.mockRestore();
	});

	test("startSeconds 가 직전보다 작은 segment 는 출력에서 제외하고 console.error 로 기록한다", () => {
		const segments: Transcript_Segment[] = [
			{ segmentId: 1, startSeconds: 10, endSeconds: 10, text: "첫번째." },
			{ segmentId: 2, startSeconds: 20, endSeconds: 20, text: "두번째." },
			// 단조 증가 위반: 20 -> 5 로 감소.
			{ segmentId: 3, startSeconds: 5, endSeconds: 5, text: "위반." },
			{ segmentId: 4, startSeconds: 25, endSeconds: 25, text: "네번째." },
		];

		const result = format(segments, TIMESTAMP_ON_NO_TRANSLATION);

		expect(result).toBe(
			"[00:10] 첫번째.\n" + "[00:20] 두번째.\n" + "[00:25] 네번째.\n",
		);
		expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
		expect(consoleErrorSpy).toHaveBeenCalledWith(
			"[Sentence_Formatter] non-monotonic segment dropped",
			3,
		);
	});
});

describe("Sentence_Formatter.parse — AC 7.3: 타임스탬프 없는 라인 처리", () => {
	test("타임스탬프 없는 라인은 직전 startSeconds 를 부여하고 본문을 보존한다", () => {
		const text =
			"[00:10] 첫번째 문장.\n" +
			"이어지는 두번째 문장.\n" +
			"[00:20] 세번째 문장.\n";

		const parsed = parse(text);

		expect(parsed).toHaveLength(3);
		expect(parsed[0]).toMatchObject({
			startSeconds: 10,
			text: "첫번째 문장.",
		});
		expect(parsed[1]).toMatchObject({
			startSeconds: 10, // 직전 startSeconds 승계.
			text: "이어지는 두번째 문장.",
		});
		expect(parsed[2]).toMatchObject({
			startSeconds: 20,
			text: "세번째 문장.",
		});
	});

	test("문서 첫 라인이 타임스탬프 없는 라인이면 startSeconds=0 을 부여한다", () => {
		const text = "타임스탬프 없는 첫 라인.\n[00:30] 두번째.\n";

		const parsed = parse(text);

		expect(parsed).toHaveLength(2);
		expect(parsed[0]).toMatchObject({
			startSeconds: 0,
			text: "타임스탬프 없는 첫 라인.",
		});
		expect(parsed[1]).toMatchObject({
			startSeconds: 30,
			text: "두번째.",
		});
	});
});

describe("Sentence_Formatter.parse — AC 7.4: 60 이상 분/초 라인 무시", () => {
	let consoleErrorSpy!: ReturnType<typeof vi.spyOn> & {
		mock: { calls: unknown[][] };
	};

	beforeEach(() => {
		consoleErrorSpy = vi
			.spyOn(console, "error")
			.mockImplementation(() => undefined) as typeof consoleErrorSpy;
	});

	afterEach(() => {
		consoleErrorSpy.mockRestore();
	});

	test("분 부분이 60 이상이면 해당 라인을 무시하고 console.error 로 기록한다", () => {
		const text =
			"[00:10] 정상 라인.\n" +
			"[60:00] 잘못된 분.\n" +
			"[00:20] 다음 정상 라인.\n";

		const parsed = parse(text);

		expect(parsed).toHaveLength(2);
		expect(parsed[0]).toMatchObject({ startSeconds: 10, text: "정상 라인." });
		expect(parsed[1]).toMatchObject({
			startSeconds: 20,
			text: "다음 정상 라인.",
		});
		expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
		expect(consoleErrorSpy).toHaveBeenCalledWith(
			"[Sentence_Formatter] invalid timestamp dropped",
			"[60:00] 잘못된 분.",
		);
	});

	test("초 부분이 60 이상이면 해당 라인을 무시하고 console.error 로 기록한다", () => {
		const text = "[00:60] 잘못된 초.\n[00:30] 정상.\n";

		const parsed = parse(text);

		expect(parsed).toHaveLength(1);
		expect(parsed[0]).toMatchObject({ startSeconds: 30, text: "정상." });
		expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
	});

	test("hh:mm:ss 형식에서 mm 또는 ss 가 60 이상이면 해당 라인을 무시한다 (hh 는 자릿수 무제한)", () => {
		const text =
			"[1:00:00] 정상 1시간.\n" +
			"[1:60:00] 분 위반.\n" +
			"[2:00:60] 초 위반.\n" +
			"[12:34:56] 정상 12시간.\n";

		const parsed = parse(text);

		expect(parsed).toHaveLength(2);
		expect(parsed[0]).toMatchObject({
			startSeconds: 3600,
			text: "정상 1시간.",
		});
		expect(parsed[1]).toMatchObject({
			startSeconds: 12 * 3600 + 34 * 60 + 56,
			text: "정상 12시간.",
		});
		expect(consoleErrorSpy).toHaveBeenCalledTimes(2);
	});
});

describe("Sentence_Formatter.format — AC 13.7: 번역 inline 직렬화", () => {
	test("translationOutputFormat='inline' + timestamp on + translatedText 존재 시 두 번째 줄 '  → translated' 가 부착된다", () => {
		const segments: Translated_Segment[] = [
			{
				segmentId: 1,
				startSeconds: 12,
				endSeconds: 12,
				text: "안녕하세요.",
				sourceText: "안녕하세요.",
				translatedText: "Hello.",
			},
			{
				segmentId: 2,
				startSeconds: 18,
				endSeconds: 18,
				text: "반갑습니다.",
				sourceText: "반갑습니다.",
				translatedText: "Nice to meet you.",
			},
		];
		const opts: FormatOptions = {
			speakerDiarizationEnabled: false,
			timestampOutputEnabled: true,
			translationOutputFormat: "inline",
		};

		const result = format(segments, opts);

		expect(result).toBe(
			"[00:12] 안녕하세요.\n" +
				"  → Hello.\n" +
				"[00:18] 반갑습니다.\n" +
				"  → Nice to meet you.\n",
		);
	});

	test("translationOutputFormat='inline' 이지만 translatedText 가 undefined 인 segment 는 번역 라인을 출력하지 않는다", () => {
		const segments: Translated_Segment[] = [
			{
				segmentId: 1,
				startSeconds: 5,
				endSeconds: 5,
				text: "원본만 있음.",
				sourceText: "원본만 있음.",
				// translatedText 부재 — 번역 라인 미부착.
			},
		];
		const opts: FormatOptions = {
			speakerDiarizationEnabled: false,
			timestampOutputEnabled: true,
			translationOutputFormat: "inline",
		};

		const result = format(segments, opts);

		expect(result).toBe("[00:05] 원본만 있음.\n");
	});
});

describe('Sentence_Formatter.format — AC 13.7: translationOutputFormat="none" 분기', () => {
	test('translationOutputFormat="none" 시 번역 텍스트가 본문에 포함되지 않고 [mm:ss] text 만 출력된다', () => {
		const segments: Translated_Segment[] = [
			{
				segmentId: 1,
				startSeconds: 12,
				endSeconds: 12,
				text: "안녕하세요.",
				sourceText: "안녕하세요.",
				translatedText: "Hello.",
			},
			{
				segmentId: 2,
				startSeconds: 18,
				endSeconds: 18,
				text: "반갑습니다.",
				sourceText: "반갑습니다.",
				translatedText: "Nice to meet you.",
			},
		];
		const opts: FormatOptions = {
			speakerDiarizationEnabled: false,
			timestampOutputEnabled: true,
			translationOutputFormat: "none",
		};

		const result = format(segments, opts);

		expect(result).toBe(
			"[00:12] 안녕하세요.\n" + "[00:18] 반갑습니다.\n",
		);
		// 번역 라인 prefix 가 출력에 등장하지 않음을 추가 검증.
		expect(result).not.toContain("  → ");
	});
});

describe("Sentence_Formatter.format — AC 13.7: timestamp off 시 통짜 본문 우선 (번역 미포함)", () => {
	test("timestampOutputEnabled=false 이면 translationOutputFormat='inline' 이고 translatedText 가 있어도 v1.0 통짜 본문만 출력한다", () => {
		const segments: Translated_Segment[] = [
			{
				segmentId: 1,
				startSeconds: 12,
				endSeconds: 12,
				text: "안녕하세요.",
				sourceText: "안녕하세요.",
				translatedText: "Hello.",
			},
			{
				segmentId: 2,
				startSeconds: 18,
				endSeconds: 18,
				text: "반갑습니다.",
				sourceText: "반갑습니다.",
				translatedText: "Nice to meet you.",
			},
		];
		const opts: FormatOptions = {
			speakerDiarizationEnabled: false,
			timestampOutputEnabled: false,
			translationOutputFormat: "inline",
		};

		const result = format(segments, opts);

		// v1.0 통짜 본문: segments.map(s => s.text).join(" ") + "\n".
		expect(result).toBe("안녕하세요. 반갑습니다.\n");
		// 번역 텍스트와 타임스탬프 prefix 가 모두 누락되어야 한다.
		expect(result).not.toContain("Hello");
		expect(result).not.toContain("Nice to meet");
		expect(result).not.toContain("[00:");
		expect(result).not.toContain("  → ");
	});
});
