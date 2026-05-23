/**
 * Whisper 추론 Web Worker.
 *
 * 메인 스레드의 `Local_Whisper_Service` 가 `new Worker(blobUrl)` 로 띄우고
 * `WhisperWorkerRequest` / `WhisperWorkerResponse` 프로토콜로 통신한다.
 * 모든 추론은 transformers.js v3 의 `pipeline("automatic-speech-recognition", ...)`
 * 를 통해 본 워커 스레드 내부에서만 수행되며, 마이크 PCM 샘플은 메인 스레드와
 * 워커 사이의 ArrayBuffer transfer 외에는 외부로 송신되지 않는다.
 *
 * 매핑:
 * - Requirement 4 (로컬 Whisper 전사 실행)
 * - Requirement 10.1 (메인 스레드 격리)
 * - Requirement 10.5 (5 초 이내 정리)
 * - Requirement 11.1 (본문/스택 trace 미송신, 짧은 진단 코드만)
 * - design.md §6 (워커 책임), §Worker Protocol
 */

import { pipeline } from "@huggingface/transformers";
import type {
    Local_Inference_Result,
    WhisperWorkerRequest,
    WhisperWorkerResponse,
} from "./whisper-worker-protocol";

/**
 * 워커 전역의 최소 타입 표면.
 *
 * tsconfig 가 DOM lib 만 포함하고 WebWorker lib 는 포함하지 않으므로
 * `DedicatedWorkerGlobalScope` 를 직접 참조할 수 없다. 본 워커가 실제로 사용하는
 * 메서드(`onmessage`, `postMessage`, `close`) 만 정의한 좁은 인터페이스로 대체한다.
 */
interface WhisperWorkerScope {
    onmessage:
        | ((event: MessageEvent<WhisperWorkerRequest>) => void)
        | null;
    postMessage(
        message: WhisperWorkerResponse,
        transfer?: Transferable[],
    ): void;
    close(): void;
}

declare const self: WhisperWorkerScope;

/**
 * transformers.js v3 의 `pipeline()` 결과 인스턴스는 callable + `dispose()` 를 갖는다
 * (`AutomaticSpeechRecognitionPipelineType = ... & Callback & Disposable`).
 * TypeScript 의 클래스 InstanceType 추론이 base 의 callable signature 를 그대로 노출하지
 * 않으므로, 호출 시점에 본 좁은 인터페이스로 단일 캐스트하여 사용한다.
 */
interface CallableAsrPipeline {
    (
        audio: Float32Array,
        options: {
            readonly return_timestamps: true;
            readonly chunk_length_s?: number;
            readonly stride_length_s?: number;
        },
    ): Promise<{
        readonly text: string;
        readonly chunks?: ReadonlyArray<{
            readonly timestamp: readonly [number, number | null];
            readonly text: string;
        }>;
    }>;
    dispose?: () => Promise<void> | void;
}

/** 로드된 ASR 파이프라인. `load` 응답 전까지 null. */
let pipe: CallableAsrPipeline | null = null;

/**
 * 진행 중인 추론의 AbortController 추적 Map.
 *
 * transformers.js v3 의 `pipeline()` 호출은 AbortSignal 을 직접 받지 않는다. 따라서
 * 본 워커의 `abort` 처리는 best-effort cancellation 이며, 추론 자체는 즉시 중단되지
 * 않지만 결과 송신 직전에 `signal.aborted` 를 검사해 결과를 폐기한다.
 */
const inFlight = new Map<string, AbortController>();

/** 응답 송신 헬퍼. transferList 는 호출자가 명시할 때만 적용한다. */
function post(response: WhisperWorkerResponse, transfer?: Transferable[]): void {
    if (transfer && transfer.length > 0) {
        self.postMessage(response, transfer);
    } else {
        self.postMessage(response);
    }
}

/**
 * load 단계에서 발생한 에러를 짧은 진단 코드로 분류한다.
 * - 파일이 존재하지 않거나 HTTP 404 → `model_not_found`
 * - 파일은 있으나 파싱/형식/체크섬 문제 → `model_corrupted`
 * - 그 외 (RangeError, OOM, wasm-memory) → `out_of_memory`
 * - 위 셋 모두 미해당 → `infer_failed` (load 실패도 추론 실패로 분류)
 *
 * Requirement 11.1: 에러 본문/스택 trace 는 송신하지 않는다. 메시지 자체는 워커 내부의
 * 휴리스틱 분류에만 사용되고 호출자에게 노출되지 않는다.
 */
