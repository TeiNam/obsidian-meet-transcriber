/**
 * `TranscribeService` — AWS Transcribe Streaming 세션 수명주기 관리.
 *
 * 본 서비스는 `AudioCapture`가 생산하는 PCM 청크를 AWS Transcribe Streaming에
 * 양방향 HTTP/2 스트림으로 전달하고, 수신 이벤트(`TranscriptEvent`)의
 * `IsPartial` 필드로 Partial_Result / Final_Result 를 구분하여 콜백으로 노출한다.
 *
 * 본 서비스는 `StreamingStateMachine` 을 **직접 dispatch 하지 않는다**. 상태 전이는
 * `main.ts` 가 콜백을 수신한 뒤 적절한 `StreamingEvent` 로 변환해 dispatch 하는
 * 책임을 진다(계층 간 단방향 의존). 이는 테스트 용이성과 관심사 분리를 위함이다.
 *
 * ## 관련 요구사항
 * - 3.2: AWS 자격 증명/리전/언어 코드로 세션 수립 시도
 * - 3.3: 10초 이내 세션 수립 시 `streaming`으로 전환 신호(onSessionEstablished)
 * - 3.4: 마이크에서 캡처한 PCM 16kHz 청크 최대 200ms 간격 전송
 * - 3.5: Partial_Result 수신 시 `onPartial` 콜백
 * - 3.6, 3.7: Final_Result 수신 시 `onFinal` 콜백(버퍼에 누적)
 * - 3.10: 10초 내 첫 이벤트 없으면 `onSessionError("timeout")`
 * - 3.11: 연결 단절 감지 → 재연결 절차 수행
 * - 4.2: `stop()` 시 5초 이내 종료 신호 전송
 * - 4.10: 5초 경과 시 `AbortController.abort()` 강제 종료
 * - 7.5, 7.6: 단일 세션 불변식(`activeSession` 필드)
 * - 8.2: `dispose()` 시 진행 중 세션 종료
 * - 8.5, 8.7: 연결 단절 시 2초 간격으로 최대 2회 재연결, 모두 실패 시 `reconnect_exhausted`
 *
 * ## 아키텍처 — 세션 수명주기
 *
 * 실행은 두 개의 내부 메서드로 분리되어 있다.
 *
 * 1. `runSessionOnce(session, { isReconnect })` — 단일 시도만 수행하고 결과
 *    (`SessionResult`) 만 반환. **절대 자기 자신이나 재연결 루프를 호출하지 않는다**.
 *    이 격리가 Property 13(재연결 시도 상한)의 핵심이다.
 * 2. `runSessionLifecycle(session)` — 최상위 상태 머신. 초기 시도를 돌린 뒤,
 *    `CONNECTION_LOST` 계열 결과(서버 스트림 종료/첫 이벤트 이후 예외)가 나오면
 *    톱레벨 재연결 루프(최대 `maxReconnectAttempts` 회)를 돌린다. 루프 카운터는
 *    한 복구 사이클 동안만 유효하며 중첩 생성되지 않는다.
 *
 * 이전 구현은 `runSession` 과 `reconnectWithBackoff` 가 상호 재귀적이어서,
 * 재연결 중 발생한 또 다른 연결 단절이 브랜드 뉴 재연결 루프를 생성해
 * 전역 시도 카운터가 바운드되지 않았다(Property 13 PBT 가 `onReconnectAttempt`
 * 137 회 호출을 관찰). 분할+평탄화 리팩토링으로 이를 해결한다.
 *
 * ## 테스트 가능성
 * - `audioCapture` 와 `clientFactory` 는 생성자에서 주입되므로,
 *   `aws-sdk-client-mock` 또는 수동 목으로 클라이언트를 대체할 수 있다.
 * - `reconnectDelayMs` / `sessionEstablishTimeoutMs` / `stopTimeoutMs` 는 생성자 옵션으로
 *   오버라이드 가능하여 테스트에서 타이밍을 짧게 가져갈 수 있다.
 * - `dispose()` 는 동기 함수이므로 테스트 tear-down 에서 안전하게 호출할 수 있다.
 *
 * ## 심사 준수
 * - 모든 로깅은 `console.error` 만 사용(Requirements 9.6).
 * - 민감 정보(자격 증명, 오디오 샘플, 전사 본문) 는 로그에 기록하지 않는다.
 * - `Notice` 등 Obsidian UI API 를 직접 호출하지 않는다(콜백 전달 책임은 main.ts).
 */

import {
	StartStreamTranscriptionCommand,
	TranscribeStreamingClient,
	type AudioStream,
	type Item,
	type Result,
	type TranscriptResultStream,
} from "@aws-sdk/client-transcribe-streaming";

import type { AudioCapture } from "./AudioCapture";
import { TranscriptBuffer } from "../domain/TranscriptBuffer";
import type { Transcript_Segment } from "../domain/segments";
import {
	createInitialSpeakerLabelSessionState,
	mapSpeakerLabel,
	type Speaker_Label_Session_State,
} from "../domain/mapSpeakerLabel";
import type { AwsCredentials, LanguageCode } from "../types/settings";

// -----------------------------------------------------------------------------
// 상수 — 설계 문서(design.md §5)의 타이밍 사양을 단일 소스로 추출
// -----------------------------------------------------------------------------

/**
 * Transcribe Streaming 세션 수립 타임아웃 기본값(ms). Requirements 3.3, 3.10.
 *
 * `start()` 호출 시점부터 첫 이벤트(Partial/Final)가 도착할 때까지 허용되는 최대 시간.
 * 이 시간 내에 이벤트가 도착하지 않으면 `onSessionError("timeout")` 콜백을 호출하고
 * 세션을 abort 한다.
 */
const DEFAULT_SESSION_ESTABLISH_TIMEOUT_MS = 10_000;

/**
 * `stop()` 시 정상 종료를 기다리는 기본 시간(ms). Requirements 4.2, 4.10.
 *
 * 종료 신호 송신 후 이 시간 내에 `send()` 프로미스가 완료되지 않으면
 * `AbortController.abort()` 로 강제 종료한다.
 */
const DEFAULT_STOP_TIMEOUT_MS = 5_000;

/**
 * 재연결 시도 간격 기본값(ms). Requirements 8.5.
 */
const DEFAULT_RECONNECT_INTERVAL_MS = 2_000;

