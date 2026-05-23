/**
 * `TranscribeService`의 세션 수명주기 모킹 예시 테스트 (Task 12.3).
 *
 * 검증 목표:
 * - 세션 수립 성공 → `onSessionEstablished` 1회 호출 (Requirement 3.3).
 * - 10초 타임아웃 내 첫 이벤트 없음 → `onSessionError("timeout")`
 *   + `AbortController`를 통한 세션 취소 (Requirement 3.10).
 * - Partial/Final 이벤트 수신 → `onPartial` / `onFinal` 콜백이 수신 순서와
 *   `IsPartial` 플래그에 따라 정확히 분기된다 (Requirements 3.5, 3.6, 3.7).
 * - `stop()` 후 지정 시간(5초) 내 세션이 종료되지 않으면 `AbortController.abort()`로
 *   강제 종료하고 `onSessionError("stop_timeout")` 경고를 남긴다
 *   (Requirements 4.2, 4.10).
 *
 * 테스트 전략:
 * - `TranscribeStreamingClient`를 실제로 생성하지 않는다. 대신 `clientFactory`를
 *   통해 `send(command, { abortSignal })`만 구현한 경량 fake 클라이언트를 주입한다.
 *   이는 `aws-sdk-client-mock`보다 결정적(deterministic)이며, 제어된 async iterable을
 *   통한 이벤트 순서 검증을 간단하게 만든다.
 * - `AudioCapture`는 `requestPermission`/`pcmChunks`/`stop`만 사용되므로 최소 목으로 대체한다.
 *   AWS SDK를 우회하므로 `pcmChunks`의 async generator는 실제로 iterate 되지 않는다.
 * - 타이밍은 `sessionEstablishTimeoutMs` / `stopTimeoutMs`를 밀리초 단위로 단축하여
 *   실제 10초 / 5초 대신 수백 밀리초로 조정한다. 이는 서비스 계약의 *동작*을 검증하는 것이
 *   목적이며 구체적 값은 Requirement 3.10 / 4.10에서 옵션으로 오버라이드 가능함을 전제한다.
 * - 재연결 경로를 차단하기 위해 `maxReconnectAttempts: 0`으로 구성한다.
 *   (재연결 검증은 Task 12.2의 범위이다.)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	TranscribeStreamingClient,
	TranscriptResultStream,
} from "@aws-sdk/client-transcribe-streaming";

import { TranscribeService } from "./TranscribeService";
import type {
	StartParams,
	TranscribeCallbacks,
	TranscribeClientFactory,
} from "./TranscribeService";
import type { AudioCapture } from "./AudioCapture";

// -----------------------------------------------------------------------------
// 공통 유틸 — 제어 가능한 async iterable / 최소 모의 객체
// -----------------------------------------------------------------------------

/**
 * 테스트에서 명시적으로 `push()` / `close()` 할 수 있는 async iterable 큐.
 *
 * AWS SDK의 `TranscriptResultStream`은 `AsyncIterable<TranscriptResultStream>`이므로,
 * 테스트에서는 이 헬퍼를 사용해 이벤트를 원하는 시점에 주입하고, 원하는 시점에 스트림을
 * 종료(또는 계속 대기)할 수 있다.
 *
 * - `push(event)`: 대기 중인 소비자가 있으면 즉시 해소, 없으면 내부 큐에 적재.
 * - `close()`: 대기 중인 소비자와 미래의 소비자 모두에게 `done: true`를 반환.
 */
class ControlledAsyncIterable<T> implements AsyncIterable<T> {
	private readonly queue: T[] = [];
	private readonly waiters: Array<(result: IteratorResult<T>) => void> = [];
	private closed = false;

	push(event: T): void {
		if (this.closed) {
			return;
		}
		const waiter = this.waiters.shift();
		if (waiter) {
			waiter({ value: event, done: false });
			return;
		}
		this.queue.push(event);
	}

	close(): void {
		this.closed = true;
		while (this.waiters.length > 0) {
			const waiter = this.waiters.shift();
			waiter?.({ value: undefined as unknown as T, done: true });
		}
	}

	[Symbol.asyncIterator](): AsyncIterator<T> {
		return {
			next: (): Promise<IteratorResult<T>> =>
				new Promise((resolve) => {
					if (this.queue.length > 0) {
						const value = this.queue.shift() as T;
						resolve({ value, done: false });
						return;
					}
					if (this.closed) {
						resolve({ value: undefined as unknown as T, done: true });
						return;
					}
					this.waiters.push(resolve);
				}),
		};
	}
}

