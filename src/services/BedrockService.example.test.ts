/**
 * `BedrockService.analyze`의 오류 분기 및 해피 패스 예시 테스트 (Task 11.3).
 *
 * 검증 목표:
 * - `AccessDeniedException` / `UnrecognizedClientException` → `TranscribeError.code === "AWS_AUTH"`
 *   (Requirement 6.13)
 * - `ValidationException` → `TranscribeError.code === "AWS_MODEL_UNAVAILABLE"`
 *   (Requirement 6.14)
 * - 타임아웃(`AbortError`) → `TranscribeError.code === "AWS_NETWORK"`와 "timed out" 사유
 *   (Requirements 6.11, 6.12)
 * - 네트워크/기타 오류 / JSON 파싱 실패 → `TranscribeError.code === "AWS_NETWORK"`
 *   (Requirement 6.15)
 *
 * 테스트 전략:
 * - `aws-sdk-client-mock`의 `mockClient(BedrockRuntimeClient)`로 모든 인스턴스의 `send`를 가로챈다.
 * - `BedrockService`는 `clientFactory`로 `BedrockRuntimeClient`를 지연 생성하므로,
 *   팩토리에서 실제 클라이언트를 반환해도 모의 인터셉터가 적용된다.
 * - 타임아웃 분기는 두 가지로 검증한다:
 *   1) 모의 `send`가 `AbortError`를 직접 reject 하여 SDK가 관측하는 시나리오(시간 조작 불필요)
 *   2) `vi.useFakeTimers()` + 장시간 pending 프로미스로 setTimeout 기반 abort 경로 검증
 * - `TranscribeError`가 그대로 전파되는 경로는 `clientFactory`에서 직접 throw 하여 재현한다.
 *
 * 주의:
 * - 각 테스트 앞에서 `bedrockMock.reset()`을 호출해 격리된 상태로 시작한다.
 * - `console.error`는 프로덕션 로깅 호출을 관측하는 동시에 테스트 출력 소음을 억제하기 위해 spy 처리한다.
 */

import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import {
	BedrockRuntimeClient,
	InvokeModelCommand,
} from "@aws-sdk/client-bedrock-runtime";
import { mockClient } from "aws-sdk-client-mock";

import { BedrockService, type AnalyzeParams } from "./BedrockService";
import { TranscribeError } from "../types/errors";
import type { AwsCredentials } from "../types/settings";

// -----------------------------------------------------------------------------
// 공통 설정
// -----------------------------------------------------------------------------

/**
 * `BedrockRuntimeClient` 생성자를 가로채는 글로벌 모의 인스턴스.
 *
 * `mockClient()`는 클라이언트 생성자 자체를 패치하므로, 이후 테스트 내에서
 * `new BedrockRuntimeClient({...})`로 만든 어떤 인스턴스에서도 `send`가 모의로 동작한다.
 */
const bedrockMock = mockClient(BedrockRuntimeClient);

/** 실제 클라이언트를 생성해 반환하는 기본 팩토리. */
const realClientFactory = (credentials: AwsCredentials, region: string) =>
	new BedrockRuntimeClient({
		region,
		credentials: {
			accessKeyId: credentials.accessKeyId,
			secretAccessKey: credentials.secretAccessKey,
		},
	});

/** 테스트에서 반복 사용하는 `analyze` 매개변수. 각 케이스에서 필요 시 override 한다. */
function baseParams(overrides: Partial<AnalyzeParams> = {}): AnalyzeParams {
	return {
		credentials: {
			// 실제 AWS 자격 증명이 아닌 테스트용 더미 문자열. (실제 서비스 호출 없이 모의에서만 사용됨)
			accessKeyId: "TEST_ACCESS_KEY_ID_DUMMY",
			secretAccessKey: "test-secret-access-key-dummy-value-0000",
		},
		region: "us-east-1",
		modelId: "anthropic.claude-3-sonnet-20240229-v1:0",
		transcript: "회의 전사 본문 샘플입니다.",
		locale: "ko",
		...overrides,
	};
}

/**
 * Claude 3 응답 본문 스키마에 맞는 바이너리 본문을 만든다.
 *
 * `BedrockRuntimeClient.send` 응답의 `body`는 SDK 타입 정의상
 * `Uint8ArrayBlobAdapter`(Uint8Array + `transformToString()`)로 선언되어 있지만,
 * `BedrockService`의 추출 로직은 `TextDecoder`만 사용하므로 런타임상 순수 Uint8Array로 충분하다.
 * 테스트에서는 타입 호환을 위해 최소 필드(`transformToString`)만 스텁한 구조체로 반환한다.
 */
