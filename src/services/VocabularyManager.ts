/**
 * `VocabularyManager` — 설정에 입력된 단어 목록을 AWS Transcribe Custom Vocabulary 로
 * 자동 생성/업데이트하는 서비스.
 *
 * ## 동작 흐름
 * 1. 사용자가 설정 탭에서 단어 목록을 저장하면 `syncVocabulary()` 호출.
 * 2. `GetVocabulary` 로 기존 Vocabulary 존재 여부 확인.
 *    - 없으면 `CreateVocabulary` 로 새로 생성.
 *    - 있으면 `UpdateVocabulary` 로 갱신.
 * 3. Vocabulary 이름은 `obsidian-transcribe-{languageCode}` 형태로 고정.
 *    (리전/언어 조합당 하나만 유지)
 * 4. 생성/갱신 후 상태가 `READY` 가 될 때까지 폴링(최대 60초, 3초 간격).
 * 5. 전사 시작 시 `buildVocabName()` 으로 현재 언어의 이름을 반환.
 *
 * ## Vocabulary 형식
 * AWS Transcribe Custom Vocabulary 는 "Phrases" 형태를 사용한다.
 * 각 단어/구문을 한 줄에 하나씩 나열하면 된다.
 *
 * ## 필요 IAM 권한
 * - `transcribe:CreateVocabulary`
 * - `transcribe:UpdateVocabulary`
 * - `transcribe:GetVocabulary`
 * - `transcribe:DeleteVocabulary`
 */

import {
	TranscribeClient,
	CreateVocabularyCommand,
	UpdateVocabularyCommand,
	GetVocabularyCommand,
	DeleteVocabularyCommand,
	type VocabularyState,
} from "@aws-sdk/client-transcribe";

import { TranscribeError } from "../types/errors";
import type { AwsCredentials, LanguageCode } from "../types/settings";

/**
 * Vocabulary 이름 접두사. 언어 코드를 붙여 최종 이름을 구성한다.
 * 예: `obsidian-transcribe-ko-KR`
 */
const VOCAB_NAME_PREFIX = "obsidian-transcribe";

/** 폴링 간격(ms). */
const POLL_INTERVAL_MS = 3_000;

/** 폴링 최대 대기 시간(ms). */
const POLL_TIMEOUT_MS = 60_000;

export interface VocabSyncParams {
	credentials: AwsCredentials;
	region: string;
	languageCode: LanguageCode;
	/** 사용자가 설정에 입력한 단어 목록(한 줄에 하나). 빈 문자열이면 Vocabulary 삭제. */
	phrases: string;
}

export interface VocabSyncResult {
	/** 생성/갱신된 Vocabulary 이름. 삭제된 경우 빈 문자열. */
	vocabularyName: string;
	/** 최종 상태. */
	status: "READY" | "DELETED" | "FAILED" | "PENDING";
}

/**
 * `TranscribeClient` 팩토리 — DI 용.
 */
export type TranscribeControlClientFactory = (
	credentials: AwsCredentials,
	region: string,
) => TranscribeClient;

function defaultClientFactory(
	credentials: AwsCredentials,
	region: string,
): TranscribeClient {
	return new TranscribeClient({
		region,
		credentials: {
			accessKeyId: credentials.accessKeyId,
			secretAccessKey: credentials.secretAccessKey,
		},
	});
}

export class VocabularyManager {
	constructor(
		private readonly clientFactory: TranscribeControlClientFactory = defaultClientFactory,
	) {}

