/**
 * `mapSpeakerLabel` 속성 테스트 (Property-Based Tests).
 *
 * 본 파일은 `design.md §Correctness Properties` 의 다음 정확성 속성을 검증한다.
 *
 * - Property 3: 화자 라벨 매핑 안정성 (Validates Requirements 6.4, 12.3)
 *
 * Property 3 은 다음 4 개 invariant 으로 분리하여 검증한다.
 *
 * 1. **안정성 (stability)** — 같은 raw label 을 동일 세션 내에서 여러 번 호출하면
 *    항상 같은 displayLabel 을 반환한다.
 * 2. **Injectivity** — 서로 다른 raw label 은 서로 다른 displayLabel 로 매핑된다.
 * 3. **첫 등장 순서대로 인덱스 부여** — 신규 raw label 은 첫 등장 순서대로
 *    `Speaker 1`, `Speaker 2`, ... 가 부여된다.
 * 4. **Immutability** — 입력 `sessionState` 는 변형되지 않는다(원본의 `mapping` 과
 *    `nextIndex` 가 호출 전후로 변하지 않음).
 *
 * `fast-check` 3.x API 를 사용하며, 각 `fc.assert` 는 `numRuns: 200` 으로 충분한 샘플을
 * 확보한다.
 */

import { describe, test, expect } from "vitest";
import fc from "fast-check";
import {
	createInitialSpeakerLabelSessionState,
	mapSpeakerLabel,
	type Speaker_Label_Session_State,
} from "./mapSpeakerLabel";

/**
 * Raw 화자 식별자(`spk_0`, `spk_1`, ...) 를 무작위로 생성하는 fast-check arbitrary.
 *
 * AWS Transcribe Streaming 의 실제 형식에 가까운 입력을 생성하면서도, 다양한 식별자
 * (10 종류) 를 시퀀스 안에 반복 등장시켜 캐시 hit/miss 가 충분히 발생하도록 한다.
 */
const RAW_LABEL_ARB: fc.Arbitrary<string> = fc.constantFrom(
	"spk_0",
	"spk_1",
	"spk_2",
	"spk_3",
	"spk_4",
	"spk_5",
	"spk_6",
	"spk_7",
	"spk_8",
	"spk_9",
);

/**
 * Raw 화자 식별자 시퀀스(1 개 이상) 를 생성하는 arbitrary.
 *
 * 단일 호출에 대한 trivial case 를 피하기 위해 `minLength: 1` 을 보장하고, 캐시 동작과
 * 인덱스 단조 증가를 검증할 수 있도록 `maxLength: 50` 까지 허용한다.
 */
const RAW_LABEL_SEQUENCE_ARB: fc.Arbitrary<string[]> = fc.array(RAW_LABEL_ARB, {
	minLength: 1,
	maxLength: 50,
});

/**
 * raw label 시퀀스를 순회하며 `mapSpeakerLabel` 을 누적 호출한 결과를 모은다.
 *
 * @param sequence raw label 시퀀스.
 * @returns 호출별 displayLabel 배열과 마지막 sessionState.
 */
function runSequence(sequence: ReadonlyArray<string>): {
	displayLabels: string[];
	finalState: Speaker_Label_Session_State;
} {
	let state = createInitialSpeakerLabelSessionState();
	const displayLabels: string[] = [];
	for (const raw of sequence) {
		const result = mapSpeakerLabel(raw, state);
		displayLabels.push(result.displayLabel);
		state = result.sessionState;
	}
	return { displayLabels, finalState: state };
}

describe("mapSpeakerLabel — Property 3: 화자 라벨 매핑 안정성 (Validates Requirements 6.4, 12.3)", () => {
	test("안정성 — 같은 raw label 은 항상 같은 displayLabel 을 반환한다", () => {
		fc.assert(
			fc.property(RAW_LABEL_SEQUENCE_ARB, (sequence) => {
				const { displayLabels } = runSequence(sequence);
				// 시퀀스를 순회하며 raw → display 매핑을 누적한다. 한 raw 가 두 번 이상 등장
				// 하면 모든 등장에서의 display 가 동일해야 한다.
				const seen = new Map<string, string>();
				for (let i = 0; i < sequence.length; i++) {
					const raw = sequence[i];
					const display = displayLabels[i];
					const previous = seen.get(raw);
					if (previous !== undefined) {
						expect(display).toBe(previous);
					} else {
						seen.set(raw, display);
					}
				}
			}),
			{ numRuns: 200 },
		);
	});

	test("Injectivity — 서로 다른 raw label 은 서로 다른 displayLabel 로 매핑된다", () => {
		fc.assert(
			fc.property(RAW_LABEL_SEQUENCE_ARB, (sequence) => {
				const { displayLabels } = runSequence(sequence);
				// 시퀀스 내 각 raw label 의 첫 등장에서 부여된 display 들끼리는 서로 달라야
				// 한다(injective). 두 번째 이상 등장은 캐시 hit 이므로 비교 대상이 아니다.
				const firstAppearance = new Map<string, string>();
				for (let i = 0; i < sequence.length; i++) {
					const raw = sequence[i];
					if (!firstAppearance.has(raw)) {
						firstAppearance.set(raw, displayLabels[i]);
					}
				}
				const uniqueDisplays = new Set(firstAppearance.values());
				expect(uniqueDisplays.size).toBe(firstAppearance.size);
			}),
			{ numRuns: 200 },
		);
	});

	test("첫 등장 순서대로 Speaker 1, Speaker 2, ... 가 부여된다", () => {
		fc.assert(
			fc.property(RAW_LABEL_SEQUENCE_ARB, (sequence) => {
				const { displayLabels } = runSequence(sequence);
				// 시퀀스를 순회하며 신규 raw 가 등장한 순서대로 `Speaker 1`, `Speaker 2`, ...
				// 가 부여되는지 확인한다.
				let nextExpectedIndex = 1;
				const seen = new Set<string>();
				for (let i = 0; i < sequence.length; i++) {
					const raw = sequence[i];
					if (!seen.has(raw)) {
						expect(displayLabels[i]).toBe(`Speaker ${nextExpectedIndex}`);
						seen.add(raw);
						nextExpectedIndex += 1;
					}
				}
			}),
			{ numRuns: 200 },
		);
	});

	test("Immutability — 입력 sessionState 는 변형되지 않는다", () => {
		fc.assert(
			fc.property(RAW_LABEL_SEQUENCE_ARB, (sequence) => {
				let state = createInitialSpeakerLabelSessionState();
				for (const raw of sequence) {
					// 호출 직전 state 의 스냅샷을 만든다(Map 의 복사 + nextIndex 보존).
					const snapshotMapping = new Map(state.mapping);
					const snapshotNextIndex = state.nextIndex;

					const result = mapSpeakerLabel(raw, state);

					// 입력 state 의 mapping 과 nextIndex 가 호출 전후로 변하지 않아야 한다.
					expect(state.nextIndex).toBe(snapshotNextIndex);
					expect(state.mapping.size).toBe(snapshotMapping.size);
					for (const [key, value] of snapshotMapping) {
						expect(state.mapping.get(key)).toBe(value);
					}

					state = result.sessionState;
				}
			}),
			{ numRuns: 200 },
		);
	});
});
