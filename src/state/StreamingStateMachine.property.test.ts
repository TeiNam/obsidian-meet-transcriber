/**
 * StreamingStateMachine Property 1: 상태 머신 전이 규칙 속성 테스트.
 *
 * design.md §"Correctness Properties / Property 1" 전이 규칙을 fast-check로 검증한다.
 *
 * **Validates: Requirements 3.3, 3.10, 3.11, 4.1, 7.5, 7.6, 8.7**
 *
 * 설계 방침:
 * - 각 bullet을 독립적인 `test`로 분리하여 실패 시 어느 규칙이 깨졌는지 즉시 식별되도록 한다.
 * - `StreamingEvent` 유니온 전체를 덮는 임의 생성기(`eventArb`)를 구성하고,
 *   `fc.array(eventArb, { maxLength: 30 })`로 중간 시퀀스의 간섭을 시뮬레이션한다.
 * - 초기 상태는 `fc.constantFrom<StreamingState>`로 4개 관찰 가능한 상태 전부에서 시작한다.
 * - "정의되지 않은 전이" 속성은 리스너 호출 여부까지 검사하여 "부작용 없음"을 엄격히 검증한다.
 */

import fc from "fast-check";
import { describe, expect, test } from "vitest";
import {
	IllegalTransitionError,
	type StreamingEvent,
	type StreamingState,
	StreamingStateMachine,
} from "./StreamingStateMachine";

// 관찰 가능한 외부 상태 4종.
const stateArb: fc.Arbitrary<StreamingState> = fc.constantFrom<StreamingState>(
	"idle",
	"streaming",
	"stopped",
	"error",
);

// `StreamingEvent` 유니온의 모든 variant를 덮는 생성기.
// `SESSION_FAILED`만 `reason` 페이로드를 가지므로 별도로 생성한다.
const eventArb: fc.Arbitrary<StreamingEvent> = fc.oneof(
	fc.constant<StreamingEvent>({ type: "START_REQUESTED" }),
	fc.constant<StreamingEvent>({ type: "SESSION_ESTABLISHED" }),
	fc
		.string({ maxLength: 50 })
		.map<StreamingEvent>((reason) => ({ type: "SESSION_FAILED", reason })),
	fc.constant<StreamingEvent>({ type: "STOP_REQUESTED" }),
	fc.constant<StreamingEvent>({ type: "SESSION_CLOSED" }),
	fc.constant<StreamingEvent>({ type: "CONNECTION_LOST" }),
	fc.constant<StreamingEvent>({ type: "RECONNECT_SUCCEEDED" }),
	fc.constant<StreamingEvent>({ type: "RECONNECT_EXHAUSTED" }),
	fc.constant<StreamingEvent>({ type: "RESET" }),
);

// 정의된(유효한) 전이 테이블.
// design.md §"전이 테이블"에서 해당 state × event.type이 명시적으로 기술된 조합.
// 이 외의 조합은 "정의되지 않은 전이"로 간주한다.
const VALID_TRANSITIONS: Readonly<
	Record<StreamingState, ReadonlySet<StreamingEvent["type"]>>
> = {
	idle: new Set<StreamingEvent["type"]>([
		"START_REQUESTED",
		"SESSION_ESTABLISHED",
		"SESSION_FAILED",
	]),
	streaming: new Set<StreamingEvent["type"]>([
		"STOP_REQUESTED",
		"START_REQUESTED",
		"CONNECTION_LOST",
		"RECONNECT_SUCCEEDED",
		"RECONNECT_EXHAUSTED",
	]),
	stopped: new Set<StreamingEvent["type"]>(["SESSION_CLOSED"]),
	error: new Set<StreamingEvent["type"]>(["RESET"]),
};

function isUndefinedTransition(
	state: StreamingState,
	event: StreamingEvent,
): boolean {
	return !VALID_TRANSITIONS[state].has(event.type);
}

