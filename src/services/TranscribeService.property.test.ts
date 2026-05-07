/**
 * `TranscribeService` 속성 테스트 2종 (Task 12.2).
 *
 * design.md §"Correctness Properties" 중 Property 12, 13을 `fast-check`로 검증한다.
 *
 * - **Property 12: 단일 Transcribe 세션 불변식**
 *   임의의 `start` / `stop` 호출 시퀀스 동안 동시에 존재하는 활성 세션 수는 항상 0 또는 1.
 *   관찰 가능한 지표로 `StartStreamTranscriptionCommand` 의 `send` 중첩 호출 수
 *   (send 진입 ~ 결과 스트림 소진)를 사용한다.
 *   **Validates: Requirement 7.5 (7.6 연계)**
 *
 * - **Property 13: 재연결 시도 횟수 상한**
 *   임의의 `CONNECTION_LOST` 시나리오에서 `onReconnectAttempt` 호출 수는 2 이하.
 *   `attempts === 2` 후 모두 실패 시 `onSessionError("reconnect_exhausted")` 가 호출되고
 *   활성 세션이 정리되어 후속 `start()` 가 `"already_active"` 로 거부되지 않아야 한다.
 *   **Validates: Requirements 8.5, 8.7**
 *
 * ## 테스트 전략
 * - `aws-sdk-client-mock` 의 `mockClient(TranscribeStreamingClient)` 로 모든 SDK 인스턴스의
 *   `send` 를 가로챈다. `TranscribeService` 의 `clientFactory` 가 실제 SDK 객체를 생성하더라도
 *   가로채기가 유지되므로 세션 수명주기를 결정적으로 주입할 수 있다.
 * - `AudioCapture` 는 구조 호환 더미 객체로 대체한다. JSDOM 에서 AudioWorklet/AudioContext 을
 *   실제로 실행할 수 없으므로 불가피한 선택이며, `TranscribeService` 는 `requestPermission`,
 *   `pcmChunks`, `stop` 이 세 메서드만 사용한다.
 * - `reconnectDelayMs`, `sessionEstablishTimeoutMs`, `stopTimeoutMs` 를 작게 설정해
 *   fc 속성 테스트의 총 소요 시간을 현실적 범위에 유지한다.
 * - `console.error` 는 서비스가 예외 로깅에 사용하므로 spy 로 가로채 테스트 출력 소음을 없앤다.
 *
 * ## 심사 준수
 * - 테스트 자격 증명은 의도가 드러나는 더미 문자열만 사용하고, 외부 네트워크 접근을 수행하지 않는다.
 * - `console.error` 는 프로덕션 로깅 경로를 그대로 두되 출력은 억제한다.
 */

import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	test,
	vi,
} from "vitest";
import fc from "fast-check";
import { mockClient } from "aws-sdk-client-mock";
import {
	StartStreamTranscriptionCommand,
	TranscribeStreamingClient,
	type TranscriptResultStream,
} from "@aws-sdk/client-transcribe-streaming";

import { TranscribeService } from "./TranscribeService";
import type {
	StartParams,
	TranscribeCallbacks,
	TranscribeClientFactory,
} from "./TranscribeService";
import type { AudioCapture } from "./AudioCapture";
import type { AwsCredentials } from "../types/settings";

// ---------------------------------------------------------------------------
// 공통 상수 및 헬퍼
// ---------------------------------------------------------------------------

/** 테스트용 더미 자격 증명 — mockClient 가 실제 네트워크 전송을 가로챈다. */
const DUMMY_CREDENTIALS: AwsCredentials = {
	accessKeyId: "test-access-key-id",
	secretAccessKey: "test-secret-access-key",
};

const DUMMY_REGION = "us-east-1";

/**
 * `TranscribeService` 는 구조적으로 `MediaStream` 에 접근하지 않고 그대로
 * `AudioCapture.stop(stream)` 에 전달하기만 한다. JSDOM 에 `MediaStream` 이 없으므로
 * 최소 구조의 가짜 객체를 사용한다.
 */
function makeFakeStream(): MediaStream {
	return {
		getTracks: () => [],
	} as unknown as MediaStream;
}