/**
 * 재연결 시도 횟수 상한. Requirements 8.5, 8.7.
 */
const MAX_RECONNECT_ATTEMPTS = 2;

/**
 * AWS Transcribe Streaming 이 요구하는 샘플레이트(Hz). Requirements 3.4.
 *
 * `AudioCapture` 도 동일한 상수를 사용하며, 두 값이 일치해야 한다.
 */
const TRANSCRIBE_SAMPLE_RATE_HERTZ = 16_000;

// -----------------------------------------------------------------------------
// 공개 타입
// -----------------------------------------------------------------------------

/**
 * 전사 이벤트를 소비할 상위 계층(main.ts) 이 제공하는 콜백 묶음.
 *
 * 모든 콜백은 **동기적** 이어야 하며, 내부에서 오래 걸리는 작업을 수행해서는 안 된다.
 * 콜백 내부에서 예외가 발생해도 서비스의 스트리밍 루프가 중단되지 않도록
 * 각 호출은 try/catch 로 감싸 `console.error` 로만 로깅한다.
 */
export interface TranscribeCallbacks {
	/** Partial_Result 수신 시 호출. Requirements 3.5. */
	onPartial(text: string): void;
	/** Final_Result 수신 시 호출. Requirements 3.6, 3.7. */
	onFinal(text: string): void;
	/**
	 * Final_Result 의 구조화된 segment 단위 콜백 (v1.1 신규, design §4.6).
	 *
	 * `onFinal(text)` 가 1 회 발사되는 동일한 Final_Result 에 대해, 화자 구간별로
	 * 1 개 이상의 `Transcript_Segment` 가 추가로 발사된다. 한 Final 응답에 두 명 이상의
	 * 화자가 등장하면 화자별로 segment 가 분할되어 각 segment 마다 별개의 `segmentId` 가
	 * 부여된다 (Requirement 6.5). `Item.Speaker` 가 없는 응답에서는 단일 segment 만
	 * 발사되며 `speakerLabel` 은 `undefined` 가 된다 (Requirement 6.7).
	 *
	 * 본 콜백은 호환성을 위해 선택적(optional) 이다. 호출자가 등록하지 않으면 v1.0
	 * 동작과 동일하게 `onFinal(text)` 만 발사된다.
	 *
	 * 매핑: Requirement 6.4, 6.5, 6.7, 13.4, 13.5.
	 */
	onFinalSegment?(segment: Transcript_Segment): void;
	/** 첫 이벤트가 도착해 세션이 수립된 직후 1회 호출. Requirements 3.3. */
	onSessionEstablished(): void;
	/**
	 * 세션 수립 실패/타임아웃/재연결 소진 등 복구 불가 오류 발생 시 호출.
	 * reason 은 식별용 짧은 영문 키이며, UI 메시지는 호출 측이 i18n 으로 매핑한다.
	 *
	 * - `"timeout"`: 세션 수립 10초 타임아웃(Requirements 3.10) — **초기 시도에서만 발생**.
	 *   재연결 시도 중 동일한 수립 타임아웃은 해당 시도의 실패로만 계상된다.
	 * - `"already_active"`: 단일 세션 불변식 위반(Requirements 7.5, 7.6)
	 * - `"reconnect_exhausted"`: 재연결 2회 모두 실패(Requirements 8.5, 8.7)
	 * - `"stop_timeout"`: stop() 시 5초 내 정상 종료 실패(Requirements 4.10)
	 * - `"start_failed"`: **초기** 세션 시작에서 첫 이벤트 이전 실패(권한/네트워크 등).
	 *   재연결 시도 중 동일 실패는 루프의 실패 카운트로만 계상되며 이 코드를 발사하지 않는다.
	 */
	onSessionError(reason: string): void;
	/** 재연결 시도 시마다 호출(첫 시도 시 attempt=1). Requirements 8.5. */
	onReconnectAttempt(attempt: number): void;
	/** 연결 단절 감지 직후 1회 호출(재연결 시도 전). Requirements 3.11. */
	onConnectionLost(): void;
}

/**
 * `TranscribeService.start()` 매개변수.
 *
 * 매개변수를 객체로 받는 이유: 호출부에서 이름 붙은 인자로 의미를 드러내고,
 * 향후 옵션 추가 시 기존 호출부를 깨지 않기 위함이다.
 */
export interface StartParams {
	/** AWS IAM access/secret. `clientFactory` 로 전달되어 SDK 서명에 사용된다. */
	credentials: AwsCredentials;
	/** Transcribe Streaming 엔드포인트 리전(예: `"us-east-1"`). */
	region: string;
	/** 전사 언어 코드(Requirements 2.9). */
	languageCode: LanguageCode;
	/**
	 * AWS Transcribe 커스텀 어휘 이름(선택).
	 *
	 * 빈 문자열/`undefined` 면 SDK 에 해당 파라미터를 전달하지 않아 표준 어휘로 전사한다.
	 * 값이 있으면 `StartStreamTranscriptionCommand.VocabularyName` 로 전달되어
	 * Transcribe 모델이 해당 어휘의 단어를 우선 인식한다.
	 *
	 * 주의: Vocabulary 는 동일 리전/언어로 미리 생성돼 있어야 한다. 부적합하면 세션
	 * 수립에서 `BadRequestException` 이 발생하여 `onSessionError("start_failed")` 로 통지된다.
	 */
	vocabularyName?: string;
	/**
	 * AWS Transcribe Streaming 의 화자 분리(`ShowSpeakerLabel`) 활성화 여부 (v1.1 신규).
	 *
	 * `true` 인 경우 `StartStreamTranscriptionCommand` 입력에
	 * `ShowSpeakerLabel: true` 와 `EnablePartialResultsStabilization: true` 를 함께 전달한다
	 * (Requirement 6.3). `false` 또는 미지정 시에는 두 필드를 SDK 인자에 포함하지 않으므로
	 * v1.0 호출자(설정값 없이 `start({...})` 만 호출하는 경로) 와 완전 호환된다.
	 *
	 * 본 옵션의 기본값은 `false` 이다 (design §4.6).
	 */
	showSpeakerLabel?: boolean;
	/** 이벤트 콜백 묶음. */
	callbacks: TranscribeCallbacks;
}