describe("StreamingStateMachine — Property 1: 상태 머신 전이 규칙", () => {
	// Bullet 1: idle + START_REQUESTED + SESSION_ESTABLISHED → streaming
	test("idle에서 START_REQUESTED 후 SESSION_ESTABLISHED를 수신하면 streaming으로 전이된다", () => {
		fc.assert(
			fc.property(fc.constant(null), () => {
				const sm = new StreamingStateMachine("idle");
				sm.dispatch({ type: "START_REQUESTED" });
				// START_REQUESTED는 idle에서 외부 상태를 유지해야 한다(내부 pendingStart만 set).
				expect(sm.getState()).toBe<StreamingState>("idle");

				sm.dispatch({ type: "SESSION_ESTABLISHED" });
				expect(sm.getState()).toBe<StreamingState>("streaming");
				// 신선하게 수립된 세션이므로 재연결 플래그는 off.
				expect(sm.isReconnecting()).toBe(false);
			}),
			{ numRuns: 200 },
		);
	});

	// Bullet 2: idle + SESSION_FAILED → error
	test("idle에서 SESSION_FAILED를 수신하면 error로 전이된다", () => {
		fc.assert(
			fc.property(fc.string({ maxLength: 100 }), (reason) => {
				const sm = new StreamingStateMachine("idle");
				sm.dispatch({ type: "SESSION_FAILED", reason });
				expect(sm.getState()).toBe<StreamingState>("error");
				expect(sm.isReconnecting()).toBe(false);
			}),
			{ numRuns: 200 },
		);
	});

	// Bullet 3: streaming + STOP_REQUESTED → stopped
	test("streaming에서 STOP_REQUESTED를 수신하면 stopped로 전이된다", () => {
		fc.assert(
			fc.property(fc.boolean(), (wasReconnecting) => {
				const sm = new StreamingStateMachine("streaming");
				// 재연결 중이었던 케이스도 포함해 테스트한다.
				if (wasReconnecting) {
					sm.dispatch({ type: "CONNECTION_LOST" });
					expect(sm.isReconnecting()).toBe(true);
				}
				sm.dispatch({ type: "STOP_REQUESTED" });
				expect(sm.getState()).toBe<StreamingState>("stopped");
				// STOP_REQUESTED는 재연결 플래그를 리셋해야 한다(design 전이 테이블).
				expect(sm.isReconnecting()).toBe(false);
			}),
			{ numRuns: 200 },
		);
	});

	// Bullet 4: streaming + START_REQUESTED → streaming (단일 세션 불변식)
	test("streaming에서 START_REQUESTED를 반복해도 streaming을 유지한다 (단일 세션 불변식)", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 1, max: 20 }),
				fc.boolean(),
				(repeat, withReconnectingMid) => {
					const sm = new StreamingStateMachine("streaming");
					if (withReconnectingMid) {
						sm.dispatch({ type: "CONNECTION_LOST" });
					}
					const reconnectingBefore = sm.isReconnecting();

					for (let i = 0; i < repeat; i++) {
						sm.dispatch({ type: "START_REQUESTED" });
					}

					expect(sm.getState()).toBe<StreamingState>("streaming");
					// START_REQUESTED는 streaming에서 부작용이 없어야 하므로
					// 재연결 플래그 역시 이전 값 그대로 유지된다.
					expect(sm.isReconnecting()).toBe(reconnectingBefore);
				},
			),
			{ numRuns: 200 },
		);
	});

	// Bullet 5: streaming + CONNECTION_LOST → isReconnecting()=true, 외부 상태 streaming
	test("streaming에서 CONNECTION_LOST를 수신하면 외부 상태는 streaming을 유지하면서 isReconnecting()이 true가 된다", () => {
		fc.assert(
			fc.property(fc.integer({ min: 1, max: 10 }), (repeat) => {
				const sm = new StreamingStateMachine("streaming");
				// CONNECTION_LOST를 여러 번 보내도 동일하게 재연결 플래그가 true여야 한다(멱등성).
				for (let i = 0; i < repeat; i++) {
					sm.dispatch({ type: "CONNECTION_LOST" });
				}
				expect(sm.getState()).toBe<StreamingState>("streaming");
				expect(sm.isReconnecting()).toBe(true);
			}),
			{ numRuns: 200 },
		);
	});

	// Bullet 6: reconnecting + RECONNECT_EXHAUSTED → error
	test("재연결 중(streaming + CONNECTION_LOST) 상태에서 RECONNECT_EXHAUSTED를 수신하면 error로 전이된다", () => {
		fc.assert(
			fc.property(fc.integer({ min: 1, max: 5 }), (lostRepeats) => {
				const sm = new StreamingStateMachine("streaming");
				for (let i = 0; i < lostRepeats; i++) {
					sm.dispatch({ type: "CONNECTION_LOST" });
				}
				expect(sm.isReconnecting()).toBe(true);

				sm.dispatch({ type: "RECONNECT_EXHAUSTED" });
				expect(sm.getState()).toBe<StreamingState>("error");
				// error로 전이될 때 재연결 플래그는 리셋되어야 한다(design).
				expect(sm.isReconnecting()).toBe(false);
			}),
			{ numRuns: 200 },
		);
	});

	// Bullet 7: Undefined event/state combinations → 상태 불변 OR IllegalTransitionError, 부작용 없음
	test("정의되지 않은 (state, event) 조합은 상태를 변경하지 않고 리스너를 호출하지 않는다", () => {
		fc.assert(
			fc.property(stateArb, eventArb, (initial, event) => {
				fc.pre(isUndefinedTransition(initial, event));

				const sm = new StreamingStateMachine(initial);
				// 하위 플래그까지 "부작용 없음"을 검증하기 위해 리스너 호출 여부를 캡처한다.
				let listenerCalled = false;
				sm.onChange(() => {
					listenerCalled = true;
				});

				const stateBefore = sm.getState();
				const reconnectingBefore = sm.isReconnecting();

				// 현재 구현은 silent 정책이므로 throw하지 않지만,
				// 설계 문서에 따라 `IllegalTransitionError`를 던지는 구현도 허용한다.
				try {
					sm.dispatch(event);
				} catch (err) {
					// 엄격 구현이라면 IllegalTransitionError만 허용되어야 한다.
					expect(err).toBeInstanceOf(IllegalTransitionError);
				}

				// 어느 정책이든 외부 상태와 재연결 플래그, 리스너 호출은 모두 불변이어야 한다.
				expect(sm.getState()).toBe(stateBefore);
				expect(sm.isReconnecting()).toBe(reconnectingBefore);
				expect(listenerCalled).toBe(false);
			}),
			{ numRuns: 200 },
		);
	});

	// 추가 안정성 검증: 임의 이벤트 시퀀스를 가해도 항상 유효한 상태로 수렴하고
	// `isReconnecting()`이 true인 순간에는 외부 상태가 반드시 "streaming"이어야 한다
	// (bullet 5를 시퀀스 전체에 걸쳐 강화한 invariant — Requirements 3.11, 7.6).
	test("임의의 이벤트 시퀀스에서 isReconnecting()이 true이면 외부 상태는 항상 streaming이다", () => {
		fc.assert(
			fc.property(
				stateArb,
				fc.array(eventArb, { maxLength: 30 }),
				(initial, events) => {
					const sm = new StreamingStateMachine(initial);
					for (const ev of events) {
						sm.dispatch(ev);
						if (sm.isReconnecting()) {
							expect(sm.getState()).toBe<StreamingState>("streaming");
						}
						expect(["idle", "streaming", "stopped", "error"]).toContain(
							sm.getState(),
						);
					}
				},
			),
			{ numRuns: 200 },
		);
	});
});