/**
 * Transcribe 서비스에 주입할 최소 `AudioCapture` 목.
 *
 * `requestPermission`은 더미 MediaStream을 반환하고, `pcmChunks`는 빈 async generator이다.
 * 본 테스트는 fake client가 audio stream을 실제로 iterate 하지 않으므로 `pcmChunks`가
 * 호출되지 않지만, 타입 적합성을 위해 제공한다.
 */
function createAudioCaptureMock(): AudioCapture {
	const mockStream = {
		getTracks: () => [],
	} as unknown as MediaStream;

	return {
		requestPermission: vi.fn().mockResolvedValue(mockStream),
		// 빈 async iterable — SDK 목이 consume 하지 않으므로 실제로 호출되지 않는다.
		pcmChunks: vi.fn(
			(): AsyncIterable<Uint8Array> => ({
				[Symbol.asyncIterator]: () => ({
					next: () =>
						Promise.resolve({
							value: undefined as unknown as Uint8Array,
							done: true,
						}),
				}),
			}),
		),
		stop: vi.fn(),
	} as unknown as AudioCapture;
}

/** 각 테스트에서 관측할 콜백 묶음을 생성. 모두 `vi.fn()`으로 호출 순서 추적 가능. */
function createCallbacks(): TranscribeCallbacks {
	return {
		onPartial: vi.fn(),
		onFinal: vi.fn(),
		onSessionEstablished: vi.fn(),
		onSessionError: vi.fn(),
		onReconnectAttempt: vi.fn(),
		onConnectionLost: vi.fn(),
	};
}

/** 반복 사용되는 `start()` 파라미터 생성. 자격 증명 값은 모의용 더미. */
function makeStartParams(callbacks: TranscribeCallbacks): StartParams {
	return {
		credentials: {
			accessKeyId: "TEST_TRANSCRIBE_KEY_DUMMY",
			secretAccessKey: "test-secret-transcribe-dummy-value-0000",
		},
		region: "us-east-1",
		languageCode: "ko-KR",
		callbacks,
	};
}

/**
 * `IsPartial` 플래그와 텍스트만 담은 최소 `TranscriptEvent` 형태의 이벤트 생성.
 *
 * AWS SDK 타입은 매우 상세하지만 `TranscribeService.handleTranscriptResultStreamEvent`는
 * `TranscriptEvent?.Transcript?.Results?.[].Alternatives?.[0]?.Transcript`와 `IsPartial`만
 * 참조하므로 이들만 채워 넣는다. 타입 적합성을 위해 `as` 캐스팅을 사용한다.
 */
function makeTranscriptEvent(
	text: string,
	isPartial: boolean,
): TranscriptResultStream {
	return {
		TranscriptEvent: {
			Transcript: {
				Results: [
					{
						IsPartial: isPartial,
						Alternatives: [{ Transcript: text }],
					},
				],
			},
		},
	} as unknown as TranscriptResultStream;
}

// -----------------------------------------------------------------------------
// 테스트 수명주기
// -----------------------------------------------------------------------------

// Vitest 의 `vi.spyOn(console, "error").mockImplementation(...)` 반환 타입은 버전에 따라
// 제네릭 기본형이 달라져 직관적인 주석으로는 TS2322/TS2344 를 유발한다.
// `ReturnType<typeof vi.spyOn>`를 사용하고 실제 할당 시 캐스트로 타입 경계를 넘는다.
let consoleErrorSpy!: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	consoleErrorSpy = vi
		.spyOn(console, "error")
		.mockImplementation(() => undefined) as typeof consoleErrorSpy;
});

afterEach(() => {
	consoleErrorSpy.mockRestore();
	// 어떤 테스트가 `useFakeTimers`를 사용했더라도 다음 테스트에는 영향이 없도록 원복.
	vi.useRealTimers();
});

// -----------------------------------------------------------------------------
// 세션 수립 성공 (Requirement 3.3)
// -----------------------------------------------------------------------------