/**
 * `TranscribeStreamingClient` 를 지연 생성하기 위한 팩토리 함수 타입.
 *
 * 테스트에서 `aws-sdk-client-mock` 의 모의 클라이언트를 주입하거나,
 * 프로덕션에서 자격 증명/리전을 반영한 실제 클라이언트를 생성하기 위한 DI 경로이다.
 */
export type TranscribeClientFactory = (
	credentials: AwsCredentials,
	region: string,
) => TranscribeStreamingClient;

/**
 * 생성자 옵션. 프로덕션에서는 생략 가능하며 테스트에서 타이밍을 단축하거나
 * 재연결 동작을 조정할 때 사용한다.
 */
export interface TranscribeServiceOptions {
	/** 세션 수립 타임아웃(ms). 기본 10_000. */
	sessionEstablishTimeoutMs?: number;
	/** `stop()` 의 기본 타임아웃(ms). 기본 5_000. */
	stopTimeoutMs?: number;
	/** 재연결 시도 간격(ms). 기본 2_000. */
	reconnectDelayMs?: number;
	/** 재연결 시도 최대 횟수. 기본 2. */
	maxReconnectAttempts?: number;
}

// -----------------------------------------------------------------------------
// 내부 상태 타입
// -----------------------------------------------------------------------------

/**
 * 활성 세션을 대표하는 내부 상태 묶음.
 *
 * `activeSession !== null` 이 참인 동안은 `start()` 호출을 거부한다(Requirements 7.5, 7.6).
 */
interface ActiveSession {
	/** 세션 abort 신호. 네트워크 요청과 audio generator 양쪽이 구독한다. */
	controller: AbortController;
	/** 현재 세션이 사용 중인 MediaStream(정리 시 트랙 stop 필요). */
	mediaStream: MediaStream;
	/** 사용자가 `stop()` 을 호출했는지 여부. 재연결 분기 판단에 사용. */
	stopRequested: boolean;
	/** 오디오 생성기가 청크를 전송하는 것을 중단할지 여부(stop 신호). */
	audioClosed: boolean;
	/** 현재 세션에 연결된 콜백(초기 세션 이후 재연결에서도 동일). */
	callbacks: TranscribeCallbacks;
	/** 이 세션을 시작할 때 사용한 파라미터 스냅샷(재연결 시 재사용). */
	params: StartParams;
	/**
	 * 다음 Final 결과에 부여할 1-based segment ID (Requirement 13.4, 13.5, design §4.6).
	 *
	 * 세션 시작 시 1 로 초기화되며, Final 1 건마다 사용 후 +1 한다. 한 Final 응답에서
	 * 화자별로 분할되어 N 개 segment 가 발사되면 카운터도 그만큼 N 씩 증가한다.
	 * **재연결 후에도 본 카운터를 유지한다** — 한 세션 내 단조 증가를 보장하기 위해
	 * 재연결 진입 시 리셋하지 않는다.
	 */
	nextSegmentId: number;
	/**
	 * 화자 라벨 매핑 누적 상태 (Requirement 6.4, design §4.6, §4.10).
	 *
	 * 세션 시작 시 `createInitialSpeakerLabelSessionState()` 로 초기화되며,
	 * Final 의 각 화자 구간을 처리할 때마다 `mapSpeakerLabel(rawLabel, state)` 의 결과로
	 * 갱신된다. 재연결 후에도 동일 세션이므로 본 상태를 유지하여 동일 `spk_N` 이 같은
	 * 표시명(`Speaker N`) 으로 매핑되도록 한다.
	 */
	speakerSession: Speaker_Label_Session_State;
}

/**
 * `runSessionOnce` 의 결과 코드. 최상위 `runSessionLifecycle` 가 다음 동작을 결정한다.
 *
 * - `"completed-user-stop"` — 사용자가 stop() 을 호출했거나 abort 신호로 정상 종료. 재연결 대상 아님.
 * - `"completed-server-end"` — 사용자는 중지하지 않았는데 스트림이 자연 종료.
 *   초기 시도에서는 `CONNECTION_LOST` 로 간주되어 재연결 대상.
 * - `"failed-before-first-event"` — send() 가 reject 하거나 스트림이 첫 이벤트 전에 예외.
 *   초기 시도에서는 `onSessionError("start_failed")` 후 종료.
 *   재연결 시도 중에는 해당 시도의 실패로만 계상.
 * - `"failed-after-first-event"` — 첫 이벤트 수신 이후 스트림 중도 예외. 재연결 대상.
 * - `"session-establish-timeout"` — 초기 수립 10초 타임아웃.
 *   초기 시도에서는 `onSessionError("timeout")` 후 종료.
 *   재연결 시도 중에는 해당 시도의 실패로만 계상(Requirement 3.10 은 초기 수립에만 적용).
 */
type SessionResult =
	| "completed-user-stop"
	| "completed-server-end"
	| "failed-before-first-event"
	| "failed-after-first-event"
	| "session-establish-timeout";

/**
 * Transcribe Streaming 세션 수명 주기를 관리하는 도메인 서비스.
 *
 * @see design.md §5 "TranscribeService (실시간 전사)"
 */
export class TranscribeService {
	/** 누적 전사 텍스트 버퍼. 세션 간 유지되며 `clearBuffer()` 로만 초기화된다. */
	private readonly buffer = new TranscriptBuffer();

	/** 활성 세션 핸들. 단일 세션 불변식을 강제하는 단일 필드(Requirements 7.5). */
	private activeSession: ActiveSession | null = null;

	/** 세션 수립 타임아웃(ms). 옵션 또는 기본값. */
	private readonly sessionEstablishTimeoutMs: number;

	/** stop() 기본 타임아웃(ms). 옵션 또는 기본값. */
	private readonly stopTimeoutMs: number;

	/** 재연결 시도 간격(ms). */
	private readonly reconnectDelayMs: number;

	/** 재연결 시도 최대 횟수. */
	private readonly maxReconnectAttempts: number;

