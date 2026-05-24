/**
 * `Local_Whisper_Service` — 마이크 PCM 오디오를 로컬 Whisper 모델로 추론하는 서비스.
 *
 * 본 서비스는 `LocalInferenceClient` 를 통해 Web Worker (또는 동등 격리 컨텍스트) 와
 * 통신하며, 오디오 샘플은 본 장치를 떠나지 않는다 (Requirement 4.1, 4.10).
 *
 * 두 가지 표시 모드를 지원한다:
 * - `progress-only`: `start()` 부터 `stop()` 까지 PCM 을 누적해 두었다가 stop 시점에
 *   단일 `infer()` 호출로 일괄 처리한다 (Requirement 4.3).
 * - `chunked-streaming`: 30 초 청크가 채워질 때마다 `infer()` 를 호출하고 결과를
 *   `onFinal` 콜백으로 즉시 노출한다 (Requirement 4.2).
 *
 * 본 태스크에서는 `LocalInferenceClient` 의 인터페이스만 export 한다. 실제 워커 기반
 * 구현(`WhisperWorkerClient`) 은 후속 태스크(26) 에서 `whisper-worker.ts` 를 띄우는
 * 어댑터로 추가된다.
 *
 * ## 매핑 (design §4.2, requirements.md)
 * - Requirement 4.1: PCM 데이터는 외부 네트워크로 송신하지 않는다.
 * - Requirement 4.2: chunked-streaming 모드는 30 초 청크 단위로 `infer()` 호출.
 * - Requirement 4.3: progress-only 모드는 stop 시점에 일괄 추론.
 * - Requirement 4.6: 결과 segment 를 `Transcript_Segment` 로 변환하여 버퍼에 적재.
 * - Requirement 4.7: 모델 로드 30 초 초과 시 `onLoadingProgress(elapsedMs)` 호출.
 * - Requirement 4.8: 모델 손상 시 `onSessionError("model_corrupted")` 통지.
 * - Requirement 4.9: dispose 5 초 이내 워커 정리 (멱등 + fallback terminate).
 * - Requirement 4.10: 모든 PCM 처리는 메모리 내부에서만 수행, 외부 송신 금지.
 * - Requirement 10.1: 추론은 메인 스레드가 아닌 별도 워커에서 수행.
 * - Requirement 10.4: 한 시점에 최대 1 개의 추론 워커.
 * - Requirement 10.5: 종료 신호 후 5 초 이내 워커 종료 보장.
 * - Requirement 11.3: 추론 실패 시 모델 ID / 청크 길이(s) / 추론 소요(ms) 만 기록.
 * - Requirement 12.4: `LocalInferenceClient` 인터페이스로 모킹 가능.
 *
 * ## 보안 / 로깅
 * - 모든 로그는 `console.error` 만 사용 (Requirement 11.1, 4.10).
 * - 마이크 오디오 샘플 값, 전사 본문은 로그에 기록하지 않는다.
 * - PCM 청크는 워커 transferList 로 이동되며 외부 네트워크로 송신되지 않는다.
 */

import type { AudioCapture } from "./AudioCapture";
import { TranscriptBuffer } from "../domain/TranscriptBuffer";
import type { Streaming_Display_Mode } from "../types/settings";
import type { Local_Inference_Result } from "./whisper-worker-protocol";

// -----------------------------------------------------------------------------
// 도메인 타입 (Task 9 와의 임시 호환)
// -----------------------------------------------------------------------------

/**
 * Final transcript segment 1 건.
 *
 * Task 9 가 `src/domain/segments.ts` 에 동일 타입을 정의할 예정이지만, 본 태스크 시점에는
 * 그 파일이 존재하지 않는다. import 가 깨지지 않도록 file-local 정의를 제공한다.
 *
 * TODO(task-9): `src/domain/segments.ts` 가 추가되면 본 정의를 삭제하고 `import type
 * { Transcript_Segment } from "../domain/segments"` 로 교체한다. 필드 형태는 design
 * §Data Models 4 와 일치하도록 유지되어야 한다.
 */
