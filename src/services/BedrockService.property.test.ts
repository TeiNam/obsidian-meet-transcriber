/**
 * `BedrockService` 속성 기반 테스트(PBT).
 *
 * design.md §9 "Correctness Properties" 중 Property 10을 검증한다:
 *
 * - **Property 10: 본문 길이 경계 검증 규칙**
 *   임의의 `transcript` 문자열에 대해 `BedrockService.analyze` 호출 시:
 *     - `transcript.length <= MAX_TRANSCRIPT_LENGTH` → SDK `send`가 호출되고 요청이 정상 개시된다.
 *     - `transcript.length >  MAX_TRANSCRIPT_LENGTH` → SDK `send`가 호출되지 않으며
 *       `TranscribeError` (code `"TRANSCRIPT_TOO_LONG"`)가 throw 된다.
 *
 * 경계값(`MAX_TRANSCRIPT_LENGTH`) 은 `BedrockService.ts` 에서 확정되며, 본 테스트는
 * 상수의 참조 값을 그대로 가져와 검증해 향후 상수 변경 시에도 같은 경계 계약을 유지한다.
 *
 * **Validates: Requirement 6.5**
 *
 * 테스트 전략:
 * - `aws-sdk-client-mock`의 `mockClient(BedrockRuntimeClient)`로 전역 SDK 호출을 가로챈다.
 *   `BedrockService`의 `clientFactory`가 매번 `new BedrockRuntimeClient(...)`를 생성해도
 *   라이브러리가 모든 인스턴스를 가로채므로 `send` 카운트를 정확히 관측할 수 있다.
 * - 각 `fc.asyncProperty` 실행 전 `bedrockMock.reset()`으로 호출 카운트를 초기화하고
 *   `resolves(...)` 핸들러를 재등록한다.
 * - 대용량 문자열을 현실적인 시간 내에 생성하기 위해 `fc.integer`로 길이를 뽑고
 *   `"a".repeat(n)`으로 구성한다(랜덤 코드포인트 생성은 길이 수십만 기준으로 과도하게 느리다).
 * - 실행 횟수는 `numRuns: 50` — 길이 범위 [0, MAX_TRANSCRIPT_LENGTH] 및
 *   (MAX_TRANSCRIPT_LENGTH, MAX_TRANSCRIPT_LENGTH + 20_000] 을
 *   충분히 커버하면서 CI 실행 시간을 과도하게 늘리지 않는다.
 */

import { afterAll, beforeEach, describe, expect, test } from "vitest";
import fc from "fast-check";
import { mockClient } from "aws-sdk-client-mock";
import {
	BedrockRuntimeClient,
	InvokeModelCommand,
} from "@aws-sdk/client-bedrock-runtime";

import { BedrockService } from "./BedrockService";
import type { BedrockClientFactory } from "./BedrockService";
import { TranscribeError } from "../types/errors";
import type { AwsCredentials } from "../types/settings";

// ---------------------------------------------------------------------------
// 공통 상수 — `BedrockService.ts`의 구현 상세와 일치해야 한다
// ---------------------------------------------------------------------------

/** `BedrockService.ts`의 `MAX_TRANSCRIPT_LENGTH`와 동일한 경계값. */
const MAX_TRANSCRIPT_LENGTH = 200_000;

/**
 * 테스트용 더미 자격 증명.
 * `aws-sdk-client-mock`이 실제 네트워크 요청을 가로채므로 AWS에 전송되지 않는다.
 * 실제 키 형식(AKIA…)을 피하고 테스트 의도가 드러나는 문자열만 사용한다.
 */
const DUMMY_CREDENTIALS: AwsCredentials = {
	accessKeyId: "test-access-key-id",
	secretAccessKey: "test-secret-access-key",
};

const DUMMY_REGION = "us-east-1";
const DUMMY_MODEL_ID = "anthropic.claude-3-sonnet-20240229-v1:0";

// ---------------------------------------------------------------------------
// mock 설정 — 모듈 로드 시 1회 생성하고, 각 fc 실행 전에 reset/재등록
// ---------------------------------------------------------------------------

