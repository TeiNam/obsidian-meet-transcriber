/**
 * `AudioCapture` — 마이크 권한 요청과 PCM 청크 스트림 제공.
 *
 * 본 서비스는 Transcribe 파이프라인의 오디오 입력단을 담당한다. 브라우저의
 * `navigator.mediaDevices.getUserMedia`로 마이크 접근을 요청하고, 획득된
 * `MediaStream`을 `AudioContext` + `AudioWorkletNode`(pcm-processor) 그래프에
 * 연결하여 Float32 샘플을 Int16 PCM(16kHz/모노/리틀엔디안)으로 변환한 뒤,
 * 호출 측이 `for await` 으로 소비할 수 있는 `AsyncIterable<Uint8Array>`를 노출한다.
 *
 * ## 관련 요구사항
 * - Requirements 3.1 (마이크 권한 요청)
 * - Requirements 3.4 (PCM 16kHz/16-bit/mono, 최대 200ms 간격 전송)
 * - Requirements 8.3 (언로드 시 MediaStream 트랙 `stop()`)
 *
 * ## 테스트 가능성
 * JSDOM은 AudioWorklet/AudioContext/getUserMedia 를 실제로 실행할 수 없다.
 * 단위 테스트에서는 생성자 옵션으로 `getUserMedia`, `AudioContextCtor` 를 주입하고
 * worklet 소스 혹은 URL 을 우회해 동작을 검증한다.
 *
 * ## 심사 준수
 * - 로깅은 `console.error`만 사용 (Requirements 9.6).
 * - 전역 `var` 미사용, `innerHTML` 계열 미사용.
 * - 플러그인 비활성화 시 자원 누수 방지를 위해 `stop()`은 이중 호출에 안전하다 (Requirements 8.3).
 */

import { TranscribeError } from "../types/errors";

/**
 * 전사 파이프라인이 요구하는 목표 샘플레이트(Hz).
 *
 * Requirements 3.4 의 "PCM 16kHz" 요구를 AudioWorklet 의
 * `processorOptions.targetSampleRate` 로 전달하여, 브라우저 입력이 48kHz 등
 * 다른 샘플레이트라도 worklet 내부에서 다운샘플링을 수행한다.
 */
const TARGET_SAMPLE_RATE = 16000;

/**
 * `pcm-worklet.js` 에서 `registerProcessor` 로 등록된 프로세서 이름.
 *
 * `new AudioWorkletNode(ctx, name, ...)` 에 그대로 전달된다.
 */
const WORKLET_PROCESSOR_NAME = "pcm-processor";

/**
 * `AudioCapture` 생성자 주입 옵션.
 *
 * 프로덕션에서는 모든 필드를 생략한 기본 생성자로 충분하며, 테스트에서는
 * 필요한 의존성을 목(mock) 으로 주입한다. `workletSource` 는 번들러가 worklet
 * 스크립트를 문자열로 임포트해 전달하는 용도이며, `workletUrl` 이 주어지면
 * Blob 생성을 생략하고 그 URL 로 직접 `addModule` 한다.
 */
export interface AudioCaptureOptions {
	/**
	 * `navigator.mediaDevices.getUserMedia` 대체 함수.
	 * 생략 시 전역 `navigator.mediaDevices.getUserMedia` 를 사용한다.
	 */
	getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;

	/**
	 * `AudioContext` 생성자 대체.
	 * 생략 시 전역 `AudioContext` 를 사용한다.
	 */
	AudioContextCtor?: typeof AudioContext;

	/**
	 * AudioWorklet 모듈의 원시 JavaScript 소스 문자열.
	 * 주어지면 `Blob` URL 을 만들어 `audioWorklet.addModule` 에 전달한다.
	 * Obsidian 플러그인은 추가 파일을 상대 경로로 서빙할 수 없으므로, worklet 은
	 * 번들 시 텍스트로 임포트되어 본 옵션으로 주입되는 것이 표준 경로이다.
	 */
	workletSource?: string;

	/**
	 * 사전 계산된 AudioWorklet 모듈 URL.
	 * 제공 시 `workletSource` 보다 우선한다. 테스트 및 특수 환경용.
	 */
	workletUrl?: string;
}

/**
 * 마이크 오디오 캡처 및 PCM 변환 서비스.
 *
 * 한 인스턴스가 여러 `pcmChunks` 세션을 순차적으로 처리할 수 있도록 설계되었으며,
 * 각 세션의 `AudioContext` 와 생성된 Blob URL 은 내부 Set 에 추적되어
 * `stop(stream)` 호출이나 정상 종료 시 확실히 해제된다.
 */