	/**
	 * @param audioCapture  마이크 권한 요청 + PCM 청크 생성 담당.
	 * @param clientFactory `start` 호출 시 자격 증명/리전으로 클라이언트 생성.
	 * @param options       테스트/튜닝용 타이밍 옵션.
	 */
	constructor(
		private readonly audioCapture: AudioCapture,
		private readonly clientFactory: TranscribeClientFactory,
		options: TranscribeServiceOptions = {},
	) {
		this.sessionEstablishTimeoutMs =
			options.sessionEstablishTimeoutMs ?? DEFAULT_SESSION_ESTABLISH_TIMEOUT_MS;
		this.stopTimeoutMs = options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
		this.reconnectDelayMs = options.reconnectDelayMs ?? DEFAULT_RECONNECT_INTERVAL_MS;
		this.maxReconnectAttempts =
			options.maxReconnectAttempts ?? MAX_RECONNECT_ATTEMPTS;
	}

	// ---------------------------------------------------------------------------
	// 공개 API
	// ---------------------------------------------------------------------------

	/**
	 * 새 Transcribe Streaming 세션을 시작한다.
	 *
	 * 순서:
	 * 1. 이미 활성 세션이 있으면 `onSessionError("already_active")` 후 즉시 반환(Requirements 7.6).
	 * 2. `audioCapture.requestPermission()` 으로 MediaStream 획득(Requirements 3.1).
	 *    - 실패 시 `onSessionError("start_failed")` 후 반환.
	 * 3. 활성 세션 핸들 생성(단일 세션 불변식 성립).
	 * 4. 백그라운드에서 `runSession()` 을 실행.
	 *    - 세션 수립 타임아웃, Partial/Final 분기, 연결 단절 감지 등을 모두 처리.
	 *    - 실패 시 내부에서 `onSessionError` 또는 재연결 절차를 수행.
	 *
	 * 본 함수는 세션 수립을 await 하지 않고 오디오 파이프라인 가동 시점에서 반환한다.
	 * 세션 성공/실패는 콜백(`onSessionEstablished` / `onSessionError`) 으로만 통지된다.
	 */
	async start(params: StartParams): Promise<void> {
		// 1) 단일 세션 불변식 — 이미 활성 세션이 있으면 거부.
		//    호출 측이 상태 머신을 통해 이중 start 를 먼저 차단하지만, 방어적으로 한 번 더 확인한다.
		if (this.activeSession !== null) {
			this.safeCallback(() => params.callbacks.onSessionError("already_active"));
			return;
		}

		// 2) 마이크 권한 + MediaStream 획득.
		let mediaStream: MediaStream;
		try {
			mediaStream = await this.audioCapture.requestPermission();
		} catch (err) {
			console.error("[TranscribeService] Microphone permission failed:", err);
			this.safeCallback(() => params.callbacks.onSessionError("start_failed"));
			return;
		}

		// 3) 활성 세션 핸들 생성. 이 시점부터 dispose/stop 이 이 세션을 정리할 수 있다.
		const session: ActiveSession = {
			controller: new AbortController(),
			mediaStream,
			stopRequested: false,
			audioClosed: false,
			callbacks: params.callbacks,
			params,
			// v1.1: segment 카운터와 화자 라벨 세션 상태를 세션 시작 시 1 회 초기화.
			// 재연결은 이 인스턴스를 그대로 재사용하므로 동일 세션 내 단조 증가가 보장된다.
			nextSegmentId: 1,
			speakerSession: createInitialSpeakerLabelSessionState(),
		};
		this.activeSession = session;

		// 4) 세션 실행을 백그라운드로 기동.
		//    `start()` 는 여기서 반환하며, 이후 콜백을 통해서만 결과가 통지된다.
		//    예외는 runSessionLifecycle 내부에서 모두 처리되므로 void-await 로 충분하다.
		void this.runSessionLifecycle(session);
	}

	/**
	 * 현재 세션에 종료 신호를 보내고 정상 종료를 기다린다.
	 *
	 * Requirements 4.2 / 4.10:
	 * - 오디오 생성기에 `audioClosed` 플래그를 세워 더 이상 청크를 yield 하지 못하게 한다.
	 *   AWS SDK 는 async generator 가 완료되면 자동으로 종료 이벤트를 전송한다.
	 * - `timeoutMs` 내에 세션이 정상 종료되지 않으면 `controller.abort()` 로 강제 종료하고
	 *   `onSessionError("stop_timeout")` 경고를 전달한다.
	 *
	 * @param timeoutMs 정상 종료 허용 시간(ms). 기본 5_000.
	 */
	async stop(timeoutMs: number = this.stopTimeoutMs): Promise<void> {
		const session = this.activeSession;
		if (session === null) {
			// 이미 종료되었거나 시작된 적이 없는 경우는 no-op.
			return;
		}

		// 사용자 의도 표시: 이후 연결 단절 이벤트가 발생해도 재연결을 시도하지 않는다.
		session.stopRequested = true;
		// audio generator 에 종료 신호 — 다음 yield 시점에서 루프가 빠져나간다.
		session.audioClosed = true;

		// 정상 종료를 기다리거나, 타임아웃 시 강제 abort.
		await this.waitForSessionClose(session, timeoutMs);
	}

	/**
	 * 동기적으로 모든 자원을 정리한다(플러그인 언로드/비활성화 경로).
	 *
	 * Requirements 8.2, 8.3:
	 * - 활성 세션이 있으면 `controller.abort()` 로 즉시 네트워크 요청 중단.
	 * - `audioCapture.stop(mediaStream)` 으로 트랙 해제.
	 * - 비동기 정리는 기다리지 않는다(언로드는 동기 경로이므로).
	 *
	 * 멱등성: 여러 번 호출해도 안전하다.
	 */
	dispose(): void {
		const session = this.activeSession;
		if (session === null) {
			return;
		}

		// 네트워크 요청과 audio iteration 양쪽을 abort 신호로 깨운다.
		session.stopRequested = true;
		session.audioClosed = true;
		try {
			session.controller.abort();
		} catch (err) {
			// AbortController.abort() 는 원래 예외를 던지지 않지만 안전 그물망.
			console.error("[TranscribeService] abort() failed during dispose:", err);
		}

		// MediaStream 해제 — AudioCapture 내부 AudioContext 도 함께 정리된다.
		try {
			this.audioCapture.stop(session.mediaStream);
		} catch (err) {
			console.error("[TranscribeService] audioCapture.stop failed during dispose:", err);
		}

		// 활성 세션 해제. 이후 start() 가 다시 허용된다.
		this.activeSession = null;
	}

	/**
	 * 누적 전사 버퍼를 반환한다. main.ts 가 저장 시 본문 원본으로 사용한다.
	 */
	getTranscriptBuffer(): TranscriptBuffer {
		return this.buffer;
	}

