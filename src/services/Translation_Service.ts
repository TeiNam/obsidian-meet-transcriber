/**
 * `Translation_Service` — AWS Translate `TranslateTextCommand` 호출 + 번역 큐 + 자동 비활성화 정책.
 *
 * 본 서비스는 `TranscribeService` / `Local_Whisper_Service` 의 Final 결과 1 건당 1 회
 * `enqueue` 를 받아, 비동기로 AWS Translate 를 호출하고 결과를 콜백으로 통지한다.
 * 사이드바 DOM 의 placeholder 노드 조작은 SidebarView (task 25) 의 책임이며, 본 서비스는
 * `placeholderEl` 을 큐 아이템에 보관만 하고 직접 읽거나 변형하지 않는다.
 *
 * 관련 요구사항:
 * - Requirement 13.4: Final 1 건당 1 회 `Translation_Service.translate` 비동기 호출
 * - Requirement 13.5: 표시 순서 = `Segment_Id` 단조 증가 (out-of-order resolve 안정성)
 * - Requirement 13.6: 30 초 슬라이딩 윈도우 3 회 실패 → 자동 비활성화 + 1 회 Notice
 * - Requirement 13.8: `navigator.onLine === false` 일 때 enqueue skip + 세션당 1 회 `console.error`
 * - Requirement 13.9: 누적 입력 문자 수(코드포인트 단위) 단조 비감소
 * - Requirement 13.12: Partial 에 대해서는 enqueue 호출되지 않음 (호출자 책임)
 * - Requirement 13.13: `selectTargetLanguage` 가 결정한 대상 언어를 그대로 전달
 *
 * 설계 매핑: design.md §4.5, §Translation Queue, §Correctness Properties 9~11.
 *
 * 보안/로깅 (Requirement 11.1):
 * - 자격 증명, 원본 텍스트, 번역 결과 본문은 `console.error` 에 기록하지 않는다.
 * - 실패 시 `console.error` 로 사유 코드만 (`network` / `throttling` / `auth` / `unknown`) 1 회 기록.
 */

import {
	TranslateClient,
	TranslateTextCommand,
} from "@aws-sdk/client-translate";
import type { Transcript_Segment } from "../domain/segments";
import type {
	AwsCredentials,
	Curated_Target_Language,
} from "../types/settings";

/**
 * 30 초 슬라이딩 윈도우 자동 비활성화 임계값 (밀리초).
 *
 * 윈도우 내 실패 카운트가 `FAILURE_THRESHOLD` 회 이상이 되면 자동 비활성화 진입.
 */
const FAILURE_WINDOW_MS = 30_000;

/**
 * 자동 비활성화 진입 임계 실패 횟수 (Requirement 13.6).
 *
 * "30 초 이내에 연속 3 회" 의 정확한 의미: 윈도우 내 누적 실패가 3 회 도달한 시점에 진입.
 */
const FAILURE_THRESHOLD = 3;

/**
 * 한 Final_Result 에 대한 번역 호출 메타데이터 (design §Data Models 6).
 *
 * 큐는 `Map<segmentId, Translation_Queue_Item>` 으로 관리되며, `segmentId` 가
 * 단조 증가이므로 Map 의 삽입 순서 = 표시 순서이다 (Requirement 13.5).
 *
 * - `placeholderEl`: 사이드바 placeholder DOM 노드. 본 서비스는 보관만 하고
 *   읽거나 변형하지 않는다. 결과 도착 시 호출자(SidebarView) 가 `onResolved`
 *   콜백을 받아 직접 `setText` 를 수행한다 (design §Translation Queue).
 * - `state`: 호출 lifecycle 추적용. 외부에서 직접 set 하지 않는다.
 */
export interface Translation_Queue_Item {
	readonly segmentId: number;
	readonly sourceText: string;
	/** 원본 언어 ISO 639-1 코드 ("ko" / "en"). `selectTargetLanguage` 에서 파생. */
	readonly sourceLanguage: string;
	readonly targetLanguage: Curated_Target_Language;
	/** 큐 추가 시점의 timestamp(ms). 사이드바 비용 카운터 갱신 등에 활용 가능. */
	readonly enqueuedAtMs: number;
	/** 사이드바 placeholder DOM 노드 참조. 본 서비스는 직접 사용하지 않는다. */
	readonly placeholderEl: HTMLElement;
	state: "pending" | "done" | "failed";
}

