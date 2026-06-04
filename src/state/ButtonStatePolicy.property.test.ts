/**
 * ButtonStatePolicy 속성 기반 테스트(PBT).
 *
 * Property 2: 버튼 상태 결정 규칙 (design.md §7 Property 2)
 *
 * `computeButtonStates`는 입력값의 조합에 따라 세 버튼(시작/중지, 편집, 분석)의
 * 활성 여부와 시작/중지 버튼의 레이블 키를 결정하는 순수 함수이다. 본 테스트는
 * 다섯 개의 이중 함의(bi-conditional)를 각각 독립적으로 검증하여 규칙이 모든
 * 입력 조합에 대해 성립함을 보인다.
 *
 * **Validates: Requirements 3.8, 5.1, 5.2, 6.1, 6.2, 6.3, 6.7, 7.1, 7.2, 7.3, 8.8**
 */

import { describe, test, expect } from "vitest";
import fc from "fast-check";

import type { StreamingState } from "./StreamingStateMachine";
import {
	computeButtonStates,
	type ButtonStateInputs,
} from "./ButtonStatePolicy";

/**
 * 임의의 `ButtonStateInputs`를 생성하는 fast-check 임의값(arbitrary).
 *
 * - `streamingState`: FSM이 노출하는 네 가지 외부 상태 중 하나.
 * - boolean 필드들: `fc.boolean()`.
 * - `transcriptLength`: 음수가 아닌 정수(최대 1,000,000 — 실용적 상한).
 */
const inputsArb: fc.Arbitrary<ButtonStateInputs> = fc.record({
	streamingState: fc.constantFrom<StreamingState>(
		"idle",
		"streaming",
		"stopped",
		"error",
	),
	isAnalyzing: fc.boolean(),
	isEditing: fc.boolean(),
	hasTranscriptNote: fc.boolean(),
	transcriptLength: fc.nat({ max: 1_000_000 }),
	hasCredentials: fc.boolean(),
	hasBedrockModel: fc.boolean(),
});

const NUM_RUNS = 500;

describe("ButtonStatePolicy — Property 2: 버튼 상태 결정 규칙", () => {
	test("startStop.labelKey === 'stop' ⇔ streamingState === 'streaming'", () => {
		fc.assert(
			fc.property(inputsArb, (inputs) => {
				const { startStop } = computeButtonStates(inputs);
				const isStop = startStop.labelKey === "stop";
				const isStreaming = inputs.streamingState === "streaming";
				expect(isStop).toBe(isStreaming);
				// 레이블 키는 두 값 중 하나로만 제한된다.
				expect(
					startStop.labelKey === "start" || startStop.labelKey === "stop",
				).toBe(true);
			}),
			{ numRuns: NUM_RUNS },
		);
	});

	test("startStop.enabled ⇔ !isAnalyzing && !isEditing", () => {
		fc.assert(
			fc.property(inputsArb, (inputs) => {
				const { startStop } = computeButtonStates(inputs);
				const expected = !inputs.isAnalyzing && !inputs.isEditing;
				expect(startStop.enabled).toBe(expected);
			}),
			{ numRuns: NUM_RUNS },
		);
	});

	test("edit.enabled ⇔ hasTranscriptNote && transcriptLength >= 1 && streamingState !== 'streaming' && !isAnalyzing && !isEditing", () => {
		fc.assert(
			fc.property(inputsArb, (inputs) => {
				const { edit } = computeButtonStates(inputs);
				const expected =
					inputs.hasTranscriptNote &&
					inputs.transcriptLength >= 1 &&
					inputs.streamingState !== "streaming" &&
					!inputs.isAnalyzing &&
					!inputs.isEditing;
				expect(edit.enabled).toBe(expected);
			}),
			{ numRuns: NUM_RUNS },
		);
	});

	test("analyze.enabled ⇔ edit.enabled 조건 전체 + hasCredentials && hasBedrockModel", () => {
		fc.assert(
			fc.property(inputsArb, (inputs) => {
				const { edit, analyze } = computeButtonStates(inputs);
				const expected =
					edit.enabled && inputs.hasCredentials && inputs.hasBedrockModel;
				expect(analyze.enabled).toBe(expected);
			}),
			{ numRuns: NUM_RUNS },
		);
	});

	test("newSession.enabled ⇔ (hasTranscriptNote || transcriptLength >= 1) && streamingState !== 'streaming' && !isAnalyzing && !isEditing", () => {
		fc.assert(
			fc.property(inputsArb, (inputs) => {
				const { newSession } = computeButtonStates(inputs);
				const expected =
					(inputs.hasTranscriptNote || inputs.transcriptLength >= 1) &&
					inputs.streamingState !== "streaming" &&
					!inputs.isAnalyzing &&
					!inputs.isEditing;
				expect(newSession.enabled).toBe(expected);
			}),
			{ numRuns: NUM_RUNS },
		);
	});

	test("streamingState === 'streaming' → newSession.enabled === false (스트리밍 중 초기화 차단)", () => {
		const streamingInputsArb = inputsArb.map((inputs) => ({
			...inputs,
			streamingState: "streaming" as StreamingState,
		}));

		fc.assert(
			fc.property(streamingInputsArb, (inputs) => {
				const { newSession } = computeButtonStates(inputs);
				expect(newSession.enabled).toBe(false);
			}),
			{ numRuns: NUM_RUNS },
		);
	});

	test("isAnalyzing === true → 네 버튼 모두 enabled === false", () => {
		// 분석 중 플래그만 true로 강제하고 나머지는 임의 값으로 샘플링한다.
		const analyzingInputsArb = inputsArb.map((inputs) => ({
			...inputs,
			isAnalyzing: true,
		}));

		fc.assert(
			fc.property(analyzingInputsArb, (inputs) => {
				const { startStop, edit, analyze, newSession } =
					computeButtonStates(inputs);
				expect(startStop.enabled).toBe(false);
				expect(edit.enabled).toBe(false);
				expect(analyze.enabled).toBe(false);
				expect(newSession.enabled).toBe(false);
			}),
			{ numRuns: NUM_RUNS },
		);
	});
});