function classifyLoadError(
    error: unknown,
): "model_not_found" | "model_corrupted" | "out_of_memory" | "infer_failed" {
    if (isOutOfMemory(error)) return "out_of_memory";
    const msg = errorMessage(error).toLowerCase();
    if (
        msg.includes("404") ||
        msg.includes("enoent") ||
        msg.includes("no such file") ||
        msg.includes("not found") ||
        msg.includes("could not locate")
    ) {
        return "model_not_found";
    }
    if (
        msg.includes("corrupt") ||
        msg.includes("invalid") ||
        msg.includes("parse") ||
        msg.includes("magic") ||
        msg.includes("checksum") ||
        msg.includes("protobuf") ||
        msg.includes("deserialize") ||
        msg.includes("unexpected token") ||
        msg.includes("unsupported model")
    ) {
        return "model_corrupted";
    }
    return "infer_failed";
}

/**
 * infer 단계에서 발생한 에러를 짧은 진단 코드로 분류한다.
 * - OOM 휴리스틱 일치 → `out_of_memory`
 * - 그 외 → `infer_failed`
 */
function classifyInferError(
    error: unknown,
): "out_of_memory" | "infer_failed" {
    return isOutOfMemory(error) ? "out_of_memory" : "infer_failed";
}

/**
 * OOM 휴리스틱: `RangeError` 거나 메시지에 "out of memory" / "wasm-memory" 등이 포함되면
 * 메모리 고갈로 판정한다. wasm 런타임이 RangeError 로 OOM 을 던지는 사례를 커버한다.
 */
function isOutOfMemory(error: unknown): boolean {
    if (error instanceof RangeError) return true;
    const msg = errorMessage(error).toLowerCase();
    return (
        msg.includes("out of memory") ||
        msg.includes("wasm-memory") ||
        msg.includes("memory access out of bounds") ||
        msg.includes("allocation failed")
    );
}

/** 에러를 안전하게 문자열화한다. 본 함수의 반환값은 송신되지 않으며 분류용으로만 사용된다. */
function errorMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    if (typeof error === "string") return error;
    try {
        return JSON.stringify(error);
    } catch {
        return "";
    }
}

/**
 * 모델 로드: 사용자가 지정한 절대 경로(`modelFilePath`) 의 가중치 파일 1 개만 사용하며,
 * `local_files_only: true` 로 네트워크 fallback 을 차단한다 (Requirement 4.1, 4.10).
 *
 * `model_file_name` 은 transformers.js 가 ONNX 모델 파일을 찾을 때 사용하는 파일명
 * 힌트이다. 본 워커는 사용자가 다운로드한 단일 파일의 절대 경로를 그대로 전달한다.
 */
async function handleLoad(
    msg: Extract<WhisperWorkerRequest, { type: "load" }>,
): Promise<void> {
    try {
        const loaded = await pipeline(
            "automatic-speech-recognition",
            msg.modelId,
            {
                local_files_only: true,
                model_file_name: msg.modelFilePath,
                progress_callback: (progress: unknown) => {
                    // transformers.js 의 진행 콜백은 다양한 단계 이벤트를 보낸다.
                    // `progress` 필드(0..100) 가 있을 때만 forward 한다.
                    if (
                        typeof progress === "object" &&
                        progress !== null &&
                        "progress" in progress &&
                        typeof (progress as { progress: unknown }).progress ===
                            "number"
                    ) {
                        post({
                            type: "load-progress",
                            requestId: msg.requestId,
                            percent: (progress as { progress: number }).progress,
                        });
                    }
                },
            },
        );
        pipe = loaded as unknown as CallableAsrPipeline;
        post({ type: "loaded", requestId: msg.requestId });
    } catch (error) {
        post({
            type: "error",
            requestId: msg.requestId,
            code: classifyLoadError(error),
        });
    }
}

/**
 * 청크 추론. PCM 16 kHz mono Float32Array 를 그대로 transformers.js 에 넘기고, segment 별
 * 시작/끝 초에 `chunkStartSeconds` 를 가산하여 세션 시작 기준 절대 시각으로 정규화한다.
 *
 * abort 처리: 추론 자체는 transformers.js 내부에서 비차단으로 진행되므로 즉시 중단되지
 * 않는다. 추론 완료 후 `signal.aborted` 가 참이면 결과를 폐기하고 `infer-aborted` 응답을
 * 한 번만 송신한다(중복 전송 방지를 위해 abort 핸들러가 이미 송신한 경우는 skip).
 */
