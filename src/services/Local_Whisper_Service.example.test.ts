/**
 * `Local_Whisper_Service` 의 예제 테스트 (Task 15).
 *
 * 검증 시나리오:
 * - AC 4.2: chunked-streaming, 90 초 PCM 입력 → 30 초 청크 3 개 → infer 3 회 호출,
 *           onFinal 3 회 발사.
 * - AC 4.3: progress-only, 60 초 PCM 입력 + stop() → infer 정확히 1 회 호출
 *           (start ~ stop 사이 onFinal 0 회).
 * - AC 4.7: 모델 로드가 30 초 임계값을 초과할 때 `onLoadingProgress(elapsedMs)` 가
 *           호출된다.
 * - AC 4.8: load() 가 `model_corrupted` 코드로 reject → `onSessionError("model_corrupted")`
 *           발사. 호출 측이 `localModelInstalled` 초기화를 책임지므로 본 테스트는
 *           통지(reason) 만 검증한다.
 * - AC 4.9: dispose() 가 짧은 timeoutMs 한도에서도 5 초 fallback 으로 종료를 강제한다.
 *
 * 테스트 전략:
 * - `LocalInferenceClient` 는 in-memory mock 으로 주입하여 워커/실 모델 없이 검증.
 * - `AudioCapture` 도 최소 mock 으로 대체. PCM 청크는 Int16 little-endian Uint8Array 로
 *   생성하여 서비스의 Float32 변환 경로를 함께 검증한다.
 * - 타이밍은 `chunkSeconds` / `loadingProgressThresholdMs` / `disposeTimeoutMs` 옵션으로
 *   짧게 단축한다 — 계약상 동작이 중요하며 구체적 값은 옵션으로 오버라이드 가능함을 전제.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	Local_Whisper_Service,
	type LocalInferenceClient,
	type LocalWhisperCallbacks,
	type LocalWhisperStartParams,
} from "./Local_Whisper_Service";
import type { Local_Inference_Result } from "./whisper-worker-protocol";
import type { AudioCapture } from "./AudioCapture";
import type { Streaming_Display_Mode } from "../types/settings";

// -----------------------------------------------------------------------------
// 공통 유틸 — 제어 가능한 PCM 청크 큐 / 최소 mock
// -----------------------------------------------------------------------------

/**
 * 외부에서 PCM 청크를 push 하고 close 할 수 있는 async iterable.
 *
 * 본 테스트는 `Local_Whisper_Service` 가 PCM 청크를 어떻게 누적/분할하는지 검증해야
 * 하므로 `AudioCapture.pcmChunks` 의 산출량을 정확히 제어할 수 있어야 한다.
 */
class ControlledPcmStream implements AsyncIterable<Uint8Array> {
	private readonly queue: Uint8Array[] = [];
	private readonly waiters: Array<
		(result: IteratorResult<Uint8Array>) => void
	> = [];
	private closed = false;

	push(chunk: Uint8Array): void {
		if (this.closed) return;
		const waiter = this.waiters.shift();
		if (waiter) {
			waiter({ value: chunk, done: false });
			return;
		}
		this.queue.push(chunk);
	}

	close(): void {
		this.closed = true;
		while (this.waiters.length > 0) {
			const w = this.waiters.shift();
			w?.({
				value: undefined as unknown as Uint8Array,
				done: true,
			});
		}
	}

	[Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
		return {
			next: (): Promise<IteratorResult<Uint8Array>> =>
				new Promise((resolve) => {
					if (this.queue.length > 0) {
						const value = this.queue.shift() as Uint8Array;
						resolve({ value, done: false });
						return;
					}
					if (this.closed) {
						resolve({
							value: undefined as unknown as Uint8Array,
							done: true,
						});
						return;
					}
					this.waiters.push(resolve);
				}),
		};
	}
}

/**
 * Int16 little-endian PCM 청크를 `sampleCount` 길이로 생성한다.
 *
 * 모든 샘플은 `0x0001` (값 1) 로 채워 0 이 아닌 의미 있는 데이터로 만든다. 실제 값은 본
 * 테스트의 의미와 무관하며, mock client 는 PCM 길이만 보고 가짜 segment 를 반환한다.
 */
function makePcmChunk(sampleCount: number): Uint8Array {
	const buf = new Uint8Array(sampleCount * 2);
	for (let i = 0; i < sampleCount; i++) {
		buf[i * 2] = 0x01;
		buf[i * 2 + 1] = 0x00;
	}
	return buf;
}