export interface Transcript_Segment {
	readonly segmentId: number;
	readonly startSeconds: number;
	readonly endSeconds: number;
	readonly text: string;
	readonly speakerLabel?: string;
}

// -----------------------------------------------------------------------------
// 외부 인터페이스 (DI)
// -----------------------------------------------------------------------------

/**
 * 로컬 추론 클라이언트의 추상 인터페이스 (Requirement 12.4, design §4.2).
 *
 * 실제 구현은 `WhisperWorkerClient`(Web Worker 어댑터, task 26) 가 담당하며, 테스트에서는
 * 본 인터페이스를 만족하는 in-memory mock 으로 대체한다. 본 서비스는 인터페이스에만
 * 의존하므로 jsdom 환경에서도 단위 테스트가 가능하다.
 *
 * 호출 순서 계약:
 * 1. `load(modelId, modelFilePath)` — 한 번만. resolve 까지 후속 `infer()` 호출 금지.
 * 2. `infer(pcm, startSeconds, signal)` — 0 회 이상. 한 시점에 1 호출만(직렬).
 * 3. `dispose()` — 한 번만. 이후 어떤 메서드도 호출되지 않는다.
 */
export interface LocalInferenceClient {
	load(modelId: string, modelFilePath: string): Promise<void>;
	infer(
		pcm: Float32Array,
		startSeconds: number,
		signal: AbortSignal,
	): Promise<Local_Inference_Result>;
	dispose(): Promise<void>;
}

/**
 * 본 서비스가 상위 계층(main.ts) 에 보내는 콜백 묶음.
 *
 * - `onFinal`: 한 청크의 추론이 완료될 때마다(또는 progress-only 모드에서 stop 후 일괄
 *   추론이 완료될 때) segment 단위로 호출된다.
 * - `onPartial`: chunked-streaming 모드에서 청크 추론 결과의 일부를 partial 로 보낼 때
 *   사용 가능. 현 구현은 호출하지 않으나 인터페이스로 노출한다.
 * - `onSessionEstablished`: 모델 로드 성공 직후 1 회.
 * - `onSessionError(reason)`: 짧은 영문 키. 호출 측이 i18n 으로 매핑한다. 예:
 *   - `"model_corrupted"` (Requirement 4.8): 모델 가중치 손상.
 *   - `"model_not_found"`: 가중치 파일 없음.
 *   - `"infer_failed"`: 청크 추론 중 비복구 실패.
 *   - `"out_of_memory"`: 워커 메모리 부족.
 *   - `"already_active"`: 단일 세션 불변식 위반.
 * - `onLoadingProgress(elapsedMs)`: 모델 로드 30 초 초과 시 1 회 호출 (Requirement 4.7).
 */
export interface LocalWhisperCallbacks {
	onPartial?(text: string): void;
	onFinal(segment: Transcript_Segment): void;
	onSessionEstablished(): void;
	onSessionError(reason: string): void;
	onLoadingProgress?(elapsedMs: number): void;
}

/**
 * `Local_Whisper_Service.start()` 매개변수.
 */
export interface LocalWhisperStartParams {
	readonly modelId: string;
	readonly modelFilePath: string;
	readonly streamingDisplayMode: Streaming_Display_Mode;
	readonly callbacks: LocalWhisperCallbacks;
	/**
	 * 사용할 마이크(`MediaDeviceInfo.deviceId`).
	 *
	 * 빈 문자열 / 미지정 시 OS / 브라우저 기본 입력 장치를 사용한다.
	 */
	readonly audioInputDeviceId?: string;
}