/**
 * `AudioCapture` 인터페이스를 구조적으로 만족하는 더미.
 * - `requestPermission` 은 즉시 해소되어 start() 의 await 경로를 단축시킨다.
 * - `pcmChunks` 는 5ms 간격으로 더미 PCM 청크를 무한 yield 한다. Transcribe 세션이
 *   정상적으로 종료(stop/abort)되면 generator 도 break 되어 누수가 없다.
 * - `stop` 은 no-op — 실제 트랙이 없기 때문이다.
 */
function makeMockAudioCapture(): AudioCapture {
	return {
		async requestPermission(): Promise<MediaStream> {
			return makeFakeStream();
		},
		async *pcmChunks(_stream: MediaStream): AsyncIterable<Uint8Array> {
			while (true) {
				await new Promise((resolve) => setTimeout(resolve, 5));
				yield new Uint8Array(320);
			}
		},
		stop(_stream: MediaStream): void {},
	} as unknown as AudioCapture;
}

/** 실제 `TranscribeStreamingClient` 를 반환하는 팩토리 — mockClient 가 가로챈다. */
const realClientFactory: TranscribeClientFactory = (creds, region) =>
	new TranscribeStreamingClient({
		region,
		credentials: {
			accessKeyId: creds.accessKeyId,
			secretAccessKey: creds.secretAccessKey,
		},
	});

/** 특정 콜백만 덮어쓰기 편하도록 no-op 기본 콜백 묶음을 제공. */
function emptyCallbacks(
	overrides: Partial<TranscribeCallbacks> = {},
): TranscribeCallbacks {
	return {
		onPartial: () => {},
		onFinal: () => {},
		onSessionEstablished: () => {},
		onSessionError: () => {},
		onReconnectAttempt: () => {},
		onConnectionLost: () => {},
		...overrides,
	};
}

/** 공통 `StartParams` — 언어 코드/리전 등은 서비스 내부에서만 사용되므로 고정. */
function makeStartParams(callbacks: TranscribeCallbacks): StartParams {
	return {
		credentials: DUMMY_CREDENTIALS,
		region: DUMMY_REGION,
		languageCode: "en-US",
		callbacks,
	};
}

/** polling 기반 조건 대기 헬퍼. JSDOM 환경에서 promise microtask 배수를 안정적으로 드레인한다. */
async function waitFor(
	predicate: () => boolean,
	timeoutMs: number = 2_000,
	intervalMs: number = 10,
): Promise<boolean> {
	const startedAt = Date.now();
	while (!predicate()) {
		if (Date.now() - startedAt > timeoutMs) {
			return false;
		}
		await new Promise((resolve) => setTimeout(resolve, intervalMs));
	}
	return true;
}

/**
 * "final" 하나를 포함한 `TranscriptResultStream` 이벤트 객체 생성.
 *
 * `TranscribeService.handleTranscriptResultStreamEvent` 가 이 형식을 Partial/Final 로 분기한다.
 */
function makeFinalEvent(text: string): TranscriptResultStream {
	return {
		TranscriptEvent: {
			Transcript: {
				Results: [
					{
						Alternatives: [{ Transcript: text }],
						IsPartial: false,
					},
				],
			},
		},
	} as TranscriptResultStream;
}

// ---------------------------------------------------------------------------
// SDK 전역 목 — describe 블록 간 공유하되 각 테스트에서 reset 한다
// ---------------------------------------------------------------------------

const transcribeMock = mockClient(TranscribeStreamingClient);

// ---------------------------------------------------------------------------
// Property 12: 단일 Transcribe 세션 불변식
// ---------------------------------------------------------------------------