/**
 * `BedrockRuntimeClient`의 모든 인스턴스를 가로채는 mock.
 * `aws-sdk-client-mock`은 클래스 레벨 패치이므로 팩토리가 매번 새 클라이언트를
 * 생성하더라도 `send` 호출이 동일한 `bedrockMock`에 기록된다.
 */
const bedrockMock = mockClient(BedrockRuntimeClient);

/**
 * Claude 3 응답 스키마를 만족하는 정상 응답 페이로드.
 *
 * `BedrockService.analyze`는 응답 `body`를 UTF-8로 디코드한 뒤 JSON 파싱하여
 * `content[].text`를 합친 문자열을 반환한다. 스키마가 어긋나면 `AWS_NETWORK`
 * 오류로 승격되어 Property 10의 under-limit 분기를 오판할 수 있으므로,
 * 스키마에 충실한 응답을 주입한다.
 *
 * SDK 타입은 `body`가 `Uint8ArrayBlobAdapter`(Uint8Array + `transformToString()`)임을
 * 요구하므로, 테스트에서는 최소 필드만 스텁한 구조체로 반환한다.
 */
function makeSuccessResponseBody(): Uint8Array & {
	transformToString: (encoding?: string) => string;
} {
	const raw = JSON.stringify({
		content: [{ type: "text", text: "summary" }],
	});
	const bytes = new TextEncoder().encode(raw);
	return Object.assign(bytes, {
		transformToString: (_encoding?: string): string => raw,
	});
}

/**
 * `bedrockMock`을 초기 상태로 되돌리고 정상 응답 핸들러를 재등록한다.
 * `fc.asyncProperty`의 각 실행 직전에 호출되어 호출 카운트가 누적되지 않도록 한다.
 */
function resetMock(): void {
	bedrockMock.reset();
	bedrockMock.on(InvokeModelCommand).resolves({
		body: makeSuccessResponseBody(),
		contentType: "application/json",
		$metadata: {},
	});
}

/**
 * 실제 SDK 클라이언트를 반환하는 팩토리. `mockClient`가 이 클래스의 모든 인스턴스를
 * 가로채므로, 팩토리가 반환하는 클라이언트의 `send`는 mock으로 라우팅된다.
 */
const realClientFactory: BedrockClientFactory = (
	credentials,
	region,
): BedrockRuntimeClient =>
	new BedrockRuntimeClient({
		region,
		credentials: {
			accessKeyId: credentials.accessKeyId,
			secretAccessKey: credentials.secretAccessKey,
		},
	});

// ---------------------------------------------------------------------------
// 테스트 스위트
// ---------------------------------------------------------------------------