/**
 * 로컬 추론 클라이언트 팩토리 — `start()` 시점마다 새 인스턴스를 생성한다.
 *
 * 단일 워커 불변식(Requirement 10.4) 을 강제하기 위해 본 서비스는 한 시점에 최대
 * 1 개의 클라이언트만 보유하며, 새 `start()` 전에 기존 `dispose()` 를 보장한다.
 */
export type LocalInferenceClientFactory = () => LocalInferenceClient;

/** 생성자 옵션 — 테스트에서 타이밍을 단축할 때 사용한다. */
export interface LocalWhisperServiceOptions {
	/** 청크 길이(초). 기본 30 초 (Requirement 4.2 의 30~60 초 범위 내). */
	chunkSeconds?: number;
	/** 로딩 안내 임계값(ms). 기본 30_000 (Requirement 4.7). */
	loadingProgressThresholdMs?: number;
	/** dispose() 의 정상 종료 대기 한도(ms). 기본 5_000 (Requirement 4.9, 10.5). */
	disposeTimeoutMs?: number;
	/** PCM 의 샘플레이트(Hz). 기본 16_000 (AudioCapture 와 동일). */
	sampleRateHertz?: number;
}

// -----------------------------------------------------------------------------
// 상수 — 단일 소스 오브 트루스
// -----------------------------------------------------------------------------

/** Requirement 4.2 의 청크 길이 기본값. 30 초. */
const DEFAULT_CHUNK_SECONDS = 30;

/** Requirement 4.7 의 로딩 안내 임계값. 30 초. */
const DEFAULT_LOADING_PROGRESS_THRESHOLD_MS = 30_000;

/** Requirement 4.9, 10.5 의 dispose 타임아웃. 5 초. */
const DEFAULT_DISPOSE_TIMEOUT_MS = 5_000;

/** AudioCapture 가 생산하는 PCM 의 샘플레이트(Hz). */
const DEFAULT_SAMPLE_RATE_HERTZ = 16_000;

// -----------------------------------------------------------------------------
// 내부 상태
// -----------------------------------------------------------------------------

/**
 * 활성 세션 1 건의 상태 묶음. `activeSession !== null` 이 곧 단일 세션 불변식이다
 * (Requirement 10.4).
 */
interface ActiveSession {
	readonly client: LocalInferenceClient;
	readonly callbacks: LocalWhisperCallbacks;
	readonly streamingDisplayMode: Streaming_Display_Mode;
	readonly modelId: string;
	/** 사용자/플러그인이 stop()/dispose() 를 요청했는지 여부. */
	stopRequested: boolean;
	/** 마이크 캡처 스트림 — finalize 시 트랙 stop. */
	mediaStream: MediaStream | null;
	/** in-flight 추론을 abort 하기 위한 controller. */
	inferController: AbortController;
	/** progress-only 모드의 누적 PCM (Float32). 메모리 내에만 보관. */
	pcmAccumulator: Float32Array[];
	/** chunked-streaming 모드의 현재 청크 PCM (Float32). */
	currentChunk: Float32Array[];
	/** 현재 청크가 시작된 세션 시작 기준 초. */
	currentChunkStartSeconds: number;
	/** 현재까지 누적된 PCM 샘플 수 (현재 청크 포함). */
	totalSamplesAccumulated: number;
	/** 한 세션 내에서 단조 증가하는 segmentId 카운터. */
	nextSegmentId: number;
	/** 현재 청크에 누적된 샘플 수. */
	currentChunkSamples: number;
	/** 백그라운드 PCM 소비 루프의 완료 promise — finalize 가 await. */
	captureLoopPromise: Promise<void> | null;
}

/**
 * Transcribe Streaming 세션과 동일한 패턴(생성자 DI + start/stop/dispose) 으로 구현된
 * 로컬 Whisper 추론 서비스.
 */
export class Local_Whisper_Service {
	/** 누적 전사 결과를 보관하는 도메인 버퍼. 세션 간 유지된다. */
	private readonly buffer = new TranscriptBuffer();