/**
 * 본 서비스가 발사하는 콜백 묶음 (design §4.5).
 *
 * `beginSession` 진입 시 1 회만 등록되며, 세션 lifecycle 동안 동일 인스턴스를 재사용한다.
 *
 * - `onResolved`: AWS Translate 가 성공 응답을 반환했을 때. 정확히 1 회 호출.
 * - `onRejected`: 네트워크 / throttle / 자격 증명 등 실패. 정확히 1 회 호출.
 *   `errorCode` 는 사유 분류 문자열 (`"network"` / `"throttling"` / `"auth"` / `"unknown"`).
 * - `onAutoDisabled`: 30 초 윈도우 3 회 실패 도달 시 1 회. Notice 표시는 호출자 책임.
 * - `onCostCounterChanged`: 누적 코드포인트 카운터 변경 시 호출 (Requirement 13.9).
 *   매 enqueue 직후 1 회 (호출이 실제 발사된 경우에만).
 */
export interface Translation_Service_Callbacks {
	onResolved(segmentId: number, translatedText: string): void;
	onRejected(segmentId: number, errorCode: string): void;
	onAutoDisabled(): void;
	onCostCounterChanged(totalCharCount: number): void;
}

/**
 * `TranslateClient` 인스턴스를 자격 증명/리전에 따라 지연 생성하는 DI 팩토리.
 *
 * `BedrockService.BedrockClientFactory` 와 같은 패턴으로, 테스트에서는
 * `aws-sdk-client-mock` 의 `mockClient(TranslateClient)` 가 적용된 실제 클라이언트를
 * 그대로 반환하면 mock 인터셉터가 동작한다.
 */
export type TranslateClientFactory = (
	credentials: AwsCredentials,
	region: string,
) => TranslateClient;

/**
 * AWS SDK 에러를 본 서비스 사유 코드로 분류한다.
 *
 * SDK v3 는 예외의 `name` 속성으로 분기 식별을 권장한다. 미상의 에러는
 * `"unknown"` 으로 묶어 `onRejected` 의 errorCode 인자를 결정 가능한 값으로 정규화한다.
 */
function classifyError(
	err: unknown,
): "network" | "throttling" | "auth" | "unknown" {
	const name =
		err && typeof err === "object" && "name" in err
			? String((err as { name?: unknown }).name ?? "")
			: "";
	if (name === "ThrottlingException" || name === "TooManyRequestsException") {
		return "throttling";
	}
	if (
		name === "UnrecognizedClientException" ||
		name === "InvalidSignatureException" ||
		name === "ExpiredTokenException" ||
		name === "AccessDeniedException"
	) {
		return "auth";
	}
	if (
		name === "NetworkingError" ||
		name === "TimeoutError" ||
		name === "AbortError"
	) {
		return "network";
	}
	if (
		err instanceof Error &&
		/network|fetch|ENOTFOUND|EAI_AGAIN/i.test(err.message)
	) {
		return "network";
	}
	return "unknown";
}

/**
 * `Translation_Service` — AWS Translate 호출 큐 관리자.
 *
 * 동작 개요:
 * 1. `beginSession(callbacks)` 로 콜백 1 회 등록.
 * 2. `enqueue(item, params)` 호출마다 (a) 가드 평가 → (b) 큐 적재 → (c) cost counter 증가
 *    → (d) `TranslateClient.send` 비동기 발사.
 * 3. AWS 응답 도착 시 `onResolved` / `onRejected` 콜백 통지. 큐 아이템 state 갱신.
 * 4. `endSession` 으로 콜백 / 큐 / 카운터 / 윈도우를 모두 초기화.
 *
 * 가드 순서 (Requirement 13.6, 13.8):
 * - (G1) `navigator.onLine === false` → no-op + 세션당 1 회 `console.error("translation_skipped: offline")`.
 * - (G2) `autoDisabled === true` → no-op (조용히 무시).
 * - (G3) 큐 적재 + AWS 호출 발사.
 */
export class Translation_Service {
	private readonly clientFactory: TranslateClientFactory;
	private callbacks: Translation_Service_Callbacks | null = null;

	/**
	 * 큐. 삽입 순서 = `segmentId` 단조 증가 순서 (Requirement 13.5).
	 * 본 서비스는 큐를 traversal 하지 않으며 (각 응답은 segmentId 키로 직접 lookup),
	 * 호출자(SidebarView) 가 placeholder DOM 의 위치 안정성으로 표시 순서를 보장한다.
	 */
	private readonly queue: Map<number, Translation_Queue_Item> = new Map();