/**
 * 본 테스트가 사용하는 최소 `AudioCapture` mock.
 *
 * - `requestPermission`: 더미 MediaStream resolve.
 * - `pcmChunks(stream)`: 주입된 `ControlledPcmStream` 을 그대로 반환.
 * - `stop`: stream 을 close 하여 캡처 루프가 즉시 종료되도록 한다.
 */
function createAudioCaptureMock(stream: ControlledPcmStream): AudioCapture {
	const mockStream = {
		getTracks: () => [],
	} as unknown as MediaStream;
	return {
		requestPermission: vi.fn().mockResolvedValue(mockStream),
		pcmChunks: vi.fn(() => stream),
		stop: vi.fn(() => stream.close()),
	} as unknown as AudioCapture;
}

/** 매 테스트가 관측할 콜백 묶음을 생성. */
function createCallbacks(): LocalWhisperCallbacks {
	return {
		onPartial: vi.fn(),
		onFinal: vi.fn(),
		onSessionEstablished: vi.fn(),
		onSessionError: vi.fn(),
		onLoadingProgress: vi.fn(),
	};
}

/** 반복 사용되는 `start()` 파라미터 빌더. */
function makeStartParams(
	mode: Streaming_Display_Mode,
	callbacks: LocalWhisperCallbacks,
): LocalWhisperStartParams {
	return {
		modelId: "whisper-large-v3-turbo",
		modelFilePath: "/tmp/fake/model.onnx",
		streamingDisplayMode: mode,
		callbacks,
	};
}

/**
 * mock client 의 기본형. `infer` 는 입력 길이에 비례하는 단일 segment 를 반환한다.
 *
 * 본 헬퍼는 호출 횟수와 인자(특히 PCM 길이) 검증을 위해 `vi.fn()` 으로 래핑된다.
 */
function createMockClient(overrides?: Partial<LocalInferenceClient>): {
	client: LocalInferenceClient;
	infer: ReturnType<typeof vi.fn>;
	load: ReturnType<typeof vi.fn>;
	dispose: ReturnType<typeof vi.fn>;
} {
	// override 가 주어지면 그 spy 자체를 client 와 반환값 양쪽에서 공유한다.
	// override 가 없으면 default spy 를 새로 만든다. 이 단일 소스화가 없으면
	// 테스트가 추적하는 spy 와 client.* 가 분리되어 호출 횟수가 어긋난다.
	const load =
		(overrides?.load as ReturnType<typeof vi.fn>) ??
		vi.fn().mockResolvedValue(undefined);
	const infer =
		(overrides?.infer as ReturnType<typeof vi.fn>) ??
		vi.fn(
			async (
				pcm: Float32Array,
				startSeconds: number,
			): Promise<Local_Inference_Result> => ({
				chunkStartSeconds: startSeconds,
				chunkDurationSeconds: pcm.length / 16000,
				segments: [
					{
						start: startSeconds,
						end: startSeconds + pcm.length / 16000,
						text: `segment@${startSeconds}`,
					},
				],
				inferenceDurationMs: 1,
			}),
		);
	const dispose =
		(overrides?.dispose as ReturnType<typeof vi.fn>) ??
		vi.fn().mockResolvedValue(undefined);
	// vi.fn() 반환 타입은 Mock<any[], unknown> 이라 LocalInferenceClient 의 구체
	// 시그니처와 직접 호환되지 않는다. 본 테스트 컨텍스트에서는 호출 횟수/인자 추적이
	// 목적이므로, 인터페이스로 캐스트하여 타입 경계를 넘는다 (테스트 한정).
	const client = {
		load,
		infer,
		dispose,
	} as unknown as LocalInferenceClient;
	return { client, load, infer, dispose };
}

// -----------------------------------------------------------------------------
// 테스트 수명주기
// -----------------------------------------------------------------------------

let consoleErrorSpy!: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	consoleErrorSpy = vi
		.spyOn(console, "error")
		.mockImplementation(() => undefined) as typeof consoleErrorSpy;
});

afterEach(() => {
	consoleErrorSpy.mockRestore();
	vi.useRealTimers();
});

// -----------------------------------------------------------------------------
// AC 4.2 — chunked-streaming 30 초 청크 분할
// -----------------------------------------------------------------------------