describe("TranscribeService.start — 세션 수립 성공 (Requirement 3.3)", () => {
	it("첫 TranscriptEvent 수신 시 onSessionEstablished를 1회 호출한다", async () => {
		const stream = new ControlledAsyncIterable<TranscriptResultStream>();
		const send = vi.fn().mockResolvedValue({ TranscriptResultStream: stream });
		const fakeClient = {
			send,
		} as unknown as TranscribeStreamingClient;
		const clientFactory: TranscribeClientFactory = vi.fn(() => fakeClient);

		const audioCapture = createAudioCaptureMock();
		const callbacks = createCallbacks();
		const service = new TranscribeService(audioCapture, clientFactory, {
			sessionEstablishTimeoutMs: 1_000,
			stopTimeoutMs: 500,
			reconnectDelayMs: 10,
			maxReconnectAttempts: 0,
		});

		await service.start(makeStartParams(callbacks));

		// runSession이 백그라운드에서 send 호출을 await 하므로, 마이크로태스크가 한 번
		// 이상 돌아야 푸시된 이벤트가 소비된다. `vi.waitFor`가 폴링해 준다.
		stream.push(makeTranscriptEvent("안녕", true));

		await vi.waitFor(() => {
			expect(callbacks.onSessionEstablished).toHaveBeenCalledTimes(1);
		});

		expect(callbacks.onSessionError).not.toHaveBeenCalled();
		expect(clientFactory).toHaveBeenCalledWith(
			expect.objectContaining({ accessKeyId: "TEST_TRANSCRIBE_KEY_DUMMY" }),
			"us-east-1",
		);
		expect(send).toHaveBeenCalledTimes(1);

		// 정리: 스트림을 닫으면 runSession의 for-await 가 종료되고 세션 정리 경로로 진입한다.
		stream.close();
		// 정리 경로가 마이크로태스크 몇 개 이상 걸릴 수 있으므로 dispose로 즉시 종결.
		service.dispose();
	});
});

// -----------------------------------------------------------------------------
// 세션 수립 타임아웃 (Requirement 3.10)
// -----------------------------------------------------------------------------

describe("TranscribeService.start — 세션 수립 타임아웃 (Requirement 3.10)", () => {
	it("지정된 타임아웃 내 첫 이벤트가 없으면 onSessionError('timeout')을 호출하고 세션을 abort한다", async () => {
		// fake send: abortSignal이 발화될 때까지 pending 상태를 유지하고, 발화 시 AbortError로 reject.
		// TranscribeService의 establishTimer가 controller.abort()를 호출하는 경로를 재현한다.
		const send = vi.fn(
			(_cmd: unknown, options: { abortSignal: AbortSignal }) =>
				new Promise((_resolve, reject) => {
					if (options.abortSignal.aborted) {
						const err = new Error("The operation was aborted");
						err.name = "AbortError";
						reject(err);
						return;
					}
					options.abortSignal.addEventListener("abort", () => {
						const err = new Error("The operation was aborted");
						err.name = "AbortError";
						reject(err);
					});
				}),
		);

		const fakeClient = { send } as unknown as TranscribeStreamingClient;
		const clientFactory: TranscribeClientFactory = () => fakeClient;

		const audioCapture = createAudioCaptureMock();
		const callbacks = createCallbacks();
		const service = new TranscribeService(audioCapture, clientFactory, {
			// 테스트 속도를 위해 10초 대신 100ms로 단축. 계약상 "지정된 타임아웃"이 중요하다.
			sessionEstablishTimeoutMs: 100,
			stopTimeoutMs: 200,
			reconnectDelayMs: 10,
			maxReconnectAttempts: 0,
		});

		await service.start(makeStartParams(callbacks));

		await vi.waitFor(
			() => {
				expect(callbacks.onSessionError).toHaveBeenCalledWith("timeout");
			},
			{ timeout: 2_000, interval: 20 },
		);

		// onSessionEstablished는 호출되지 않아야 한다.
		expect(callbacks.onSessionEstablished).not.toHaveBeenCalled();
		// timeout 이후 세션이 정리되어 다음 start()가 허용되어야 한다(단일 세션 불변식 해제).
		// 새 start()를 시도했을 때 "already_active"가 발생하지 않으면 정리된 것이다.
		const freshCallbacks = createCallbacks();
		await service.start(makeStartParams(freshCallbacks));
		expect(freshCallbacks.onSessionError).not.toHaveBeenCalledWith(
			"already_active",
		);

		service.dispose();
	});
});

// -----------------------------------------------------------------------------
// Partial / Final 이벤트 수신 순서 (Requirements 3.5, 3.6, 3.7)
// -----------------------------------------------------------------------------

