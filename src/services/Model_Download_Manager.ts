/**
 * `Model_Download_Manager` — Hugging Face 에서 로컬 Whisper 모델 가중치 파일을
 * 다운로드하고, 진행률 통지, SHA-256 무결성 검증, AbortController 기반 취소,
 * 디스크 공간 부족 감지를 담당하는 서비스.
 *
 * ## 책임
 * - 사용자 동의 후 호출되는 단일 진입점 `download(entry, modelFolder, callbacks)`.
 * - 디렉터리 자동 생성 → 스트리밍 fetch → 청크 단위 SHA-256 누적 + 디스크 쓰기 →
 *   완료 시 검증 → 검증 통과 시 `onCompleted(record)` / 실패 시 부분 파일 삭제 +
 *   `onError(code)`.
 * - 1 초 주기로 `statfs` 를 polling 하여 free disk < 100MB 시 자동 abort + `disk-low`.
 *
 * ## 의존성 추상화
 * - `HttpStreamClient`: `fetch` 기반 스트리밍 응답 어댑터. 프로덕션에서는
 *   `globalThis.fetch` 를 감싸고, 테스트에서는 in-memory fake 로 대체된다.
 * - `NodeFsLike`: `node:fs/promises` 의 mkdir/createWriteStream/unlink/statfs 만
 *   추상화한 인터페이스. 테스트에서는 인메모리 Map 기반 mock 으로 대체.
 *
 * ## 보안 / 로깅
 * - 모든 로그는 `console.error` 만 사용 (Requirement 11.1).
 * - 다운로드 URL 의 인증 토큰은 절대 로그에 기록하지 않는다 (Requirement 11.2).
 *   로그에는 도메인 + HTTP 상태 코드만 남긴다.
 * - `modelFolder` 외부 경로에는 파일을 쓰지 않는다 (Requirement 2.12).
 *
 * ## 매핑 (design §4.3, requirements.md)
 * - Requirement 2.4 ~ 2.10: 폴더 생성, 진행률, SHA-256 검증, 디스크/네트워크 오류,
 *   취소, 메타데이터 기록.
 * - Requirement 9.1.c: Hugging Face HTTPS 엔드포인트.
 * - Requirement 10.3: 다운로드 중 디스크 < 100MB 감지 시 abort.
 * - Requirement 11.1, 11.2: 로깅 채널 / 토큰 비기록.
 * - Requirement 12.5: HTTP / fs 추상화로 테스트 가능.
 */

import { createHash } from "node:crypto";
import * as nodeFs from "node:fs";
import * as nodeFsPromises from "node:fs/promises";

// -----------------------------------------------------------------------------
// 외부 인터페이스 (DI 진입점)
// -----------------------------------------------------------------------------

/**
 * 스트리밍 HTTP 응답 어댑터.
 *
 * - `body`: Uint8Array 청크의 async iterable. 호출자가 for-await 로 소비한다.
 * - `contentLength`: `Content-Length` 헤더가 있으면 정수 바이트 수, 없으면 `null`.
 * - `signal` 이 abort 되면 구현체는 in-flight 네트워크 요청을 중단해야 한다.
 *
 * 기본 구현(`createDefaultHttpStreamClient`) 은 `globalThis.fetch` 를 사용한다.
 */
export interface HttpStreamClient {
	fetchStream(
		url: string,
		signal: AbortSignal,
	): Promise<{
		readonly status: number;
		readonly contentLength: number | null;
		readonly body: AsyncIterable<Uint8Array>;
	}>;
}

/**
 * 파일 시스템 추상화.
 *
 * Obsidian Vault API 가 아닌 **운영체제 절대 경로** 위 파일 시스템을 다룬다
 * (`Model_Folder` 는 vault 외부 경로이므로 — Requirement 1.4).
 *
 * 기본 구현(`createDefaultNodeFs`) 은 `node:fs/promises` 와 `node:fs` 의
 * `createWriteStream` 을 사용한다. 테스트에서는 인메모리 mock 으로 대체.
 */