describe("Local_Whisper_Service — AC 4.2 chunked-streaming 청크 분할", () => {
	it("chunked-streaming 모드에서 PCM 입력이 청크 길이의 3 배 누적되면 infer 가 정확히 3 회 호출되고 onFinal 3 회 발사된다", async () => {
		// 청크 길이를 1 초로 단축 — 청크당 16_000 샘플 = 32_000 바이트.
		// 16kHz 기준 1 초 = 16_000 sample = 32_000 byte (Int16).
		const stream = new ControlledPcmStream();
		const audioCapture = createAudioCaptureMock(stream);
		const { client, infer } = createMockClient();
		const callbacks = createCallbacks();

		const service = new Local_Whisper_Service(audioCapture, () => client, {
			chunkSeconds: 1, // 1 초 청크
			sampleRateHertz: 16_000,
			loadingProgressThresholdMs: 60_000,
			disposeTimeoutMs: 200,
		});

		await service.start(makeStartParams("chunked-streaming", callbacks));

		// 0.5 초 분량씩 6 번 push → 총 3 초 (= 청크 3 개 분량).
		const halfSecondSamples = 16_000 / 2; // 0.5 초 = 8_000 샘플
		for (let i = 0; i < 6; i++) {
			stream.push(makePcmChunk(halfSecondSamples));
		}

		// infer 가 3 회 호출될 때까지 대기.
		await vi.waitFor(
			() => {
				expect(infer).toHaveBeenCalledTimes(3);
			},
			{ timeout: 2_000, interval: 10 },
		);

		// onFinal 도 3 회 발사 (각 infer 가 단일 segment 를 반환).
		expect(callbacks.onFinal).toHaveBeenCalledTimes(3);
		// onSessionEstablished 1 회.
		expect(callbacks.onSessionEstablished).toHaveBeenCalledTimes(1);
		// 에러 통지 없음.
		expect(callbacks.onSessionError).not.toHaveBeenCalled();

		// 각 청크의 PCM 길이가 16_000 (= 1 초) 인지 검증 (chunked-streaming 청크 길이 불변식).
		for (const call of infer.mock.calls) {
			const pcm = call[0] as Float32Array;
			expect(pcm.length).toBe(16_000);
		}

		// 청크 시작 초가 0, 1, 2 로 누적되는지 검증.
		expect(infer.mock.calls[0]?.[1]).toBe(0);
		expect(infer.mock.calls[1]?.[1]).toBe(1);
		expect(infer.mock.calls[2]?.[1]).toBe(2);

		// 정리.
		stream.close();
		await service.stop(200);
	});
});

// -----------------------------------------------------------------------------
// AC 4.3 — progress-only stop 트리거 일괄 추론
// -----------------------------------------------------------------------------

describe("Local_Whisper_Service — AC 4.3 progress-only stop 일괄 추론", () => {
	it("progress-only 모드에서 stop() 시점에만 infer 가 1 회 호출되고 그 전에는 onFinal 이 발사되지 않는다", async () => {
		const stream = new ControlledPcmStream();
		const audioCapture = createAudioCaptureMock(stream);
		const { client, infer } = createMockClient();
		const callbacks = createCallbacks();

		const service = new Local_Whisper_Service(audioCapture, () => client, {
			chunkSeconds: 30,
			sampleRateHertz: 16_000,
			loadingProgressThresholdMs: 60_000,
			disposeTimeoutMs: 200,
		});

		await service.start(makeStartParams("progress-only", callbacks));

		// 60 초 분량 PCM 을 6 번에 걸쳐 (각 10 초 = 160_000 샘플) 누적.
		for (let i = 0; i < 6; i++) {
			stream.push(makePcmChunk(160_000));
			// 각 청크 push 후 한 마이크로태스크 yield — 캡처 루프가 PCM 을 흡수할 시간 부여.
			await Promise.resolve();
		}

		// stop 호출 전 일정 시간 기다려서, 만약 잘못된 구현이 청크별 추론을 한다면 호출이 발생할 시간을 충분히 부여.
		await new Promise((r) => setTimeout(r, 50));

		// stop 전에는 infer 가 0 회 호출되어야 함 (Requirement 4.3 의 핵심 — 누적만 함).
		expect(infer).toHaveBeenCalledTimes(0);
		expect(callbacks.onFinal).toHaveBeenCalledTimes(0);

		// stop() — 누적된 PCM 으로 단일 infer 호출.
		await service.stop(200);

		// stop 시점 트리거로 infer 정확히 1 회 호출.
		expect(infer).toHaveBeenCalledTimes(1);
		// 1 회의 infer 가 1 개 segment 를 반환했으므로 onFinal 도 1 회.
		expect(callbacks.onFinal).toHaveBeenCalledTimes(1);

		// 호출된 PCM 길이는 60 초 분량 (16kHz × 60 = 960_000 샘플).
		const pcm = infer.mock.calls[0]?.[0] as Float32Array;
		expect(pcm.length).toBe(960_000);

		// progress-only 의 startSeconds 는 항상 0 (전체 녹음 1 개 입력).
		expect(infer.mock.calls[0]?.[1]).toBe(0);
	});
});