describe("TranscribeService.start — Partial/Final 이벤트 분기 (Requirements 3.5, 3.6, 3.7)", () => {
	it("IsPartial 플래그에 따라 onPartial / onFinal을 수신 순서대로 호출한다", async () => {
		const stream = new ControlledAsyncIterable<TranscriptResultStream>();
		const send = vi.fn().mockResolvedValue({ TranscriptResultStream: stream });
		const fakeClient = { send } as unknown as TranscribeStreamingClient;
		const clientFactory: TranscribeClientFactory = () => fakeClient;

		const audioCapture = createAudioCaptureMock();
		const callbacks = createCallbacks();
		const service = new TranscribeService(audioCapture, clientFactory, {
			sessionEstablishTimeoutMs: 2_000,
			stopTimeoutMs: 200,
			reconnectDelayMs: 10,
			// 스트림이 자연 종료되면 reconnect 경로로 진입하지 않도록 0으로 설정.
			maxReconnectAttempts: 0,
		});

		await service.start(makeStartParams(callbacks));

		// 의도한 이벤트 순서 — partial → partial → final → partial → final.
		// 이 순서는 실제 Transcribe Streaming이 발송하는 전형적 패턴을 모사한다.
		stream.push(makeTranscriptEvent("안녕", true));
		stream.push(makeTranscriptEvent("안녕하세요", true));
		stream.push(makeTranscriptEvent("안녕하세요 반갑습니다", false));
		stream.push(makeTranscriptEvent("오늘은", true));
		stream.push(makeTranscriptEvent("오늘은 회의 시작입니다", false));

		// 두 final이 모두 도착하면 buffer의 committed 텍스트에 누적되어 있어야 한다.
		await vi.waitFor(
			() => {
				expect(callbacks.onFinal).toHaveBeenCalledTimes(2);
			},
			{ timeout: 2_000, interval: 10 },
		);

		// partial은 3회 호출되었어야 한다.
		expect(callbacks.onPartial).toHaveBeenCalledTimes(3);
		expect(callbacks.onSessionEstablished).toHaveBeenCalledTimes(1);

		// 콜백 호출 순서 검증 — mock.invocationCallOrder를 사용해 전역적으로 정렬한다.
		const partialCalls = (callbacks.onPartial as ReturnType<typeof vi.fn>).mock;
		const finalCalls = (callbacks.onFinal as ReturnType<typeof vi.fn>).mock;

		// 인자 검증 (순서대로 저장된 partial/final 텍스트).
		expect(partialCalls.calls.map((c) => c[0])).toEqual([
			"안녕",
			"안녕하세요",
			"오늘은",
		]);
		expect(finalCalls.calls.map((c) => c[0])).toEqual([
			"안녕하세요 반갑습니다",
			"오늘은 회의 시작입니다",
		]);

		// 전역 호출 순서: partial(1) < partial(2) < final(1) < partial(3) < final(2).
		const order = [
			partialCalls.invocationCallOrder[0],
			partialCalls.invocationCallOrder[1],
			finalCalls.invocationCallOrder[0],
			partialCalls.invocationCallOrder[2],
			finalCalls.invocationCallOrder[1],
		];
		const sorted = [...order].sort((a, b) => a - b);
		expect(order).toEqual(sorted);

		// 버퍼에 final 텍스트가 공백으로 join 되어 있어야 한다(Requirement 3.7).
		expect(service.getTranscriptBuffer().getCommittedText()).toBe(
			"안녕하세요 반갑습니다 오늘은 회의 시작입니다",
		);

		// 정리: 스트림 종료 → runSession이 자연 종료 경로로 진입 → 재연결 0회 → finalize.
		stream.close();
		service.dispose();
	});
});

// -----------------------------------------------------------------------------
// stop() 타임아웃 → 강제 abort + 경고 (Requirements 4.2, 4.10)
// -----------------------------------------------------------------------------

