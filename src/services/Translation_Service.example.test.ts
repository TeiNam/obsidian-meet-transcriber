/**
 * `Translation_Service` 예제 기반 테스트 (`aws-sdk-client-mock`).
 *
 * design.md §4.5 의 동작 계약을 다음 acceptance criterion 대해 결정성 있게 검증한다:
 *
 * - **AC 13.4**: Final 1 건당 1 회 `TranslateClient.send` 호출 + `onResolved` 1 회.
 * - **AC 13.6**: 30 초 윈도우 내 3 회 실패 → `autoDisabled = true` + `onAutoDisabled` 1 회 +
 *               이후 `enqueue` 호출은 no-op (send 발사 0 건).
 * - **AC 13.8**: `navigator.onLine === false` 시 enqueue 가 send 발사 0 건 + 세션당 1 회만
 *               `console.error("translation_skipped: offline")` 기록.
 *
 * 테스트 전략:
 * - `aws-sdk-client-mock` 으로 `TranslateClient` 의 모든 인스턴스를 가로챈다.
 * - 30 초 윈도우는 `vi.useFakeTimers()` 와 `Date.now()` 흐름을 직접 조작하여 결정성 확보.
 * - `navigator.onLine` 은 `Object.defineProperty(navigator, "onLine", ...)` 로 모킹.
 */

import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import {
	TranslateClient,
	TranslateTextCommand,
} from "@aws-sdk/client-translate";

import {
	Translation_Service,
	type Translation_Queue_Item,
} from "./Translation_Service";
import type { AwsCredentials } from "../types/settings";

// ---------------------------------------------------------------------------
// 공통 fixture
// ---------------------------------------------------------------------------

const DUMMY_CREDENTIALS: AwsCredentials = {
	accessKeyId: "test-access-key",
	secretAccessKey: "test-secret-key",
};
const DUMMY_REGION = "us-east-1";

const translateMock = mockClient(TranslateClient);

const realClientFactory = (creds: AwsCredentials, region: string) =>
	new TranslateClient({
		region,
		credentials: {
			accessKeyId: creds.accessKeyId,
			secretAccessKey: creds.secretAccessKey,
		},
	});

function makeItem(
	segmentId: number,
	sourceText: string,
): Translation_Queue_Item {
	return {
		segmentId,
		sourceText,
		sourceLanguage: "ko",
		targetLanguage: "en",
		enqueuedAtMs: 0,
		placeholderEl: document.createElement("div"),
		state: "pending",
	};
}

/** AWS SDK 가 throw 하는 명명된 예외를 모사. SDK v3 는 `name` 으로 분기 식별을 권장. */
function makeNamedError(name: string, message = name): Error {
	const err = new Error(message);
	err.name = name;
	return err;
}

// `console.error` spy — 본 서비스는 실패 / 오프라인 사유만 기록한다 (Requirement 11.1).
let consoleErrorSpy!: ReturnType<typeof vi.spyOn> & {
	mock: { calls: unknown[][] };
};

beforeEach(() => {
	translateMock.reset();
	consoleErrorSpy = vi
		.spyOn(console, "error")
		.mockImplementation(() => undefined) as typeof consoleErrorSpy;
});

afterEach(() => {
	consoleErrorSpy.mockRestore();
	vi.useRealTimers();
	// `navigator.onLine` 모킹 해제: jsdom 의 기본값(true) 으로 복원.
	Object.defineProperty(navigator, "onLine", {
		configurable: true,
		get: () => true,
	});
});

afterAll(() => {
	translateMock.restore();
});

// ===========================================================================
// AC 13.4 — Final 1 건당 1 회 호출 + 1 회 onResolved
// ===========================================================================