	/**
	 * 설정의 단어 목록을 AWS Custom Vocabulary 로 동기화한다.
	 *
	 * - phrases 가 비어 있으면 기존 Vocabulary 를 삭제한다.
	 * - phrases 가 있으면 생성 또는 업데이트 후 READY 상태까지 폴링한다.
	 *
	 * @returns 동기화 결과. UI 에서 상태 표시에 사용.
	 * @throws {TranscribeError} 인증 실패 또는 네트워크 오류 시.
	 */
	async syncVocabulary(params: VocabSyncParams): Promise<VocabSyncResult> {
		const { credentials, region, languageCode, phrases } = params;
		const client = this.clientFactory(credentials, region);
		const vocabName = this.buildVocabName(languageCode);

		// 단어 목록 파싱: 빈 줄/공백 줄 제거, 중복 제거.
		const lines = phrases
			.split("\n")
			.map((l) => l.trim())
			.filter((l) => l.length > 0);
		const uniquePhrases = [...new Set(lines)];

		// 단어가 없으면 기존 Vocabulary 삭제 시도.
		if (uniquePhrases.length === 0) {
			await this.tryDelete(client, vocabName);
			return { vocabularyName: "", status: "DELETED" };
		}

		// 기존 Vocabulary 존재 여부 확인.
		const exists = await this.vocabularyExists(client, vocabName);

		try {
			if (exists) {
				await client.send(
					new UpdateVocabularyCommand({
						VocabularyName: vocabName,
						LanguageCode: languageCode,
						Phrases: uniquePhrases,
					}),
				);
			} else {
				await client.send(
					new CreateVocabularyCommand({
						VocabularyName: vocabName,
						LanguageCode: languageCode,
						Phrases: uniquePhrases,
					}),
				);
			}
		} catch (err) {
			throw this.mapError(err);
		}

		// READY 상태까지 폴링.
		const finalStatus = await this.pollUntilReady(client, vocabName);
		return { vocabularyName: vocabName, status: finalStatus };
	}

	/**
	 * 현재 언어에 해당하는 Vocabulary 이름을 반환한다.
	 * 실제 존재 여부는 확인하지 않는다 — 전사 시작 시 AWS 가 검증한다.
	 */
	buildVocabName(languageCode: LanguageCode): string {
		return `${VOCAB_NAME_PREFIX}-${languageCode}`;
	}

	// ─────────────────────────────────────────────────────────────────────────

	private async vocabularyExists(
		client: TranscribeClient,
		name: string,
	): Promise<boolean> {
		try {
			await client.send(new GetVocabularyCommand({ VocabularyName: name }));
			return true;
		} catch (err) {
			const errName = getErrorName(err);
			if (errName === "BadRequestException" || errName === "NotFoundException") {
				return false;
			}
			throw this.mapError(err);
		}
	}

	private async tryDelete(
		client: TranscribeClient,
		name: string,
	): Promise<void> {
		try {
			await client.send(new DeleteVocabularyCommand({ VocabularyName: name }));
		} catch (err) {
			const errName = getErrorName(err);
			// 이미 없으면 무시.
			if (errName === "BadRequestException" || errName === "NotFoundException") {
				return;
			}
			throw this.mapError(err);
		}
	}

	private async pollUntilReady(
		client: TranscribeClient,
		name: string,
	): Promise<"READY" | "FAILED" | "PENDING"> {
		const deadline = Date.now() + POLL_TIMEOUT_MS;

		while (Date.now() < deadline) {
			await this.delay(POLL_INTERVAL_MS);
			try {
				const res = await client.send(
					new GetVocabularyCommand({ VocabularyName: name }),
				);
				const state = res.VocabularyState as VocabularyState | undefined;
				if (state === "READY") return "READY";
				if (state === "FAILED") return "FAILED";
				// PENDING — 계속 폴링.
			} catch (err) {
				console.error("[VocabularyManager] poll error:", getErrorName(err));
				return "FAILED";
			}
		}
		return "PENDING";
	}

	private mapError(err: unknown): TranscribeError {
		const name = getErrorName(err);
		if (
			name === "AccessDeniedException" ||
			name === "UnrecognizedClientException"
		) {
			return new TranscribeError(
				"AWS authentication failed while managing vocabulary.",
				"AWS_AUTH",
				err,
			);
		}
		return new TranscribeError(
			"Failed to manage Transcribe vocabulary.",
			"AWS_NETWORK",
			err,
		);
	}

	private delay(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}
}

function getErrorName(err: unknown): string {
	if (err && typeof err === "object" && "name" in err) {
		const name = (err as { name?: unknown }).name;
		if (typeof name === "string") return name;
	}
	return "";
}