function encodeClaudeResponse(payload: unknown): Uint8Array & {
	transformToString: (encoding?: string) => string;
} {
	return encodeClaudeResponseRaw(JSON.stringify(payload));
}

/**
 * 임의 문자열을 Bedrock 응답 body 타입(`Uint8Array & { transformToString }`)으로 감싼다.
 *
 * JSON 파싱 실패 경로(Requirement 6.15) 검증 시 의도적으로 비JSON 문자열을 주입하기 위해 사용.
 */
function encodeClaudeResponseRaw(raw: string): Uint8Array & {
	transformToString: (encoding?: string) => string;
} {
	const bytes = new TextEncoder().encode(raw);
	return Object.assign(bytes, {
		transformToString: (_encoding?: string): string => raw,
	});
}

/** 이름 있는 AWS SDK 예외를 모사하기 위한 헬퍼. `name` 속성 식별이 분기의 핵심이다. */
function makeNamedError(name: string, message = name): Error {
	const err = new Error(message);
	err.name = name;
	return err;
}

// -----------------------------------------------------------------------------
// 테스트 수명주기
// -----------------------------------------------------------------------------

// Vitest 의 `vi.spyOn(console, "error").mockImplementation(...)` 반환 타입은 버전에 따라
// 제네릭 기본형이 달라져 직관적인 주석으로는 TS2322/TS2344 를 유발한다.
// `ReturnType<typeof vi.spyOn>` + 필요한 필드(mock.calls)만 교차 타입으로 확장하고,
// 실제 할당 시 `as typeof consoleErrorSpy` 캐스트로 타입 경계를 넘는다.
let consoleErrorSpy!: ReturnType<typeof vi.spyOn> & {
	mock: { calls: unknown[][] };
};

beforeEach(() => {
	bedrockMock.reset();
	// 프로덕션 코드는 에러 경로에서 `console.error`로 요약 정보를 남긴다(Requirements 9.6).
	// 테스트 출력 소음을 줄이는 동시에 호출을 관측할 수 있도록 spy 처리한다.
	consoleErrorSpy = vi
		.spyOn(console, "error")
		.mockImplementation(() => undefined) as typeof consoleErrorSpy;
});

afterEach(() => {
	consoleErrorSpy.mockRestore();
	// 각 테스트에서 `useFakeTimers()`를 사용했을 수 있으므로 실제 타이머로 복귀.
	vi.useRealTimers();
});

// -----------------------------------------------------------------------------
// 해피 패스
// -----------------------------------------------------------------------------

describe("BedrockService.analyze - 해피 패스", () => {
	it("Claude 3 응답의 content 배열 텍스트를 줄바꿈으로 이어 반환한다", async () => {
		bedrockMock.on(InvokeModelCommand).resolves({
			body: encodeClaudeResponse({
				id: "msg-1",
				type: "message",
				role: "assistant",
				content: [
					{ type: "text", text: "요약 결과 1" },
					{ type: "text", text: "요약 결과 2" },
				],
			}),
		});

		const service = new BedrockService(realClientFactory);
		const result = await service.analyze(baseParams());

		// 소스의 `extractClaudeText`는 각 text 블록을 `\n`으로 join 한다.
		expect(result).toBe("요약 결과 1\n요약 결과 2");

		// 실제로 InvokeModelCommand가 1회 호출되었는지 확인.
		expect(bedrockMock.calls()).toHaveLength(1);
	});

	it("content 배열이 비어 있으면 빈 문자열을 반환한다", async () => {
		bedrockMock.on(InvokeModelCommand).resolves({
			body: encodeClaudeResponse({
				id: "msg-2",
				type: "message",
				role: "assistant",
				content: [],
			}),
		});

		const service = new BedrockService(realClientFactory);
		const result = await service.analyze(baseParams());

		expect(result).toBe("");
	});
});

// -----------------------------------------------------------------------------
// 인증/권한 오류 → AWS_AUTH (Requirement 6.13)
// -----------------------------------------------------------------------------