async function handleInfer(
    msg: Extract<WhisperWorkerRequest, { type: "infer" }>,
): Promise<void> {
    if (!pipe) {
        post({
            type: "error",
            requestId: msg.requestId,
            code: "infer_failed",
        });
        return;
    }
    const controller = new AbortController();
    inFlight.set(msg.requestId, controller);
    const startedAt = performance.now();
    try {
        // pipe 는 callable. transformers.js 의 ASR 파이프라인은 단일 입력에 대해 단일 객체를
        // 반환한다 (배열 입력일 때만 배열 반환).
        const raw = await pipe(msg.pcm, {
            return_timestamps: true,
            // 청크 길이는 메인 스레드의 chunked-streaming 모드(30~60 초) 와 동일하게 30 초.
            chunk_length_s: 30,
            stride_length_s: 5,
        });

        if (controller.signal.aborted) {
            // abort 핸들러가 이미 infer-aborted 를 송신했다. 결과 폐기.
            return;
        }

        const inferenceDurationMs = performance.now() - startedAt;
        const segments = (raw.chunks ?? []).map((chunk) => ({
            start: (chunk.timestamp[0] ?? 0) + msg.chunkStartSeconds,
            // Whisper 가 마지막 chunk 의 end 를 null 로 반환하는 경우가 있다 (긴 침묵 등).
            // 이 경우 start 와 동일하게 두어 단조성 불변식(end >= start) 만 충족시킨다.
            end:
                (chunk.timestamp[1] ?? chunk.timestamp[0] ?? 0) +
                msg.chunkStartSeconds,
            text: chunk.text,
        }));

        // chunks 가 비어 있고 transcript 만 있는 경우(짧은 입력) 단일 segment 로 폴백.
        const finalSegments =
            segments.length > 0
                ? segments
                : raw.text.trim().length > 0
                  ? [
                        {
                            start: msg.chunkStartSeconds,
                            end:
                                msg.chunkStartSeconds +
                                msg.pcm.length / 16000,
                            text: raw.text,
                        },
                    ]
                  : [];

        const result: Local_Inference_Result = {
            chunkStartSeconds: msg.chunkStartSeconds,
            chunkDurationSeconds: msg.pcm.length / 16000,
            segments: finalSegments,
            inferenceDurationMs,
        };
        post({ type: "infer-result", requestId: msg.requestId, result });
    } catch (error) {
        if (controller.signal.aborted) {
            // abort 후 발생한 에러는 무시. infer-aborted 는 abort 핸들러가 이미 송신.
            return;
        }
        post({
            type: "error",
            requestId: msg.requestId,
            code: classifyInferError(error),
        });
    } finally {
        inFlight.delete(msg.requestId);
    }
}

/**
 * abort: 해당 requestId 의 in-flight controller 를 abort 표시하고 즉시 `infer-aborted`
 * 응답을 송신한다. 추론 자체는 transformers.js 내부에서 계속 돌 수 있으나, 완료 시점에
 * `handleInfer` 가 `signal.aborted` 를 보고 결과를 폐기한다(이중 송신 방지).
 *
 * 매칭되는 controller 가 없으면(이미 완료/취소된 requestId) silently no-op.
 */
function handleAbort(
    msg: Extract<WhisperWorkerRequest, { type: "abort" }>,
): void {
    const controller = inFlight.get(msg.requestId);
    if (!controller) return;
    controller.abort();
    inFlight.delete(msg.requestId);
    post({ type: "infer-aborted", requestId: msg.requestId });
}

/**
 * dispose: 모든 in-flight 추론을 abort 한 뒤 파이프라인을 해제하고 `disposed` 응답을
 * 보낸다. 마지막으로 `self.close()` 로 워커 스레드를 종료한다 (Requirement 10.5).
 *
 * `pipe.dispose()` 가 실패하더라도 종료 흐름은 막지 않는다.
 */
async function handleDispose(): Promise<void> {
    for (const controller of inFlight.values()) {
        controller.abort();
    }
    inFlight.clear();
    try {
        await pipe?.dispose?.();
    } catch (error) {
        // dispose 실패는 진단 가치가 낮고, 본 워커는 곧 close 된다. 본문은 송신하지 않는다.
        console.error("whisper-worker: dispose failed", errorMessage(error));
    }
    pipe = null;
    post({ type: "disposed" });
    self.close();
}

self.onmessage = (event: MessageEvent<WhisperWorkerRequest>): void => {
    const msg = event.data;
    switch (msg.type) {
        case "load":
            void handleLoad(msg);
            return;
        case "infer":
            void handleInfer(msg);
            return;
        case "abort":
            handleAbort(msg);
            return;
        case "dispose":
            void handleDispose();
            return;
        default: {
            // exhaustiveness check — discriminated union 변경 시 컴파일 에러로 감지.
            const _exhaustive: never = msg;
            void _exhaustive;
        }
    }
};
