/**
 * Transcribe 스트리밍 수명 주기 상태 머신.
 *
 * 본 모듈은 UI/네트워크 I/O에 의존하지 않는 **순수 로직**으로 구현된다.
 * 외부에서 관찰 가능한 상태값(`StreamingState`)과 관찰용 하위 플래그
 * (`reconnecting`)를 분리하여, `streaming` 중 연결 단절이 발생해도
 * 외부 상태는 `streaming`으로 유지하고 내부 `reconnecting` 플래그만 on한다.
 * (design.md §3 "상태 머신", Requirements 3.11, 8.5, 8.7)
 *
 * 정의되지 않은 전이(예: `idle`에서 `STOP_REQUESTED`)에 대해서는
 * **상태를 변경하지 않고 silent 하게 무시**하여 UI가 예기치 못한 예외로
 * 중단되는 것을 방지한다. 호출자가 엄격 검증을 원하는 경우를 위해
 * `IllegalTransitionError`를 함께 export 한다(현재 내부에서는 throw 하지 않는다).
 */

/**
 * 외부에서 관찰 가능한 Transcribe 스트리밍 상태.
 *
 * - `idle`: 세션이 수립되지 않은 대기 상태(플러그인 초기/종료 후 상태).
 * - `streaming`: Transcribe Streaming 세션이 활성 중인 상태. 네트워크 일시 단절이
 *   발생해도 재연결을 시도하는 동안에는 이 값을 유지한다(Requirements 3.11).
 * - `stopped`: 사용자가 중지를 요청하고 세션 종료 절차가 진행 중인 상태.
 * - `error`: 세션 수립 실패, 재연결 소진, 치명적 오류 등으로 복구가 필요한 상태.
 */
export type StreamingState = "idle" | "streaming" | "stopped" | "error";

/**
 * 상태 머신에 입력되는 이벤트 유니온 타입.
 *
 * 각 이벤트는 외부 서비스(`TranscribeService`, `AudioCapture`) 또는 UI
 * 버튼 핸들러로부터 dispatch 된다.
 */
export type StreamingEvent =
	/** 사용자가 Start 버튼을 클릭하여 세션 시작을 요청한 경우. */
	| { type: "START_REQUESTED" }
	/** AWS Transcribe Streaming 세션이 성공적으로 수립된 경우. */
	| { type: "SESSION_ESTABLISHED" }
	/** 세션 수립이 실패하거나 10초 타임아웃이 발생한 경우. */
	| { type: "SESSION_FAILED"; reason: string }
	/** 사용자가 Stop 버튼을 클릭하여 세션 종료를 요청한 경우. */
	| { type: "STOP_REQUESTED" }
	/** 세션 종료 절차(종료 신호 송신 + 트랙 정리)가 완료된 경우. */
	| { type: "SESSION_CLOSED" }
	/** 진행 중 세션의 네트워크 연결이 단절된 경우(재연결 시도 전). */
	| { type: "CONNECTION_LOST" }
	/** 재연결 시도 중 하나가 성공한 경우. */
	| { type: "RECONNECT_SUCCEEDED" }
	/** 재연결을 허용 횟수(기본 2회)만큼 시도했으나 모두 실패한 경우. */
	| { type: "RECONNECT_EXHAUSTED" }
	/** `error` 상태에서 사용자가 재시작을 위해 상태를 초기화한 경우. */
	| { type: "RESET" };

/**
 * 상태 머신이 정의되지 않은 전이를 거부할 때 사용할 수 있는 에러 타입.
 *
 * 현재 구현은 안전한 UI 동작을 위해 silent 정책을 채택하여 이 에러를
 * 직접 throw 하지 않는다. 테스트 코드나 엄격 모드 호출자가 필요할 경우
 * 참조할 수 있도록 public API로 export 한다.
 *
 * @remarks design.md "전이 테이블" 주석: "정의되지 않은 이벤트-상태
 * 조합에서는 상태 불변 또는 `IllegalTransitionError`, 부작용 없음"
 */
export class IllegalTransitionError extends Error {
	constructor(
		public readonly state: StreamingState,
		public readonly event: StreamingEvent,
	) {
		super(
			`Illegal transition: event "${event.type}" is not valid in state "${state}".`,
		);
		Object.setPrototypeOf(this, IllegalTransitionError.prototype);
		this.name = "IllegalTransitionError";
	}
}

/**
 * 상태 변경 리스너 시그니처.
 *
 * 외부 상태값(`next`)과 관찰용 하위 플래그(`reconnecting`)를 함께 전달하여
 * UI가 한 번의 콜백으로 전체 표시를 갱신할 수 있도록 한다.
 */
export type StreamingStateListener = (
	next: StreamingState,
	reconnecting: boolean,
) => void;