describe("BedrockService.analyze - 인증/권한 오류 분기 (Requirement 6.13)", () => {
	it("AccessDeniedException은 AWS_AUTH로 매핑되고 원본 에러를 cause로 보존한다", async () => {
		const original = makeNamedError(
			"AccessDeniedException",
			"User is not authorized to perform bedrock:InvokeModel",
		);
		bedrockMock.on(InvokeModelCommand).rejects(original);

		const service = new BedrockService(realClientFactory);

		// 예외 자체를 캡처해 `code`/`cause`/`instanceof`를 모두 단일 단언으로 검증한다.
		const err = await service.analyze(baseParams()).then(
			() => {
				throw new Error("analyze should have rejected");
			},
			(e: unknown) => e,
		);

		expect(err).toBeInstanceOf(TranscribeError);
		const te = err as TranscribeError;
		expect(te.code).toBe("AWS_AUTH");
		// `rejects(Error)`는 모의 send가 정확히 이 에러 인스턴스를 throw 하도록 지시한다.
		// BedrockService는 해당 에러를 `cause`로 보존해야 한다.
		expect(te.cause).toBe(original);

		// 민감 정보 없이 에러 종류만 로그로 남기는지 가볍게 검증한다.
		expect(consoleErrorSpy).toHaveBeenCalled();
		const loggedArgs = consoleErrorSpy.mock.calls.flat();
		// 자격 증명이나 프롬프트 본문이 로그에 유출되지 않아야 한다(Requirements 9.6).
		for (const arg of loggedArgs) {
			if (typeof arg === "string") {
				expect(arg).not.toContain("TEST_ACCESS_KEY_ID_DUMMY");
				expect(arg).not.toContain(
					"test-secret-access-key-dummy-value-0000",
				);
			}
		}
	});

	it("UnrecognizedClientException도 AWS_AUTH로 매핑된다", async () => {
		bedrockMock
			.on(InvokeModelCommand)
			.rejects(makeNamedError("UnrecognizedClientException"));

		const service = new BedrockService(realClientFactory);
		await expect(service.analyze(baseParams())).rejects.toMatchObject({
			name: "TranscribeError",
			code: "AWS_AUTH",
		});
	});
});

// -----------------------------------------------------------------------------
// 모델 미지원 → AWS_MODEL_UNAVAILABLE (Requirement 6.14)
// -----------------------------------------------------------------------------

describe("BedrockService.analyze - 모델 미지원 분기 (Requirement 6.14)", () => {
	it("ValidationException은 AWS_MODEL_UNAVAILABLE로 매핑된다", async () => {
		const original = makeNamedError(
			"ValidationException",
			"The provided model identifier is invalid.",
		);
		bedrockMock.on(InvokeModelCommand).rejects(original);

		const service = new BedrockService(realClientFactory);
		const err = await service
			.analyze(baseParams({ modelId: "invalid-model-id" }))
			.then(
				() => {
					throw new Error("analyze should have rejected");
				},
				(e: unknown) => e,
			);

		expect(err).toBeInstanceOf(TranscribeError);
		const te = err as TranscribeError;
		expect(te.code).toBe("AWS_MODEL_UNAVAILABLE");
		expect(te.cause).toBe(original);
	});
});

// -----------------------------------------------------------------------------
// 타임아웃 → AWS_NETWORK (Requirements 6.11, 6.12)
// -----------------------------------------------------------------------------