describe("Translation_Service.enqueue — AC 13.4: Final 1 건당 1 회 호출", () => {
	it("Final 1 건 enqueue 시 TranslateTextCommand 가 정확히 1 회 발사되고 onResolved 가 1 회 호출된다", async () => {
		translateMock.on(TranslateTextCommand).resolves({
			TranslatedText: "Hello",
			SourceLanguageCode: "ko",
			TargetLanguageCode: "en",
		});

		const service = new Translation_Service(realClientFactory);
		const onResolved = vi.fn();
		const onRejected = vi.fn();
		const onCostCounterChanged = vi.fn();

		service.beginSession({
			onResolved,
			onRejected,
			onAutoDisabled: vi.fn(),
			onCostCounterChanged,
		});

		const item = makeItem(1, "안녕");
		service.enqueue(item, {
			credentials: DUMMY_CREDENTIALS,
			region: DUMMY_REGION,
		});

		// fire-and-forget Promise 의 .then 이 실행되도록 microtask flush.
		await Promise.resolve();
		await Promise.resolve();

		// (1) send 호출 수 = 1.
		const sendCalls = translateMock.commandCalls(TranslateTextCommand);
		expect(sendCalls.length).toBe(1);

		// (2) command 입력값이 정확히 전달됨 — design §4.5 의 시그니처 준수 검증.
		const sentInput = sendCalls[0].args[0].input;
		expect(sentInput.SourceLanguageCode).toBe("ko");
		expect(sentInput.TargetLanguageCode).toBe("en");
		expect(sentInput.Text).toBe("안녕");

		// (3) onResolved 가 정확히 1 회, segmentId 1 + "Hello" 인자로 호출됨.
		expect(onResolved).toHaveBeenCalledTimes(1);
		expect(onResolved).toHaveBeenCalledWith(1, "Hello");
		expect(onRejected).not.toHaveBeenCalled();

		// (4) cost counter: "안녕" = 2 codepoints.
		expect(service.getCostCounter()).toBe(2);
		expect(onCostCounterChanged).toHaveBeenCalledWith(2);

		service.endSession();
	});

	it("코드포인트 단위 카운팅 — 서로게이트 페어를 1 자로 카운트", async () => {
		translateMock.on(TranslateTextCommand).resolves({
			TranslatedText: "ok",
		});

		const service = new Translation_Service(realClientFactory);
		service.beginSession({
			onResolved: () => undefined,
			onRejected: () => undefined,
			onAutoDisabled: () => undefined,
			onCostCounterChanged: () => undefined,
		});

		// "👋" 는 UTF-16 코드 유닛 2 개 (서로게이트 페어), 코드포인트 1 개.
		// `String.length` 는 2 를 반환하지만 본 서비스는 spread 로 1 로 카운트한다.
		service.enqueue(makeItem(1, "👋"), {
			credentials: DUMMY_CREDENTIALS,
			region: DUMMY_REGION,
		});

		expect(service.getCostCounter()).toBe(1);

		service.endSession();
	});
});

// ===========================================================================
// AC 13.6 — 30 초 3 회 실패 → 자동 비활성화 + 이후 enqueue no-op
// ===========================================================================

