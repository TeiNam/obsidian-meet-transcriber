/**
 * AWS Bedrock Runtime을 호출해 전사 본문을 AI 분석하는 서비스.
 *
 * 설계 문서(design.md) §7 "BedrockService (AI 분석)"에 정의된 책임을 구현한다.
 * 테스트 가능성을 위해 `BedrockRuntimeClient` 인스턴스를 직접 생성하지 않고,
 * 생성자에 주입된 `clientFactory`를 통해 필요 시점에 클라이언트를 얻는다.
 *
 * 관련 요구사항:
 * - 6.4: 자격 증명/모델과 사전 정의 프롬프트로 Bedrock 요청 개시
 * - 6.5: 본문 길이 100,000자 초과 시 요청 미개시(SDK `send` 호출 금지)
 * - 6.11, 6.12: 30초 타임아웃(`AbortController.abort()`) 및 본문 불변 보장
 * - 6.13: 인증/권한 오류 → `AWS_AUTH`
 * - 6.14: 리전 모델 미지원 → `AWS_MODEL_UNAVAILABLE`
 * - 6.15: 네트워크/기타 오류 → `AWS_NETWORK`
 *
 * 보안 및 로깅(Requirements 9.6):
 * - 자격 증명, 프롬프트 본문, 응답 본문은 절대 로그에 기록하지 않는다.
 * - 모든 로깅은 `console.error`로만 수행하며, 에러 객체의 이름/코드 수준 정보만 남긴다.
 */

import {
	BedrockRuntimeClient,
	InvokeModelCommand,
} from "@aws-sdk/client-bedrock-runtime";
import { TranscribeError } from "../types/errors";
import type { AwsCredentials } from "../types/settings";
import type { SupportedLocale } from "../i18n";

/**
 * 본문 길이 한계. 초과 시 요청을 개시하지 않는다(Requirements 6.5).
 *
 * design.md §7 "본문 길이 100,000자 초과" 조건을 단일 상수로 추출하여,
 * 속성 테스트(Property 10)와 동일한 경계를 참조하도록 한다.
 */
const MAX_TRANSCRIPT_LENGTH = 100_000;

/**
 * 분석 요청 기본 타임아웃(밀리초). Requirements 6.11의 "30초" 기준.
 */
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Claude 3 계열 요청 본문의 `max_tokens` 값.
 *
 * design.md §7의 "Claude 3 계열 요청 본문 구성" 예시에 정의된 값.
 * 프롬프트가 요구하는 요약/키워드/실행 항목을 여유 있게 담기 위한 상한이다.
 */
const CLAUDE_MAX_TOKENS = 4000;

/**
 * Anthropic on Bedrock 요청 스키마 버전 식별자.
 *
 * Bedrock의 Claude 3 계열 모델은 요청 본문에서 이 버전 문자열을 필수로 요구한다.
 * (참고: Bedrock 모델 페이지의 "Anthropic Claude API Schema")
 */
const ANTHROPIC_VERSION = "bedrock-2023-05-31";

/**
 * `BedrockService.analyze`에 전달되는 매개변수 구조체.
 *
 * 매개변수를 객체로 받는 이유: 호출부에서 이름 붙은 인자로 의미를 드러내고,
 * 향후 `maxTokens`/`temperature` 등 옵션이 추가되더라도 기존 호출부를 깨지 않기 위함이다.
 */
export interface AnalyzeParams {
	/** AWS IAM access/secret key. `clientFactory`로 전달되어 SDK 서명에 사용된다. */
	credentials: AwsCredentials;
	/** Bedrock Runtime 엔드포인트를 식별할 AWS 리전(예: `"us-east-1"`). */
	region: string;
	/** 호출할 파운데이션 모델 식별자(예: `"anthropic.claude-3-sonnet-20240229-v1:0"`). */
	modelId: string;
	/** 분석 대상 전사 본문. 길이 100,000자 초과 시 `TRANSCRIPT_TOO_LONG`. */
	transcript: string;
	/** 요청 타임아웃(밀리초). 생략 시 `DEFAULT_TIMEOUT_MS` 사용(Requirements 6.11). */
	timeoutMs?: number;
	/** 분석 프롬프트 언어를 결정하는 UI 로케일(영어/한국어). */
	locale: SupportedLocale;
}