	/** 단일 활성 세션. null 이면 idle. */
	private activeSession: ActiveSession | null = null;

	private readonly chunkSamples: number;
	private readonly loadingProgressThresholdMs: number;
	private readonly disposeTimeoutMs: number;
	private readonly sampleRateHertz: number;

	/**
	 * @param audioCapture   PCM 청크를 yield 하는 오디오 캡처 서비스(생성자 DI).
	 * @param clientFactory  새 세션마다 새 `LocalInferenceClient` 를 생성하는 팩토리.
	 *                        Requirement 10.4 의 단일 워커 불변식 강제용.
	 * @param options        타이밍 옵션 — 테스트에서 short-circuit 용으로 오버라이드.
	 */
	constructor(
		private readonly audioCapture: AudioCapture,
		private readonly clientFactory: LocalInferenceClientFactory,
		options: LocalWhisperServiceOptions = {},
	) {
		const chunkSeconds = options.chunkSeconds ?? DEFAULT_CHUNK_SECONDS;
		this.sampleRateHertz =
			options.sampleRateHertz ?? DEFAULT_SAMPLE_RATE_HERTZ;
		this.chunkSamples = Math.max(
			1,
			Math.floor(chunkSeconds * this.sampleRateHertz),
		);
		this.loadingProgressThresholdMs =
			options.loadingProgressThresholdMs ??
			DEFAULT_LOADING_PROGRESS_THRESHOLD_MS;
		this.disposeTimeoutMs =
			options.disposeTimeoutMs ?? DEFAULT_DISPOSE_TIMEOUT_MS;
	}

	// ---------------------------------------------------------------------------
	// 공개 API
	// ---------------------------------------------------------------------------

	/**
	 * 새 추론 세션을 시작한다.
	 *
	 * 흐름:
	 * 1. 단일 세션 불변식 확인 — 활성 세션이 있으면 `onSessionError("already_active")`.
	 * 2. 마이크 권한 요청 + MediaStream 획득.
	 * 3. 새 클라이언트 생성 + `load(modelId, filePath)` 호출.
	 *    - 30 초 초과 시 `onLoadingProgress(elapsedMs)` 1 회 (Requirement 4.7).
	 *    - 실패 시 진단 코드를 짧은 영문 키로 `onSessionError` 에 전달.
	 * 4. 로드 성공 시 `onSessionEstablished()` 1 회.
	 * 5. 백그라운드 PCM 캡처 루프 가동.
	 *
	 * `start()` 는 모델 로드가 끝나는 시점에 resolve 한다. PCM 소비 루프는 백그라운드에서
	 * 진행되며 결과는 콜백으로만 통지된다.
	 */
	async start(params: LocalWhisperStartParams): Promise<void> {
		if (this.activeSession !== null) {
			this.safeCallback(() =>
				params.callbacks.onSessionError("already_active"),
			);
			return;
		}

		// 마이크 권한 + MediaStream — 실패 시 즉시 에러 통지.
		let mediaStream: MediaStream;
		try {
			mediaStream = await this.audioCapture.requestPermission(
				params.audioInputDeviceId,
			);
		} catch (err) {
			console.error(
				"[Local_Whisper_Service] microphone permission failed:",
				err,
			);
			this.safeCallback(() =>
				params.callbacks.onSessionError("mic_permission_denied"),
			);
			return;
		}

		const client = this.clientFactory();
		const session: ActiveSession = {
			client,
			callbacks: params.callbacks,
			streamingDisplayMode: params.streamingDisplayMode,
			modelId: params.modelId,
			stopRequested: false,
			mediaStream,
			inferController: new AbortController(),
			pcmAccumulator: [],
			currentChunk: [],
			currentChunkStartSeconds: 0,
			totalSamplesAccumulated: 0,
			currentChunkSamples: 0,
			nextSegmentId: 1,
			captureLoopPromise: null,
		};
		this.activeSession = session;

		// 모델 로드 + 30 초 임계값 안내 타이머.
		const loadStartedAt = Date.now();
		const loadingProgressTimer = setTimeout(() => {
			if (this.activeSession !== session || session.stopRequested) return;
			this.safeCallback(() =>
				session.callbacks.onLoadingProgress?.(Date.now() - loadStartedAt),
			);
		}, this.loadingProgressThresholdMs);

		try {
			await client.load(params.modelId, params.modelFilePath);
		} catch (err) {
			clearTimeout(loadingProgressTimer);
			console.error("[Local_Whisper_Service] model load failed:", err);
			const reason = this.classifyClientError(err);
			this.safeCallback(() => session.callbacks.onSessionError(reason));
			// 정리 — 워커 종료 + 마이크 해제 + 활성 세션 해제.
			await this.finalizeSession(session);
			return;
		} finally {
			clearTimeout(loadingProgressTimer);
		}

		// 로드 도중 dispose() 가 호출돼 세션이 교체/제거되었으면 즉시 정리.
		if (this.activeSession !== session || session.stopRequested) {
			await this.finalizeSession(session);
			return;
		}

		this.safeCallback(() => session.callbacks.onSessionEstablished());

		// 백그라운드 PCM 캡처 루프 가동.
		session.captureLoopPromise = this.runCaptureLoop(session).catch((err) => {
			console.error("[Local_Whisper_Service] capture loop crashed:", err);
		});
	}