describe("Translation_Service.enqueue — AC 13.6: 30 초 윈도우 3 회 실패 자동 비활성화", () => {
	it("30 초 윈도우 내 3 회 실패 도달 시 onAutoDisabled 1 회 + 이후 enqueue 가 no-op", async () => {
		// 가짜 타이머 + Date.now 시작점 고정.
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));

		// AWS 가 ThrottlingException 으로 reject — 본 서비스는 throttle 사유로 분류.
		translateMock
			.on(TranslateTextCommand)
			.rejects(makeNamedError("ThrottlingException"));

		const service = new Translation_Service(realClientFactory);
		const onRejected = vi.fn();
		const onAutoDisabled = vi.fn();

		service.beginSession({
			onResolved: () => undefined,
			onRejected,
			onAutoDisabled,
			onCostCounterChanged: () => undefined,
		});

		// 1 회차 실패 — 0 초 시점.
		service.enqueue(makeItem(1, "a"), {
			credentials: DUMMY_CREDENTIALS,
			region: DUMMY_REGION,
		});
		await vi.advanceTimersByTimeAsync(0);
		await Promise.resolve();
		await Promise.resolve();

		expect(service.isAutoDisabled()).toBe(false);
		expect(onAutoDisabled).not.toHaveBeenCalled();

		// 2 회차 실패 — 10 초 시점.
		await vi.advanceTimersByTimeAsync(10_000);
		service.enqueue(makeItem(2, "b"), {
			credentials: DUMMY_CREDENTIALS,
			region: DUMMY_REGION,
		});
		await vi.advanceTimersByTimeAsync(0);
		await Promise.resolve();
		await Promise.resolve();

		expect(service.isAutoDisabled()).toBe(false);
		expect(onAutoDisabled).not.toHaveBeenCalled();

		// 3 회차 실패 — 20 초 시점. 윈도우(30 초) 내 누적 3 회 → 자동 비활성화 진입.
		await vi.advanceTimersByTimeAsync(10_000);
		service.enqueue(makeItem(3, "c"), {
			credentials: DUMMY_CREDENTIALS,
			region: DUMMY_REGION,
		});
		await vi.advanceTimersByTimeAsync(0);
		await Promise.resolve();
		await Promise.resolve();

		expect(service.isAutoDisabled()).toBe(true);
		expect(onAutoDisabled).toHaveBeenCalledTimes(1);
		expect(onRejected).toHaveBeenCalledTimes(3);

		// send 가 정확히 3 회만 발사됨.
		expect(translateMock.commandCalls(TranslateTextCommand).length).toBe(3);

		// 자동 비활성화 진입 후 enqueue 4 ~ 5 — no-op 이어야 함.
		service.enqueue(makeItem(4, "d"), {
			credentials: DUMMY_CREDENTIALS,
			region: DUMMY_REGION,
		});
		service.enqueue(makeItem(5, "e"), {
			credentials: DUMMY_CREDENTIALS,
			region: DUMMY_REGION,
		});
		await vi.advanceTimersByTimeAsync(0);
		await Promise.resolve();
		await Promise.resolve();

		// send 호출 수가 여전히 3 회 (4, 5 는 발사되지 않음).
		expect(translateMock.commandCalls(TranslateTextCommand).length).toBe(3);
		// `onAutoDisabled` 는 여전히 1 회 (재진입 시 재발사 안 함).
		expect(onAutoDisabled).toHaveBeenCalledTimes(1);
		// `onRejected` 도 여전히 3 회 (4, 5 는 send 자체가 없으므로 reject 도 없음).
		expect(onRejected).toHaveBeenCalledTimes(3);

		service.endSession();
	});

	it("30 초 이상 떨어진 실패는 윈도우에서 빠져 자동 비활성화에 카운트되지 않는다", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));

		translateMock
			.on(TranslateTextCommand)
			.rejects(makeNamedError("ThrottlingException"));

		const service = new Translation_Service(realClientFactory);
		const onAutoDisabled = vi.fn();
		service.beginSession({
			onResolved: () => undefined,
			onRejected: () => undefined,
			onAutoDisabled,
			onCostCounterChanged: () => undefined,
		});

		// 1 회차 실패 — 0 초.
		service.enqueue(makeItem(1, "a"), {
			credentials: DUMMY_CREDENTIALS,
			region: DUMMY_REGION,
		});
		await vi.advanceTimersByTimeAsync(0);
		await Promise.resolve();
		await Promise.resolve();

		// 31 초 후 2 회차 — 첫 실패는 윈도우 밖으로 빠짐.
		await vi.advanceTimersByTimeAsync(31_000);
		service.enqueue(makeItem(2, "b"), {
			credentials: DUMMY_CREDENTIALS,
			region: DUMMY_REGION,
		});
		await vi.advanceTimersByTimeAsync(0);
		await Promise.resolve();
		await Promise.resolve();

		// 5 초 후 3 회차 — 윈도우 내 누적은 2 회 (2 회차 + 3 회차) 이므로 자동 비활성화 미진입.
		await vi.advanceTimersByTimeAsync(5_000);
		service.enqueue(makeItem(3, "c"), {
			credentials: DUMMY_CREDENTIALS,
			region: DUMMY_REGION,
		});
		await vi.advanceTimersByTimeAsync(0);
		await Promise.resolve();
		await Promise.resolve();

		expect(service.isAutoDisabled()).toBe(false);
		expect(onAutoDisabled).not.toHaveBeenCalled();

		service.endSession();
	});
});

// ===========================================================================
// AC 13.8 — navigator.onLine === false 시 enqueue skip
// ===========================================================================