/**
 * `BedrockRuntimeClient`를 지연 생성하기 위한 팩토리 함수 타입.
 *
 * 테스트에서 `aws-sdk-client-mock`의 모의 클라이언트를 주입하거나, 프로덕션에서
 * 자격 증명/리전을 반영한 실제 클라이언트를 생성하기 위한 DI 경로이다.
 */
export type BedrockClientFactory = (
	credentials: AwsCredentials,
	region: string,
) => BedrockRuntimeClient;

/**
 * locale별 분석 프롬프트.
 *
 * design.md §7 "분석 프롬프트(locale별)"에서 확정된 고정 문자열을 사용한다.
 * 수정 시 설계 문서와 동기화되어야 한다(요약 품질 영향 요인).
 */
const PROMPT_BY_LOCALE: Record<SupportedLocale, string> = {
	en:
		"The following is a meeting/lecture transcript. Summarize in concise markdown: " +
		"(1) key summary (3-5 sentences), (2) main keywords (5-10), (3) action items (if any).",
	ko:
		"다음은 회의/강의 전사 내용입니다. 간결한 마크다운으로 정리해 주세요: " +
		"(1) 핵심 요약(3~5문장), (2) 주요 키워드(5~10개), (3) 실행 항목(있다면).",
};

/**
 * 주어진 locale과 전사 본문을 결합해 Claude 3에 전달할 user 메시지를 구성한다.
 *
 * 구분선(`--- transcript start ---`, `--- transcript end ---`)은 모델이 지시문과
 * 전사 본문을 명확히 구분하도록 돕는다(design.md §7).
 */
function buildPrompt(locale: SupportedLocale, transcript: string): string {
	const instruction = PROMPT_BY_LOCALE[locale];
	return `${instruction}\n\n--- transcript start ---\n${transcript}\n--- transcript end ---`;
}

/**
 * AWS SDK 에러의 "이름"을 안전하게 추출한다.
 *
 * SDK v3는 예외 객체의 `name` 속성(예: `"AccessDeniedException"`)으로 분기 식별을 권장한다.
 * `err`가 `Error`가 아닌 값(문자열, 숫자 등)으로 throw 된 경우에도 안전하게 동작하도록
 * `unknown`을 수용한 뒤 `typeof` 검사를 거친다.
 */
function getErrorName(err: unknown): string {
	if (err && typeof err === "object" && "name" in err) {
		const name = (err as { name?: unknown }).name;
		if (typeof name === "string") return name;
	}
	return "";
}

/**
 * AbortController가 발생시키는 "AbortError" 계열 예외인지 판별한다.
 *
 * 일부 런타임은 `DOMException("...", "AbortError")`로, 다른 런타임은 `name === "AbortError"`인
 * 일반 Error로 전달하므로 양쪽을 모두 수용한다.
 */
function isAbortError(err: unknown): boolean {
	return getErrorName(err) === "AbortError";
}

/**
 * InvokeModel 응답의 바이너리 본문에서 Claude 3 어시스턴트 응답 텍스트를 추출한다.
 *
 * Claude 3 on Bedrock의 응답 스키마:
 * ```
 * {
 *   "id": "...",
 *   "type": "message",
 *   "role": "assistant",
 *   "content": [{ "type": "text", "text": "<answer>" }, ...],
 *   ...
 * }
 * ```
 *
 * 스키마가 어긋나거나 텍스트 블록이 없으면 빈 문자열을 반환한다. 이 경우 호출부에서
 * 빈 분석 결과를 사용자에게 그대로 전달하지 않고 UI가 적절히 처리해야 한다.
 */