describe("BedrockService.analyze — Property 10: 본문 길이 경계 검증 규칙", () => {
	beforeEach(() => {
		resetMock();
	});

	afterAll(() => {
		// 다른 테스트 파일에 영향이 남지 않도록 mock 상태를 복원한다.
		bedrockMock.restore();
	});

	// -------------------------------------------------------------------------
	// (a) under-limit: length ∈ [0, 100_000] → send IS called, resolves 성공
	// -------------------------------------------------------------------------
	test("transcript.length <= 100_000 → SDK send가 호출되고 analyze가 성공한다", async () => {
		const service = new BedrockService(realClientFactory);

		await fc.assert(
			fc.asyncProperty(
				// `0..100_000` 길이의 정수 뽑기. 10만 크기 임의 문자열 생성은 비용이 크므로
				// 동일 문자 반복(`"a".repeat(n)`)으로 대체한다. 길이 경계가 핵심 관심사이므로
				// 내용물의 다양성은 Property 10의 진술과 무관하다.
				fc.integer({ min: 0, max: MAX_TRANSCRIPT_LENGTH }),
				fc.constantFrom<"en" | "ko">("en", "ko"),
				async (len, locale) => {
					resetMock();

					const transcript = "a".repeat(len);

					const result = await service.analyze({
						credentials: DUMMY_CREDENTIALS,
						region: DUMMY_REGION,
						modelId: DUMMY_MODEL_ID,
						transcript,
						locale,
					});

					// (1) SDK `send`가 정확히 1회 호출되었다(= 요청이 개시되었다).
					const sendCalls = bedrockMock.commandCalls(InvokeModelCommand);
					expect(sendCalls.length).toBe(1);

					// (2) 주입한 정상 응답 페이로드에서 추출된 텍스트가 반환된다.
					expect(result).toBe("summary");
				},
			),
			{ numRuns: 50 },
		);
	});

	// -------------------------------------------------------------------------
	// (b) over-limit: length ∈ (MAX_TRANSCRIPT_LENGTH, MAX_TRANSCRIPT_LENGTH + 20_000]
	//     → send NOT called, throws
	// -------------------------------------------------------------------------
	test("transcript.length > MAX_TRANSCRIPT_LENGTH → send 미호출 + TRANSCRIPT_TOO_LONG throw", async () => {
		const service = new BedrockService(realClientFactory);

		await fc.assert(
			fc.asyncProperty(
				// 경계를 살짝 넘기는 값부터 여유를 둔 상한까지 고르게 샘플.
				// 상한은 실행 시간을 적정하게 유지하면서도 경계를 충분히 벗어나도록 +20_000 여유.
				fc.integer({
					min: MAX_TRANSCRIPT_LENGTH + 1,
					max: MAX_TRANSCRIPT_LENGTH + 20_000,
				}),
				fc.constantFrom<"en" | "ko">("en", "ko"),
				async (len, locale) => {
					resetMock();

					const transcript = "a".repeat(len);

					// analyze 호출은 반드시 TranscribeError("TRANSCRIPT_TOO_LONG")로 거부되어야 한다.
					let caught: unknown = undefined;
					try {
						await service.analyze({
							credentials: DUMMY_CREDENTIALS,
							region: DUMMY_REGION,
							modelId: DUMMY_MODEL_ID,
							transcript,
							locale,
						});
					} catch (err) {
						caught = err;
					}

					expect(caught).toBeInstanceOf(TranscribeError);
					expect((caught as TranscribeError).code).toBe(
						"TRANSCRIPT_TOO_LONG",
					);

					// SDK `send`는 개시되지 않았어야 한다(Requirement 6.5: "분석 요청을 개시하지 않고").
					const sendCalls = bedrockMock.commandCalls(InvokeModelCommand);
					expect(sendCalls.length).toBe(0);
				},
			),
			{ numRuns: 50 },
		);
	});

	// -------------------------------------------------------------------------
	// (c) 경계값: length === MAX_TRANSCRIPT_LENGTH (포함 경계)
	//     Property 10 의 "<= MAX_TRANSCRIPT_LENGTH 이면 호출" 을 명시적 예시로 확인한다.
	// -------------------------------------------------------------------------
	test("경계: transcript.length === MAX_TRANSCRIPT_LENGTH → send가 호출된다", async () => {
		resetMock();
		const service = new BedrockService(realClientFactory);

		const transcript = "a".repeat(MAX_TRANSCRIPT_LENGTH);

		const result = await service.analyze({
			credentials: DUMMY_CREDENTIALS,
			region: DUMMY_REGION,
			modelId: DUMMY_MODEL_ID,
			transcript,
			locale: "en",
		});

		expect(bedrockMock.commandCalls(InvokeModelCommand).length).toBe(1);
		expect(result).toBe("summary");
	});

	// -------------------------------------------------------------------------
	// (d) 경계값: length === MAX_TRANSCRIPT_LENGTH + 1 (미포함 경계)
	//     "length > MAX_TRANSCRIPT_LENGTH 이면 미호출 + throw" 를 명시적 예시로 확인한다.
	// -------------------------------------------------------------------------
	test("경계: transcript.length === MAX_TRANSCRIPT_LENGTH + 1 → send 미호출 + throw", async () => {
		resetMock();
		const service = new BedrockService(realClientFactory);

		const transcript = "a".repeat(MAX_TRANSCRIPT_LENGTH + 1);

		let caught: unknown = undefined;
		try {
			await service.analyze({
				credentials: DUMMY_CREDENTIALS,
				region: DUMMY_REGION,
				modelId: DUMMY_MODEL_ID,
				transcript,
				locale: "ko",
			});
		} catch (err) {
			caught = err;
		}

		expect(caught).toBeInstanceOf(TranscribeError);
		expect((caught as TranscribeError).code).toBe("TRANSCRIPT_TOO_LONG");
		expect(bedrockMock.commandCalls(InvokeModelCommand).length).toBe(0);
	});
});
