/**
 * `transcriptNote` 단위 테스트.
 *
 * 노트 본문 콜아웃 양식(분석 → 원본 → 교정본)의 조립/파싱/병합을 검증한다.
 */

import { describe, test, expect } from "vitest";
import {
	wrapInCallout,
	buildTranscriptNoteBody,
	extractCalloutBody,
	extractAnalysisSource,
	upsertAnalysisCallout,
	mergeContinuedSession,
	CALLOUT_ORIGINAL,
	CALLOUT_REFINED,
} from "./transcriptNote";

const titles = { analysis: "분석 결과", original: "원본", refined: "교정본" };

describe("wrapInCallout", () => {
	test("각 줄에 '> ' 를 붙이고 헤더에 폴드 마크를 넣는다", () => {
		const out = wrapInCallout("quote", "원본", true, "첫 줄\n둘째 줄");
		expect(out).toBe("> [!quote]- 원본\n> 첫 줄\n> 둘째 줄");
	});

	test("빈 줄은 '>' 로만 이어 콜아웃이 끊기지 않게 한다", () => {
		const out = wrapInCallout("tip", "교정본", false, "줄1\n\n줄2");
		expect(out).toBe("> [!tip] 교정본\n> 줄1\n>\n> 줄2");
	});
});

describe("buildTranscriptNoteBody", () => {
	test("교정본이 없으면 원본 콜아웃만 만든다", () => {
		const body = buildTranscriptNoteBody({
			original: "안녕하세요",
			refined: null,
			titles,
		});
		expect(body).toContain(`[!${CALLOUT_ORIGINAL}]- 원본`);
		expect(body).not.toContain(`[!${CALLOUT_REFINED}]`);
		expect(extractCalloutBody(body, CALLOUT_ORIGINAL)).toBe("안녕하세요");
	});

	test("교정본이 있으면 원본 → 교정본 순서로 두 콜아웃을 만든다", () => {
		const body = buildTranscriptNoteBody({
			original: "원본 문장",
			refined: "교정 문장",
			titles,
		});
		const origIdx = body.indexOf(`[!${CALLOUT_ORIGINAL}]`);
		const refIdx = body.indexOf(`[!${CALLOUT_REFINED}]`);
		expect(origIdx).toBeGreaterThanOrEqual(0);
		expect(refIdx).toBeGreaterThan(origIdx);
		expect(extractCalloutBody(body, CALLOUT_REFINED)).toBe("교정 문장");
	});
});

describe("extractAnalysisSource", () => {
	test("교정본이 있으면 교정본을 우선 반환한다", () => {
		const body = buildTranscriptNoteBody({
			original: "원본만",
			refined: "교정본 우선",
			titles,
		});
		expect(extractAnalysisSource(body)).toBe("교정본 우선");
	});

	test("교정본이 없으면 원본을 반환한다", () => {
		const body = buildTranscriptNoteBody({
			original: "원본 사용",
			refined: null,
			titles,
		});
		expect(extractAnalysisSource(body)).toBe("원본 사용");
	});

	test("콜아웃이 없는 레거시 노트는 본문 전체를 반환한다", () => {
		expect(extractAnalysisSource("그냥 평문 본문")).toBe("그냥 평문 본문");
	});
});

describe("upsertAnalysisCallout", () => {
	test("분석 콜아웃을 본문 맨 위에 삽입한다", () => {
		const body = buildTranscriptNoteBody({
			original: "원본",
			refined: null,
			titles,
		});
		const out = upsertAnalysisCallout(body, "요약 결과", "분석 결과");

		// 맨 위가 분석 콜아웃이어야 한다.
		expect(out.startsWith("## 분석 결과")).toBe(true);
		// 원본 콜아웃은 보존된다.
		expect(extractCalloutBody(out, CALLOUT_ORIGINAL)).toBe("원본");
		expect(out).toContain("요약 결과");
	});

	test("재실행 시 기존 분석을 교체한다(누적하지 않음)", () => {
		const base = buildTranscriptNoteBody({
			original: "원본",
			refined: null,
			titles,
		});
		const once = upsertAnalysisCallout(base, "첫 분석", "분석 결과");
		const twice = upsertAnalysisCallout(once, "두 번째 분석", "분석 결과");

		// 분석 콜아웃은 정확히 하나여야 한다.
		const count = (twice.match(/^## 분석 결과$/gm) ?? []).length;
		expect(count).toBe(1);
		expect(twice).toContain("두 번째 분석");
	});
});

describe("mergeContinuedSession", () => {
	test("기존 원본 콜아웃 안쪽에 구분선과 새 원본을 병합한다(콜아웃 1개 유지)", () => {
		const existing = buildTranscriptNoteBody({
			original: "1차 발화",
			refined: null,
			titles,
		});
		const merged = mergeContinuedSession({
			existingBody: existing,
			newOriginal: "2차 발화",
			newRefined: null,
			divider: "--- 이어서 ---",
			titles,
		});

		const originalBody = extractCalloutBody(merged, CALLOUT_ORIGINAL);
		expect(originalBody).toContain("1차 발화");
		expect(originalBody).toContain("--- 이어서 ---");
		expect(originalBody).toContain("2차 발화");
		// 원본 콜아웃은 하나만 존재한다.
		expect((merged.match(/\[!quote\]/g) ?? []).length).toBe(1);
	});

	test("기존 교정본이 있으면 교정본 콜아웃도 병합한다", () => {
		const existing = buildTranscriptNoteBody({
			original: "1차 원본",
			refined: "1차 교정",
			titles,
		});
		const merged = mergeContinuedSession({
			existingBody: existing,
			newOriginal: "2차 원본",
			newRefined: "2차 교정",
			divider: "--- 이어서 ---",
			titles,
		});

		const refinedBody = extractCalloutBody(merged, CALLOUT_REFINED);
		expect(refinedBody).toContain("1차 교정");
		expect(refinedBody).toContain("2차 교정");
		expect((merged.match(/\[!tip\]/g) ?? []).length).toBe(1);
	});

	test("레거시(콜아웃 없는) 노트는 전체를 이전 원본으로 간주해 재구성한다", () => {
		const merged = mergeContinuedSession({
			existingBody: "옛날 평문 전사",
			newOriginal: "새 발화",
			newRefined: null,
			divider: "--- 이어서 ---",
			titles,
		});
		const originalBody = extractCalloutBody(merged, CALLOUT_ORIGINAL);
		expect(originalBody).toContain("옛날 평문 전사");
		expect(originalBody).toContain("새 발화");
	});
});