describe("TranscribeService — Property 12: 단일 세션 불변식", () => {
	let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		transcribeMock.reset();
		consoleErrorSpy = vi
			.spyOn(console, "error")
			.mockImplementation(() => undefined) as typeof consoleErrorSpy;
	});

	afterEach(() => {
		consoleErrorSpy.mockRestore();
	});

	afterAll(() => {
		transcribeMock.restore();
	});

	test(
		"임의의 start/stop 시퀀스에 대해 동시 활성 세션 수는 항상 0 또는 1",
		async () => {
			await fc.assert(
				fc.asyncProperty(
					// "start" | "stop" 연산의 임의 시퀀스.
					// 길이를 8 이하로 제한해 fc.numRuns * maxLength 총 연산 수를 관리한다.
					fc.array(fc.constantFrom<"start" | "stop">("start", "stop"), {
						minLength: 1,
						maxLength: 8,
					}),
					async (ops) => {
						// fc 실행 간 간섭을 막기 위해 mock 핸들러와 카운터를 로컬로 재등록한다.
						transcribeMock.reset();

						/** 현재 진행 중인 `send` 수(= "활성 세션"의 관찰 지표). */
						let concurrentSends = 0;
						/** 본 실행 내 관찰된 최댓값. 최종 assert 에 사용. */
						let maxConcurrentSends = 0;

						transcribeMock
							.on(StartStreamTranscriptionCommand)
							.callsFake(async () => {
								concurrentSends += 1;
								if (concurrentSends > maxConcurrentSends) {
									maxConcurrentSends = concurrentSends;
								}

								// `TranscriptResultStream` 은 AsyncIterable. 서비스가 `for await` 로
								// 소비하는 동안 세션이 "활성"으로 간주된다.
								const stream: AsyncIterable<TranscriptResultStream> = {
									async *[Symbol.asyncIterator](): AsyncIterator<TranscriptResultStream> {
										try {
											yield makeFinalEvent("hello");
											// 세션이 바로 끝나 버리면 stop/start 교차를 관찰할 수 없으므로
											// 잠시 살아 있도록 대기한다. stop() 호출로 stopRequested 가
											// true 가 되면 서비스가 for-await 루프에서 break 한다.
											await new Promise((resolve) =>
												setTimeout(resolve, 40),
											);
										} finally {
											concurrentSends -= 1;
										}
									},
								};

								return {
									TranscriptResultStream: stream,
								} as unknown as Awaited<
									ReturnType<
										InstanceType<
											typeof TranscribeStreamingClient
										>["send"]
									>
								>;
							});

						const service = new TranscribeService(
							makeMockAudioCapture(),
							realClientFactory,
							{
								sessionEstablishTimeoutMs: 500,
								stopTimeoutMs: 200,
								reconnectDelayMs: 20,
								maxReconnectAttempts: 2,
							},
						);

						const callbacks = emptyCallbacks();

						try {
							for (const op of ops) {
								if (op === "start") {
									await service.start(makeStartParams(callbacks));
								} else {
									await service.stop(200);
								}

								// 각 연산 직후 불변식 확인. 비동기 pending 작업을 약간 드레인해
								// concurrentSends 카운터가 정상 반영된 시점에서 검사.
								await new Promise((resolve) => setTimeout(resolve, 10));
								expect(concurrentSends).toBeGreaterThanOrEqual(0);
								expect(concurrentSends).toBeLessThanOrEqual(1);
							}
						} finally {
							// 서비스 해제 + pending generator finally 배수 드레인.
							service.dispose();
							await new Promise((resolve) => setTimeout(resolve, 80));
						}

						// 실행 전체에서 관찰된 최댓값도 1 이하여야 한다.
						expect(maxConcurrentSends).toBeLessThanOrEqual(1);
					},
				),
				{ numRuns: 15 },
			);
		},
		30_000,
	);

	test(
		"이미 활성 세션이 있으면 두 번째 start() 는 onSessionError('already_active') 후 send 를 추가 호출하지 않는다",
		async () => {
			// 예시 테스트로 Property 12 의 핵심 메커니즘(단일 세션 가드)을 명시적으로 검증한다.
			let sendCount = 0;

			transcribeMock.reset();
			transcribeMock.on(StartStreamTranscriptionCommand).callsFake(async () => {
				sendCount += 1;
				const stream: AsyncIterable<TranscriptResultStream> = {
					async *[Symbol.asyncIterator](): AsyncIterator<TranscriptResultStream> {
						yield makeFinalEvent("hello");
						await new Promise((resolve) => setTimeout(resolve, 100));
					},
				};
				return {
					TranscriptResultStream: stream,
				} as unknown as Awaited<
					ReturnType<InstanceType<typeof TranscribeStreamingClient>["send"]>
				>;
			});

			const errorReasons: string[] = [];
			const callbacks = emptyCallbacks({
				onSessionError: (reason) => errorReasons.push(reason),
			});

			const service = new TranscribeService(
				makeMockAudioCapture(),
				realClientFactory,
				{
					sessionEstablishTimeoutMs: 500,
					stopTimeoutMs: 200,
					reconnectDelayMs: 20,
					maxReconnectAttempts: 2,
				},
			);

			try {
				await service.start(makeStartParams(callbacks));
				// 두 번째 start — activeSession 이 존재하므로 즉시 거부되어야 한다.
				await service.start(makeStartParams(callbacks));

				// 첫 start 로 인한 send 가 미루어졌을 수 있으므로 짧게 드레인 후 확인.
				await new Promise((resolve) => setTimeout(resolve, 30));

				expect(errorReasons).toContain("already_active");
				expect(sendCount).toBeLessThanOrEqual(1);
			} finally {
				service.dispose();
				await new Promise((resolve) => setTimeout(resolve, 80));
			}
		},
		10_000,
	);
});