describe("TranscribeService.stop — 지정 시간 내 미종료 시 강제 abort (Requirements 4.2, 4.10)", () => {
	it("stop() 후 stopTimeoutMs 내 세션이 닫히지 않으면 abort + onSessionError('stop_timeout')", async () => {
		// 제어 가능한 스트림 — stop이 들어와도 명시적으로 close() 하기 전까지 for-await가 hang 한다.
		const stream = new ControlledAsyncIterable<TranscriptResultStream>();

		// send에 전달되는 abortSignal을 테스트에서 관측하기 위해 캡처한다.
		let capturedSignal: AbortSignal | undefined;
		const send = vi.fn(
			(_cmd: unknown, options: { abortSignal: AbortSignal }) => {
				capturedSignal = options.abortSignal;
				return Promise.resolve({ TranscriptResultStream: stream });
			},
		);
		const fakeClient = { send } as unknown as TranscribeStreamingClient;
		const clientFactory: TranscribeClientFactory = () => fakeClient;

		const audioCapture = createAudioCaptureMock();
		const callbacks = createCallbacks();
		const service = new TranscribeService(audioCapture, clientFactory, {
			sessionEstablishTimeoutMs: 2_000,
			// 계약상 5초이지만 테스트 속도를 위해 100ms로 단축. 동작 자체(타임아웃 후 강제 abort)를 검증한다.
			stopTimeoutMs: 100,
			reconnectDelayMs: 10,
			maxReconnectAttempts: 0,
		});

		await service.start(makeStartParams(callbacks));

		// 세션이 수립되도록 첫 이벤트를 푸시.
		stream.push(makeTranscriptEvent("안녕하세요", false));
		await vi.waitFor(() => {
			expect(callbacks.onSessionEstablished).toHaveBeenCalledTimes(1);
		});

		// 이 시점에 stop()을 호출한다. 스트림이 hang 중이므로 send 프로미스가 해소되지 않는다.
		// stopTimeoutMs(100ms) 경과 후 abort + onSessionError("stop_timeout") + finalize가 발생해야 한다.
		const stopStart = Date.now();
		await service.stop();
		const elapsed = Date.now() - stopStart;

		// 경고 콜백이 호출되었는지.
		expect(callbacks.onSessionError).toHaveBeenCalledWith("stop_timeout");

		// AbortController.abort()가 실제로 발화되었는지 — send에 전달된 signal로 검증.
		expect(capturedSignal).toBeDefined();
		expect(capturedSignal?.aborted).toBe(true);

		// 대략 stopTimeoutMs 이상 대기했는지(환경 편차를 고려해 하한만 체크).
		expect(elapsed).toBeGreaterThanOrEqual(90);

		// finalize가 호출되어 다음 start()가 허용되어야 한다.
		const freshCallbacks = createCallbacks();
		const freshStream = new ControlledAsyncIterable<TranscriptResultStream>();
		// 이전 클라이언트의 send는 여전히 pending 이므로, 새 호출에는 새 fake 응답을 바인딩한다.
		send.mockResolvedValueOnce({ TranscriptResultStream: freshStream });
		await service.start(makeStartParams(freshCallbacks));
		expect(freshCallbacks.onSessionError).not.toHaveBeenCalledWith(
			"already_active",
		);

		// 정리.
		freshStream.close();
		stream.close();
		service.dispose();
	});
});

// =============================================================================
// v1.1 — 화자 분리 / Segment 분할 / Segment_Id 단조 증가
// =============================================================================
//
// 본 절은 task 20 (design §4.6) 의 신규 동작 3 가지 acceptance criterion 을
// `aws-sdk-client-mock` + 제어 가능한 fake stream 조합으로 검증한다.
//
// - **AC 6.3** — `showSpeakerLabel: true` 인 경우 `StartStreamTranscriptionCommand`
//   입력에 `ShowSpeakerLabel: true` 와 `EnablePartialResultsStabilization: true` 가
//   포함되어 호출된다. 미지정/false 의 경우 두 필드는 SDK 인자에 포함되지 않는다
//   (v1.0 호환).
// - **AC 6.5** — 단일 Final 응답에 두 명 이상의 화자 (`spk_0`, `spk_1`) 가
//   섞여 등장하면 `onFinalSegment` 가 화자 구간별로 2 회 호출되며, 각 segment 의
//   `speakerLabel` 이 `mapSpeakerLabel` 규칙에 따라 `Speaker 1`, `Speaker 2` 로
//   부여된다.
// - **AC 13.4 (재해석: design §4.6 Segment_Id 단조 증가)** — 3 개 Final 결과에 대해
//   `segmentId` 가 1, 2, 3 순서로 부여되고, 동일 `spk_0` 은 같은 표시명을 재사용한다.
//
// 테스트 전략:
// - `aws-sdk-client-mock` 으로 `StartStreamTranscriptionCommand` 호출의 input 을
//   직접 검증 (AC 6.3). 단, mock 의 `resolves` 는 `TranscriptResultStream` 을
//   AsyncIterable 로 받아 주므로 `ControlledAsyncIterable` 을 그대로 사용한다.
// - `clientFactory` 는 매번 새 `TranscribeStreamingClient` 인스턴스를 반환하지만
//   `mockClient` 가 모든 인스턴스를 가로채기 때문에 mock send 가 호출된다.

import {
	StartStreamTranscriptionCommand as StartStreamCmd,
	TranscribeStreamingClient as TranscribeStreamingClientReal,
	type Item as TranscribeItem,
} from "@aws-sdk/client-transcribe-streaming";
import { mockClient } from "aws-sdk-client-mock";
import { afterAll } from "vitest";