describe("Translation_Service.enqueue — AC 13.8: 오프라인 가드", () => {
	it("navigator.onLine === false 일 때 enqueue 가 send 미발사 + 세션당 1 회 console.error", async () => {
		// `navigator.onLine` 을 false 로 모킹.
		Object.defineProperty(navigator, "onLine", {
			configurable: true,
			get: () => false,
		});

		const service = new Translation_Service(realClientFactory);
		const onResolved = vi.fn();
		const onRejected = vi.fn();
		const onCostCounterChanged = vi.fn();

		service.beginSession({
			onResolved,
			onRejected,
			onAutoDisabled: vi.fn(),
			onCostCounterChanged,
		});

		// 5 회 enqueue — 모두 no-op 이어야 함.
		for (let i = 1; i <= 5; i++) {
			service.enqueue(makeItem(i, `text-${i}`), {
				credentials: DUMMY_CREDENTIALS,
				region: DUMMY_REGION,
			});
		}
		await Promise.resolve();
		await Promise.resolve();

		// (1) send 가 0 회 발사됨.
		expect(translateMock.commandCalls(TranslateTextCommand).length).toBe(0);

		// (2) onResolved / onRejected / onCostCounterChanged 미호출.
		expect(onResolved).not.toHaveBeenCalled();
		expect(onRejected).not.toHaveBeenCalled();
		expect(onCostCounterChanged).not.toHaveBeenCalled();

		// (3) cost counter 미증가.
		expect(service.getCostCounter()).toBe(0);

		// (4) `console.error("translation_skipped: offline")` 가 정확히 1 회 호출됨.
		const offlineLogCalls = consoleErrorSpy.mock.calls.filter((args) =>
			args.some(
				(a) =>
					typeof a === "string" && a.includes("translation_skipped"),
			),
		);
		expect(offlineLogCalls.length).toBe(1);

		service.endSession();
	});

	it("오프라인 → 온라인 전환 후 enqueue 는 정상 발사된다 (offlineSkipLogged 가 beginSession 으로 리셋)", async () => {
		const service = new Translation_Service(realClientFactory);
		service.beginSession({
			onResolved: () => undefined,
			onRejected: () => undefined,
			onAutoDisabled: () => undefined,
			onCostCounterChanged: () => undefined,
		});

		// 첫 세션: 오프라인 상태에서 enqueue 1 회.
		Object.defineProperty(navigator, "onLine", {
			configurable: true,
			get: () => false,
		});
		service.enqueue(makeItem(1, "a"), {
			credentials: DUMMY_CREDENTIALS,
			region: DUMMY_REGION,
		});
		expect(translateMock.commandCalls(TranslateTextCommand).length).toBe(0);

		// 새 세션 시작 (온라인 복귀).
		Object.defineProperty(navigator, "onLine", {
			configurable: true,
			get: () => true,
		});
		translateMock.on(TranslateTextCommand).resolves({
			TranslatedText: "ok",
		});
		service.beginSession({
			onResolved: () => undefined,
			onRejected: () => undefined,
			onAutoDisabled: () => undefined,
			onCostCounterChanged: () => undefined,
		});
		service.enqueue(makeItem(2, "b"), {
			credentials: DUMMY_CREDENTIALS,
			region: DUMMY_REGION,
		});
		await Promise.resolve();
		await Promise.resolve();

		// 새 세션의 enqueue 는 정상 발사됨.
		expect(translateMock.commandCalls(TranslateTextCommand).length).toBe(1);

		service.endSession();
	});
});

// ===========================================================================
// AC 13.7 (v1.1 갱신본) / Requirement 14.5 — `markBackendChanged("local")` 모드 게이트
// ===========================================================================
//
// 본 시나리오는 task 27 의 통합 와이어링이 의도대로 작동하는지 검증한다.
// 흐름:
//   1) beginSession()
//   2) markBackendChanged("local") — main.ts 의 task 26 가 startStreaming 직후 호출함
//   3) enqueue(...) 를 N 건 — Final segment 가 도착할 때마다 main.ts 의 handleFinalSegment
//      가 호출하는 경로를 모사
//   4) 검증:
//      - TranslateClient.send 가 정확히 0 회 호출됨 (G0 가드가 모두 차단)
//      - console.error("translation_skipped: offline_mode") 가 정확히 1 회 기록됨
//        (한 세션 1 회 보장 — Requirement 14.5)
//
// 본 테스트는 task 27 의 "main.ts 측에서 navigator.onLine 검사 없이 enqueue 만 호출하면
// 된다" 라는 와이어링 계약을 결정성 있게 보장한다.

