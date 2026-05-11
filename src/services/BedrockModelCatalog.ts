/**
 * `BedrockModelCatalog` — AWS Bedrock 컨트롤 플레인에서 호출 가능한 모델 목록을 조회한다.
 *
 * 전사 분석은 `BedrockRuntimeClient.InvokeModel` 이므로, 여기서 조회한 `modelId` 는
 * 그대로 Runtime 호출에 사용할 수 있어야 한다. 두 종류의 식별자를 병합해 반환한다:
 *
 * 1. **Foundation models** (`ListFoundationModels`): `modelId` 예) `anthropic.claude-3-sonnet-20240229-v1:0`.
 *    - `ON_DEMAND` inference type 이 지원되는 모델만 포함해, 순수 `modelId` 로 InvokeModel 이 가능한 경우만 노출.
 *    - 출력 modality 에 `TEXT` 가 포함된 모델만 포함(이미지/임베딩 전용 모델 제외).
 * 2. **Inference profiles** (`ListInferenceProfiles`): `inferenceProfileId` 예) `global.anthropic.claude-haiku-4-5-20251001-v1:0`.
 *    - Claude 4.5 계열처럼 ON_DEMAND 가 아닌 모델은 cross-Region inference profile 을 통해서만 호출 가능하다.
 *    - `STATUS === "ACTIVE"` 인 프로필만 포함.
 *
 * ## 의존성
 * - `@aws-sdk/client-bedrock` (컨트롤 플레인). runtime 패키지(`@aws-sdk/client-bedrock-runtime`)와 별개.
 *
 * ## 권한
 * 호출하려는 IAM 주체는 다음 권한이 필요하다:
 * - `bedrock:ListFoundationModels`
 * - `bedrock:ListInferenceProfiles`
 *
 * 권한이 없으면 `AccessDeniedException` 가 발생하며, 본 서비스는 빈 배열이 아닌 예외를 throw 해
 * 상위 계층이 적절한 Notice 를 표시하도록 한다.
 *
 * ## 테스트
 * SDK 클라이언트는 생성자 주입된 `clientFactory` 로 생성되므로 `aws-sdk-client-mock` 으로 대체 가능.
 */

import {
	BedrockClient,
	ListFoundationModelsCommand,
	ListInferenceProfilesCommand,
	type FoundationModelSummary,
	type InferenceProfileSummary,
} from "@aws-sdk/client-bedrock";

import { TranscribeError } from "../types/errors";
import type { AwsCredentials } from "../types/settings";

/**
 * 목록 조회 시 사용할 AWS 자격 증명/리전 묶음.
 */
export interface ListModelsParams {
	credentials: AwsCredentials;
	region: string;
}

/**
 * 카탈로그 한 항목의 공개 형태. UI 드롭다운에서 `id` 를 값으로, `label`/`provider` 를 표시용으로 사용한다.
 */
export interface BedrockCatalogEntry {
	/** InvokeModel 에 그대로 전달할 수 있는 식별자(`modelId` 또는 `inferenceProfileId`). */
	id: string;
	/** UI 에 표시할 사람이 읽기 쉬운 이름. 없으면 `id` 를 그대로 사용. */
	label: string;
	/** 모델 제공자(예: `Anthropic`). 그룹 라벨링에 사용할 수 있다. */
	provider: string;
	/** `foundation-model` 또는 `inference-profile` — UI 에서 아이콘/접두사 구분용. */
	kind: "foundation-model" | "inference-profile";
}

/**
 * `BedrockClient` 팩토리 — 자격 증명/리전 반영 및 테스트 주입을 위한 DI 경로.
 */
export type BedrockCatalogClientFactory = (
	credentials: AwsCredentials,
	region: string,
) => BedrockClient;

/**
 * 기본 클라이언트 팩토리. 런타임에서는 이 팩토리를 사용한다.
 */
export function defaultBedrockClientFactory(
	credentials: AwsCredentials,
	region: string,
): BedrockClient {
	return new BedrockClient({
		region,
		credentials: {
			accessKeyId: credentials.accessKeyId,
			secretAccessKey: credentials.secretAccessKey,
		},
	});
}

export class BedrockModelCatalog {
	constructor(
		private readonly clientFactory: BedrockCatalogClientFactory = defaultBedrockClientFactory,
	) {}

