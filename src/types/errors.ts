/**
 * 플러그인 전반에서 사용하는 에러 타입 정의.
 *
 * 설계 문서(design.md)의 "Error Handling" → "에러 타입 정의" 섹션에 정의된
 * `TranscribeError`를 구현한다. 각 `code`는 `t.notices.*` 번역 키에 매핑되어
 * UI 로케일에 맞는 메시지로 사용자에게 표시된다.
 */

/**
 * 플러그인에서 발생 가능한 모든 에러 코드의 유니온 타입.
 *
 * - `MIC_PERMISSION_DENIED`: 사용자가 마이크 권한 프롬프트를 거부했거나 OS 레벨에서 차단된 경우.
 * - `SESSION_TIMEOUT`: AWS Transcribe Streaming 세션 수립이 10초 이내에 완료되지 않은 경우.
 * - `CONNECTION_LOST`: 진행 중인 Transcribe 스트리밍 세션 연결이 끊어진 경우(재연결 시도 전).
 * - `RECONNECT_EXHAUSTED`: 재연결을 2회 시도했으나 모두 실패한 경우(영구 실패로 간주).
 * - `AWS_AUTH`: AWS 자격 증명이 유효하지 않거나 권한 부족(`AccessDenied` 등)인 경우.
 * - `AWS_MODEL_UNAVAILABLE`: Bedrock 모델이 해당 리전/계정에서 사용 불가(`ValidationException` 등)인 경우.
 * - `AWS_NETWORK`: AWS API 호출 중 네트워크 레벨 오류가 발생한 경우.
 * - `IO_ERROR`: Vault 파일 저장 등 로컬 I/O 작업 실패.
 * - `SETTINGS_INCOMPLETE`: 필수 설정 항목(자격 증명, 모델, 폴더 등)이 누락된 상태로 동작 시도.
 * - `BUFFER_EMPTY`: 전사 버퍼가 비어 있어 분석/저장을 수행할 수 없는 경우.
 * - `TRANSCRIPT_TOO_LONG`: 분석 대상 전사 본문이 모델 컨텍스트 한도를 초과한 경우.
 * - `FOLDER_CREATE_FAILED`: 전사 결과를 저장할 대상 폴더 생성에 실패한 경우.
 */
export type TranscribeErrorCode =
    | "MIC_PERMISSION_DENIED"
    | "SESSION_TIMEOUT"
    | "CONNECTION_LOST"
    | "RECONNECT_EXHAUSTED"
    | "AWS_AUTH"
    | "AWS_MODEL_UNAVAILABLE"
    | "AWS_NETWORK"
    | "IO_ERROR"
    | "SETTINGS_INCOMPLETE"
    | "BUFFER_EMPTY"
    | "TRANSCRIPT_TOO_LONG"
    | "FOLDER_CREATE_FAILED";

/**
 * 플러그인 도메인 전용 에러 클래스.
 *
 * 표준 `Error`를 확장하여 분류용 `code`와 원인 오류 `cause`를 함께 전달한다.
 * 서비스 계층에서 이 에러를 throw 하면 UI 계층이 `code`를 기반으로
 * i18n 메시지를 조회하고 사용자에게 `Notice`로 안내한다.
 *
 * @example
 * ```ts
 * throw new TranscribeError(
 *   "Microphone permission denied",
 *   "MIC_PERMISSION_DENIED",
 *   originalError,
 * );
 * ```
 */
export class TranscribeError extends Error {
    constructor(
        message: string,
        public readonly code: TranscribeErrorCode,
        public readonly cause?: unknown,
    ) {
        super(message);
        // ES5 이하로 트랜스파일될 때 `instanceof` 판정이 어긋나는 문제를 방지한다.
        // 현재 타깃은 ES2020이지만 번들러/툴체인 호환성을 위해 안전장치를 둔다.
        Object.setPrototypeOf(this, TranscribeError.prototype);
        this.name = "TranscribeError";
    }
}
