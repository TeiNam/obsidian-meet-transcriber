/**
 * `Translation_Service` 속성 기반 테스트 (PBT) — Properties 9, 10, 11.
 *
 * design.md §Correctness Properties 의 다음 세 속성을 검증한다:
 *
 * - **Property 9: 번역 큐 표시 순서 안정성**
 *   임의의 N 개 segment 에 대해 비동기 완료 permutation `π` 가 어떻든,
 *   모든 `onResolved` 가 완료된 후의 표시 순서는 항상 `Segment_Id` 단조 증가 순서이다.
 *   본 서비스 자체에서는 placeholder DOM 의 위치 안정성으로 표시 순서가 결정되므로,
 *   `onResolved` 호출이 정확히 enqueue 된 segmentId 의 placeholder 와 매칭됨을 검증한다.
 *   **Validates: Requirement 13.5**
 *
 * - **Property 10: 번역 비용 카운터 단조성**
 *   임의의 sourceText 시퀀스에 대해 매 enqueue 직후 `getCostCounter()` 가 직전 값과
 *   같거나 더 크다. 어떤 호출 시퀀스에서도 카운터는 절대 감소하지 않는다.
 *   **Validates: Requirement 13.9**
 *
 * - **Property 11: Partial 에 대한 번역 호출 금지**
 *   본 서비스는 Partial / Final 분류를 외부에서 받지 않는다 (호출자 책임).
 *   따라서 본 PBT 는 호출자 시뮬레이션을 통해 (Partial, Final) 인터리빙에서
 *   `Translation_Service.enqueue` 가 정확히 Final 의 개수만큼만 호출되며
 *   `TranslateClient.send` 도 동일 횟수만 발사됨을 검증한다.
 *   **Validates: Requirement 13.12**
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from "vitest";
import fc from "fast-check";
import { mockClient } from "aws-sdk-client-mock";
import {
	TranslateClient,
	TranslateTextCommand,
} from "@aws-sdk/client-translate";

import {
	Translation_Service,
	type Translation_Queue_Item,
} from "./Translation_Service";
import type { AwsCredentials } from "../types/settings";

// ---------------------------------------------------------------------------
// 공통 fixture
// ---------------------------------------------------------------------------

const DUMMY_CREDENTIALS: AwsCredentials = {
	accessKeyId: "test-access-key",
	secretAccessKey: "test-secret-key",
};
const DUMMY_REGION = "us-east-1";

/**
 * 모든 `TranslateClient` 인스턴스의 send 를 가로채는 글로벌 mock.
 * `aws-sdk-client-mock` 은 클래스 레벨 패치이므로 `clientFactory` 가 매번 새 인스턴스를
 * 생성해도 송신은 동일 mock 으로 라우팅된다.
 */
const translateMock = mockClient(TranslateClient);

/** `clientFactory` 인자 — 실제 클라이언트를 반환해도 mock 이 가로챈다. */
const realClientFactory = (creds: AwsCredentials, region: string) =>
	new TranslateClient({
		region,
		credentials: {
			accessKeyId: creds.accessKeyId,
			secretAccessKey: creds.secretAccessKey,
		},
	});

/** 빈 placeholder DOM 노드 생성. 본 서비스는 DOM 을 읽지 않으므로 단순 div 로 충분. */
function makePlaceholder(): HTMLElement {
	return document.createElement("div");
}

/**
 * `Translation_Queue_Item` 을 segmentId / sourceText 만으로 빌드한다.
 * 본 PBT 의 모든 케이스는 ko → en 으로 고정 (Property 9/10/11 은 언어 분기와 무관).
 */
function makeItem(
	segmentId: number,
	sourceText: string,
): Translation_Queue_Item {
	return {
		segmentId,
		sourceText,
		sourceLanguage: "ko",
		targetLanguage: "en",
		enqueuedAtMs: 0,
		placeholderEl: makePlaceholder(),
		state: "pending",
	};
}

beforeEach(() => {
	translateMock.reset();
});

afterEach(() => {
	translateMock.reset();
});

afterAll(() => {
	translateMock.restore();
});

// ===========================================================================
// Property 9: 번역 큐 표시 순서 안정성 (Requirement 13.5)
// ===========================================================================