	/**
	 * 주어진 자격 증명/리전으로 호출 가능한 모델 카탈로그를 조회한다.
	 *
	 * 실행 순서:
	 * 1. `ListFoundationModelsCommand` 호출 — ON_DEMAND & TEXT 출력 모델만 필터링.
	 * 2. `ListInferenceProfilesCommand` 호출 — ACTIVE 프로필만 필터링.
	 * 3. 두 목록을 병합. 같은 모델의 프로필 우선(호출 안정성 높음).
	 * 4. 제공자(provider) 알파벳 → id 알파벳 순으로 정렬.
	 *
	 * 에러 매핑:
	 * - `AccessDenied*` / `UnrecognizedClient*` → `AWS_AUTH`
	 * - 그 외 → `AWS_NETWORK`
	 *
	 * 두 API 중 하나가 실패해도 다른 하나의 결과는 유지한다. 단 둘 다 실패하면 throw 한다.
	 */
	async listInvokableModels(
		params: ListModelsParams,
	): Promise<BedrockCatalogEntry[]> {
		const client = this.clientFactory(params.credentials, params.region);

		let foundations: FoundationModelSummary[] = [];
		let profiles: InferenceProfileSummary[] = [];
		let foundationErr: unknown = null;
		let profileErr: unknown = null;

		try {
			const res = await client.send(new ListFoundationModelsCommand({}));
			foundations = res.modelSummaries ?? [];
		} catch (err) {
			foundationErr = err;
			console.error("[BedrockModelCatalog] ListFoundationModels failed:", getErrorName(err));
		}

		try {
			const res = await client.send(new ListInferenceProfilesCommand({}));
			profiles = res.inferenceProfileSummaries ?? [];
		} catch (err) {
			profileErr = err;
			console.error("[BedrockModelCatalog] ListInferenceProfiles failed:", getErrorName(err));
		}

		// 둘 다 실패한 경우에만 throw — 부분 실패 시 한쪽 결과만으로 UI 를 채울 수 있게 한다.
		if (foundationErr !== null && profileErr !== null) {
			throw mapErrorToTranscribeError(foundationErr);
		}

		const entries: BedrockCatalogEntry[] = [];

		// 1) Foundation models — ON_DEMAND 추론 지원 + TEXT 출력 지원만.
		for (const m of foundations) {
			if (!m.modelId) continue;
			const supportsOnDemand = (m.inferenceTypesSupported ?? []).includes("ON_DEMAND");
			const outputsText = (m.outputModalities ?? []).includes("TEXT");
			if (!supportsOnDemand || !outputsText) continue;
			entries.push({
				id: m.modelId,
				label: m.modelName ?? m.modelId,
				provider: m.providerName ?? "Unknown",
				kind: "foundation-model",
			});
		}

		// 2) Inference profiles — ACTIVE 만.
		for (const p of profiles) {
			if (!p.inferenceProfileId) continue;
			if (p.status && p.status !== "ACTIVE") continue;
			// 프로필은 `global.anthropic.claude-*` 같은 형태. provider 는 id 에서 유추.
			const provider = inferProviderFromId(p.inferenceProfileId);
			entries.push({
				id: p.inferenceProfileId,
				label: p.inferenceProfileName ?? p.inferenceProfileId,
				provider,
				kind: "inference-profile",
			});
		}

		// 정렬: provider 알파벳 → id 알파벳.
		entries.sort((a, b) => {
			if (a.provider !== b.provider) return a.provider.localeCompare(b.provider);
			return a.id.localeCompare(b.id);
		});

		return entries;
	}
}

// -----------------------------------------------------------------------------
// 내부 헬퍼
// -----------------------------------------------------------------------------

function getErrorName(err: unknown): string {
	if (err && typeof err === "object" && "name" in err) {
		const name = (err as { name?: unknown }).name;
		if (typeof name === "string") return name;
	}
	return "";
}

/**
 * SDK 예외를 `TranscribeError` 로 래핑한다. 호출부(SettingTab)는 code 로 Notice 분기.
 */
function mapErrorToTranscribeError(err: unknown): TranscribeError {
	const name = getErrorName(err);
	if (
		name === "AccessDeniedException" ||
		name === "UnrecognizedClientException" ||
		name === "ExpiredTokenException"
	) {
		return new TranscribeError(
			"Bedrock authentication failed while listing models.",
			"AWS_AUTH",
			err,
		);
	}
	return new TranscribeError(
		"Failed to list Bedrock models.",
		"AWS_NETWORK",
		err,
	);
}

/**
 * inference profile id 에서 provider 이름을 유추한다.
 *
 * 예) `global.anthropic.claude-haiku-4-5-20251001-v1:0` → `Anthropic`
 *    `us.amazon.nova-lite-v1:0` → `Amazon`
 */
function inferProviderFromId(id: string): string {
	// 첫 번째 점 이후의 세그먼트를 본다(첫 세그먼트는 `global`/`us`/`eu`/`apac` 지역 접두사).
	const segs = id.split(".");
	// 지역 접두사가 있는 inference profile: segs = [region, provider, model, ...]
	// 프로필이 아닌 foundation-model id 는 보통 [provider, model, ...]
	const providerSeg =
		segs.length >= 3 && isRegionPrefix(segs[0]) ? segs[1] : segs[0];
	if (!providerSeg) return "Unknown";
	return providerSeg.charAt(0).toUpperCase() + providerSeg.slice(1);
}

function isRegionPrefix(seg: string): boolean {
	return seg === "global" || seg === "us" || seg === "eu" || seg === "apac";
}