/**
 * Transcribe 스트리밍 상태 전이를 관리하는 유한 상태 머신(FSM).
 *
 * 외부 `StreamingState` 전이 규칙(design.md §3 "전이 테이블"):
 *
 * | 현재 상태       | 이벤트                | 다음 상태   | 비고                                     |
 * |-----------------|-----------------------|-------------|------------------------------------------|
 * | `idle`          | `START_REQUESTED`     | `idle`      | `pendingStart=true`로 표기(세션 수립 대기). |
 * | `idle`          | `SESSION_ESTABLISHED` | `streaming` | `pendingStart=true`일 때만 전이.          |
 * | `idle`          | `SESSION_FAILED`      | `error`     | `pendingStart` 리셋.                      |
 * | `streaming`     | `START_REQUESTED`     | `streaming` | 단일 세션 불변식(Requirements 7.5).        |
 * | `streaming`     | `STOP_REQUESTED`      | `stopped`   | `reconnecting` 리셋.                      |
 * | `streaming`     | `CONNECTION_LOST`     | `streaming` | `reconnecting=true`(Requirements 3.11).   |
 * | `streaming`(재) | `RECONNECT_SUCCEEDED` | `streaming` | `reconnecting=false`.                     |
 * | `streaming`(재) | `RECONNECT_EXHAUSTED` | `error`     | `reconnecting=false`(Requirements 8.7).   |
 * | `stopped`       | `SESSION_CLOSED`      | `idle`      | 저장 절차 완료 후 초기화.                 |
 * | `error`         | `RESET`               | `idle`      | 사용자가 재시도 허용.                      |
 *
 * 위에 열거되지 않은 전이는 상태/플래그를 변경하지 않고 silent 하게 무시한다.
 * (UI 이벤트 경합으로 인한 비정상 시퀀스를 안전하게 흡수하기 위함.)
 */
export class StreamingStateMachine {
	/**
	 * 외부에서 관찰 가능한 현재 상태.
	 */
	private state: StreamingState;

	/**
	 * `CONNECTION_LOST` 이후 재연결 시도 중임을 표시하는 내부 플래그.
	 *
	 * 외부 `state`가 `streaming`일 때만 `true`가 될 수 있다. UI는 이 값을
	 * 감지해 "재연결 시도 중" 레이블을 노출한다(Requirements 8.6).
	 */
	private reconnecting = false;

	/**
	 * `idle` 상태에서 `START_REQUESTED`를 수신했음을 표시하는 내부 플래그.
	 *
	 * 이 플래그가 `true`인 동안에만 후속 `SESSION_ESTABLISHED` 이벤트가
	 * `streaming`으로의 전이를 유발한다. 사용자가 시작 요청을 보내지 않은
	 * 채 세션 수립 이벤트가 도착하는 비정상 시퀀스를 차단하기 위함이다.
	 */
	private pendingStart = false;

	/**
	 * 상태/플래그 변경 시 호출될 리스너 집합.
	 *
	 * `Set`을 사용해 동일 리스너 중복 등록을 방지하고 O(1) 등록/해제를 보장한다.
	 */
	private readonly listeners = new Set<StreamingStateListener>();

	/**
	 * @param initial 초기 상태. 테스트에서 특정 상태로 시작하고 싶을 때 사용한다.
	 * 기본값은 `"idle"`(플러그인 부팅 시점의 상태).
	 */
	constructor(initial: StreamingState = "idle") {
		this.state = initial;
	}

	/**
	 * 현재 외부에서 관찰 가능한 상태값을 반환한다.
	 */
	getState(): StreamingState {
		return this.state;
	}

	/**
	 * 현재 재연결 시도 중인지 여부를 반환한다.
	 *
	 * 외부 상태가 `streaming`일 때만 `true`가 될 수 있다.
	 * 다른 상태에서는 항상 `false`.
	 */
	isReconnecting(): boolean {
		return this.reconnecting;
	}

	/**
	 * 이벤트를 상태 머신에 전달하여 전이를 시도한다.
	 *
	 * 유효한 전이가 발생하면 새 상태를 반환하고 리스너를 호출한다.
	 * 정의되지 않은 전이이면 상태/플래그를 변경하지 않고 현재 상태를 그대로 반환한다.
	 *
	 * @param event 상태 전이 이벤트.
	 * @returns 처리 후의 외부 상태값.
	 */
	dispatch(event: StreamingEvent): StreamingState {
		const prevState = this.state;
		const prevReconnecting = this.reconnecting;

		this.applyTransition(event);

		// 외부 상태 또는 재연결 플래그가 변한 경우에만 리스너에게 알린다.
		if (prevState !== this.state || prevReconnecting !== this.reconnecting) {
			this.emit();
		}

		return this.state;
	}