function extractClaudeText(body: Uint8Array): string {
	// Uint8Array → UTF-8 디코드.
	// 응답 본문이 항상 JSON인 것은 아니므로 JSON 파싱은 호출부에서 try/catch로 감싼다.
	const json = new TextDecoder().decode(body);
	const parsed = JSON.parse(json) as {
		content?: Array<{ type?: string; text?: string }>;
	};

	if (!Array.isArray(parsed.content)) return "";

	// Claude 3의 `content`는 멀티모달 지원을 위한 배열 구조.
	// text 블록만 순서대로 이어 붙여 하나의 분석 결과 문자열을 반환한다.
	return parsed.content
		.filter((block) => block?.type === "text" && typeof block.text === "string")
		.map((block) => block.text as string)
		.join("\n");
}

/**
 * Bedrock AI 분석 서비스.
 *
 * 생명주기 규칙:
 * - `BedrockRuntimeClient`는 `analyze()` 호출 시점에만 `clientFactory`로 생성되고
 *   해당 호출 종료 시 GC 대상이 된다(자격 증명 변경 반영 및 테스트 주입 용이성).
 * - 동시 1건만 허용되어야 한다는 상위 요구(7.2)는 호출부(Plugin)가 관리한다.
 */
export class BedrockService {
	/**
	 * @param clientFactory `analyze` 호출 시 `credentials`/`region`을 적용해
	 *                      `BedrockRuntimeClient`를 생성하는 DI용 팩토리.
	 */
	constructor(private readonly clientFactory: BedrockClientFactory) {}