export interface NodeFsLike {
	mkdirRecursive(path: string): Promise<void>;
	createWriteStream(path: string): WritableFileLike;
	unlink(path: string): Promise<void>;
	/**
	 * 마운트의 사용 가능한 블록 수와 블록 크기를 반환한다.
	 * `freeBytes = bavail * bsize`.
	 */
	statfs(path: string): Promise<{ readonly bavail: number; readonly bsize: number }>;
}

/**
 * `NodeFsLike.createWriteStream` 이 반환하는 핸들.
 *
 * - `write(chunk)`: 청크를 디스크에 비동기로 기록한다. 디스크 쓰기 실패 시 reject.
 * - `close()`: 핸들을 정리한다. 성공/실패 모두에서 호출되며 멱등이어야 한다.
 */
export interface WritableFileLike {
	write(chunk: Uint8Array): Promise<void>;
	close(): Promise<void>;
}

// -----------------------------------------------------------------------------
// 도메인 타입 (콜백 / 에러)
// -----------------------------------------------------------------------------

/** 다운로드 진행률 1 회 통지. */
export interface DownloadProgress {
	readonly bytesDownloaded: number;
	readonly bytesTotal: number | null;
	readonly percent: number; // 0..100, contentLength 가 없으면 0 으로 고정
}

/** 다운로드 결과 메타데이터 — 검증 통과 시 PluginDataStore 의 `localModelInstalled` 에 기록된다. */
export interface Local_Model_Installation_Record {
	readonly modelId: string;
	readonly filePath: string;
	readonly sha256: string; // lowercase hex 64
	readonly installedAt: string; // ISO 8601
	readonly sizeBytes: number;
}

/**
 * 다운로드 오류 분류.
 *
 * - `network`: HTTP status ≠ 200 또는 fetch 자체 예외.
 * - `checksum`: SHA-256 불일치 (Requirement 2.6).
 * - `disk`: 디스크 쓰기 실패 (Requirement 2.7).
 * - `disk-low`: 다운로드 도중 free disk < 100MB 감지 (Requirement 10.3).
 * - `cancelled`: 사용자/UI 가 `controller.abort()` 호출 (Requirement 2.9).
 */
export type ModelDownloadError =
	| { readonly code: "network"; readonly httpStatus?: number; readonly detail?: string }
	| { readonly code: "checksum"; readonly expected: string; readonly actual: string }
	| { readonly code: "disk"; readonly detail?: string }
	| { readonly code: "disk-low"; readonly freeMb: number }
	| { readonly code: "cancelled" };

/** 다운로드 콜백 묶음. 모든 콜백은 동기적이며 try/catch 로 안전하게 호출된다. */
export interface ModelDownloadCallbacks {
	onProgress(progress: DownloadProgress): void;
	onCompleted(record: Local_Model_Installation_Record): void;
	onError(reason: ModelDownloadError): void;
}

// -----------------------------------------------------------------------------
// 정적 카탈로그 엔트리 타입
// -----------------------------------------------------------------------------

// TODO(task-14): `Local_Model_Catalog.ts` 가 작성되면 다음 import 로 교체:
//   import type { LocalModelCatalogEntry } from "./Local_Model_Catalog";
// 본 파일은 task 14 와 병렬로 작성되므로, 임시로 file-local 정의를 둔다.
// design §Data Models 3 의 형태와 1:1 일치한다.
export interface LocalModelCatalogEntry {
	readonly id: string;
	readonly displayName: string;
	readonly downloadUrl: string;
	readonly sha256: string; // lowercase hex 64
	readonly sizeMb: number;
	readonly transformersJsId: string;
}

// -----------------------------------------------------------------------------
// 옵션 / 상수
// -----------------------------------------------------------------------------

/** Requirement 10.3 의 임계치 — free disk 100MB. */
const DEFAULT_DISK_LOW_THRESHOLD_BYTES = 100 * 1024 * 1024;