	/**
	 * 새 세션을 시작하기 전에 호출해 버퍼를 초기화한다.
	 * 자동 호출하지 않는 이유: 이전 세션 저장 실패 시 내용 보존이 필요하기 때문이다.
	 */
	clearBuffer(): void {
		this.buffer.clear();
	}

	// ---------------------------------------------------------------------------
	// 내부 — 세션 실행 / 재연결
	// ---------------------------------------------------------------------------

	/**
	 * 초기 시도부터 재연결 소진까지 세션 전체 수명주기를 관리하는 **최상위** 상태 머신.
	 *
	 * 핵심 설계 — 재귀 제거:
	 * 재연결 루프를 `runSessionOnce` 내부가 아닌 **이 메서드에서만** 실행한다.
	 * 따라서 재연결 시도 중 발생한 또 다른 연결 단절이 새로운 재연결 루프를
	 * 중첩 생성하지 않고, 동일 루프의 다음 iteration 으로만 처리된다.
	 * 이로써 `maxReconnectAttempts` 가 전역적으로 보장된다(Property 13).
	 *
	 * 결과 매핑:
	 * - 초기 `completed-user-stop`            → finalize, 종료.
	 * - 초기 `session-establish-timeout`     → `onSessionError("timeout")`, finalize.
	 * - 초기 `failed-before-first-event`     → `onSessionError("start_failed")`, finalize.
	 * - 초기 `completed-server-end` / `failed-after-first-event`
	 *                                         → `onConnectionLost()` 후 재연결 루프 진입.
	 * - 재연결 루프:
	 *     - `completed-user-stop` → finalize, 종료.
	 *     - 그 외(서버 종료, 첫 이벤트 전/후 실패, 수립 타임아웃)
	 *                             → 해당 시도의 실패로 계상, 다음 iteration.
	 * - 루프 소진 시 `onSessionError("reconnect_exhausted")`, finalize.
	 */
	private async runSessionLifecycle(session: ActiveSession): Promise<void> {
		const { callbacks } = session;

		// ---- 1) 초기 시도 ------------------------------------------------------
		const initialResult = await this.runSessionOnce(session, {
			isReconnect: false,
		});

		if (initialResult === "completed-user-stop") {
			this.finalizeSession(session);
			return;
		}

		if (initialResult === "session-establish-timeout") {
			// Requirement 3.10: 초기 수립 타임아웃만 "timeout" 콜백으로 통지한다.
			this.safeCallback(() => callbacks.onSessionError("timeout"));
			this.finalizeSession(session);
			return;
		}

		if (initialResult === "failed-before-first-event") {
			// 초기 수립 실패(권한/네트워크/응답 형식 등) — 재연결 대상이 아니다.
			// 재연결은 "세션이 한 번이라도 성립했다가 끊긴 경우" 에만 의미가 있다.
			this.safeCallback(() => callbacks.onSessionError("start_failed"));
			this.finalizeSession(session);
			return;
		}

		// 여기 도달: initialResult ∈ { "completed-server-end", "failed-after-first-event" }.
		// → 연결 단절로 간주하고 재연결 사이클 진입.
		if (session.stopRequested || this.activeSession !== session) {
			this.finalizeSession(session);
			return;
		}

		// Requirement 3.11: 재연결 시도 전 1회 알림.
		this.safeCallback(() => callbacks.onConnectionLost());

		// ---- 2) 재연결 루프 ----------------------------------------------------
		// 이 루프의 카운터는 한 번의 복구 사이클 동안 유효하며, 어떤 경우에도 리셋되지 않는다.
		// 재연결 중 성공적으로 다시 establish 되더라도 카운터를 유지하는 이유:
		// 중첩 실패 시 무한 루프로 이어질 수 있으며, Property 13 이 전역 상한을 요구한다.
		let attempt = 0;
		while (
			attempt < this.maxReconnectAttempts &&
			!session.stopRequested &&
			this.activeSession === session
		) {
			attempt += 1;

			// 2초 대기(Requirement 8.5). 대기 중 stop/dispose 는 다음 체크로 걸러진다.
			await this.delay(this.reconnectDelayMs);
			if (session.stopRequested || this.activeSession !== session) {
				break;
			}

			this.safeCallback(() => callbacks.onReconnectAttempt(attempt));

			// 재시도마다 새 AbortController 가 필요하다(이전 것은 이미 abort/무효).
			// audio generator 도 재가동되어야 하므로 플래그를 리셋.
			session.controller = new AbortController();
			session.audioClosed = false;

			const result = await this.runSessionOnce(session, { isReconnect: true });

			if (result === "completed-user-stop") {
				// 재연결 도중 사용자가 stop 했거나, 성공 후 stop — 모두 정상 종료.
				this.finalizeSession(session);
				return;
			}

			// 그 외 결과(completed-server-end / failed-*-first-event / session-establish-timeout)
			// 는 모두 "이 재연결 시도가 실패했다" 로 계상되어 다음 iteration 으로 진행한다.
			// 특히 수립 타임아웃은 재연결 시 터미널 오류로 변환되지 않는다.
		}

		// ---- 3) 루프 종결 처리 ------------------------------------------------
		if (session.stopRequested || this.activeSession !== session) {
			this.finalizeSession(session);
			return;
		}

		// 정상 소진 — 모든 재연결 시도가 실패했다.
		console.error("[TranscribeService] reconnect attempts exhausted");
		this.safeCallback(() => callbacks.onSessionError("reconnect_exhausted"));
		this.finalizeSession(session);
	}