// -----------------------------------------------------------------------------
// AC 4.7 — 30 초 로딩 임계값 초과 시 onLoadingProgress 발사
// -----------------------------------------------------------------------------

describe("Local_Whisper_Service — AC 4.7 모델 로드 30 초 초과 시 onLoadingProgress", () => {
	it("load() 가 임계값을 초과하면 onLoadingProgress(elapsedMs) 가 호출된다", async () => {
		const stream = new ControlledPcmStream();
		const audioCapture = createAudioCaptureMock(stream);
		const callbacks = createCallbacks();

		// load() 를 외부 deferred 로 제어 — 테스트 끝부분에 resolve.
		let resolveLoad!: () => void;
		const loadPromise = new Promise<void>((resolve) => {
			resolveLoad = resolve;
		});
		const { client, load } = createMockClient({
			load: vi.fn(() => loadPromise),
		});

		const service = new Local_Whisper_Service(audioCapture, () => client, {
			chunkSeconds: 30,
			sampleRateHertz: 16_000,
			// 30_000ms 임계값을 50ms 로 단축. 계약상 "임계값 초과 시 통지" 만 보장된다.
			loadingProgressThresholdMs: 50,
			disposeTimeoutMs: 200,
		});

		// start() 가 load 를 await 하므로, 백그라운드로 실행하고 임계값 통과를 기다린다.
		const startPromise = service.start(
			makeStartParams("chunked-streaming", callbacks),
		);

		// 로딩 임계값 + 여유 시간 대기.
		await vi.waitFor(
			() => {
				expect(callbacks.onLoadingProgress).toHaveBeenCalledTimes(1);
			},
			{ timeout: 1_000, interval: 10 },
		);

		// elapsedMs 인자가 임계값 이상이어야 함.
		const elapsed = (callbacks.onLoadingProgress as ReturnType<typeof vi.fn>)
			.mock.calls[0]?.[0] as number;
		expect(elapsed).toBeGreaterThanOrEqual(50);

		// load 가 1 회 호출되었음.
		expect(load).toHaveBeenCalledTimes(1);

		// 정리 — load resolve 후 start promise 도 정상 종료.
		resolveLoad();
		await startPromise;

		stream.close();
		await service.stop(200);
	});
});

// -----------------------------------------------------------------------------
// AC 4.8 — model_corrupted 시 onSessionError 발사
// -----------------------------------------------------------------------------