/** Requirement 10.3 의 polling 주기 — 1초. */
const DEFAULT_STATFS_POLL_INTERVAL_MS = 1_000;

/**
 * 생성자 옵션. 프로덕션에서는 생략 가능하며 테스트에서 타이밍/임계값을 단축한다.
 */
export interface ModelDownloadManagerOptions {
	/** statfs 폴링 주기 (ms). 기본 1000. */
	statfsPollIntervalMs?: number;
	/** 디스크 부족 임계 바이트. 기본 100MB. */
	diskLowThresholdBytes?: number;
}

// -----------------------------------------------------------------------------
// 본체
// -----------------------------------------------------------------------------

export class Model_Download_Manager {
	private readonly statfsPollIntervalMs: number;
	private readonly diskLowThresholdBytes: number;

	constructor(
		private readonly http: HttpStreamClient,
		private readonly fs: NodeFsLike,
		options: ModelDownloadManagerOptions = {},
	) {
		this.statfsPollIntervalMs =
			options.statfsPollIntervalMs ?? DEFAULT_STATFS_POLL_INTERVAL_MS;
		this.diskLowThresholdBytes =
			options.diskLowThresholdBytes ?? DEFAULT_DISK_LOW_THRESHOLD_BYTES;
	}

	/**
	 * 단일 모델 파일 다운로드를 백그라운드로 시작한다.
	 *
	 * 본 메서드는 다운로드 완료를 await 하지 않고, 호출 측이 사용자 취소에 사용할
	 * `AbortController` 를 즉시 반환한다. 진행률 / 완료 / 오류는 모두 `callbacks`
	 * 를 통해서만 통지된다.
	 */
	download(
		entry: LocalModelCatalogEntry,
		modelFolder: string,
		callbacks: ModelDownloadCallbacks,
	): AbortController {
		const controller = new AbortController();
		// 비동기 본체를 시작하되, 호출자에게는 즉시 controller 를 돌려준다.
		void this.runDownload(entry, modelFolder, callbacks, controller);
		return controller;
	}