// ---------------------------------------------------------------------------
// Property 13: 재연결 시도 횟수 상한
// ---------------------------------------------------------------------------

describe("TranscribeService — Property 13: 재연결 시도 횟수 상한", () => {
	let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		transcribeMock.reset();
		consoleErrorSpy = vi
			.spyOn(console, "error")
			.mockImplementation(() => undefined) as typeof consoleErrorSpy;
	});

	afterEach(() => {
		consoleErrorSpy.mockRestore();
	});

	afterAll(() => {
		transcribeMock.restore();
	});

	test(
		"임의의 CONNECTION_LOST 실패 패턴에서 onReconnectAttempt 호출 수는 항상 2 이하",
		async () => {
			await fc.assert(
				fc.asyncProperty(
					// 재연결 시도마다 적용할 실패 모드의 임의 시퀀스.
					// - "reject": client.send() 가 즉시 reject (네트워크/자격 증명 류)
					// - "stream-throws": 1 이벤트 수신 후 스트림이 throw (중도 단절)
					// - "stream-ends": 1 이벤트 수신 후 스트림이 조용히 종료
					fc.array(
						fc.constantFrom<"reject" | "stream-throws" | "stream-ends">(
							"reject",
							"stream-throws",
							"stream-ends",
						),
						{ minLength: 1, maxLength: 4 },
					),
					async (reconnectModes) => {
						transcribeMock.reset();

						// 첫 세션은 항상 "1 이벤트 후 throw" 로 시작해 CONNECTION_LOST 경로를 유발.
						// 이후 send 호출부터 reconnectModes 순서대로 시뮬레이션한다.
						let sendIdx = 0;

						transcribeMock
							.on(StartStreamTranscriptionCommand)
							.callsFake(async () => {
								const current = sendIdx++;

								// 0번째 send = 초기 세션. 1 이벤트 후 throw.
								if (current === 0) {
									const stream: AsyncIterable<TranscriptResultStream> = {
										async *[Symbol.asyncIterator](): AsyncIterator<TranscriptResultStream> {
											yield makeFinalEvent("hello");
											throw new Error(
												"simulated initial connection loss",
											);
										},
									};
									return {
										TranscriptResultStream: stream,
									} as unknown as Awaited<
										ReturnType<
											InstanceType<
												typeof TranscribeStreamingClient
											>["send"]
										>
									>;
								}

								const mode =
									reconnectModes[
										Math.min(
											current - 1,
											reconnectModes.length - 1,
										)
									];

								if (mode === "reject") {
									throw new Error("simulated reconnect reject");
								}

								if (mode === "stream-throws") {
									const stream: AsyncIterable<TranscriptResultStream> = {
										async *[Symbol.asyncIterator](): AsyncIterator<TranscriptResultStream> {
											yield makeFinalEvent("retry");
											throw new Error(
												"simulated reconnect stream throw",
											);
										},
									};
									return {
										TranscriptResultStream: stream,
									} as unknown as Awaited<
										ReturnType<
											InstanceType<
												typeof TranscribeStreamingClient
											>["send"]
										>
									>;
								}

								// mode === "stream-ends": 1 이벤트 후 바로 종료.
								const stream: AsyncIterable<TranscriptResultStream> = {
									async *[Symbol.asyncIterator](): AsyncIterator<TranscriptResultStream> {
										yield makeFinalEvent("retry");
									},
								};
								return {
									TranscriptResultStream: stream,
								} as unknown as Awaited<
									ReturnType<
										InstanceType<
											typeof TranscribeStreamingClient
										>["send"]
									>
								>;
							});

						const reconnectAttempts: number[] = [];
						let terminalErrorCount = 0;
						const callbacks = emptyCallbacks({
							onReconnectAttempt: (attempt) =>
								reconnectAttempts.push(attempt),
							onSessionError: () => {
								terminalErrorCount += 1;
							},
						});

						const service = new TranscribeService(
							makeMockAudioCapture(),
							realClientFactory,
							{
								sessionEstablishTimeoutMs: 300,
								stopTimeoutMs: 200,
								reconnectDelayMs: 10,
								maxReconnectAttempts: 2,
							},
						);

						try {
							await service.start(makeStartParams(callbacks));

							// 재연결 절차가 터미널 오류를 발생시키거나 충분히 진행될 때까지 대기.
							await waitFor(() => terminalErrorCount > 0, 1_500);
							// 드레인: 중첩 재연결 경로가 남긴 후속 콜백까지 반영되도록 한다.
							await new Promise((resolve) => setTimeout(resolve, 150));

							// Property 13 의 상한: 재연결 시도 횟수 ≤ maxReconnectAttempts (= 2).
							expect(reconnectAttempts.length).toBeLessThanOrEqual(2);
						} finally {
							service.dispose();
							await new Promise((resolve) => setTimeout(resolve, 80));
						}
					},
				),
				{ numRuns: 10 },
			);
		},
		30_000,
	);

	test(
		"모든 재연결이 실패하면 onSessionError('reconnect_exhausted') 가 발생하고 활성 세션이 정리된다",
		async () => {
			// 설계된 시나리오:
			// - 초기 세션: 1 이벤트 후 throw → 재연결 개시.
			// - 이후 모든 send: 즉시 reject.
			//
			// 구현이 정의대로 동작하면 최종 결과는 `onSessionError("reconnect_exhausted")`.
			let sendIdx = 0;

			transcribeMock.reset();
			transcribeMock.on(StartStreamTranscriptionCommand).callsFake(async () => {
				const current = sendIdx++;
				if (current === 0) {
					const stream: AsyncIterable<TranscriptResultStream> = {
						async *[Symbol.asyncIterator](): AsyncIterator<TranscriptResultStream> {
							yield makeFinalEvent("hello");
							throw new Error("simulated initial connection loss");
						},
					};
					return {
						TranscriptResultStream: stream,
					} as unknown as Awaited<
						ReturnType<
							InstanceType<typeof TranscribeStreamingClient>["send"]
						>
					>;
				}
				// 모든 후속 재연결 시도는 즉시 reject.
				throw new Error("simulated reconnect failure");
			});

			const reconnectAttempts: number[] = [];
			const errorReasons: string[] = [];
			const callbacks = emptyCallbacks({
				onReconnectAttempt: (attempt) => reconnectAttempts.push(attempt),
				onSessionError: (reason) => errorReasons.push(reason),
			});

			const service = new TranscribeService(
				makeMockAudioCapture(),
				realClientFactory,
				{
					sessionEstablishTimeoutMs: 300,
					stopTimeoutMs: 200,
					reconnectDelayMs: 10,
					maxReconnectAttempts: 2,
				},
			);

			try {
				await service.start(makeStartParams(callbacks));
				await waitFor(() => errorReasons.length > 0, 1_500);
				await new Promise((resolve) => setTimeout(resolve, 150));

				// 상한 속성.
				expect(reconnectAttempts.length).toBeLessThanOrEqual(2);

				// 터미널 오류가 "reconnect_exhausted" 로 발생해야 한다.
				expect(errorReasons).toContain("reconnect_exhausted");

				// 활성 세션이 정리되었음을 간접 확인: 재시작 시도가 "already_active" 로 거부되지 않음.
				const postStartReasons: string[] = [];
				await service.start(
					makeStartParams(
						emptyCallbacks({
							onSessionError: (reason) => postStartReasons.push(reason),
						}),
					),
				);
				await new Promise((resolve) => setTimeout(resolve, 50));
				expect(postStartReasons).not.toContain("already_active");
			} finally {
				service.dispose();
				await new Promise((resolve) => setTimeout(resolve, 80));
			}
		},
		10_000,
	);
});