	/**
	 * 상태 변경 리스너를 등록한다.
	 *
	 * @param listener 새 상태와 재연결 플래그를 전달받는 콜백.
	 * @returns 호출 시 리스너를 해제하는 unsubscribe 함수.
	 */
	onChange(listener: StreamingStateListener): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	/**
	 * 전이 테이블을 적용해 내부 상태와 플래그를 갱신한다.
	 *
	 * 유효하지 않은 전이는 silent 하게 무시한다.
	 */
	private applyTransition(event: StreamingEvent): void {
		switch (this.state) {
			case "idle":
				this.transitionFromIdle(event);
				return;
			case "streaming":
				this.transitionFromStreaming(event);
				return;
			case "stopped":
				this.transitionFromStopped(event);
				return;
			case "error":
				this.transitionFromError(event);
				return;
		}
	}

	/**
	 * `idle` 상태에서의 전이 처리.
	 *
	 * - `START_REQUESTED`: 세션 수립 대기를 표시(`pendingStart=true`). 외부 상태는 불변.
	 * - `SESSION_ESTABLISHED`: `pendingStart`가 true인 경우에만 `streaming`으로 전이.
	 * - `SESSION_FAILED`: `pendingStart`를 리셋하고 `error`로 전이.
	 * - 그 외: silent 무시.
	 */
	private transitionFromIdle(event: StreamingEvent): void {
		switch (event.type) {
			case "START_REQUESTED":
				this.pendingStart = true;
				return;
			case "SESSION_ESTABLISHED":
				if (this.pendingStart) {
					this.pendingStart = false;
					this.state = "streaming";
				}
				return;
			case "SESSION_FAILED":
				this.pendingStart = false;
				this.state = "error";
				return;
			default:
				return;
		}
	}

	/**
	 * `streaming` 상태에서의 전이 처리.
	 *
	 * - `STOP_REQUESTED`: `stopped`로 전이하고 재연결 플래그 리셋.
	 * - `START_REQUESTED`: 단일 세션 불변식을 유지하기 위해 상태 불변.
	 * - `CONNECTION_LOST`: 외부 상태는 `streaming` 유지, `reconnecting=true`.
	 * - `RECONNECT_SUCCEEDED`: 재연결 성공. 외부 상태는 `streaming` 유지, 플래그만 리셋.
	 * - `RECONNECT_EXHAUSTED`: 재연결 소진. `error`로 전이하고 플래그 리셋.
	 * - 그 외: silent 무시.
	 */
	private transitionFromStreaming(event: StreamingEvent): void {
		switch (event.type) {
			case "STOP_REQUESTED":
				this.reconnecting = false;
				this.state = "stopped";
				return;
			case "START_REQUESTED":
				// 단일 세션 불변식: 이미 스트리밍 중이면 신규 세션 시작을 거부.
				return;
			case "CONNECTION_LOST":
				this.reconnecting = true;
				return;
			case "RECONNECT_SUCCEEDED":
				this.reconnecting = false;
				return;
			case "RECONNECT_EXHAUSTED":
				this.reconnecting = false;
				this.state = "error";
				return;
			default:
				return;
		}
	}

	/**
	 * `stopped` 상태에서의 전이 처리.
	 *
	 * - `SESSION_CLOSED`: 종료 절차 완료 → `idle`로 초기화.
	 * - 그 외: silent 무시(저장 I/O 오류 재시도 등은 외부에서 관리).
	 */
	private transitionFromStopped(event: StreamingEvent): void {
		switch (event.type) {
			case "SESSION_CLOSED":
				this.state = "idle";
				return;
			default:
				return;
		}
	}

	/**
	 * `error` 상태에서의 전이 처리.
	 *
	 * - `RESET`: 사용자의 재시도 수락 → `idle`로 복귀. 재연결/대기 플래그도 안전하게 리셋.
	 * - 그 외: silent 무시.
	 */
	private transitionFromError(event: StreamingEvent): void {
		switch (event.type) {
			case "RESET":
				this.reconnecting = false;
				this.pendingStart = false;
				this.state = "idle";
				return;
			default:
				return;
		}
	}

	/**
	 * 등록된 모든 리스너에 현재 상태와 재연결 플래그를 전달한다.
	 *
	 * 리스너 중 하나가 예외를 던져도 나머지 리스너 호출을 보장하기 위해
	 * 스냅샷을 떠 순회한다. 개별 예외는 `console.error`로만 기록한다
	 * (Requirements 9.6 — `console.log/warn/debug` 금지).
	 */
	private emit(): void {
		const snapshot = Array.from(this.listeners);
		for (const listener of snapshot) {
			try {
				listener(this.state, this.reconnecting);
			} catch (err) {
				console.error(
					"[StreamingStateMachine] listener threw during state emit:",
					err,
				);
			}
		}
	}
}