	/**
	 * 현재 세션을 정상 종료한다.
	 *
	 * 흐름:
	 * 1. `stopRequested` 플래그를 세워 캡처 루프가 다음 yield 시 종료되도록 한다.
	 * 2. progress-only 모드: 누적된 PCM 으로 단일 `infer()` 를 호출 후 결과 통지.
	 *    chunked-streaming 모드: 현재 청크에 잔여 PCM 이 있으면 마지막 청크로 추론.
	 * 3. 워커 dispose 를 5 초 한도로 기다린다 (Requirement 4.9, 10.5). 초과 시 강제 종료.
	 *
	 * 본 메서드는 멱등 — 이미 종료된 세션에 호출해도 no-op.
	 */
	async stop(timeoutMs: number = this.disposeTimeoutMs): Promise<void> {
		const session = this.activeSession;
		if (session === null) return;
		session.stopRequested = true;

		// 캡처 루프가 종료될 때까지 대기 (PCM yield 도중인 경우 audioCapture.stop 호출 후 다음 iteration 에서 break).
		try {
			this.audioCapture.stop(session.mediaStream as MediaStream);
		} catch (err) {
			console.error("[Local_Whisper_Service] audio stop failed:", err);
		}
		if (session.captureLoopPromise) {
			try {
				await session.captureLoopPromise;
			} catch (err) {
				console.error(
					"[Local_Whisper_Service] capture loop join failed:",
					err,
				);
			}
		}

		// 모드별 잔여 처리.
		if (this.activeSession === session) {
			await this.flushOnStop(session);
		}

		// 워커 정리 — 5 초 fallback.
		await this.finalizeSession(session, timeoutMs);
	}

	/**
	 * 동기적으로 모든 자원을 정리한다 (플러그인 언로드/비활성화 경로).
	 *
	 * - 활성 세션이 있으면 in-flight 추론 abort + 마이크 트랙 stop.
	 * - 워커 dispose 는 백그라운드에서 5 초 한도로 진행되며, 5 초 초과 시 클라이언트가
	 *   자체 terminate 를 수행해야 한다(`WhisperWorkerClient` 책임).
	 *
	 * 멱등성 — 여러 번 호출해도 안전.
	 */
	dispose(): void {
		const session = this.activeSession;
		if (session === null) return;

		session.stopRequested = true;
		try {
			session.inferController.abort();
		} catch (err) {
			console.error(
				"[Local_Whisper_Service] abort during dispose failed:",
				err,
			);
		}
		if (session.mediaStream) {
			try {
				this.audioCapture.stop(session.mediaStream);
			} catch (err) {
				console.error(
					"[Local_Whisper_Service] audio stop during dispose failed:",
					err,
				);
			}
		}

		// 활성 세션을 즉시 해제하여 새 start() 가 허용되도록 한다.
		this.activeSession = null;

		// 워커 정리 — 백그라운드 + 5 초 fallback.
		void this.disposeClientWithTimeout(session.client, this.disposeTimeoutMs);
	}