export class AudioCapture {
	/** 현재 살아 있는 AudioContext 목록. `stop()` 에서 일괄 정리된다. */
	private readonly contexts = new Set<AudioContext>();

	/** 생성한 Blob URL 목록. `stop()` 에서 `URL.revokeObjectURL` 로 해제된다. */
	private readonly blobUrls = new Set<string>();

	constructor(private readonly options: AudioCaptureOptions = {}) {}

	/**
	 * 마이크 접근 권한을 요청하고 16kHz 모노 `MediaStream` 을 반환한다.
	 *
	 * 브라우저가 요청한 제약을 정확히 수용하지 못할 수 있으므로, 실제 샘플레이트는
	 * `pcmChunks` 파이프라인에서 AudioWorklet 의 다운샘플링이 보정한다.
	 *
	 * 에러 분기:
	 * - `navigator.mediaDevices` 자체가 없으면 `MIC_PERMISSION_DENIED` 로 즉시 실패.
	 * - `NotAllowedError` / `PermissionDeniedError` 는 사용자 거부로 보고 동일 코드로 래핑.
	 * - 그 외 예외도 래핑하여 호출 측이 코드 기반으로 분기할 수 있게 한다.
	 *
	 * Requirements 3.1.
	 */
	async requestPermission(): Promise<MediaStream> {
		const getUserMedia = this.resolveGetUserMedia();
		if (!getUserMedia) {
			throw new TranscribeError(
				"Microphone API (navigator.mediaDevices.getUserMedia) is not available in this environment.",
				"MIC_PERMISSION_DENIED",
			);
		}

		try {
			return await getUserMedia({
				audio: {
					sampleRate: TARGET_SAMPLE_RATE,
					channelCount: 1,
					echoCancellation: true,
				},
			});
		} catch (err) {
			const name = err instanceof Error ? err.name : "";
			// NotAllowedError 와 PermissionDeniedError 는 모두 사용자/OS 의 권한 거부에 해당한다.
			// 권한 거부 외의 원인(예: NotFoundError, OverconstrainedError) 도 사용자에게는
			// 동일하게 "마이크 사용 불가" 로 보이므로 같은 코드로 매핑하고 message 에 원인을 남긴다.
			const message =
				name === "NotAllowedError" || name === "PermissionDeniedError"
					? "Microphone permission was denied."
					: `Failed to access microphone: ${err instanceof Error ? err.message : String(err)}`;
			throw new TranscribeError(message, "MIC_PERMISSION_DENIED", err);
		}
	}