	/** 누적 입력 문자 수 (코드포인트 단위, Requirement 13.9). 단조 비감소. */
	private costCounter = 0;

	/** 30 초 슬라이딩 윈도우 실패 timestamp 들 (Requirement 13.6). */
	private failureWindow: number[] = [];

	/** 자동 비활성화 진입 후 true. 한 세션 내에서 false 로 돌아가지 않는다. */
	private autoDisabled = false;

	/** `navigator.onLine === false` 시 console.error 를 세션당 1 회만 발사하기 위한 플래그. */
	private offlineSkipLogged = false;

	/**
	 * 활성 세션의 현재 백엔드 (Requirement 14.4, 14.5, 14.6).
	 *
	 * `null` (= 미설정) 또는 `"cloud"` 인 동안 `enqueue` 는 정상 가드 평가 후 발사된다.
	 * `"local"` 로 전환된 이후의 `enqueue` 호출은 (G0) 가드에서 즉시 no-op 으로 반환되며
	 * 세션당 1 회 `console.error("translation_skipped: offline_mode")` 가 기록된다.
	 *
	 * 본 필드는 `markBackendChanged()` 에서만 갱신되며, `beginSession` / `endSession` 시
	 * `null` 로 리셋된다 (다음 세션에서 호출자가 다시 `markBackendChanged` 를 호출하지
	 * 않으면 cloud 와 동치로 동작 — task 26 wiring 전 호환성 보존).
	 */
	private currentBackend: "cloud" | "local" | null = null;

	/**
	 * `currentBackend === "local"` 상태에서 `enqueue` 가 호출됐을 때 `console.error`
	 * 를 세션당 1 회만 발사하기 위한 플래그 (Requirement 14.5). `markBackendChanged` 가
	 * `local` 로 전환될 때마다 false 로 리셋되어, 한 세션 내에서 여러 번 mark 되더라도
	 * 사용자에게 의미 있는 1 회를 보장한다.
	 */
	private offlineModeSkipLogged = false;

	constructor(clientFactory: TranslateClientFactory) {
		this.clientFactory = clientFactory;
	}

	/**
	 * 세션 시작 시 콜백을 등록한다.
	 *
	 * 동일 인스턴스를 여러 세션에 재사용할 수 있도록 `beginSession` 은 큐 / 카운터 /
	 * 윈도우 / autoDisabled / offlineSkipLogged 를 모두 초기화한다 (Requirement 13.6
	 * "한 세션 내" 의미를 보존).
	 */
	beginSession(callbacks: Translation_Service_Callbacks): void {
		this.callbacks = callbacks;
		this.queue.clear();
		this.costCounter = 0;
		this.failureWindow = [];
		this.autoDisabled = false;
		this.offlineSkipLogged = false;
		// task 26 — 새 세션 시작 시 백엔드/오프라인 게이트 상태 초기화. 호출자(main.ts)
		// 는 `selectBackend` 결과 직후 `markBackendChanged(backend)` 를 호출하여 cloud
		// 또는 local 로 명시적으로 통지한다. 그 호출 이전까지는 null 상태로 cloud 와
		// 동치 동작 (G0 가드 비활성).
		this.currentBackend = null;
		this.offlineModeSkipLogged = false;
	}