describe("Translation_Service — Property 9: 표시 순서 안정성", () => {
	/**
	 * Feature: local-whisper-and-diarization, Property 9: 번역 큐 표시 순서 안정성.
	 *
	 * 시나리오:
	 *  - N 개의 segment 를 segmentId 1..N 순서로 enqueue.
	 *  - AWS 응답을 임의의 permutation `π` 로 resolve.
	 *  - 모든 `onResolved` 가 완료된 후 (a) 호출 횟수 = N, (b) 호출의 segmentId 집합 = {1..N},
	 *    (c) 각 segmentId 가 자기 자신의 sourceText 와 정확히 매칭됨을 검증.
	 */
	test("임의 permutation resolve 후 onResolved 호출은 enqueue 된 segmentId 와 정확히 매칭된다", async () => {
		await fc.assert(
			fc.asyncProperty(
				// segment 개수 N ∈ [1, 8]: PBT 실행 시간 균형.
				fc.integer({ min: 1, max: 8 }).chain((n) =>
					fc.tuple(
						fc.constant(n),
						// resolve permutation: 0..N-1 의 임의 치환.
						fc.shuffledSubarray(
							Array.from({ length: n }, (_, i) => i),
							{ minLength: n, maxLength: n },
						),
					),
				),
				async ([n, permutation]) => {
					translateMock.reset();

					// Deferred Promise 사전: Text 를 키로 사용 (segment 별 고유 sourceText 부여).
					const pendingByText = new Map<
						string,
						{
							resolve: (v: { TranslatedText: string }) => void;
						}
					>();

					translateMock.on(TranslateTextCommand).callsFake((input) => {
						const text = input.Text as string;
						return new Promise<{ TranslatedText: string }>((resolve) => {
							pendingByText.set(text, { resolve });
						});
					});

					const service = new Translation_Service(realClientFactory);
					const resolvedCalls: { segmentId: number; text: string }[] = [];

					service.beginSession({
						onResolved: (segmentId, text) => {
							resolvedCalls.push({ segmentId, text });
						},
						onRejected: () => undefined,
						onAutoDisabled: () => undefined,
						onCostCounterChanged: () => undefined,
					});

					// 1..N enqueue. 각 sourceText 는 segmentId 를 포함시켜 매칭을 결정 가능하게 만든다.
					for (let i = 0; i < n; i++) {
						const segmentId = i + 1;
						const item = makeItem(segmentId, `text-${segmentId}`);
						service.enqueue(item, {
							credentials: DUMMY_CREDENTIALS,
							region: DUMMY_REGION,
						});
					}

					// permutation 순서로 resolve.
					for (const idx of permutation) {
						const segmentId = idx + 1;
						const text = `text-${segmentId}`;
						const deferred = pendingByText.get(text);
						expect(deferred).toBeDefined();
						deferred?.resolve({
							TranslatedText: `translated-${segmentId}`,
						});
						// fire-and-forget Promise 의 .then 이 microtask queue 에서 실행되도록 yield.
						await Promise.resolve();
						await Promise.resolve();
					}

					// (a) 호출 횟수 = N.
					expect(resolvedCalls.length).toBe(n);

					// (b) 호출된 segmentId 집합 = {1..N}.
					const segmentIdsCalled = new Set(
						resolvedCalls.map((c) => c.segmentId),
					);
					expect(segmentIdsCalled.size).toBe(n);
					for (let i = 1; i <= n; i++) {
						expect(segmentIdsCalled.has(i)).toBe(true);
					}

					// (c) 각 segmentId 가 정확히 자기 자신의 번역 결과와 매칭됨 — 본 서비스가
					//     큐에서 segmentId 를 키로 lookup 하므로 늦게 resolve 된 응답이라도
					//     올바른 segmentId 로 통지되어야 한다.
					for (const call of resolvedCalls) {
						expect(call.text).toBe(`translated-${call.segmentId}`);
					}

					service.endSession();
				},
			),
			{ numRuns: 50 },
		);
	});
});

// ===========================================================================
// Property 10: 번역 비용 카운터 단조성 (Requirement 13.9)
// ===========================================================================