	private async runDownload(
		entry: LocalModelCatalogEntry,
		modelFolder: string,
		callbacks: ModelDownloadCallbacks,
		controller: AbortController,
	): Promise<void> {
		const filePath = joinPath(modelFolder, deriveFileName(entry));

		// 디스크 부족 polling 의 결과를 본 흐름으로 전달하기 위한 플래그.
		// abort 의 사유가 사용자 취소인지 디스크 부족인지 구분해야 한다 (Requirement 10.3 vs 2.9).
		let diskLowFreeBytes: number | null = null;
		const pollHandle = this.startDiskLowPolling(
			modelFolder,
			controller,
			(free) => {
				diskLowFreeBytes = free;
			},
		);

		let writeStream: WritableFileLike | null = null;
		let bytesDownloaded = 0;

		const closeWriteStreamSilently = async (): Promise<void> => {
			if (writeStream === null) return;
			try {
				await writeStream.close();
			} catch (err) {
				console.error(
					"[Model_Download_Manager] writeStream.close() failed:",
					err,
				);
			}
			writeStream = null;
		};

		const removePartialSilently = async (): Promise<void> => {
			try {
				await this.fs.unlink(filePath);
			} catch {
				// 부분 파일이 아직 생성되지 않은 케이스(폴더 생성/HTTP 단계 실패) 도 있으므로
				// unlink 실패는 무시한다 — 본 경로는 정리 best-effort 안전 그물망이다.
			}
		};

		try {
			// 1) 폴더 자동 생성 (Requirement 2.4).
			await this.fs.mkdirRecursive(modelFolder);

			// 2) 스트리밍 fetch (Requirement 12.5 추상화 의존).
			const { status, contentLength, body } = await this.http.fetchStream(
				entry.downloadUrl,
				controller.signal,
			);

			// 3) HTTP status ≠ 200 (Requirement 2.8).
			if (status !== 200) {
				console.error(
					`[Model_Download_Manager] HTTP ${status} for ${safeDomain(entry.downloadUrl)}`,
				);
				safeInvoke(() =>
					callbacks.onError({ code: "network", httpStatus: status }),
				);
				return;
			}

			// 4) 디스크 쓰기 핸들 + SHA-256 누적기 시작.
			writeStream = this.fs.createWriteStream(filePath);
			const hash = createHash("sha256");

			// 5) 본문 청크 소비 루프.
			let writeFailed = false;
			let writeFailureDetail: string | undefined;
			try {
				for await (const chunk of body) {
					if (controller.signal.aborted) {
						throw makeAbortError();
					}
					hash.update(chunk);
					try {
						await writeStream.write(chunk);
					} catch (writeErr) {
						writeFailed = true;
						writeFailureDetail = errMessage(writeErr);
						throw writeErr;
					}
					bytesDownloaded += chunk.byteLength;
					safeInvoke(() =>
						callbacks.onProgress({
							bytesDownloaded,
							bytesTotal: contentLength,
							percent:
								contentLength !== null && contentLength > 0
									? Math.min(
											100,
											Math.floor(
												(bytesDownloaded / contentLength) * 100,
											),
									  )
									: 0,
						}),
					);
				}
			} catch (loopErr) {
				// 5a) abort 분기 — 디스크 부족 vs 사용자 취소.
				if (controller.signal.aborted) {
					await closeWriteStreamSilently();
					await removePartialSilently();
					if (diskLowFreeBytes !== null) {
						const freeMb = Math.floor(diskLowFreeBytes / (1024 * 1024));
						console.error(
							`[Model_Download_Manager] aborted: disk-low (free=${freeMb}MB)`,
						);
						safeInvoke(() =>
							callbacks.onError({ code: "disk-low", freeMb }),
						);
					} else {
						safeInvoke(() => callbacks.onError({ code: "cancelled" }));
					}
					return;
				}
				// 5b) 디스크 쓰기 실패 (Requirement 2.7).
				if (writeFailed) {
					await closeWriteStreamSilently();
					await removePartialSilently();
					console.error(
						`[Model_Download_Manager] disk write failed: ${writeFailureDetail ?? "unknown"}`,
					);
					safeInvoke(() =>
						callbacks.onError({
							code: "disk",
							detail: writeFailureDetail,
						}),
					);
					return;
				}
				// 5c) 그 외 — 본문 스트림 도중 네트워크 예외.
				await closeWriteStreamSilently();
				await removePartialSilently();
				console.error(
					`[Model_Download_Manager] network error during body stream from ${safeDomain(entry.downloadUrl)}`,
				);
				safeInvoke(() =>
					callbacks.onError({
						code: "network",
						detail: errMessage(loopErr),
					}),
				);
				return;
			}

			// 6) 정상 완료 — close 후 SHA-256 검증.
			await closeWriteStreamSilently();

			// abort 신호가 generator 의 자연 종료와 race 가 났을 수 있다.
			// (예: 일부 fetch 구현은 abort 시 readable stream 을 throw 없이 자연 종료한다.)
			// 검증 단계 진입 전에 한 번 더 abort 분기를 확인해 cancelled / disk-low 로 처리한다.
			if (controller.signal.aborted) {
				await removePartialSilently();
				if (diskLowFreeBytes !== null) {
					const freeMb = Math.floor(diskLowFreeBytes / (1024 * 1024));
					console.error(
						`[Model_Download_Manager] aborted: disk-low (free=${freeMb}MB)`,
					);
					safeInvoke(() =>
						callbacks.onError({ code: "disk-low", freeMb }),
					);
				} else {
					safeInvoke(() => callbacks.onError({ code: "cancelled" }));
				}
				return;
			}

			const actualSha256 = hash.digest("hex").toLowerCase();
			const expectedSha256 = entry.sha256.toLowerCase();
			if (actualSha256 !== expectedSha256) {
				await removePartialSilently();
				console.error(
					`[Model_Download_Manager] checksum mismatch for ${entry.id}`,
				);
				safeInvoke(() =>
					callbacks.onError({
						code: "checksum",
						expected: expectedSha256,
						actual: actualSha256,
					}),
				);
				return;
			}

			// 7) 검증 통과 — Local_Model_Installation_Record 발행 (Requirement 2.10).
			const record: Local_Model_Installation_Record = {
				modelId: entry.id,
				filePath,
				sha256: actualSha256,
				installedAt: new Date().toISOString(),
				sizeBytes: bytesDownloaded,
			};
			safeInvoke(() => callbacks.onCompleted(record));
		} catch (err) {
			// fetchStream / mkdirRecursive 자체가 throw 한 경우.
			if (controller.signal.aborted) {
				await closeWriteStreamSilently();
				await removePartialSilently();
				if (diskLowFreeBytes !== null) {
					const freeMb = Math.floor(diskLowFreeBytes / (1024 * 1024));
					safeInvoke(() =>
						callbacks.onError({ code: "disk-low", freeMb }),
					);
				} else {
					safeInvoke(() => callbacks.onError({ code: "cancelled" }));
				}
				return;
			}
			await closeWriteStreamSilently();
			await removePartialSilently();
			console.error(
				`[Model_Download_Manager] network error before body stream from ${safeDomain(entry.downloadUrl)}: ${errMessage(err)}`,
			);
			safeInvoke(() =>
				callbacks.onError({ code: "network", detail: errMessage(err) }),
			);
		} finally {
			clearInterval(pollHandle);
		}
	}