	/** 누적 전사 버퍼를 반환한다. main.ts 가 저장 시 본문 원본으로 사용한다. */
	getTranscriptBuffer(): TranscriptBuffer {
		return this.buffer;
	}

	/** 새 세션을 시작하기 전에 호출해 버퍼를 초기화한다. */
	clearBuffer(): void {
		this.buffer.clear();
	}

	// ---------------------------------------------------------------------------
	// 내부 — PCM 캡처 루프
	// ---------------------------------------------------------------------------

	/**
	 * 마이크에서 캡처한 Int16 PCM Uint8Array 청크를 Float32 로 변환하고, 현재 표시 모드에
	 * 따라 누적 또는 청크별 추론을 수행한다.
	 *
	 * - `progress-only`: PCM 을 `pcmAccumulator` 에 모은 뒤 stop() 시점에 일괄 추론.
	 * - `chunked-streaming`: `chunkSamples` 만큼 채워질 때마다 `infer()` 를 호출하고
	 *   결과 segment 를 `onFinal` 로 통지.
	 */
	private async runCaptureLoop(session: ActiveSession): Promise<void> {
		try {
			for await (const raw of this.audioCapture.pcmChunks(
				session.mediaStream as MediaStream,
			)) {
				if (session.stopRequested) break;
				const float32 = int16ToFloat32(raw);
				if (float32.length === 0) continue;
				session.totalSamplesAccumulated += float32.length;

				if (session.streamingDisplayMode === "progress-only") {
					session.pcmAccumulator.push(float32);
					continue;
				}

				// chunked-streaming — 청크가 채워지면 추론 발사.
				session.currentChunk.push(float32);
				session.currentChunkSamples += float32.length;
				if (session.currentChunkSamples >= this.chunkSamples) {
					await this.flushChunk(session);
				}
			}
		} catch (err) {
			console.error("[Local_Whisper_Service] PCM iteration error:", err);
		}
	}

	/**
	 * 현재 청크의 누적 PCM 으로 1 회 `infer()` 를 호출하고 결과 segment 를 콜백/버퍼에
	 * 부착한다. 호출 후 청크 누적 상태를 다음 청크용으로 리셋한다.
	 */
	private async flushChunk(session: ActiveSession): Promise<void> {
		const chunk = concatFloat32(session.currentChunk);
		const startSeconds = session.currentChunkStartSeconds;
		const durationSeconds = chunk.length / this.sampleRateHertz;

		// 다음 청크용 상태 리셋 (in-flight 추론과 무관).
		session.currentChunk = [];
		session.currentChunkSamples = 0;
		session.currentChunkStartSeconds += durationSeconds;

		await this.invokeInferAndDispatch(
			session,
			chunk,
			startSeconds,
			durationSeconds,
		);
	}

	/**
	 * stop() 시점의 잔여 PCM 처리.
	 *
	 * - `progress-only`: 누적된 모든 PCM 으로 단일 `infer()` 호출 (Requirement 4.3).
	 * - `chunked-streaming`: 현재 청크에 잔여 샘플이 있으면 마지막 청크로 추론.
	 *
	 * 잔여 샘플이 없거나 stop 도중 abort 된 경우 no-op.
	 */
	private async flushOnStop(session: ActiveSession): Promise<void> {
		if (session.streamingDisplayMode === "progress-only") {
			const total = concatFloat32(session.pcmAccumulator);
			session.pcmAccumulator = [];
			if (total.length === 0) return;
			const durationSeconds = total.length / this.sampleRateHertz;
			await this.invokeInferAndDispatch(session, total, 0, durationSeconds);
			return;
		}
		// chunked-streaming — 잔여 청크 처리.
		if (session.currentChunkSamples > 0) {
			await this.flushChunk(session);
		}
	}