	/**
	 * `MediaStream` 을 소비하며 Int16 PCM 청크를 비동기 이터러블로 yield 한다.
	 *
	 * 내부 파이프라인:
	 * 1. `AudioContext` 생성 (브라우저 기본 샘플레이트).
	 * 2. `audioWorklet.addModule(workletUrl)` 로 `pcm-processor` 등록.
	 * 3. `MediaStreamAudioSourceNode` → `AudioWorkletNode` 연결.
	 * 4. 이어서 `AudioWorkletNode` → `ctx.destination` 으로 연결(출력 무음).
	 *    worklet 이 outputs 에 쓰지 않으므로 스피커로는 무음이 나가며,
	 *    일부 브라우저에서 destination 경로가 있어야 process() 가 호출되는 문제를 회피한다.
	 * 5. worklet 이 `postMessage(ArrayBuffer)` 로 보내는 청크를 큐에 적재.
	 * 6. 호출 측이 `for await` 로 소비할 때마다 큐에서 하나씩 yield.
	 *
	 * 이터러블이 조기 종료(break / return / throw)되면 `finally` 에서 다음을 수행한다:
	 * - 대기 중인 Promise 들을 깨워 누수 방지
	 * - 오디오 노드 disconnect / 메시지 핸들러 해제
	 * - `AudioContext.close()` 호출
	 *
	 * Requirements 3.4.
	 *
	 * @param stream - `requestPermission()` 이 반환한 MediaStream.
	 * @param chunkMs - 한 청크의 길이(밀리초). 기본 100ms (요구사항 최대 200ms 이내).
	 */
	async *pcmChunks(
		stream: MediaStream,
		chunkMs: number = 100,
	): AsyncIterable<Uint8Array> {
		const ctx = this.createContext();
		let source: MediaStreamAudioSourceNode | undefined;
		let node: AudioWorkletNode | undefined;

		try {
			const workletUrl = this.resolveWorkletUrl();
			await ctx.audioWorklet.addModule(workletUrl);

			// 브라우저가 16kHz AudioContext 를 거부한 경우 경고만 남기고 계속 진행한다.
			// 실제 다운샘플링은 worklet 내부에서 입력 샘플레이트 기준으로 이루어진다.
			if (ctx.sampleRate !== TARGET_SAMPLE_RATE) {
				console.error(
					`[Transcribe] AudioContext sampleRate is ${ctx.sampleRate}Hz; worklet will downsample to ${TARGET_SAMPLE_RATE}Hz.`,
				);
			}

			source = ctx.createMediaStreamSource(stream);
			node = new AudioWorkletNode(ctx, WORKLET_PROCESSOR_NAME, {
				processorOptions: {
					chunkMs,
					targetSampleRate: TARGET_SAMPLE_RATE,
				},
				numberOfInputs: 1,
				numberOfOutputs: 1,
				outputChannelCount: [1],
				channelCount: 1,
				channelCountMode: "explicit",
				channelInterpretation: "speakers",
			});

			// 큐 + 대기자 패턴 — 청크 도착 시 대기자가 있으면 즉시 해소, 없으면 큐에 적재.
			const queue: Uint8Array[] = [];
			const waiters: Array<(value: Uint8Array | null) => void> = [];
			let closed = false;

			node.port.onmessage = (event: MessageEvent) => {
				if (closed) {
					return;
				}
				const data: unknown = event.data;
				// 프로세서는 Int16 PCM 의 ArrayBuffer 만 전송한다.
				if (data instanceof ArrayBuffer) {
					const chunk = new Uint8Array(data);
					const waiter = waiters.shift();
					if (waiter) {
						waiter(chunk);
					} else {
						queue.push(chunk);
					}
				}
			};

			node.onprocessorerror = (ev: Event) => {
				// worklet 스크립트 내부 예외는 심각한 상태이므로 로그만 남기고,
				// 이후 발생하는 빈 메시지로 자연스럽게 스트림이 말라붙도록 둔다.
				console.error("[Transcribe] AudioWorkletNode processor error:", ev);
			};

			source.connect(node);
			// worklet 이 outputs 에 쓰지 않으므로 destination 으로는 무음이 전달된다.
			// (이 연결이 없으면 일부 브라우저에서 process() 가 호출되지 않을 수 있다.)
			node.connect(ctx.destination);

			try {
				while (!closed) {
					const next = queue.shift();
					if (next !== undefined) {
						yield next;
						continue;
					}
					const awaited = await new Promise<Uint8Array | null>((resolve) => {
						waiters.push(resolve);
					});
					if (awaited === null) {
						break;
					}
					yield awaited;
				}
			} finally {
				closed = true;
				// 대기자 전원에게 null 을 전달해 깨운다. 안 그러면 await 에서 영원히 멈춘다.
				while (waiters.length > 0) {
					const resolve = waiters.shift();
					if (resolve) {
						resolve(null);
					}
				}
				this.teardownAudioGraph(source, node);
				await this.closeContext(ctx);
			}
		} catch (err) {
			// generator 의 finally 바깥에서 발생한 예외는 자원이 아직 설정 중일 수 있으므로
			// 방어적으로 정리한 뒤 재-throw 한다.
			this.teardownAudioGraph(source, node);
			await this.closeContext(ctx);
			throw err;
		}
	}

	/**
	 * 주어진 `MediaStream` 의 모든 트랙을 중지하고, 본 인스턴스가 생성한
	 * `AudioContext` 및 Blob URL 을 일괄 정리한다.
	 *
	 * - 멱등성: 이미 정지된 트랙에 `stop()` 재호출은 no-op 이며,
	 *   이미 닫힌 `AudioContext.close()` 는 예외를 잡아 삼킨다.
	 * - 이 메서드는 `pcmChunks` 이터러블의 `finally` 가 이미 자원을 정리한 경우에도
	 *   안전하게 호출할 수 있다 (안전 그물망 역할).
	 *
	 * Requirements 8.3.
	 */
	stop(stream: MediaStream): void {
		try {
			for (const track of stream.getTracks()) {
				try {
					track.stop();
				} catch (err) {
					console.error("[Transcribe] Failed to stop media track:", err);
				}
			}
		} catch (err) {
			console.error("[Transcribe] Failed to iterate media stream tracks:", err);
		}

		// 본 인스턴스가 여전히 관리 중인 AudioContext 들을 비동기적으로 닫는다.
		// `stop()` 자체는 동기 API 이므로 void-Promise 로 내버려두되, 내부에서 에러를 삼킨다.
		for (const ctx of Array.from(this.contexts)) {
			void this.closeContext(ctx);
		}

		this.revokeBlobUrls();
	}

	// ---------------------------------------------------------------------------
	// private helpers
	// ---------------------------------------------------------------------------