	/**
	 * 1초 주기로 statfs 를 호출해 디스크 공간을 확인하고, 임계치 미만이면 controller 를 abort.
	 *
	 * 본 polling 자체의 예외는 무시한다 (statfs 가 일시적으로 실패해도 다운로드를 계속 시도).
	 * 실제 abort 사유의 분류는 호출 측 `runDownload` 가 `diskLowFreeBytes` 변수로 추적한다.
	 */
	private startDiskLowPolling(
		modelFolder: string,
		controller: AbortController,
		onDiskLow: (freeBytes: number) => void,
	): ReturnType<typeof setInterval> {
		return setInterval(async () => {
			if (controller.signal.aborted) return;
			try {
				const { bavail, bsize } = await this.fs.statfs(modelFolder);
				const freeBytes = bavail * bsize;
				if (freeBytes < this.diskLowThresholdBytes) {
					onDiskLow(freeBytes);
					try {
						controller.abort();
					} catch {
						// AbortController.abort() 는 본래 throw 하지 않는다 — 방어적 catch.
					}
				}
			} catch (err) {
				// 일시적 statfs 실패는 다운로드 진행에 영향을 주지 않는다.
				console.error("[Model_Download_Manager] statfs poll failed:", err);
			}
		}, this.statfsPollIntervalMs);
	}
}

// -----------------------------------------------------------------------------
// 기본 구현 — globalThis.fetch 기반 HttpStreamClient
// -----------------------------------------------------------------------------

/**
 * `globalThis.fetch` 기반 기본 `HttpStreamClient` 를 생성한다.
 * 인증 토큰 등 민감 헤더는 url 에 포함되어도 우리 측에서는 url 을 로깅하지 않는다 (Requirement 11.2).
 */
export function createDefaultHttpStreamClient(): HttpStreamClient {
	return {
		async fetchStream(url, signal) {
			const response = await globalThis.fetch(url, { signal });
			const contentLengthHeader = response.headers.get("content-length");
			const contentLength =
				contentLengthHeader !== null && /^\d+$/.test(contentLengthHeader)
					? Number.parseInt(contentLengthHeader, 10)
					: null;

			if (response.body === null) {
				const empty: AsyncIterable<Uint8Array> = {
					async *[Symbol.asyncIterator]() {
						/* empty */
					},
				};
				return { status: response.status, contentLength, body: empty };
			}

			const body: AsyncIterable<Uint8Array> = readableStreamToAsyncIterable(
				response.body,
			);
			return { status: response.status, contentLength, body };
		},
	};
}