const transcribeMock = mockClient(TranscribeStreamingClientReal);

afterEach(() => {
	transcribeMock.reset();
});
afterAll(() => {
	transcribeMock.restore();
});

/**
 * 화자 라벨 / 시간 정보 / 본문이 포함된 Final `TranscriptEvent` 1 건을 생성한다.
 *
 * `Items[]` 는 하나의 `Item` 당 (Content, Speaker, StartTime, EndTime) 만 채워
 * `emitFinalSegments` 의 화자 그룹화 로직을 결정적으로 구동한다.
 */
function makeFinalWithItems(
	transcript: string,
	items: ReadonlyArray<{
		content: string;
		speaker?: string;
		startTime?: number;
		endTime?: number;
	}>,
	resultMeta: { startTime?: number; endTime?: number } = {},
): TranscriptResultStream {
	const sdkItems: TranscribeItem[] = items.map((it) => ({
		Content: it.content,
		Speaker: it.speaker,
		StartTime: it.startTime,
		EndTime: it.endTime,
		Type: "pronunciation",
	}));
	return {
		TranscriptEvent: {
			Transcript: {
				Results: [
					{
						IsPartial: false,
						StartTime: resultMeta.startTime,
						EndTime: resultMeta.endTime,
						Alternatives: [
							{
								Transcript: transcript,
								Items: sdkItems,
							},
						],
					},
				],
			},
		},
	} as unknown as TranscriptResultStream;
}

// -----------------------------------------------------------------------------
// AC 6.3 — ShowSpeakerLabel / EnablePartialResultsStabilization 전달 검증
// -----------------------------------------------------------------------------

describe("TranscribeService.start — AC 6.3: ShowSpeakerLabel 전달", () => {
	it("showSpeakerLabel=true 인 경우 ShowSpeakerLabel/EnablePartialResultsStabilization 이 SDK 인자에 포함된다", async () => {
		const stream = new ControlledAsyncIterable<TranscriptResultStream>();
		transcribeMock
			.on(StartStreamCmd)
			.resolves({ TranscriptResultStream: stream } as unknown as object);

		// 매 호출마다 새 클라이언트 인스턴스 — `mockClient` 가 가로채므로 동일 동작.
		const clientFactory: TranscribeClientFactory = () =>
			new TranscribeStreamingClientReal({ region: "us-east-1" });

		const audioCapture = createAudioCaptureMock();
		const callbacks = createCallbacks();
		const service = new TranscribeService(audioCapture, clientFactory, {
			sessionEstablishTimeoutMs: 2_000,
			stopTimeoutMs: 200,
			reconnectDelayMs: 10,
			maxReconnectAttempts: 0,
		});

		await service.start({
			...makeStartParams(callbacks),
			showSpeakerLabel: true,
		});

		// 세션이 수립되어 send 가 호출되도록 첫 이벤트 푸시.
		stream.push(makeTranscriptEvent("안녕", true));
		await vi.waitFor(() => {
			expect(callbacks.onSessionEstablished).toHaveBeenCalledTimes(1);
		});

		// `mockClient.commandCalls(StartStreamCmd)` 로 입력 인자 검증.
		const calls = transcribeMock.commandCalls(StartStreamCmd);
		expect(calls.length).toBe(1);
		const input = calls[0].args[0].input;
		expect(input.ShowSpeakerLabel).toBe(true);
		expect(input.EnablePartialResultsStabilization).toBe(true);
		expect(input.LanguageCode).toBe("ko-KR");
		expect(input.MediaEncoding).toBe("pcm");
		expect(input.MediaSampleRateHertz).toBe(16_000);

		// 정리.
		stream.close();
		service.dispose();
	});

	it("showSpeakerLabel 미지정(v1.0 호환) 시 ShowSpeakerLabel/EnablePartialResultsStabilization 이 SDK 인자에 포함되지 않는다", async () => {
		const stream = new ControlledAsyncIterable<TranscriptResultStream>();
		transcribeMock
			.on(StartStreamCmd)
			.resolves({ TranscriptResultStream: stream } as unknown as object);

		const clientFactory: TranscribeClientFactory = () =>
			new TranscribeStreamingClientReal({ region: "us-east-1" });

		const audioCapture = createAudioCaptureMock();
		const callbacks = createCallbacks();
		const service = new TranscribeService(audioCapture, clientFactory, {
			sessionEstablishTimeoutMs: 2_000,
			stopTimeoutMs: 200,
			reconnectDelayMs: 10,
			maxReconnectAttempts: 0,
		});

		// showSpeakerLabel 옵션 없이 v1.0 형태로 호출.
		await service.start(makeStartParams(callbacks));

		stream.push(makeTranscriptEvent("안녕", true));
		await vi.waitFor(() => {
			expect(callbacks.onSessionEstablished).toHaveBeenCalledTimes(1);
		});

		const calls = transcribeMock.commandCalls(StartStreamCmd);
		expect(calls.length).toBe(1);
		const input = calls[0].args[0].input;
		// 두 필드는 SDK 입력 객체에 키 자체가 없어야 한다 (v1.0 호환).
		expect(input.ShowSpeakerLabel).toBeUndefined();
		expect(input.EnablePartialResultsStabilization).toBeUndefined();

		stream.close();
		service.dispose();
	});
});

