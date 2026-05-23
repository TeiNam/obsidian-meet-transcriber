/**
 * `WhisperWorkerClient` — `LocalInferenceClient` 인터페이스의 Web Worker 어댑터.
 *
 * 메인 스레드에서 `Local_Whisper_Service` 가 본 클래스를 통해 `whisper-worker.js`
 * 워커와 `WhisperWorkerRequest` / `WhisperWorkerResponse` 프로토콜로 통신한다.
 * 본 클래스는 워커의 lifecycle (생성, 메시지 송수신, dispose, terminate fallback)
 * 만 다루며 추론 로직 자체는 워커에 위임한다.
 *
 * Requirement 4.1 (마이크 PCM 외부 미전송), 10.1 (워커 격리), 10.5 (5초 dispose
 * fallback), 12.4 (인터페이스 추상화).
 *
 * 호출 측 흐름:
 * 1. `new WhisperWorkerClient(workerSource)` — 생성 시점에는 워커를 띄우지 않는다.
 * 2. `load(modelId, modelFilePath)` — 첫 호출 시 워커를 띄우고 `load` 메시지 발사.
 * 3. `infer(pcm, startSeconds, signal)` — `infer` 메시지 발사 + 응답 대기. signal
 *    은 in-flight 추론을 abort 하려는 호출 측 의도를 워커로 전달한다 (`abort` 메시지).
 * 4. `dispose()` — `dispose` 메시지 발사 + 5 초 한도. 초과 시 `worker.terminate()`.
 *
 * 본 어댑터는 워커 내부 에러를 `Local_Whisper_Service.classifyClientError` 가 인식
 * 할 수 있는 `Error.name` 으로 변환해 throw 한다 (`model_not_found`, `model_corrupted`,
 * `infer_failed`, `out_of_memory` 4 종 — Requirement 11.1).
 */

import type { LocalInferenceClient } from "./Local_Whisper_Service";
import type {
	Local_Inference_Result,
	WhisperWorkerRequest,
	WhisperWorkerResponse,
} from "./whisper-worker-protocol";

/** dispose 정상 종료 대기 한도 (ms). Requirement 10.5. */
const DISPOSE_TIMEOUT_MS = 5_000;

/**
 * 워커 진입점 소스의 URL.
 *
 * `whisper-worker.js` 는 esbuild 가 플러그인 루트에 떨어뜨리므로, 호출 측(main.ts) 이
 * Obsidian 의 `vault.adapter.getResourcePath()` 또는 인접 경로 헬퍼로 URL 을 만들어
 * 주입한다.
 */
export type WorkerSourceUrl = string;

/** 진행 중인 메시지 한 건의 resolver 묶음. */
interface PendingRequest {
	readonly type: "load" | "infer";
	readonly resolve: (result: PendingResult) => void;
	readonly reject: (err: Error) => void;
}

type PendingResult =
	| { readonly type: "loaded" }
	| { readonly type: "infer-result"; readonly result: Local_Inference_Result };

export class WhisperWorkerClient implements LocalInferenceClient {
	private worker: Worker | null = null;
	private readonly pending: Map<string, PendingRequest> = new Map();
	private nextRequestId = 0;
	private disposed = false;

	/**
	 * @param workerSourceUrl  `new Worker(...)` 에 넘길 워커 진입점 URL.
	 *                         테스트에서는 mock URL 또는 stub Worker 팩토리로 대체 가능.
	 * @param workerFactory    선택. 기본 `(url) => new Worker(url)`. 테스트에서 mock 워커
	 *                         생성용으로 주입 가능.
	 */
	constructor(
		private readonly workerSourceUrl: WorkerSourceUrl,
		private readonly workerFactory: (url: string) => Worker = (url) =>
			new Worker(url),
	) {}

	async load(modelId: string, modelFilePath: string): Promise<void> {
		this.ensureWorker();
		const requestId = this.allocRequestId();
		const result = await this.sendAndWait({
			type: "load",
			requestId,
			modelId,
			modelFilePath,
		});
		if (result.type !== "loaded") {
			throw makeNamedError("infer_failed");
		}
	}

	async infer(
		pcm: Float32Array,
		startSeconds: number,
		signal: AbortSignal,
	): Promise<Local_Inference_Result> {
		this.ensureWorker();
		const requestId = this.allocRequestId();

		// signal 이 abort 되면 워커로 abort 메시지를 발사하고 pending 을 reject 한다.
		const onAbort = (): void => {
			const pending = this.pending.get(requestId);
			if (!pending) return;
			this.pending.delete(requestId);
			this.postMessage({ type: "abort", requestId });
			pending.reject(makeNamedError("AbortError"));
		};
		signal.addEventListener("abort", onAbort, { once: true });

		try {
			const result = await this.sendAndWait(
				{
					type: "infer",
					requestId,
					pcm,
					chunkStartSeconds: startSeconds,
				},
				[pcm.buffer],
			);
			if (result.type !== "infer-result") {
				throw makeNamedError("infer_failed");
			}
			return result.result;
		} finally {
			signal.removeEventListener("abort", onAbort);
		}
	}