	/**
	 * 주입된 `getUserMedia` 또는 전역 `navigator.mediaDevices.getUserMedia` 를 해석한다.
	 *
	 * 전역이 없는 환경(구 브라우저, JSDOM 등)에서는 `undefined` 를 반환하여
	 * 호출 측이 의미 있는 에러를 발생시키도록 한다.
	 */
	private resolveGetUserMedia():
		| ((constraints: MediaStreamConstraints) => Promise<MediaStream>)
		| undefined {
		if (this.options.getUserMedia) {
			return this.options.getUserMedia;
		}
		if (
			typeof navigator !== "undefined" &&
			navigator.mediaDevices &&
			typeof navigator.mediaDevices.getUserMedia === "function"
		) {
			return navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
		}
		return undefined;
	}

	/**
	 * `AudioContext` 를 생성해 내부 Set 에 등록한다.
	 *
	 * 브라우저 구현이 16kHz 컨텍스트를 거부하는 경우 `sampleRate` 옵션 없이 재시도하여
	 * 브라우저 기본 샘플레이트로 생성한다(실제 다운샘플링은 worklet 이 담당).
	 */
	private createContext(): AudioContext {
		const Ctor =
			this.options.AudioContextCtor ??
			(typeof AudioContext !== "undefined" ? AudioContext : undefined);
		if (!Ctor) {
			throw new TranscribeError(
				"AudioContext is not available in this environment.",
				"MIC_PERMISSION_DENIED",
			);
		}

		let ctx: AudioContext;
		try {
			ctx = new Ctor({ sampleRate: TARGET_SAMPLE_RATE });
		} catch (err) {
			// 브라우저가 요청된 샘플레이트를 지원하지 않으면 기본 샘플레이트로 재시도.
			console.error(
				"[Transcribe] AudioContext construction at target sample rate failed; falling back to default:",
				err,
			);
			ctx = new Ctor();
		}
		this.contexts.add(ctx);
		return ctx;
	}

	/**
	 * AudioWorklet 모듈에 전달할 URL 을 결정한다.
	 *
	 * 우선순위: `workletUrl` > `workletSource` (Blob URL 생성) > 예외.
	 */
	private resolveWorkletUrl(): string {
		if (this.options.workletUrl) {
			return this.options.workletUrl;
		}
		if (this.options.workletSource) {
			const blob = new Blob([this.options.workletSource], {
				type: "application/javascript",
			});
			const url = URL.createObjectURL(blob);
			this.blobUrls.add(url);
			return url;
		}
		throw new TranscribeError(
			"AudioWorklet source or URL was not provided to AudioCapture. " +
				"Pass `workletSource` or `workletUrl` in AudioCaptureOptions.",
			"MIC_PERMISSION_DENIED",
		);
	}

	/**
	 * 오디오 그래프의 노드를 disconnect 하고 메시지 핸들러를 해제한다.
	 *
	 * 호출 시점에 노드가 `undefined` 이거나 이미 해제된 상태일 수 있으므로
	 * 모든 예외를 조용히 로깅하고 계속 진행한다.
	 */
	private teardownAudioGraph(
		source: MediaStreamAudioSourceNode | undefined,
		node: AudioWorkletNode | undefined,
	): void {
		if (source) {
			try {
				source.disconnect();
			} catch (err) {
				console.error("[Transcribe] Failed to disconnect audio source:", err);
			}
		}
		if (node) {
			try {
				node.disconnect();
			} catch (err) {
				console.error("[Transcribe] Failed to disconnect worklet node:", err);
			}
			try {
				node.port.onmessage = null;
			} catch (err) {
				console.error("[Transcribe] Failed to clear worklet message handler:", err);
			}
		}
	}

	/**
	 * `AudioContext.close()` 를 멱등하게 호출하고 내부 Set 에서 제거한다.
	 */
	private async closeContext(ctx: AudioContext): Promise<void> {
		this.contexts.delete(ctx);
		if (ctx.state === "closed") {
			return;
		}
		try {
			await ctx.close();
		} catch (err) {
			console.error("[Transcribe] Failed to close AudioContext:", err);
		}
	}

	/**
	 * 생성된 Blob URL 을 모두 해제한다.
	 *
	 * `addModule` 이후에는 URL 을 revoke 해도 모듈 실행에 영향이 없다.
	 */
	private revokeBlobUrls(): void {
		for (const url of Array.from(this.blobUrls)) {
			try {
				URL.revokeObjectURL(url);
			} catch (err) {
				console.error("[Transcribe] Failed to revoke blob URL:", err);
			}
		}
		this.blobUrls.clear();
	}
}