	/**
	 * **단일** 세션 시도를 실행하고 결과 코드만 반환한다.
	 *
	 * 재귀 없음: 이 메서드는 절대로 자기 자신이나 `runSessionLifecycle`, 재연결
	 * 루프를 호출하지 않는다. 호출자가 결과를 바탕으로 다음 동작을 결정한다.
	 *
	 * 종료 분기(catch 우선순위 및 정상 종료 포함):
	 * - 스트림 자연 종료:
	 *     - stopRequested → `completed-user-stop`
	 *     - !firstEvent   → `failed-before-first-event`
	 *     - else          → `completed-server-end`
	 * - 예외 발생:
	 *     - timedOut       → `session-establish-timeout`
	 *     - stopRequested  → `completed-user-stop`
	 *     - !firstEvent    → `failed-before-first-event`
	 *     - else           → `failed-after-first-event`
	 */
	private async runSessionOnce(
		session: ActiveSession,
		opts: { isReconnect: boolean },
	): Promise<SessionResult> {
		const { callbacks, params } = session;
		const { credentials, region, languageCode } = params;

		// 세션 수립 타임아웃 타이머 핸들. 첫 이벤트 도착 시 clearTimeout 으로 해제.
		let establishTimer: ReturnType<typeof setTimeout> | undefined;
		// 첫 이벤트 도착 여부 — 실패 분류의 핵심 플래그.
		let firstEventReceived = false;
		// 세션 수립 타임아웃에 의해 abort 되었는지 구분하는 플래그.
		let timedOut = false;

		const client = this.clientFactory(credentials, region);

		try {
			// 수립 타임아웃 설치. 시간 내 첫 이벤트가 없으면 abort → catch 로 진입.
			establishTimer = setTimeout(() => {
				if (!firstEventReceived) {
					timedOut = true;
					try {
						session.controller.abort();
					} catch {
						// ignore — abort 는 부작용 없이 신호만 전송한다.
					}
				}
			}, this.sessionEstablishTimeoutMs);

			// 커스텀 어휘 이름은 빈 문자열이면 전달하지 않는다(AWS 는 빈 문자열을 허용하지 않는다).
			const vocabularyName =
				params.vocabularyName && params.vocabularyName.trim().length > 0
					? params.vocabularyName.trim()
					: undefined;

			// v1.1: 화자 분리 옵션 (Requirement 6.3, design §4.6).
			// `showSpeakerLabel === true` 인 경우에만 두 필드를 SDK 인자에 포함하여
			// v1.0 호출자(미지정/false) 와 완전 호환을 유지한다.
			const showSpeakerLabel = params.showSpeakerLabel === true;

			// StartStreamTranscriptionCommand 구성. AudioStream 은 AsyncIterable 로 전달.
			const command = new StartStreamTranscriptionCommand({
				LanguageCode: languageCode,
				MediaEncoding: "pcm",
				MediaSampleRateHertz: TRANSCRIBE_SAMPLE_RATE_HERTZ,
				AudioStream: this.buildAudioStream(session),
				...(vocabularyName ? { VocabularyName: vocabularyName } : {}),
				...(showSpeakerLabel
					? {
							ShowSpeakerLabel: true,
							EnablePartialResultsStabilization: true,
						}
					: {}),
			});

			// 세션 시작 — send() 는 세션 종료 시까지 유지되는 긴 프로미스.
			const response = await client.send(command, {
				abortSignal: session.controller.signal,
			});

			const resultStream = response.TranscriptResultStream;
			if (!resultStream) {
				// SDK 가 스트림을 제공하지 못한 비정상 응답 — "failed-before-first-event" 로 분류.
				throw new Error("TranscriptResultStream is missing in response");
			}

			for await (const event of resultStream) {
				if (!firstEventReceived) {
					firstEventReceived = true;
					if (establishTimer !== undefined) {
						clearTimeout(establishTimer);
						establishTimer = undefined;
					}
					// 재연결 시에도 매번 호출됨(design.md §5 "onSessionEstablished fires again").
					this.safeCallback(() => callbacks.onSessionEstablished());
				}
				if (session.stopRequested) {
					break;
				}
				this.handleTranscriptResultStreamEvent(event, session);
			}

			// 스트림 자연 종료.
			if (session.stopRequested) {
				return "completed-user-stop";
			}
			if (!firstEventReceived) {
				return "failed-before-first-event";
			}
			return "completed-server-end";
		} catch (err) {
			if (timedOut) {
				console.error(
					opts.isReconnect
						? "[TranscribeService] reconnect establish timeout (attempt failed)"
						: "[TranscribeService] session establish timeout",
				);
				return "session-establish-timeout";
			}
			if (session.stopRequested) {
				return "completed-user-stop";
			}
			if (!firstEventReceived) {
				console.error(
					opts.isReconnect
						? "[TranscribeService] reconnect attempt failed:"
						: "[TranscribeService] session establish failed:",
					err,
				);
				return "failed-before-first-event";
			}
			console.error(
				"[TranscribeService] stream interrupted after first event:",
				err,
			);
			return "failed-after-first-event";
		} finally {
			// 타임아웃 타이머가 남아 있으면 해제(이벤트 루프 보류 방지).
			if (establishTimer !== undefined) {
				clearTimeout(establishTimer);
			}
		}
	}

	// ---------------------------------------------------------------------------
	// 내부 — 이벤트 / 오디오 스트림 어댑터
	// ---------------------------------------------------------------------------

	/**
	 * AudioCapture 의 `pcmChunks(stream)` 를 AWS SDK 가 요구하는 AudioStream 으로 감싼다.
	 *
	 * AWS SDK 는 `AsyncIterable<AudioStream>` 을 기대하며, 각 원소는
	 * `{ AudioEvent: { AudioChunk: Uint8Array } }` 형태의 union member 이다.
	 *
	 * 세션 사이클 도중 `audioClosed` 플래그가 true 가 되면 더 이상 청크를 yield 하지 않는다.
	 * AWS SDK 는 async generator 가 완료되면 자동으로 "end of stream" 프레임을 송신한다.
	 */
	private buildAudioStream(session: ActiveSession): AsyncIterable<AudioStream> {
		const self = this;
		return {
			async *[Symbol.asyncIterator](): AsyncIterator<AudioStream> {
				try {
					for await (const chunk of self.audioCapture.pcmChunks(session.mediaStream)) {
						if (session.audioClosed) {
							// stop 이 요청된 경우 — 즉시 중단하여 SDK 가 end-of-stream 을 전송하도록 한다.
							break;
						}
						yield { AudioEvent: { AudioChunk: chunk } };
					}
				} catch (err) {
					// pcmChunks 는 내부에서 자체 정리 finally 를 가지고 있으므로 로그만 남기고 빠져나간다.
					console.error("[TranscribeService] audio stream error:", err);
				}
			},
		};
	}