	/**
	 * 활성 백엔드 변경을 통지한다 (Requirement 14.4, 14.5, 14.6).
	 *
	 * 호출 시점:
	 * 1. 세션 시작 직후 `selectBackend` 결과로 결정된 백엔드 (cloud 또는 local).
	 * 2. `auto` 모드의 인-세션 폴백 시점 — 클라우드 시도 후 timeout/auth/network 사유로
	 *    로컬로 전환되는 직후 (Requirement 3.8 EXCEPT, 14.6).
	 *
	 * 효과:
	 * - `local` 로 전환되면 이후 `enqueue` 호출은 (G0) 가드에서 즉시 no-op 으로 반환된다.
	 *   호출 시점 직전에 이미 발사된 in-flight `TranslateClient.send` Promise 는 abort
	 *   하지 않으며 (Requirement 3.9), 도착하면 `onResolved` / `onRejected` 가 정상
	 *   호출된다 — 즉 큐에 이미 들어간 아이템은 사이드바에 정상 부착된다.
	 * - `cloud` 로 전환되면 게이트가 해제된다. 본 v1 범위에서는 `cloud → local` 전환만
	 *   실제로 발생하지만 (auto 폴백은 단방향), 인터페이스는 향후 양방향 확장을 허용한다.
	 *
	 * Requirement 14.5 의 "한 세션 내에서 1 회만" 의미는 `local` 로 전환될 때마다
	 * `offlineModeSkipLogged` 를 리셋하여, 한 세션에서 여러 번 mark(예: 테스트 시나리오)
	 * 되더라도 매번 1 회씩만 console.error 가 발사되게 한다. 일반 시나리오에서는 폴백이
	 * 1 회만 발생하므로 정확히 1 회 기록된다.
	 */
	markBackendChanged(backend: "cloud" | "local"): void {
		this.currentBackend = backend;
		if (backend === "local") {
			this.offlineModeSkipLogged = false;
		}
	}

	/**
	 * 한 Final_Result 에 대한 번역 호출을 발사한다.
	 *
	 * 가드 평가 후 발사되면:
	 * 1. `costCounter += [...item.sourceText].length` (Requirement 13.9, 코드포인트 단위).
	 * 2. `onCostCounterChanged(costCounter)` 1 회 호출.
	 * 3. `TranslateTextCommand` 를 비동기 발사 — Promise 결과는 fire-and-forget 으로 처리.
	 * 4. 응답 도착 시 `onResolved` / `onRejected` 통지.
	 *
	 * 본 메서드는 즉시 반환한다 (await 하지 않는다). 호출자가 await 할 경우
	 * 사이드바의 원본 라인이 번역 완료까지 블록되어 Requirement 13.4 위반.
	 */
	enqueue(
		item: Translation_Queue_Item,
		params: { credentials: AwsCredentials; region: string },
	): void {
		// (G0) 모드 게이트 (Requirement 14.5) — 활성 백엔드가 `local` 로 마킹된 이후의
		// enqueue 는 즉시 no-op. `markBackendChanged("local")` 호출 시점 직전에 이미
		// 발사된 in-flight 요청은 abort 하지 않으며 도착하면 정상 콜백되므로, 본 가드는
		// "이후 enqueue 분만" no-op 처리한다 (Requirement 3.9 와 정합).
		// 자동 비활성화 / 오프라인 가드보다 먼저 평가하여 사유 분류를 명확히 한다.
		if (this.currentBackend === "local") {
			if (!this.offlineModeSkipLogged) {
				console.error("translation_skipped: offline_mode");
				this.offlineModeSkipLogged = true;
			}
			return;
		}

		// (G1) 오프라인 가드 (Requirement 13.8).
		if (typeof navigator !== "undefined" && navigator.onLine === false) {
			if (!this.offlineSkipLogged) {
				console.error("translation_skipped: offline");
				this.offlineSkipLogged = true;
			}
			return;
		}

		// (G2) 자동 비활성화 가드 (Requirement 13.6).
		if (this.autoDisabled) return;

		// (G3) 큐 적재 + 비용 카운터 증가 + AWS 호출 발사.
		this.queue.set(item.segmentId, item);

		// 코드포인트 단위 카운팅: 서로게이트 페어를 1 자로 정확히 처리하기 위해 spread 사용.
		// `String.length` 는 UTF-16 코드 유닛 단위이므로 4 바이트 이모지가 2 로 카운트된다.
		this.costCounter += [...item.sourceText].length;
		this.callbacks?.onCostCounterChanged(this.costCounter);

		const client = this.clientFactory(params.credentials, params.region);
		const command = new TranslateTextCommand({
			SourceLanguageCode: item.sourceLanguage,
			TargetLanguageCode: item.targetLanguage,
			Text: item.sourceText,
		});

		// fire-and-forget: 호출자가 await 하지 않는다. 내부적으로는 .then/.catch 로
		// 결과를 처리하여 unhandled rejection 을 방지한다.
		client
			.send(command)
			.then((response) =>
				this.handleResolved(item.segmentId, response.TranslatedText ?? ""),
			)
			.catch((err: unknown) => this.handleRejected(item.segmentId, err));
	}