/**
 * `ReadableStream<Uint8Array>` 를 `AsyncIterable<Uint8Array>` 로 변환한다.
 * Node 18+ 의 `ReadableStream` 은 자체 `[Symbol.asyncIterator]` 를 가지지만,
 * 일부 폴리필 환경에서는 누락되어 있어 reader pull 루프로 명시적으로 변환한다.
 */
function readableStreamToAsyncIterable(
	stream: ReadableStream<Uint8Array>,
): AsyncIterable<Uint8Array> {
	const native = (
		stream as unknown as {
			[Symbol.asyncIterator]?: () => AsyncIterator<Uint8Array>;
		}
	)[Symbol.asyncIterator];
	if (typeof native === "function") {
		return stream as unknown as AsyncIterable<Uint8Array>;
	}
	return {
		async *[Symbol.asyncIterator]() {
			const reader = stream.getReader();
			try {
				for (;;) {
					const { value, done } = await reader.read();
					if (done) return;
					if (value !== undefined) yield value;
				}
			} finally {
				try {
					reader.releaseLock();
				} catch {
					/* ignore */
				}
			}
		},
	};
}

// -----------------------------------------------------------------------------
// 기본 구현 — node:fs / node:fs/promises 기반 NodeFsLike
// -----------------------------------------------------------------------------

/**
 * `node:fs` / `node:fs/promises` 기반 기본 `NodeFsLike` 를 생성한다.
 *
 * 본 어댑터는 Obsidian 데스크톱(Electron) 환경의 Node 18.15+ 에서 작동을 가정한다.
 * 모바일/브라우저 전용 환경에서는 본 어댑터를 절대 호출하지 않아야 하며 (manifest
 * 의 `isDesktopOnly: true` 가 그 보장을 제공한다), 호출 시 ENOENT 외 예외는
 * `runDownload` 의 disk / network 분기로 자연스럽게 전파된다.
 *
 * - `mkdirRecursive`: `fs.promises.mkdir(path, { recursive: true })`. 이미 존재하는
 *   디렉터리는 no-op 으로 처리된다.
 * - `createWriteStream`: `node:fs.createWriteStream(path)` 핸들을 `WritableFileLike`
 *   계약으로 래핑한다. `write()` 는 backpressure(`drain` 이벤트) 를 honor 하여
 *   stream 의 internal buffer 가 차지 않도록 한다.
 * - `unlink`: `fs.promises.unlink(path)`. 부분 파일 정리용이며 ENOENT 는 무시한다.
 * - `statfs`: Node 18.15+ 의 `fs.promises.statfs(path)` 를 호출하고 `bavail`, `bsize`
 *   만 추출한다. 그 외 필드는 사용하지 않는다.
 *
 * 본 함수는 외부 효과가 없는 팩토리이므로 호출 시점에는 디스크/파일 시스템에 어떤
 * 영향도 주지 않는다 — 실제 I/O 는 반환된 객체의 메서드가 호출될 때만 발생한다.
 */