	/**
	 * 단일 추론 호출 + 결과 dispatch.
	 *
	 * 본 메서드는 진단 메트릭(모델 ID, 청크 길이(초), 추론 소요(ms)) 을 추적해 실패 시
	 * `console.error` 로 기록한다 (Requirement 11.3). 본문/스택 trace 는 송신하지 않는다.
	 */
	private async invokeInferAndDispatch(
		session: ActiveSession,
		pcm: Float32Array,
		startSeconds: number,
		chunkDurationSeconds: number,
	): Promise<void> {
		const inferStartedAt = Date.now();
		try {
			const result = await session.client.infer(
				pcm,
				startSeconds,
				session.inferController.signal,
			);
			if (session.stopRequested && this.activeSession !== session) {
				// dispose 도중 도착한 결과는 폐기.
				return;
			}
			for (const seg of result.segments) {
				const segment: Transcript_Segment = {
					segmentId: session.nextSegmentId++,
					startSeconds: seg.start,
					endSeconds: seg.end,
					text: seg.text,
				};
				this.buffer.appendFinal(segment.text);
				this.safeCallback(() => session.callbacks.onFinal(segment));
			}
		} catch (err) {
			const inferenceDurationMs = Date.now() - inferStartedAt;
			// Requirement 11.3 — 모델 ID / 청크 길이(s) / 추론 소요(ms) 만 기록.
			console.error(
				`[Local_Whisper_Service] infer failed: modelId=${session.modelId}, chunkSec=${chunkDurationSeconds}, inferMs=${inferenceDurationMs}`,
			);
			const reason = this.classifyClientError(err);
			this.safeCallback(() => session.callbacks.onSessionError(reason));
		}
	}

	// ---------------------------------------------------------------------------
	// 내부 — 종료 / 정리
	// ---------------------------------------------------------------------------

	/**
	 * 워커 + 마이크 + 활성 세션 슬롯을 정리한다. 멱등성을 보장한다.
	 *
	 * 5 초 fallback (Requirement 4.9, 10.5): `client.dispose()` 가 timeout 내에 resolve
	 * 하지 않으면 promise 를 버리고 진행한다. 실제 워커 terminate 는 클라이언트 구현
	 * 책임이며, `WhisperWorkerClient` 가 해당 fallback 으로 `worker.terminate()` 를 호출한다.
	 */
	private async finalizeSession(
		session: ActiveSession,
		timeoutMs: number = this.disposeTimeoutMs,
	): Promise<void> {
		// in-flight 추론 abort.
		try {
			session.inferController.abort();
		} catch (err) {
			console.error(
				"[Local_Whisper_Service] inferController.abort failed:",
				err,
			);
		}
		// 마이크 트랙 정리.
		if (session.mediaStream) {
			try {
				this.audioCapture.stop(session.mediaStream);
			} catch (err) {
				console.error(
					"[Local_Whisper_Service] audioCapture.stop failed:",
					err,
				);
			}
		}
		// 본 세션이 여전히 활성인 경우에만 슬롯 비움.
		if (this.activeSession === session) {
			this.activeSession = null;
		}
		// 워커 dispose — 5 초 fallback.
		await this.disposeClientWithTimeout(session.client, timeoutMs);
	}