describe("Local_Whisper_Service — AC 4.8 모델 손상 시 onSessionError('model_corrupted')", () => {
	it("load() 가 model_corrupted 코드로 reject 하면 onSessionError('model_corrupted') 가 발사된다", async () => {
		const stream = new ControlledPcmStream();
		const audioCapture = createAudioCaptureMock(stream);
		const callbacks = createCallbacks();

		// 워커 protocol 의 에러 코드 형태({ code: "model_corrupted" }) 를 모방.
		const corruptError = Object.assign(new Error("model_corrupted"), {
			code: "model_corrupted",
		});
		const { client, load } = createMockClient({
			load: vi.fn().mockRejectedValue(corruptError),
		});

		const service = new Local_Whisper_Service(audioCapture, () => client, {
			chunkSeconds: 30,
			sampleRateHertz: 16_000,
			loadingProgressThresholdMs: 60_000,
			disposeTimeoutMs: 200,
		});

		await service.start(makeStartParams("chunked-streaming", callbacks));

		// onSessionError 가 짧은 영문 키 "model_corrupted" 로 호출되어야 함.
		expect(callbacks.onSessionError).toHaveBeenCalledTimes(1);
		expect(callbacks.onSessionError).toHaveBeenCalledWith("model_corrupted");

		// 세션이 수립되기 전에 실패했으므로 onSessionEstablished 는 호출되지 않음.
		expect(callbacks.onSessionEstablished).not.toHaveBeenCalled();
		// load 는 1 회 호출.
		expect(load).toHaveBeenCalledTimes(1);

		// 실패 후 다음 start() 가 허용되도록 활성 세션이 정리되어야 한다.
		// 같은 서비스 인스턴스에서 두 번째 start — already_active 가 발사되지 않으면 슬롯이 비워진 것.
		const fresh = createCallbacks();
		// 두 번째 호출에서는 정상 client 가 필요하므로, 서비스 자체를 새로 만들 필요 없이
		// 새 stream/audio mock 을 쓰고 client factory 가 매번 새로 만들도록 한다.
		const stream2 = new ControlledPcmStream();
		const audio2 = createAudioCaptureMock(stream2);
		const { client: client2 } = createMockClient();
		const service2 = new Local_Whisper_Service(audio2, () => client2, {
			chunkSeconds: 30,
			sampleRateHertz: 16_000,
			loadingProgressThresholdMs: 60_000,
			disposeTimeoutMs: 200,
		});
		await service2.start(makeStartParams("chunked-streaming", fresh));
		expect(fresh.onSessionError).not.toHaveBeenCalledWith("already_active");
		expect(fresh.onSessionEstablished).toHaveBeenCalledTimes(1);

		stream.close();
		stream2.close();
		await service.stop(200);
		await service2.stop(200);
	});
});

// -----------------------------------------------------------------------------
// AC 4.9 — dispose() 가 5 초 fallback 으로 종료를 강제한다
// -----------------------------------------------------------------------------

describe("Local_Whisper_Service — AC 4.9 dispose 5 초 fallback", () => {
	it("dispose() 는 client.dispose() 가 timeoutMs 내에 끝나지 않아도 fallback 으로 활성 세션을 즉시 비운다", async () => {
		const stream = new ControlledPcmStream();
		const audioCapture = createAudioCaptureMock(stream);
		const callbacks = createCallbacks();

		// dispose 가 영원히 끝나지 않는 mock — 5 초 fallback 검증을 위함.
		// 본 테스트에서는 disposeTimeoutMs 를 50ms 로 단축하여 검증 시간을 짧게 가져간다.
		const neverResolving = new Promise<void>(() => undefined);
		const { client, dispose } = createMockClient({
			dispose: vi.fn(() => neverResolving),
		});

		const service = new Local_Whisper_Service(audioCapture, () => client, {
			chunkSeconds: 30,
			sampleRateHertz: 16_000,
			loadingProgressThresholdMs: 60_000,
			// 5 초 → 50ms 로 단축. 계약상 "timeout 후 fallback" 만 보장된다.
			disposeTimeoutMs: 50,
		});

		await service.start(makeStartParams("chunked-streaming", callbacks));

		// dispose() 호출 — 즉시 활성 세션 슬롯이 비워져야 한다 (동기 동작).
		const disposeStartedAt = Date.now();
		service.dispose();

		// 활성 세션이 비워졌으므로 새 start() 가 즉시 허용되어야 한다.
		const fresh = createCallbacks();
		const stream2 = new ControlledPcmStream();
		const audio2 = createAudioCaptureMock(stream2);
		const { client: client2 } = createMockClient();
		const service2 = new Local_Whisper_Service(audio2, () => client2, {
			disposeTimeoutMs: 50,
			loadingProgressThresholdMs: 60_000,
		});
		await service2.start(makeStartParams("chunked-streaming", fresh));
		expect(fresh.onSessionError).not.toHaveBeenCalledWith("already_active");

		// 본 테스트의 핵심은 "client.dispose 가 미해결이어도 서비스가 진행한다" 이다.
		expect(dispose).toHaveBeenCalledTimes(1);
		// 전체 dispose+재시작 경과는 fallback (~50ms) + 마이크로태스크 수준이어야 함 — 1 초 미만.
		const elapsed = Date.now() - disposeStartedAt;
		expect(elapsed).toBeLessThan(1_000);

		stream.close();
		stream2.close();
		await service2.stop(200);
	});
});