	/**
	 * `TranscriptResultStream` 한 개 이벤트를 처리한다.
	 *
	 * 이벤트는 union 타입이며, 우리가 관심 있는 member 는 `TranscriptEvent` 뿐이다.
	 * 나머지 `BadRequestException` / `ConflictException` 등은 SDK 가 `send()` 의
	 * 최상위 예외로 전환해 주는 경우가 대부분이므로 여기서는 무시한다.
	 *
	 * v1.1 (design §4.6):
	 * - Final 처리 시 `Item.Speaker` 가 존재하면 화자 구간별로 segment 를 분할 발사한다
	 *   (Requirement 6.5). `Item.Speaker` 가 없거나 `Items` 가 빈 응답에서는 단일 segment 만
	 *   발사하며 `speakerLabel` 은 `undefined` 이다 (Requirement 6.7).
	 * - 각 segment 마다 새 `segmentId` 를 부여하고 `mapSpeakerLabel` 로 표시명을 정규화한다
	 *   (Requirement 6.4, 13.4, 13.5).
	 * - `TranscriptBuffer` 누적은 `emitFinalSegments` 가 `appendSegment` 를 통해 1 회만 수행하여
	 *   v1.0 호환 chunks 와 v1.1 segments 가 일관된 상태를 유지한다 (design §4.7).
	 */
	private handleTranscriptResultStreamEvent(
		event: TranscriptResultStream,
		session: ActiveSession,
	): void {
		const transcriptEvent = event.TranscriptEvent;
		if (!transcriptEvent) {
			// 관심 없는 member (예외 이벤트) — 로그만 남기고 통과.
			// 보안: message 본문 등 세부 정보는 기록하지 않는다.
			return;
		}

		const results = transcriptEvent.Transcript?.Results;
		if (!results || results.length === 0) {
			return;
		}

		const { callbacks } = session;

		// 각 Result 를 순서대로 처리. Transcribe 는 한 번에 여러 Result 를 보낼 수 있다.
		for (const result of results) {
			const alternative = result.Alternatives?.[0];
			const text = alternative?.Transcript;
			if (typeof text !== "string" || text.length === 0) {
				continue;
			}

			if (result.IsPartial === true) {
				// Partial — 이전 partial 을 치환하고 콜백 발사.
				this.buffer.setPartial(text);
				this.safeCallback(() => callbacks.onPartial(text));
				continue;
			}

			// Final — 우선 v1.0 호환 콜백 (`onFinal(text)`) 을 1 회 발사한다.
			// 호출자가 `onFinalSegment` 만 사용하더라도 `onFinal` 은 항상 발사되므로
			// v1.0 사이드바 등 기존 소비자는 변경 없이 동작한다.
			//
			// `TranscriptBuffer.appendFinal(text)` 는 여기서 호출하지 않는다 — 본문 누적은
			// 아래 `emitFinalSegments` 가 `appendSegment` 를 통해 1 회만 수행한다.
			this.safeCallback(() => callbacks.onFinal(text));

			// 그리고 화자 구간별로 segment 를 분할하여 발사 (Requirement 6.5, 6.7).
			this.emitFinalSegments(result, text, session);
		}
	}

	/**
	 * 한 Final `Result` 를 화자 구간별로 분할하여 `Transcript_Segment` 를 발사한다
	 * (design §4.6, Requirement 6.4, 6.5, 6.7).
	 *
	 * 알고리즘:
	 * 1. `result.Alternatives[0].Items[]` 를 순회하며 동일 `Speaker` 가 연속된 구간끼리
	 *    그룹화한다. `Item.Speaker` 가 `undefined` 인 Item 들은 별도 그룹과 동일하게
	 *    "no-speaker" 그룹으로 묶인다.
	 * 2. `Items` 가 비어 있거나 누락된 경우 (예: 화자 분리 비활성 응답, mock 테스트) 는
	 *    단일 segment 1 건을 발사한다 (Requirement 6.7). `result.StartTime` / `EndTime` 으로
	 *    시간을 채우며, 누락 시 0 으로 fallback. 본문은 `result.Alternatives[0].Transcript`
	 *    (호출자가 전달한 `fallbackText`) 를 그대로 사용한다.
	 * 3. 각 그룹의 `Item.Content` 를 join 하여 segment 본문을 구성하고, startTime/endTime 을
	 *    그룹 첫/마지막 Item 에서 추출한다.
	 * 4. 그룹별로 새 `segmentId` 를 부여하고, `Speaker` 가 있으면 `mapSpeakerLabel` 로 표시명을
	 *    얻어 `speakerLabel` 에 부여한다.
	 *
	 * 본 메서드는 `TranscriptBuffer.appendSegment` 를 통해 v1.1 `segments` 와 v1.0 호환
	 * `chunks` 양쪽을 동시에 1 회씩 갱신한다 (design §4.7).
	 */
	private emitFinalSegments(
		result: Result,
		fallbackText: string,
		session: ActiveSession,
	): void {
		const { callbacks } = session;
		const items = result.Alternatives?.[0]?.Items ?? [];

		// 동일 화자가 연속된 구간으로 그룹화. `Items` 가 비어 있으면 그룹은 0 개.
		const groups = groupItemsBySpeaker(items);

		// `Items` 가 누락 / 비어 있으면 fallback 으로 단일 segment 발사.
		if (groups.length === 0) {
			const segment: Transcript_Segment = {
				segmentId: session.nextSegmentId,
				startSeconds: result.StartTime ?? 0,
				endSeconds: result.EndTime ?? result.StartTime ?? 0,
				text: fallbackText,
				speakerLabel: undefined,
			};
			session.nextSegmentId += 1;
			this.buffer.appendSegment(segment);
			this.safeCallback(() => callbacks.onFinalSegment?.(segment));
			return;
		}

		for (const group of groups) {
			// 화자 라벨 정규화 (Requirement 6.4). raw label 이 없는 그룹은 undefined 로 둔다.
			let speakerLabel: string | undefined;
			if (group.rawSpeaker !== undefined) {
				const mapped = mapSpeakerLabel(
					group.rawSpeaker,
					session.speakerSession,
				);
				speakerLabel = mapped.displayLabel;
				session.speakerSession = mapped.sessionState;
			}

			// 본문 join — Item.Content 가 누락된 경우 빈 문자열로 fallback.
			// PUNCTUATION 과 PRONUNCIATION 사이는 단순 공백 join 으로도 사이드바 표시에
			// 충분하다 (구두점 앞 공백은 Sentence_Formatter 가 후속 처리에서 정리한다).
			const text = group.items
				.map((it) => it.Content ?? "")
				.filter((s) => s.length > 0)
				.join(" ")
				.trim();

			// 빈 본문 그룹은 발사 대상에서 제외 (예: punctuation-only 그룹).
			if (text.length === 0) {
				continue;
			}

			const startSeconds = group.items[0]?.StartTime ?? result.StartTime ?? 0;
			const endSeconds =
				group.items[group.items.length - 1]?.EndTime ??
				result.EndTime ??
				startSeconds;

			const segment: Transcript_Segment = {
				segmentId: session.nextSegmentId,
				startSeconds,
				endSeconds,
				text,
				speakerLabel,
			};
			session.nextSegmentId += 1;

			this.buffer.appendSegment(segment);
			this.safeCallback(() => callbacks.onFinalSegment?.(segment));
		}
	}