	async dispose(): Promise<void> {
		if (this.disposed || !this.worker) {
			this.disposed = true;
			return;
		}

		const worker = this.worker;
		const disposedPromise = new Promise<void>((resolve) => {
			const handler = (event: MessageEvent<WhisperWorkerResponse>): void => {
				if (event.data.type === "disposed") {
					worker.removeEventListener("message", handler);
					resolve();
				}
			};
			worker.addEventListener("message", handler);
		});
		this.postMessage({ type: "dispose" });

		const timeoutPromise = new Promise<void>((resolve) => {
			setTimeout(resolve, DISPOSE_TIMEOUT_MS);
		});

		await Promise.race([disposedPromise, timeoutPromise]);
		// 정상이든 timeout 이든 안전하게 terminate. 중복 terminate 는 no-op.
		try {
			worker.terminate();
		} catch (err) {
			console.error("[WhisperWorkerClient] terminate failed:", err);
		}
		this.worker = null;
		this.disposed = true;
		// pending 에 남아있는 요청은 모두 reject (방어적 처리).
		for (const pending of this.pending.values()) {
			pending.reject(makeNamedError("infer_failed"));
		}
		this.pending.clear();
	}

	// ──────────────────────────────────────────────────────────
	// 내부 헬퍼
	// ──────────────────────────────────────────────────────────

	private ensureWorker(): void {
		if (this.disposed) {
			throw makeNamedError("infer_failed");
		}
		if (this.worker) return;
		const worker = this.workerFactory(this.workerSourceUrl);
		worker.addEventListener(
			"message",
			(event: MessageEvent<WhisperWorkerResponse>) => {
				this.handleMessage(event.data);
			},
		);
		worker.addEventListener("error", (event: ErrorEvent) => {
			// 워커 자체 에러 — 진단 정보 없이 짧은 코드만 기록 (Requirement 11.1).
			console.error(
				`[WhisperWorkerClient] worker error: ${event.message ?? "unknown"}`,
			);
			for (const pending of this.pending.values()) {
				pending.reject(makeNamedError("infer_failed"));
			}
			this.pending.clear();
		});
		this.worker = worker;
	}

	private allocRequestId(): string {
		this.nextRequestId += 1;
		return `req-${this.nextRequestId}`;
	}

	private postMessage(
		request: WhisperWorkerRequest,
		transfer?: Transferable[],
	): void {
		if (!this.worker) return;
		if (transfer && transfer.length > 0) {
			this.worker.postMessage(request, transfer);
		} else {
			this.worker.postMessage(request);
		}
	}

	private async sendAndWait(
		request: WhisperWorkerRequest & { requestId: string },
		transfer?: Transferable[],
	): Promise<PendingResult> {
		return new Promise<PendingResult>((resolve, reject) => {
			this.pending.set(request.requestId, {
				type: request.type as "load" | "infer",
				resolve,
				reject,
			});
			this.postMessage(request, transfer);
		});
	}

	private handleMessage(response: WhisperWorkerResponse): void {
		switch (response.type) {
			case "loaded": {
				const pending = this.pending.get(response.requestId);
				if (!pending) return;
				this.pending.delete(response.requestId);
				pending.resolve({ type: "loaded" });
				return;
			}
			case "infer-result": {
				const pending = this.pending.get(response.requestId);
				if (!pending) return;
				this.pending.delete(response.requestId);
				pending.resolve({
					type: "infer-result",
					result: response.result,
				});
				return;
			}
			case "infer-aborted": {
				const pending = this.pending.get(response.requestId);
				if (!pending) return;
				this.pending.delete(response.requestId);
				pending.reject(makeNamedError("AbortError"));
				return;
			}
			case "error": {
				const pending = this.pending.get(response.requestId);
				if (!pending) return;
				this.pending.delete(response.requestId);
				pending.reject(makeNamedError(response.code));
				return;
			}
			case "load-progress":
			case "disposed":
				// 별도 처리 없음. dispose 핸들러가 disposed 를 자체 처리.
				return;
		}
	}
}

/**
 * `Local_Whisper_Service.classifyClientError` 가 인식할 수 있는 `Error.name` 으로
 * 에러를 만든다. message 본문은 빈 문자열로 두어 진단 정보 누설을 차단한다
 * (Requirement 11.1).
 */
function makeNamedError(name: string): Error {
	const err = new Error("");
	err.name = name;
	return err;
}