	/**
	 * 세션을 종료하고 콜백 참조를 해제한다.
	 *
	 * 진행 중인 in-flight `TranslateClient.send` 호출은 abort 하지 않는다 — 호출자가
	 * `endSession` 을 호출한 시점 이후 도착하는 응답은 콜백이 null 이므로 조용히 무시된다.
	 */
	endSession(): void {
		this.callbacks = null;
		this.queue.clear();
		this.costCounter = 0;
		this.failureWindow = [];
		this.autoDisabled = false;
		this.offlineSkipLogged = false;
		// task 26 — 다음 세션이 깨끗한 상태에서 시작하도록 게이트 상태도 리셋한다.
		this.currentBackend = null;
		this.offlineModeSkipLogged = false;
	}

	/**
	 * 누적 입력 문자 수 (코드포인트 단위). UI 가 폴링하기 위한 read-only accessor.
	 *
	 * Requirement 13.9: 어떤 호출 시퀀스에서도 단조 비감소 (Property 10).
	 */
	getCostCounter(): number {
		return this.costCounter;
	}

	/** 자동 비활성화 진입 여부. 사이드바 토글의 disabled 표시에 사용 가능. */
	isAutoDisabled(): boolean {
		return this.autoDisabled;
	}

	/**
	 * AWS 성공 응답 처리. 큐에서 아이템을 lookup 하여 `onResolved` 콜백 1 회 발사.
	 *
	 * `endSession` 후 도착한 응답은 콜백이 null 이므로 조용히 무시된다 (큐가 비어있어
	 * `item` 이 undefined 인 경우도 동일).
	 */
	private handleResolved(segmentId: number, translatedText: string): void {
		const item = this.queue.get(segmentId);
		if (!item) return;
		item.state = "done";
		this.callbacks?.onResolved(segmentId, translatedText);
	}

	/**
	 * AWS 실패 응답 처리. 큐에서 아이템 lookup → `onRejected` 콜백 + 실패 윈도우 기록 →
	 * 임계값 도달 시 `onAutoDisabled` 1 회 발사.
	 *
	 * 본 메서드는 사유 코드만 `console.error` 로 기록한다 (Requirement 11.1: 자격 증명/응답
	 * 본문/AWS 응답 전체 미기록).
	 */
	private handleRejected(segmentId: number, err: unknown): void {
		const item = this.queue.get(segmentId);
		if (!item) return;
		item.state = "failed";
		const errorCode = classifyError(err);
		console.error(`translation_failed: ${errorCode}`);
		this.callbacks?.onRejected(segmentId, errorCode);
		this.recordFailure();
	}

	/**
	 * 30 초 슬라이딩 윈도우 실패 카운터 갱신 (design §Translation Queue 의사코드).
	 *
	 * 매 실패마다 현재 timestamp 를 push 한 뒤, `now - 30_000` 이전 timestamp 들을 filter 로
	 * 제거한다. 결과 길이가 `FAILURE_THRESHOLD(3)` 이상이면 자동 비활성화 진입.
	 *
	 * `autoDisabled` 가 한 번 true 가 되면 본 메서드는 이후 호출에서도 멱등하게 동작한다
	 * (`onAutoDisabled` 는 정확히 1 회만 발사).
	 */
	private recordFailure(): void {
		const now = Date.now();
		this.failureWindow.push(now);
		this.failureWindow = this.failureWindow.filter(
			(t) => now - t <= FAILURE_WINDOW_MS,
		);
		if (!this.autoDisabled && this.failureWindow.length >= FAILURE_THRESHOLD) {
			this.autoDisabled = true;
			this.callbacks?.onAutoDisabled();
		}
	}
}

/**
 * 테스트 / 호출자 편의를 위한 헬퍼 — `Transcript_Segment` 와 placeholder DOM 으로부터
 * `Translation_Queue_Item` 을 빌드한다.
 */
export function buildTranslationQueueItem(params: {
	segment: Transcript_Segment;
	placeholderEl: HTMLElement;
	sourceLanguage: string;
	targetLanguage: Curated_Target_Language;
	enqueuedAtMs?: number;
}): Translation_Queue_Item {
	return {
		segmentId: params.segment.segmentId,
		sourceText: params.segment.text,
		sourceLanguage: params.sourceLanguage,
		targetLanguage: params.targetLanguage,
		enqueuedAtMs: params.enqueuedAtMs ?? Date.now(),
		placeholderEl: params.placeholderEl,
		state: "pending",
	};
}