describe("BedrockService.analyze - 타임아웃 분기 (Requirements 6.11, 6.12)", () => {
	it("SDK가 AbortError를 reject 하면 AWS_NETWORK로 매핑되고 abort 사유가 메시지에 포함된다", async () => {
		// BedrockService 내부의 setTimeout이 AbortController.abort()를 호출하면
		// 실제 SDK는 AbortError를 throw 한다. aws-sdk-client-mock은 실제 HTTP 핸들러를
		// 거치지 않으므로, 그 최종 결과를 `AbortError` 예외로 직접 모사한다.
		bedrockMock
			.on(InvokeModelCommand)
			.rejects(makeNamedError("AbortError", "The operation was aborted"));

		const service = new BedrockService(realClientFactory);
		const err = await service.analyze(baseParams()).then(
			() => {
				throw new Error("analyze should have rejected");
			},
			(e: unknown) => e,
		);

		expect(err).toBeInstanceOf(TranscribeError);
		const te = err as TranscribeError;
		expect(te.code).toBe("AWS_NETWORK");
		// `timedOut` 플래그가 아직 false인 시점이므로 "aborted" 메시지가 사용된다.
		expect(te.message.toLowerCase()).toMatch(/abort|timed out/);
	});

	it("지정된 timeoutMs 경과 시 '타임아웃' 사유로 AWS_NETWORK를 throw 한다", async () => {
		// 실제 타임아웃 경로를 검증하기 위해 가짜 타이머 사용.
		vi.useFakeTimers();

		// 모의 send는 BedrockService가 AbortController로 abort 할 때까지 영원히 pending 상태를 유지한다.
		// AbortController가 발화하면 mock도 `AbortError`로 reject 하여 실제 SDK 동작을 재현한다.
		bedrockMock.on(InvokeModelCommand).callsFake(
			(_input) =>
				new Promise((_resolve, reject) => {
					// NOTE: aws-sdk-client-mock v4의 callsFake 콜백은 `abortSignal`을 직접
					// 전달받지 않으므로, BedrockService의 setTimeout이 발화할 만큼 긴
					// 지연 후에 AbortError를 throw 하여 모의 응답 체인을 종료한다.
					// `vi.advanceTimersByTimeAsync(timeoutMs + alpha)`로 두 타이머를 한 번에 발화시킨다.
					setTimeout(
						() => reject(makeNamedError("AbortError", "aborted")),
						60_000,
					);
				}),
		);

		const service = new BedrockService(realClientFactory);
		// 테스트 속도를 위해 기본(30초)보다 짧은 타임아웃을 지정한다.
		// BedrockService.analyze 내부는 `timeoutMs` 파라미터를 그대로 setTimeout에 전달한다.
		const timeoutMs = 1_000;

		// await를 바로 붙이지 않고 rejection 처리를 선등록하여 unhandled rejection을 방지한다.
		const settled = service
			.analyze(baseParams({ timeoutMs }))
			.then(
				() => {
					throw new Error("analyze should have rejected");
				},
				(e: unknown) => e,
			);

		// 1) BedrockService 내부 setTimeout(1_000ms) 발화 → controller.abort(), timedOut=true
		// 2) 모의 setTimeout(60_000ms) 발화 → send가 AbortError로 reject
		// 3) BedrockService catch가 isAbortError 분기에서 "timed out" 메시지로 TranscribeError throw
		await vi.advanceTimersByTimeAsync(61_000);

		const err = await settled;
		expect(err).toBeInstanceOf(TranscribeError);
		const te = err as TranscribeError;
		expect(te.code).toBe("AWS_NETWORK");
		// `timedOut` 플래그가 true이므로 "timed out" 문구가 메시지에 포함되어야 한다.
		expect(te.message).toMatch(/timed out/i);
		expect(te.message).toContain(String(timeoutMs));
	});
});

// -----------------------------------------------------------------------------
// 네트워크/스키마 오류 → AWS_NETWORK (Requirement 6.15)
// -----------------------------------------------------------------------------

describe("BedrockService.analyze - 네트워크/기타 오류 분기 (Requirement 6.15)", () => {
	it("일반 Error는 AWS_NETWORK로 매핑된다", async () => {
		const original = new Error("Network is unreachable");
		bedrockMock.on(InvokeModelCommand).rejects(original);

		const service = new BedrockService(realClientFactory);
		const err = await service.analyze(baseParams()).then(
			() => {
				throw new Error("analyze should have rejected");
			},
			(e: unknown) => e,
		);

		expect(err).toBeInstanceOf(TranscribeError);
		const te = err as TranscribeError;
		expect(te.code).toBe("AWS_NETWORK");
		expect(te.cause).toBe(original);
	});

	it("응답 본문이 유효한 JSON이 아니면 파싱 실패가 AWS_NETWORK로 변환된다", async () => {
		// `extractClaudeText` 내부의 JSON.parse가 throw → BedrockService catch가
		// 일반 오류로 간주하여 AWS_NETWORK로 승격시킨다(Requirement 6.15의 경계 케이스).
		bedrockMock.on(InvokeModelCommand).resolves({
			body: encodeClaudeResponseRaw("this-is-not-json"),
		});

		const service = new BedrockService(realClientFactory);
		await expect(service.analyze(baseParams())).rejects.toMatchObject({
			name: "TranscribeError",
			code: "AWS_NETWORK",
		});
	});
});

// -----------------------------------------------------------------------------
// TranscribeError 통과 보존 (구현 계약)
// -----------------------------------------------------------------------------

describe("BedrockService.analyze - TranscribeError 통과 보존", () => {
	it("clientFactory가 TranscribeError를 throw 하면 원래 code 그대로 재전파된다", async () => {
		// 설정이 누락된 상태에서 호출부가 throw 한 TranscribeError를 BedrockService가
		// 재포장하지 않고 그대로 전파하는지 검증한다. (내부 catch의 `instanceof` 분기)
		const injected = new TranscribeError(
			"AWS credentials or model id not configured",
			"SETTINGS_INCOMPLETE",
		);
		const faultyFactory = () => {
			throw injected;
		};

		const service = new BedrockService(faultyFactory);
		await expect(service.analyze(baseParams())).rejects.toBe(injected);

		// clientFactory에서 이미 실패했으므로 SDK send는 호출되지 않는다.
		expect(bedrockMock.calls()).toHaveLength(0);
	});
});