describe("Translation_Service — Property 10: 비용 카운터 단조성", () => {
	/**
	 * Feature: local-whisper-and-diarization, Property 10: 번역 비용 카운터 단조성.
	 *
	 * 시나리오:
	 *  - 임의 길이의 sourceText 시퀀스를 enqueue.
	 *  - 매 enqueue 직후 `getCostCounter()` 가 직전 값보다 작지 않음을 확인.
	 *  - 추가로 codepoint 단위 카운팅이 정확히 적용되어 누적 합 = `Σ [...text].length` 임도 확인.
	 *
	 * 본 PBT 는 비동기 응답에 의존하지 않는다 — 카운터는 enqueue 시점에 즉시 증가한다.
	 */
	test("매 enqueue 직후 cost counter 가 직전 값과 같거나 크고, 누적 합은 codepoint 합과 일치한다", async () => {
		await fc.assert(
			fc.asyncProperty(
				// 1..6 개의 sourceText, 각 0..50 자 (서로게이트 포함 가능).
				fc.array(fc.string({ minLength: 0, maxLength: 50 }), {
					minLength: 1,
					maxLength: 6,
				}),
				async (texts) => {
					translateMock.reset();
					// resolve 는 무한 pending — 카운터는 send 발사 시점에 이미 증가한다.
					translateMock
						.on(TranslateTextCommand)
						.callsFake(() => new Promise(() => undefined));

					const service = new Translation_Service(realClientFactory);
					service.beginSession({
						onResolved: () => undefined,
						onRejected: () => undefined,
						onAutoDisabled: () => undefined,
						onCostCounterChanged: () => undefined,
					});

					let prev = service.getCostCounter();
					expect(prev).toBe(0);

					let expectedSum = 0;
					for (let i = 0; i < texts.length; i++) {
						const text = texts[i];
						service.enqueue(makeItem(i + 1, text), {
							credentials: DUMMY_CREDENTIALS,
							region: DUMMY_REGION,
						});
						const current = service.getCostCounter();
						// 단조 비감소 (Property 10 핵심 진술).
						expect(current).toBeGreaterThanOrEqual(prev);
						expectedSum += [...text].length;
						// 코드포인트 단위 누적합 일치 (codepoint 단위 카운팅 검증).
						expect(current).toBe(expectedSum);
						prev = current;
					}

					service.endSession();
				},
			),
			{ numRuns: 100 },
		);
	});
});

// ===========================================================================
// Property 11: Partial 에 대한 번역 호출 금지 (Requirement 13.12)
// ===========================================================================

describe("Translation_Service — Property 11: Partial 호출 금지", () => {
	/**
	 * Feature: local-whisper-and-diarization, Property 11: Partial 에 대한 번역 호출 금지.
	 *
	 * 본 서비스는 Partial / Final 분류 자체를 받지 않는다 (호출자가 Final 만 enqueue 한다).
	 * 따라서 본 PBT 는 호출자 시뮬레이션을 통해 다음을 검증한다:
	 *  - Partial 이벤트는 `service.enqueue` 를 호출하지 않는다.
	 *  - Final 이벤트는 정확히 1 회 `service.enqueue` 를 호출한다.
	 *  - 결과적으로 `TranslateClient.send` 호출 수 = Final 이벤트 수 = `enqueue` 호출 수.
	 */
	test("(Partial, Final) 임의 인터리빙에서 enqueue 와 send 호출 수는 정확히 Final 개수와 같다", async () => {
		await fc.assert(
			fc.asyncProperty(
				// 이벤트 시퀀스: true=Final, false=Partial. 1..15 개.
				fc.array(fc.boolean(), { minLength: 1, maxLength: 15 }),
				async (isFinalSequence) => {
					translateMock.reset();
					// resolve 는 무한 pending — 호출 횟수만 검증.
					translateMock
						.on(TranslateTextCommand)
						.callsFake(() => new Promise(() => undefined));

					const service = new Translation_Service(realClientFactory);
					service.beginSession({
						onResolved: () => undefined,
						onRejected: () => undefined,
						onAutoDisabled: () => undefined,
						onCostCounterChanged: () => undefined,
					});

					let nextSegmentId = 1;
					let finalCount = 0;
					let enqueueCallCount = 0;

					// 호출자 시뮬레이션: Partial 은 enqueue 하지 않고, Final 만 enqueue 한다.
					// 본 분기는 main.ts (task 27) 의 onPartial / onFinalSegment 분기와 동치이다.
					for (const isFinal of isFinalSequence) {
						if (isFinal) {
							finalCount++;
							service.enqueue(
								makeItem(nextSegmentId++, `text-${finalCount}`),
								{
									credentials: DUMMY_CREDENTIALS,
									region: DUMMY_REGION,
								},
							);
							enqueueCallCount++;
						}
						// Partial 의 경우 아무것도 호출하지 않음 (Requirement 13.12).
					}

					// (a) 호출자 측에서 enqueue 가 정확히 Final 의 개수만큼 호출됨.
					expect(enqueueCallCount).toBe(finalCount);

					// (b) `TranslateClient.send` 가 Final 의 개수만큼 발사됨.
					const sendCalls = translateMock.commandCalls(TranslateTextCommand);
					expect(sendCalls.length).toBe(finalCount);

					service.endSession();
				},
			),
			{ numRuns: 100 },
		);
	});
});