// -----------------------------------------------------------------------------
// AC 6.5 — 단일 Final 응답에 두 화자 → segment 분할
// -----------------------------------------------------------------------------

describe("TranscribeService.start — AC 6.5: 다중 화자 Final 분할", () => {
	it("단일 Final 에 spk_0 / spk_1 이 섞여 등장하면 onFinalSegment 가 화자별로 2 회 호출된다", async () => {
		const stream = new ControlledAsyncIterable<TranscriptResultStream>();
		transcribeMock
			.on(StartStreamCmd)
			.resolves({ TranscriptResultStream: stream } as unknown as object);

		const clientFactory: TranscribeClientFactory = () =>
			new TranscribeStreamingClientReal({ region: "us-east-1" });

		const audioCapture = createAudioCaptureMock();
		const onFinalSegment = vi.fn();
		const callbacks: TranscribeCallbacks = {
			...createCallbacks(),
			onFinalSegment,
		};

		const service = new TranscribeService(audioCapture, clientFactory, {
			sessionEstablishTimeoutMs: 2_000,
			stopTimeoutMs: 200,
			reconnectDelayMs: 10,
			maxReconnectAttempts: 0,
		});

		await service.start({
			...makeStartParams(callbacks),
			showSpeakerLabel: true,
		});

		// 단일 Final: "안녕하세요 반갑습니다" — spk_0 가 "안녕하세요" 발화,
		// spk_1 이 "반갑습니다" 발화. 두 화자가 섞인 단일 Result.
		stream.push(
			makeFinalWithItems(
				"안녕하세요 반갑습니다",
				[
					{
						content: "안녕하세요",
						speaker: "spk_0",
						startTime: 0.5,
						endTime: 1.5,
					},
					{
						content: "반갑습니다",
						speaker: "spk_1",
						startTime: 2.0,
						endTime: 3.0,
					},
				],
				{ startTime: 0.5, endTime: 3.0 },
			),
		);

		await vi.waitFor(() => {
			expect(onFinalSegment).toHaveBeenCalledTimes(2);
		});

		// 첫 segment: spk_0 → "Speaker 1".
		const seg1 = onFinalSegment.mock.calls[0][0];
		expect(seg1.segmentId).toBe(1);
		expect(seg1.speakerLabel).toBe("Speaker 1");
		expect(seg1.text).toBe("안녕하세요");
		expect(seg1.startSeconds).toBe(0.5);
		expect(seg1.endSeconds).toBe(1.5);

		// 두 번째 segment: spk_1 → "Speaker 2".
		const seg2 = onFinalSegment.mock.calls[1][0];
		expect(seg2.segmentId).toBe(2);
		expect(seg2.speakerLabel).toBe("Speaker 2");
		expect(seg2.text).toBe("반갑습니다");
		expect(seg2.startSeconds).toBe(2.0);
		expect(seg2.endSeconds).toBe(3.0);

		// v1.0 호환 onFinal 은 Final 전체 본문으로 1 회만 호출.
		expect(callbacks.onFinal).toHaveBeenCalledTimes(1);
		expect(callbacks.onFinal).toHaveBeenCalledWith("안녕하세요 반갑습니다");

		stream.close();
		service.dispose();
	});

	it("Items 가 누락되어 화자 정보가 없는 Final 에서는 단일 segment 가 발사되며 speakerLabel = undefined 이다 (Requirement 6.7)", async () => {
		const stream = new ControlledAsyncIterable<TranscriptResultStream>();
		transcribeMock
			.on(StartStreamCmd)
			.resolves({ TranscriptResultStream: stream } as unknown as object);

		const clientFactory: TranscribeClientFactory = () =>
			new TranscribeStreamingClientReal({ region: "us-east-1" });

		const audioCapture = createAudioCaptureMock();
		const onFinalSegment = vi.fn();
		const callbacks: TranscribeCallbacks = {
			...createCallbacks(),
			onFinalSegment,
		};

		const service = new TranscribeService(audioCapture, clientFactory, {
			sessionEstablishTimeoutMs: 2_000,
			stopTimeoutMs: 200,
			reconnectDelayMs: 10,
			maxReconnectAttempts: 0,
		});

		await service.start(makeStartParams(callbacks));

		// `makeTranscriptEvent` 는 Items 를 넣지 않으므로 fallback 경로가 동작한다.
		stream.push(makeTranscriptEvent("화자 정보 없는 본문", false));

		await vi.waitFor(() => {
			expect(onFinalSegment).toHaveBeenCalledTimes(1);
		});

		const seg = onFinalSegment.mock.calls[0][0];
		expect(seg.segmentId).toBe(1);
		expect(seg.speakerLabel).toBeUndefined();
		expect(seg.text).toBe("화자 정보 없는 본문");

		stream.close();
		service.dispose();
	});
});