export function createDefaultNodeFs(): NodeFsLike {
	return {
		async mkdirRecursive(path: string): Promise<void> {
			await nodeFsPromises.mkdir(path, { recursive: true });
		},

		createWriteStream(path: string): WritableFileLike {
			const stream = nodeFs.createWriteStream(path);
			let closed = false;

			return {
				async write(chunk: Uint8Array): Promise<void> {
					return new Promise<void>((resolve, reject) => {
						// `write()` 는 backpressure 가 발생하면 false 를 반환한다.
						// 이 경우 `drain` 이벤트를 기다려 다음 청크를 안전하게 보낸다.
						const ok = stream.write(chunk, (err) => {
							if (err) {
								reject(err);
							}
						});
						if (ok) {
							// callback 이 success 로 호출되기 전에 resolve 해도 안전하다 —
							// 후속 write 는 같은 stream 이 직렬화하므로 순서가 보장된다.
							resolve();
							return;
						}
						// drain 대기. error 가 먼저 나면 reject.
						const onDrain = (): void => {
							stream.off("error", onError);
							resolve();
						};
						const onError = (err: Error): void => {
							stream.off("drain", onDrain);
							reject(err);
						};
						stream.once("drain", onDrain);
						stream.once("error", onError);
					});
				},

				async close(): Promise<void> {
					if (closed) return;
					closed = true;
					return new Promise<void>((resolve, reject) => {
						const onFinish = (): void => {
							stream.off("error", onError);
							resolve();
						};
						const onError = (err: Error): void => {
							stream.off("finish", onFinish);
							reject(err);
						};
						stream.once("finish", onFinish);
						stream.once("error", onError);
						stream.end();
					});
				},
			};
		},

		async unlink(path: string): Promise<void> {
			try {
				await nodeFsPromises.unlink(path);
			} catch (err) {
				// 파일이 애초에 없었다면 정상 분기 — 부분 파일 정리 best-effort.
				if (
					err !== null &&
					typeof err === "object" &&
					"code" in err &&
					(err as { code?: string }).code === "ENOENT"
				) {
					return;
				}
				throw err;
			}
		},

		async statfs(
			path: string,
		): Promise<{ readonly bavail: number; readonly bsize: number }> {
			// Node 18.15+ 에서만 `statfs` 가 제공된다. 미지원 환경에서는 이 호출이
			// throw 하며, 호출 측 `startDiskLowPolling` 은 console.error 후 다음 tick
			// 에 다시 시도하므로 다운로드 자체에는 영향을 주지 않는다.
			const result = (await (
				nodeFsPromises as unknown as {
					statfs: (
						p: string,
					) => Promise<{ bavail: number; bsize: number }>;
				}
			).statfs(path));
			return { bavail: result.bavail, bsize: result.bsize };
		},
	};
}

// -----------------------------------------------------------------------------
// 내부 유틸 (순수 함수)
// -----------------------------------------------------------------------------

/** 디렉터리와 파일명을 OS 경로 구분자로 결합한다. Windows 도 `/` 를 인식하므로 통일. */
function joinPath(dir: string, file: string): string {
	const trimmed = dir.replace(/[\\/]+$/, "");
	return `${trimmed}/${file}`;
}

/**
 * 다운로드 URL 의 마지막 path segment 를 파일명으로 사용한다.
 * URL 파싱 실패 시 `<entry.id>.bin` 으로 fallback.
 */
function deriveFileName(entry: LocalModelCatalogEntry): string {
	try {
		const u = new URL(entry.downloadUrl);
		const last = u.pathname.split("/").filter(Boolean).pop();
		if (last !== undefined && last.length > 0) return last;
	} catch {
		// fallback
	}
	return `${entry.id}.bin`;
}

/** 로깅 시 URL 의 host 부분만 추출한다 (Requirement 11.2 — 토큰/쿼리스트링 비기록). */
function safeDomain(url: string): string {
	try {
		return new URL(url).host;
	} catch {
		return "<invalid-url>";
	}
}

/** 콜백 호출 도중 던져진 예외가 다운로드 흐름을 깨지 않도록 감싼다. */
function safeInvoke(fn: () => void): void {
	try {
		fn();
	} catch (err) {
		console.error("[Model_Download_Manager] callback threw:", err);
	}
}

/** 임의 throw 값에서 메시지만 안전하게 추출 (스택은 노출하지 않음). */
function errMessage(err: unknown): string {
	if (err instanceof Error) return err.message;
	return String(err);
}

/** AbortError 와 동등한 예외를 생성. for-await 루프에서 abort 시 throw 하기 위함. */
function makeAbortError(): Error {
	const e = new Error("aborted");
	(e as Error & { name: string }).name = "AbortError";
	return e;
}