	/**
	 * `client.dispose()` 를 timeout 으로 보호한다.
	 *
	 * - resolve 가 timeout 내에 도착하면 정상 종료.
	 * - timeout 초과 시 fallback 으로 진행 (실제 terminate 는 클라이언트 책임).
	 */
	private async disposeClientWithTimeout(
		client: LocalInferenceClient,
		timeoutMs: number,
	): Promise<void> {
		await Promise.race([
			client.dispose().catch((err) => {
				console.error("[Local_Whisper_Service] client.dispose failed:", err);
			}),
			new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
		]);
	}

	// ---------------------------------------------------------------------------
	// 내부 — 유틸
	// ---------------------------------------------------------------------------

	/**
	 * `LocalInferenceClient` / 워커가 던진 에러를 `onSessionError(reason)` 의 짧은 영문
	 * 키로 변환한다. 워커 protocol 의 4 종 코드(`model_not_found`, `model_corrupted`,
	 * `infer_failed`, `out_of_memory`) 를 우선 인식하고, 그 외는 `infer_failed` 로 fallback.
	 */
	private classifyClientError(err: unknown): string {
		if (err && typeof err === "object" && "code" in err) {
			const code = (err as { code: unknown }).code;
			if (
				code === "model_not_found" ||
				code === "model_corrupted" ||
				code === "infer_failed" ||
				code === "out_of_memory"
			) {
				return code;
			}
		}
		if (err instanceof Error) {
			const msg = err.message.toLowerCase();
			if (msg.includes("model_not_found") || msg.includes("not found")) {
				return "model_not_found";
			}
			if (
				msg.includes("model_corrupted") ||
				msg.includes("corrupt") ||
				msg.includes("invalid")
			) {
				return "model_corrupted";
			}
			if (
				msg.includes("out_of_memory") ||
				msg.includes("out of memory")
			) {
				return "out_of_memory";
			}
		}
		return "infer_failed";
	}

	/**
	 * 콜백 실행을 안전하게 감싼다. 콜백 내부 예외가 서비스 루프를 중단시키지 않도록 하고,
	 * 민감 정보 유출을 방지하기 위해 발생 사실만 로그로 남긴다.
	 */
	private safeCallback(fn: () => void): void {
		try {
			fn();
		} catch (err) {
			console.error("[Local_Whisper_Service] callback threw:", err);
		}
	}
}

// -----------------------------------------------------------------------------
// 순수 헬퍼 (외부 노출 없음, 단위 테스트용으로 유지)
// -----------------------------------------------------------------------------

/**
 * Int16 little-endian PCM (Uint8Array) 을 Float32 PCM (-1.0 ~ +1.0) 으로 변환한다.
 *
 * AudioCapture 가 yield 하는 청크는 Int16 LE 이고, transformers.js 의 ASR 파이프라인은
 * Float32 를 요구하므로 본 헬퍼가 변환한다. 변환 식은 표준 16-bit PCM 의 정규화 — 절대값
 * 32768 (즉 `1 << 15`) 로 나눈다.
 *
 * 입력 길이가 홀수면 마지막 1 바이트는 무시된다 (불완전한 sample).
 */
function int16ToFloat32(input: Uint8Array): Float32Array {
	const sampleCount = Math.floor(input.byteLength / 2);
	if (sampleCount === 0) return new Float32Array(0);
	const view = new DataView(input.buffer, input.byteOffset, sampleCount * 2);
	const out = new Float32Array(sampleCount);
	for (let i = 0; i < sampleCount; i++) {
		const s = view.getInt16(i * 2, true /* little-endian */);
		out[i] = s / 32768;
	}
	return out;
}

/** 여러 Float32Array 를 단일 Float32Array 로 연결한다. */
function concatFloat32(parts: ReadonlyArray<Float32Array>): Float32Array {
	let total = 0;
	for (const p of parts) total += p.length;
	if (total === 0) return new Float32Array(0);
	const out = new Float32Array(total);
	let offset = 0;
	for (const p of parts) {
		out.set(p, offset);
		offset += p.length;
	}
	return out;
}