// -----------------------------------------------------------------------------
// AC 13.4 (design §4.6 Segment_Id 단조 증가) — 3 개 Final → segmentId 1,2,3
// -----------------------------------------------------------------------------

describe("TranscribeService.start — AC 13.4: Segment_Id 단조 증가 + 화자 라벨 안정성", () => {
	it("3 개 Final 결과에 대해 segmentId 가 1,2,3 순서로 부여되고 동일 spk_0 은 같은 표시명을 재사용한다", async () => {
		const stream = new ControlledAsyncIterable<TranscriptResultStream>();
		transcribeMock
			.on(StartStreamCmd)
			.resolves({ TranscriptResultStream: stream } as unknown as object);

		const clientFactory: TranscribeClientFactory = () =>
			new TranscribeStreamingClientReal({ region: "us-east-1" });

		const audioCapture = createAudioCaptureMock();
		const onFinalSegment = vi.fn();
		const callbacks: TranscribeCallbacks = {
			...createCallbacks(),
			onFinalSegment,
		};

		const service = new TranscribeService(audioCapture, clientFactory, {
			sessionEstablishTimeoutMs: 2_000,
			stopTimeoutMs: 200,
			reconnectDelayMs: 10,
			maxReconnectAttempts: 0,
		});

		await service.start({
			...makeStartParams(callbacks),
			showSpeakerLabel: true,
		});

		// 3 개의 단일 화자 Final: spk_0 → spk_1 → spk_0.
		stream.push(
			makeFinalWithItems("첫 번째", [
				{
					content: "첫 번째",
					speaker: "spk_0",
					startTime: 0.0,
					endTime: 1.0,
				},
			]),
		);
		stream.push(
			makeFinalWithItems("두 번째", [
				{
					content: "두 번째",
					speaker: "spk_1",
					startTime: 1.5,
					endTime: 2.5,
				},
			]),
		);
		stream.push(
			makeFinalWithItems("세 번째", [
				{
					content: "세 번째",
					speaker: "spk_0",
					startTime: 3.0,
					endTime: 4.0,
				},
			]),
		);

		await vi.waitFor(() => {
			expect(onFinalSegment).toHaveBeenCalledTimes(3);
		});

		const segments = onFinalSegment.mock.calls.map((c) => c[0]);

		// Segment_Id 단조 증가 (Requirement 13.4, 13.5).
		expect(segments.map((s) => s.segmentId)).toEqual([1, 2, 3]);

		// 화자 라벨 안정성 (Requirement 6.4): spk_0 은 항상 Speaker 1, spk_1 은 Speaker 2.
		expect(segments[0].speakerLabel).toBe("Speaker 1");
		expect(segments[1].speakerLabel).toBe("Speaker 2");
		expect(segments[2].speakerLabel).toBe("Speaker 1");

		// 본문 검증.
		expect(segments.map((s) => s.text)).toEqual([
			"첫 번째",
			"두 번째",
			"세 번째",
		]);

		// `TranscriptBuffer.getSegments()` 도 같은 순서/segmentId 를 보관한다.
		const bufferedSegments = service.getTranscriptBuffer().getSegments();
		expect(bufferedSegments.map((s) => s.segmentId)).toEqual([1, 2, 3]);

		stream.close();
		service.dispose();
	});
});