	/**
	 * 전사 본문을 Claude 3 모델로 분석하여 마크다운 요약 문자열을 반환한다.
	 *
	 * 실행 순서:
	 * 1. `transcript.length > 100_000` 사전 검증 → 초과 시 `TRANSCRIPT_TOO_LONG` 즉시 throw.
	 *    이 단계에서 SDK `send`가 호출되지 않음이 Property 10에 의해 검증된다.
	 * 2. `clientFactory`로 `BedrockRuntimeClient` 생성.
	 * 3. locale별 프롬프트 + 전사 본문을 결합해 Anthropic 요청 본문 JSON 구성.
	 * 4. `AbortController`로 `timeoutMs`(기본 30초) 타임아웃을 강제.
	 * 5. `InvokeModelCommand`를 `send`에 `abortSignal`과 함께 전달.
	 * 6. 응답 본문(`Uint8Array`)을 UTF-8로 디코드하고 Claude 3 스키마에서 텍스트 추출.
	 * 7. 예외는 SDK 에러 `name`을 기준으로 `TranscribeError`로 변환하여 throw.
	 *
	 * @throws {TranscribeError} code별 의미:
	 *   - `"TRANSCRIPT_TOO_LONG"`: 본문 길이 초과(Requirements 6.5).
	 *   - `"AWS_AUTH"`: 자격 증명/권한 문제(Requirements 6.13).
	 *   - `"AWS_MODEL_UNAVAILABLE"`: 리전/모델 조합이 제공되지 않는 경우(Requirements 6.14).
	 *   - `"AWS_NETWORK"`: 타임아웃, 네트워크 오류, 스키마 오류 등 그 외 모든 실패
	 *                      (Requirements 6.11, 6.12, 6.15).
	 */
	async analyze(params: AnalyzeParams): Promise<string> {
		const {
			credentials,
			region,
			modelId,
			transcript,
			timeoutMs = DEFAULT_TIMEOUT_MS,
			locale,
		} = params;

		// 1) 사전 길이 검증: SDK 호출 전에 즉시 차단한다(Requirements 6.5, Property 10).
		//    이 throw는 `clientFactory`와 `send` 호출 이전에 수행되어야 한다.
		if (transcript.length > MAX_TRANSCRIPT_LENGTH) {
			throw new TranscribeError(
				`Transcript length ${transcript.length} exceeds the ${MAX_TRANSCRIPT_LENGTH}-character limit.`,
				"TRANSCRIPT_TOO_LONG",
			);
		}

		// 2) DI 팩토리를 통해 클라이언트 생성. 팩토리 내부 예외는 아래 catch에서 AWS_NETWORK로 매핑된다.
		const client = this.clientFactory(credentials, region);

		// 3) Claude 3 요청 본문 구성. `body`는 `Uint8Array`여야 하므로 JSON 직렬화 후 UTF-8 인코딩한다.
		const requestJson = JSON.stringify({
			anthropic_version: ANTHROPIC_VERSION,
			max_tokens: CLAUDE_MAX_TOKENS,
			messages: [
				{
					role: "user",
					content: buildPrompt(locale, transcript),
				},
			],
		});
		const bodyBytes = new TextEncoder().encode(requestJson);

		const command = new InvokeModelCommand({
			modelId,
			contentType: "application/json",
			accept: "application/json",
			body: bodyBytes,
		});

		// 4) AbortController로 타임아웃 강제. `timedOut` 플래그로 abort 원인을 구분한다.
		const controller = new AbortController();
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			controller.abort();
		}, timeoutMs);

		try {
			// 5) SDK v3의 두 번째 인자로 `abortSignal` 전달.
			//    HTTP 핸들러가 이 신호를 수신하면 in-flight 요청을 중단한다.
			const response = await client.send(command, {
				abortSignal: controller.signal,
			});

			// 6) 응답 파싱. `body`는 `Uint8ArrayBlobAdapter`지만 Uint8Array와 호환된다.
			//    JSON 파싱 실패 시 아래 catch에서 AWS_NETWORK로 승격된다.
			return extractClaudeText(response.body);
		} catch (err) {
			// 7) 에러 분기. `TranscribeError`는 그대로 재전파하여 코드 정보를 보존한다.
			if (err instanceof TranscribeError) {
				throw err;
			}

			// 타임아웃: setTimeout이 발화한 abort인 경우 명시적으로 구분된 메시지를 사용한다.
			//           사용자 취소 등 다른 경로의 AbortError도 동일하게 AWS_NETWORK로 처리한다.
			if (isAbortError(err)) {
				const reason = timedOut
					? `Bedrock request timed out after ${timeoutMs} ms.`
					: "Bedrock request was aborted.";
				// 민감 정보 없이 사유 수준만 로그로 남긴다(Requirements 9.6).
				console.error("[BedrockService] aborted:", reason);
				throw new TranscribeError(reason, "AWS_NETWORK", err);
			}

			const name = getErrorName(err);

			// 인증/권한 오류(Requirements 6.13).
			if (name === "AccessDeniedException" || name === "UnrecognizedClientException") {
				console.error("[BedrockService] auth error:", name);
				throw new TranscribeError(
					"Bedrock authentication failed.",
					"AWS_AUTH",
					err,
				);
			}

			// 모델/리전 조합 미지원(Requirements 6.14).
			if (name === "ValidationException") {
				console.error("[BedrockService] model unavailable:", name);
				throw new TranscribeError(
					"Bedrock model is not available in the configured region.",
					"AWS_MODEL_UNAVAILABLE",
					err,
				);
			}

			// 그 외: 네트워크/서비스 오류, JSON 파싱 실패 등 일괄 처리(Requirements 6.15).
			console.error("[BedrockService] network/unknown error:", name || "unknown");
			throw new TranscribeError(
				"Bedrock request failed.",
				"AWS_NETWORK",
				err,
			);
		} finally {
			// 타임아웃 타이머가 아직 유효하다면 해제하여 이벤트 루프 보류를 막는다.
			clearTimeout(timer);
		}
	}
}