	// ---------------------------------------------------------------------------
	// 내부 — 세션 종료 정리 / 유틸
	// ---------------------------------------------------------------------------

	/**
	 * 세션을 정상 종료 처리한다. 멱등성을 보장한다.
	 *
	 * - 자신이 현재 활성 세션이 아니라면(이미 다른 경로에서 교체됨) 아무 작업도 하지 않는다.
	 * - MediaStream 을 AudioCapture 에 반환하여 트랙과 AudioContext 를 정리한다.
	 * - activeSession 필드를 null 로 되돌려 새 start() 가 허용되도록 한다.
	 */
	private finalizeSession(session: ActiveSession): void {
		if (this.activeSession !== session) {
			return;
		}

		try {
			this.audioCapture.stop(session.mediaStream);
		} catch (err) {
			console.error("[TranscribeService] audioCapture.stop failed during finalize:", err);
		}

		this.activeSession = null;
	}

	/**
	 * stop() 이 호출된 뒤 세션이 정상 종료되거나 timeout 될 때까지 대기한다.
	 *
	 * polling 주기는 50ms. 세션이 null 로 정리되는 것을 감지하면 조기 반환.
	 * 타임아웃 시 abort → 세션 finally 에서 정리됨 → 콜백 `stop_timeout` 전달.
	 */
	private async waitForSessionClose(
		session: ActiveSession,
		timeoutMs: number,
	): Promise<void> {
		const pollIntervalMs = 50;
		const startedAt = Date.now();

		while (this.activeSession === session) {
			if (Date.now() - startedAt >= timeoutMs) {
				// 타임아웃: 강제 abort 후 경고 통지.
				console.error("[TranscribeService] stop() timed out, forcing abort");
				try {
					session.controller.abort();
				} catch {
					// ignore
				}
				this.safeCallback(() => session.callbacks.onSessionError("stop_timeout"));
				// abort 신호가 runSession 의 finally 경로로 전파될 때까지 잠시 더 대기.
				// 그래도 정리되지 않으면 방어적으로 finalize 를 직접 호출한다.
				await this.delay(pollIntervalMs);
				if (this.activeSession === session) {
					this.finalizeSession(session);
				}
				return;
			}
			await this.delay(pollIntervalMs);
		}
	}

	/**
	 * 지정된 시간 동안 대기하는 프로미스를 반환한다.
	 *
	 * 별도 함수로 추출한 이유: 테스트에서 `vi.useFakeTimers()` 와 조합해 결정적으로 제어하기 위함.
	 */
	private delay(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}

	/**
	 * 콜백 실행을 안전하게 감싼다.
	 *
	 * 콜백에서 예외가 던져져도 서비스의 스트리밍 루프가 중단되지 않도록 하고,
	 * 민감 정보 유출을 방지하기 위해 예외 메시지 대신 발생 사실만 로그로 남긴다.
	 */
	private safeCallback(fn: () => void): void {
		try {
			fn();
		} catch (err) {
			console.error("[TranscribeService] callback threw:", err);
		}
	}
}

// -----------------------------------------------------------------------------
// 내부 헬퍼 — 화자 구간 그룹화 (design §4.6)
// -----------------------------------------------------------------------------

/**
 * 동일 화자(`Item.Speaker`) 가 연속된 Item 들을 묶는 그룹.
 *
 * `rawSpeaker` 가 `undefined` 인 그룹은 "화자 정보 없음" 을 의미하며, 이 그룹은
 * `mapSpeakerLabel` 호출 없이 `speakerLabel = undefined` 로 segment 가 발사된다
 * (Requirement 6.7).
 */
interface SpeakerGroup {
	readonly rawSpeaker: string | undefined;
	readonly items: ReadonlyArray<Item>;
}

/**
 * `Items[]` 를 동일 `Speaker` 가 연속된 구간끼리 그룹화한다 (Requirement 6.5).
 *
 * 구분 기준: `Item.Speaker` 가 직전 Item 의 값과 다르면 새 그룹을 시작한다.
 * `undefined` 와 `"spk_0"` 도 서로 다른 값으로 취급되어 그룹이 분리된다.
 *
 * 입력이 빈 배열이면 빈 결과를 반환한다 — 호출자가 fallback 단일 segment 분기로
 * 전환하도록 한다.
 *
 * 본 함수는 외부 효과 없는 순수 함수이며, 입력 배열을 변형하지 않는다.
 *
 * @param items AWS Transcribe Streaming Final 응답의 `Alternatives[0].Items[]`.
 * @returns 동일 화자 구간끼리 묶인 그룹 배열. 입력 순서를 보존한다.
 */
function groupItemsBySpeaker(
	items: ReadonlyArray<Item>,
): ReadonlyArray<SpeakerGroup> {
	if (items.length === 0) {
		return [];
	}

	const groups: SpeakerGroup[] = [];
	let currentSpeaker: string | undefined = items[0].Speaker;
	let currentItems: Item[] = [];

	for (const item of items) {
		const speaker = item.Speaker;
		if (speaker !== currentSpeaker) {
			// 화자가 바뀌었으면 직전 그룹을 확정하고 새 그룹을 연다.
			if (currentItems.length > 0) {
				groups.push({ rawSpeaker: currentSpeaker, items: currentItems });
			}
			currentSpeaker = speaker;
			currentItems = [];
		}
		currentItems.push(item);
	}

	// 마지막 그룹 flush.
	if (currentItems.length > 0) {
		groups.push({ rawSpeaker: currentSpeaker, items: currentItems });
	}

	return groups;
}