describe("Translation_Service.enqueue — AC 13.7 v1.1 / Requirement 14.5: 활성 백엔드 = local 모드 게이트", () => {
	it("markBackendChanged('local') 후 N 건 enqueue → send 0 회 + console.error 1 회", async () => {
		// 글로벌 `navigator.onLine = true` (afterEach 에서 복원). 본 시나리오는
		// 네트워크 연결 여부와 무관하게 G0 (활성 백엔드 = local) 가드만으로 차단되어야
		// 함을 검증하므로, 의도적으로 navigator 는 온라인 상태로 유지한다.
		Object.defineProperty(navigator, "onLine", {
			configurable: true,
			get: () => true,
		});

		// send 가 호출되면 안 되지만, 만약 호출된다면 즉시 알려지도록 명시적 stub 등록.
		// (테스트가 통과하면 본 stub 은 호출되지 않는다.)
		translateMock.on(TranslateTextCommand).resolves({
			TranslatedText: "(should not be called)",
		});

		const service = new Translation_Service(realClientFactory);
		const onResolved = vi.fn();
		const onRejected = vi.fn();
		service.beginSession({
			onResolved,
			onRejected,
			onAutoDisabled: () => undefined,
			onCostCounterChanged: () => undefined,
		});

		// 활성 백엔드 = local 통지 (task 26 의 startStreaming 흐름을 모사).
		service.markBackendChanged("local");

		// Final segment 5 건을 enqueue (main.ts 의 handleFinalSegment 흐름).
		for (let i = 1; i <= 5; i++) {
			service.enqueue(makeItem(i, `segment-${i}`), {
				credentials: DUMMY_CREDENTIALS,
				region: DUMMY_REGION,
			});
		}

		// 비동기 큐가 모두 흘러가도록 microtask 를 비운다.
		await Promise.resolve();
		await Promise.resolve();

		// (1) TranslateClient.send 가 정확히 0 회 호출됨.
		expect(translateMock.commandCalls(TranslateTextCommand).length).toBe(0);

		// (2) onResolved / onRejected 도 호출되지 않음 (G0 는 조용한 no-op).
		expect(onResolved).not.toHaveBeenCalled();
		expect(onRejected).not.toHaveBeenCalled();

		// (3) console.error("translation_skipped: offline_mode") 가 정확히 1 회.
		const offlineModeLogs = consoleErrorSpy.mock.calls.filter(
			(args) =>
				typeof args[0] === "string" &&
				args[0] === "translation_skipped: offline_mode",
		);
		expect(offlineModeLogs.length).toBe(1);

		service.endSession();
	});

	it("markBackendChanged('cloud') 로 다시 전환하면 enqueue 가 정상 발사된다", async () => {
		Object.defineProperty(navigator, "onLine", {
			configurable: true,
			get: () => true,
		});
		translateMock.on(TranslateTextCommand).resolves({
			TranslatedText: "Hello",
		});

		const service = new Translation_Service(realClientFactory);
		service.beginSession({
			onResolved: () => undefined,
			onRejected: () => undefined,
			onAutoDisabled: () => undefined,
			onCostCounterChanged: () => undefined,
		});

		// 먼저 local 로 전환 → enqueue → no-op.
		service.markBackendChanged("local");
		service.enqueue(makeItem(1, "a"), {
			credentials: DUMMY_CREDENTIALS,
			region: DUMMY_REGION,
		});
		await Promise.resolve();
		expect(translateMock.commandCalls(TranslateTextCommand).length).toBe(0);

		// cloud 로 복귀 → 다음 enqueue 는 정상 발사.
		service.markBackendChanged("cloud");
		service.enqueue(makeItem(2, "b"), {
			credentials: DUMMY_CREDENTIALS,
			region: DUMMY_REGION,
		});
		await Promise.resolve();
		await Promise.resolve();
		expect(translateMock.commandCalls(TranslateTextCommand).length).toBe(1);

		service.endSession();
	});

	it("같은 세션에서 markBackendChanged('local') 이후 enqueue 가 여러 건이어도 console.error 는 정확히 1 회만 기록된다", async () => {
		Object.defineProperty(navigator, "onLine", {
			configurable: true,
			get: () => true,
		});

		const service = new Translation_Service(realClientFactory);
		service.beginSession({
			onResolved: () => undefined,
			onRejected: () => undefined,
			onAutoDisabled: () => undefined,
			onCostCounterChanged: () => undefined,
		});
		service.markBackendChanged("local");

		// 10 건의 enqueue — 모두 G0 에서 차단.
		for (let i = 1; i <= 10; i++) {
			service.enqueue(makeItem(i, `text-${i}`), {
				credentials: DUMMY_CREDENTIALS,
				region: DUMMY_REGION,
			});
		}
		await Promise.resolve();

		const offlineModeLogs = consoleErrorSpy.mock.calls.filter(
			(args) =>
				typeof args[0] === "string" &&
				args[0] === "translation_skipped: offline_mode",
		);
		expect(offlineModeLogs.length).toBe(1);

		service.endSession();
	});
});
