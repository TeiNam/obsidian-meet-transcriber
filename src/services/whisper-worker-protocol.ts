/**
 * Whisper 워커 메시지 프로토콜 정의 (메인 스레드 ↔ Web Worker 공유).
 *
 * 본 파일은 코드를 포함하지 않는 순수 타입 모듈이며, `Local_Whisper_Service`
 * (메인 스레드) 와 `whisper-worker.ts` (워커) 양측에서 import 하여
 * `postMessage` / `onmessage` 메시지의 형태를 강제한다.
 *
 * 매핑:
 * - Requirement 4 (로컬 Whisper 전사 실행)
 * - Requirement 12.4 (테스트 가능성 — 인터페이스 + DI 추상화)
 * - design.md §Worker Protocol
 */

/**
 * 워커가 한 청크에 대해 메인 스레드로 반환하는 추론 결과 1 건.
 *
 * design.md §Data Models 5 의 정의와 일치한다.
 *
 * - `chunkStartSeconds`: 추론 대상 청크의 세션 시작 시점 기준 시작 초.
 * - `chunkDurationSeconds`: 청크 길이(초). progress-only 모드의 경우 전체 녹음 시간.
 * - `segments`: Whisper 가 분할한 segment 리스트. `start`/`end` 는
 *   `chunkStartSeconds` 가 이미 가산된 세션 시작 기준 절대 시각이다.
 * - `inferenceDurationMs`: 추론 자체 소요 시간(ms). Requirement 11.3 의
 *   진단 로깅에 사용된다.
 */
export interface Local_Inference_Result {
    readonly chunkStartSeconds: number;
    readonly chunkDurationSeconds: number;
    readonly segments: ReadonlyArray<{
        readonly start: number;
        readonly end: number;
        readonly text: string;
    }>;
    readonly inferenceDurationMs: number;
}

/**
 * 메인 스레드가 워커로 보내는 요청 메시지의 discriminated union.
 *
 * 4 종류:
 * - `load`: 모델 가중치 로드 요청.
 * - `infer`: 한 청크의 PCM 데이터를 추론 요청. ArrayBuffer 는 transferList 로 이동.
 * - `abort`: 특정 `requestId` 의 in-flight 추론만 폐기 (워커 자체는 살아있음).
 * - `dispose`: 워커 종료 요청. 응답 후 `self.close()`.
 */
export type WhisperWorkerRequest =
    | {
          readonly type: "load";
          readonly requestId: string;
          readonly modelId: string;
          readonly modelFilePath: string;
      }
    | {
          readonly type: "infer";
          readonly requestId: string;
          /** Float32 PCM 16kHz mono. ArrayBuffer 는 transferList 로 이동. */
          readonly pcm: Float32Array;
          readonly chunkStartSeconds: number;
      }
    | {
          readonly type: "abort";
          readonly requestId: string;
      }
    | {
          readonly type: "dispose";
      };

/**
 * 워커가 메인 스레드로 보내는 응답 메시지의 discriminated union.
 *
 * 6 종류:
 * - `loaded`: `load` 완료 응답.
 * - `load-progress`: 모델 로딩 진행률 (0..100).
 * - `infer-result`: `infer` 완료 응답. `Local_Inference_Result` 1 건 포함.
 * - `infer-aborted`: `abort` 가 적용되어 in-flight 추론이 폐기되었음을 통지.
 * - `error`: 에러 발생. `code` 는 진단용 짧은 코드 4 종 한정 — 본문/스택은
 *   송신하지 않는다 (Requirement 11.1).
 * - `disposed`: `dispose` 완료. 워커는 곧 `self.close()` 한다.
 */
export type WhisperWorkerResponse =
    | { readonly type: "loaded"; readonly requestId: string }
    | {
          readonly type: "load-progress";
          readonly requestId: string;
          readonly percent: number;
      }
    | {
          readonly type: "infer-result";
          readonly requestId: string;
          readonly result: Local_Inference_Result;
      }
    | { readonly type: "infer-aborted"; readonly requestId: string }
    | {
          readonly type: "error";
          readonly requestId: string;
          /** 진단용 짧은 코드. 본문 송신 안 함 (Requirement 11.1). */
          readonly code:
              | "model_not_found"
              | "model_corrupted"
              | "infer_failed"
              | "out_of_memory";
      }
    | { readonly type: "disposed" };
