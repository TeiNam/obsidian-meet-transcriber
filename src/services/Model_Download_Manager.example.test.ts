/**
 * `Model_Download_Manager` 의 7 개 acceptance criterion 시나리오 검증.
 *
 * 검증 시나리오 (각 `it` 블록 1 개):
 * - AC 2.4  : 폴더가 존재하지 않으면 `mkdirRecursive` 로 자동 생성.
 * - AC 2.6  : SHA-256 불일치 → 파일 삭제 + `onError({code:"checksum"})`,
 *             `localModelInstalled` 미갱신(=`onCompleted` 미호출).
 * - AC 2.7  : 디스크 쓰기 실패 → 부분 파일 삭제 + `onError({code:"disk"})`.
 * - AC 2.8  : HTTP status ≠ 200 → 부분 파일 정리 + `onError({code:"network", httpStatus})`.
 * - AC 2.9  : 사용자 취소 → 부분 파일 삭제 + `onError({code:"cancelled"})`.
 * - AC 2.10 : 다운로드 + SHA-256 검증 통과 → `onCompleted(record)` 1 회 호출.
 * - AC 10.3 : 다운로드 중 free disk < 100MB → controller.abort() + `onError({code:"disk-low"})`.
 *
 * 테스트 전략:
 * - `HttpStreamClient` 와 `NodeFsLike` 를 모두 인메모리 mock 으로 주입.
 * - mock fs 는 `Map<path, Uint8Array>` 로 작성된 파일을 보관한다.
 * - 결정성 확보를 위해 statfs polling 간격은 충분히 큰 값(10 분 = 600_000ms) 으로
 *   설정해 기본 흐름에서는 실행되지 않게 한다. AC 10.3 시나리오만 짧은 간격으로
 *   별도 테스트.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

import {
	Model_Download_Manager,
	type HttpStreamClient,
	type LocalModelCatalogEntry,
	type Local_Model_Installation_Record,
	type ModelDownloadCallbacks,
	type ModelDownloadError,
	type NodeFsLike,
	type WritableFileLike,
} from "./Model_Download_Manager";

// -----------------------------------------------------------------------------
// 인메모리 mock fs
// -----------------------------------------------------------------------------

interface InMemoryFsState {
	createdDirs: Set<string>;
	files: Map<string, Uint8Array>;
	mkdirCalls: number;
	unlinkCalls: string[];
	statfsResult: { bavail: number; bsize: number };
	failOnWrite: boolean;
}

function createInMemoryFs(
	overrides?: Partial<{
		statfsResult: { bavail: number; bsize: number };
		failOnWrite: boolean;
	}>,
): { fs: NodeFsLike; state: InMemoryFsState } {
	const state: InMemoryFsState = {
		createdDirs: new Set<string>(),
		files: new Map<string, Uint8Array>(),
		mkdirCalls: 0,
		unlinkCalls: [],
		statfsResult: overrides?.statfsResult ?? {
			bavail: 1024 * 1024 * 1024, // 1G blocks
			bsize: 4096,
		},
		failOnWrite: overrides?.failOnWrite ?? false,
	};

	const fs: NodeFsLike = {
		async mkdirRecursive(path) {
			state.mkdirCalls += 1;
			state.createdDirs.add(path);
		},
		createWriteStream(path): WritableFileLike {
			// 파일 핸들 생성 시점에는 빈 버퍼를 대응 path 에 등록한다.
			state.files.set(path, new Uint8Array(0));
			return {
				async write(chunk) {
					if (state.failOnWrite) {
						throw new Error("simulated ENOSPC");
					}
					const prev = state.files.get(path) ?? new Uint8Array(0);
					const next = new Uint8Array(prev.byteLength + chunk.byteLength);
					next.set(prev, 0);
					next.set(chunk, prev.byteLength);
					state.files.set(path, next);
				},
				async close() {
					/* noop */
				},
			};
		},
		async unlink(path) {
			state.unlinkCalls.push(path);
			state.files.delete(path);
		},
		async statfs(_path) {
			return state.statfsResult;
		},
	};
	return { fs, state };
}

// -----------------------------------------------------------------------------
// 인메모리 mock HTTP
// -----------------------------------------------------------------------------

interface HttpScript {
	status: number;
	contentLength: number | null;
	chunks: Uint8Array[];
	/** 청크 사이에 await 할 promise — abort 신호 테스트용. */
	delays?: Array<Promise<void>>;
}

function createMockHttp(script: HttpScript): {
	http: HttpStreamClient;
	calls: string[];
} {
	const calls: string[] = [];
	const http: HttpStreamClient = {
		async fetchStream(url, signal) {
			calls.push(url);
			const { status, contentLength, chunks, delays } = script;
			const body: AsyncIterable<Uint8Array> = {
				async *[Symbol.asyncIterator]() {
					for (let i = 0; i < chunks.length; i++) {
						if (signal.aborted) return;
						if (delays !== undefined && i < delays.length) {
							await delays[i];
						}
						if (signal.aborted) return;
						yield chunks[i];
					}
				},
			};
			return { status, contentLength, body };
		},
	};
	return { http, calls };
}

// -----------------------------------------------------------------------------
// 공통 테스트 픽스처
// -----------------------------------------------------------------------------

function sha256Hex(chunks: Uint8Array[]): string {
	const h = createHash("sha256");
	for (const c of chunks) h.update(c);
	return h.digest("hex");
}

function makeEntry(
	chunks: Uint8Array[],
	overrides?: Partial<LocalModelCatalogEntry>,
): LocalModelCatalogEntry {
	return {
		id: "whisper-large-v3-turbo",
		displayName: "Whisper Large V3 Turbo",
		downloadUrl: "https://huggingface.co/test/model/resolve/main/model.onnx",
		sha256: sha256Hex(chunks),
		sizeMb: 1700,
		transformersJsId: "test/whisper",
		...overrides,
	};
}

interface CapturedCallbacks {
	progressEvents: Array<{
		bytesDownloaded: number;
		bytesTotal: number | null;
		percent: number;
	}>;
	completedRecords: Local_Model_Installation_Record[];
	errors: ModelDownloadError[];
	callbacks: ModelDownloadCallbacks;
}

function captureCallbacks(): CapturedCallbacks {
	const progressEvents: CapturedCallbacks["progressEvents"] = [];
	const completedRecords: Local_Model_Installation_Record[] = [];
	const errors: ModelDownloadError[] = [];
	return {
		progressEvents,
		completedRecords,
		errors,
		callbacks: {
			onProgress: (p) => progressEvents.push({ ...p }),
			onCompleted: (r) => completedRecords.push(r),
			onError: (e) => errors.push(e),
		},
	};
}

/**
 * 다운로드의 비동기 본체가 완료될 때까지 대기한다.
 *
 * `download()` 는 controller 를 즉시 반환하므로, 콜백(onCompleted/onError) 호출까지
 * macrotask 몇 번 양보가 필요하다. 폴링 형태로 안전하게 대기한다.
 */
async function waitForSettlement(
	captured: CapturedCallbacks,
	maxIterations = 100,
): Promise<void> {
	for (let i = 0; i < maxIterations; i++) {
		if (captured.completedRecords.length > 0 || captured.errors.length > 0) {
			return;
		}
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
	}
}

// -----------------------------------------------------------------------------
// 시나리오들
// -----------------------------------------------------------------------------

describe("Model_Download_Manager", () => {
	// Vitest 의 `vi.spyOn(console, "error").mockImplementation(...)` 반환 타입은 버전에 따라
	// 제네릭 기본형이 달라져 직관적인 주석으로는 TS2322/TS2344 를 유발한다.
	// 다른 테스트 파일과 동일하게 `ReturnType<typeof vi.spyOn>` + 캐스트 패턴을 사용한다.
	let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		// 의도된 에러 로그가 다수 발생하므로 테스트 출력 노이즈를 줄이기 위해 spy.
		consoleErrorSpy = vi
			.spyOn(console, "error")
			.mockImplementation(() => undefined) as typeof consoleErrorSpy;
	});

	afterEach(() => {
		consoleErrorSpy.mockRestore();
	});

	it("AC 2.4: 폴더가 존재하지 않으면 mkdirRecursive 로 자동 생성한다", async () => {
		const chunk = new Uint8Array([1, 2, 3, 4]);
		const entry = makeEntry([chunk]);
		const { http } = createMockHttp({
			status: 200,
			contentLength: chunk.byteLength,
			chunks: [chunk],
		});
		const { fs, state } = createInMemoryFs();
		const manager = new Model_Download_Manager(http, fs, {
			statfsPollIntervalMs: 600_000,
		});
		const captured = captureCallbacks();

		manager.download(entry, "/tmp/models", captured.callbacks);
		await waitForSettlement(captured);

		expect(state.mkdirCalls).toBe(1);
		expect(state.createdDirs.has("/tmp/models")).toBe(true);
		expect(captured.completedRecords.length).toBe(1);
		expect(captured.errors).toEqual([]);
	});

	it("AC 2.10: 다운로드 + SHA-256 검증 통과 시 onCompleted(record) 가 호출된다", async () => {
		const chunks = [
			new Uint8Array([1, 2, 3]),
			new Uint8Array([4, 5, 6, 7]),
			new Uint8Array([8]),
		];
		const totalBytes = chunks.reduce((s, c) => s + c.byteLength, 0);
		const entry = makeEntry(chunks);
		const { http } = createMockHttp({
			status: 200,
			contentLength: totalBytes,
			chunks,
		});
		const { fs, state } = createInMemoryFs();
		const manager = new Model_Download_Manager(http, fs, {
			statfsPollIntervalMs: 600_000,
		});
		const captured = captureCallbacks();

		manager.download(entry, "/tmp/models", captured.callbacks);
		await waitForSettlement(captured);

		expect(captured.errors).toEqual([]);
		expect(captured.completedRecords).toHaveLength(1);
		const record = captured.completedRecords[0];
		expect(record.modelId).toBe(entry.id);
		expect(record.filePath).toBe("/tmp/models/model.onnx");
		expect(record.sha256).toBe(entry.sha256.toLowerCase());
		expect(record.sizeBytes).toBe(totalBytes);
		// installedAt 은 ISO 8601 형식.
		expect(record.installedAt).toMatch(
			/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
		);
		// 진행률 콜백이 청크당 1회씩 호출되었다.
		expect(captured.progressEvents).toHaveLength(chunks.length);
		const lastProgress = captured.progressEvents.at(-1);
		expect(lastProgress?.bytesDownloaded).toBe(totalBytes);
		expect(lastProgress?.percent).toBe(100);
		// 파일이 mock fs 에 그대로 보존된다 (검증 통과 → unlink 호출 없음).
		expect(state.unlinkCalls).toEqual([]);
		expect(state.files.get("/tmp/models/model.onnx")?.byteLength).toBe(
			totalBytes,
		);
	});

	it("AC 2.6: SHA-256 불일치 시 파일 삭제 + onError({code:checksum}), onCompleted 미호출", async () => {
		const realChunks = [new Uint8Array([1, 2, 3, 4])];
		// 카탈로그의 sha256 을 실제 데이터와 다른 값으로 설정.
		const entry = makeEntry(realChunks, {
			sha256: "0".repeat(64),
		});
		const { http } = createMockHttp({
			status: 200,
			contentLength: realChunks[0].byteLength,
			chunks: realChunks,
		});
		const { fs, state } = createInMemoryFs();
		const manager = new Model_Download_Manager(http, fs, {
			statfsPollIntervalMs: 600_000,
		});
		const captured = captureCallbacks();

		manager.download(entry, "/tmp/models", captured.callbacks);
		await waitForSettlement(captured);

		expect(captured.completedRecords).toEqual([]);
		expect(captured.errors).toHaveLength(1);
		const err = captured.errors[0];
		expect(err.code).toBe("checksum");
		if (err.code === "checksum") {
			expect(err.expected).toBe("0".repeat(64));
			expect(err.actual).toBe(sha256Hex(realChunks));
		}
		// 부분 파일이 삭제되었다 (Requirement 2.6, 2.10).
		expect(state.unlinkCalls).toContain("/tmp/models/model.onnx");
		expect(state.files.has("/tmp/models/model.onnx")).toBe(false);
	});

	it("AC 2.7: 디스크 쓰기 실패 시 부분 파일 삭제 + onError({code:disk})", async () => {
		const chunk = new Uint8Array([1, 2, 3, 4]);
		const entry = makeEntry([chunk]);
		const { http } = createMockHttp({
			status: 200,
			contentLength: chunk.byteLength,
			chunks: [chunk],
		});
		const { fs, state } = createInMemoryFs({ failOnWrite: true });
		const manager = new Model_Download_Manager(http, fs, {
			statfsPollIntervalMs: 600_000,
		});
		const captured = captureCallbacks();

		manager.download(entry, "/tmp/models", captured.callbacks);
		await waitForSettlement(captured);

		expect(captured.completedRecords).toEqual([]);
		expect(captured.errors).toHaveLength(1);
		expect(captured.errors[0].code).toBe("disk");
		expect(state.unlinkCalls).toContain("/tmp/models/model.onnx");
	});

	it("AC 2.8: HTTP status ≠ 200 시 onError({code:network, httpStatus})", async () => {
		const entry = makeEntry([new Uint8Array([0])]);
		const { http } = createMockHttp({
			status: 404,
			contentLength: 0,
			chunks: [],
		});
		const { fs } = createInMemoryFs();
		const manager = new Model_Download_Manager(http, fs, {
			statfsPollIntervalMs: 600_000,
		});
		const captured = captureCallbacks();

		manager.download(entry, "/tmp/models", captured.callbacks);
		await waitForSettlement(captured);

		expect(captured.completedRecords).toEqual([]);
		expect(captured.errors).toHaveLength(1);
		const err = captured.errors[0];
		expect(err.code).toBe("network");
		if (err.code === "network") {
			expect(err.httpStatus).toBe(404);
		}
	});

	it("AC 2.9: 사용자 취소 시 부분 파일 삭제 + onError({code:cancelled})", async () => {
		const chunks = [
			new Uint8Array([1, 2]),
			new Uint8Array([3, 4]),
			new Uint8Array([5, 6]),
		];
		// 두 번째 청크를 무한 지연시킨 뒤 abort 를 발사한다.
		let releaseSecondChunk: () => void = () => undefined;
		const secondChunkGate = new Promise<void>((resolve) => {
			releaseSecondChunk = resolve;
		});
		const entry = makeEntry(chunks);
		const { http } = createMockHttp({
			status: 200,
			contentLength: 6,
			chunks,
			delays: [Promise.resolve(), secondChunkGate, Promise.resolve()],
		});
		const { fs, state } = createInMemoryFs();
		const manager = new Model_Download_Manager(http, fs, {
			statfsPollIntervalMs: 600_000,
		});
		const captured = captureCallbacks();

		const controller = manager.download(
			entry,
			"/tmp/models",
			captured.callbacks,
		);
		// 첫 청크가 처리될 시간을 준다.
		await new Promise<void>((resolve) => setTimeout(resolve, 10));
		controller.abort();
		releaseSecondChunk();
		await waitForSettlement(captured);

		expect(captured.completedRecords).toEqual([]);
		expect(captured.errors).toHaveLength(1);
		expect(captured.errors[0].code).toBe("cancelled");
		expect(state.unlinkCalls).toContain("/tmp/models/model.onnx");
	});

	it("AC 10.3: 다운로드 중 free disk < 100MB 감지 시 abort + onError({code:disk-low})", async () => {
		const chunks = [
			new Uint8Array([1, 2]),
			new Uint8Array([3, 4]),
			new Uint8Array([5, 6]),
		];
		// 두 번째 청크를 잠시 보류해 polling 이 트리거될 시간을 준다.
		let releaseSecondChunk: () => void = () => undefined;
		const secondChunkGate = new Promise<void>((resolve) => {
			releaseSecondChunk = resolve;
		});
		const entry = makeEntry(chunks);
		const { http } = createMockHttp({
			status: 200,
			contentLength: 6,
			chunks,
			delays: [Promise.resolve(), secondChunkGate, Promise.resolve()],
		});
		// statfs 가 50MB 만 free 라고 반환 → 임계치 100MB 미만.
		const fiftyMb = 50 * 1024 * 1024;
		const { fs, state } = createInMemoryFs({
			statfsResult: { bavail: fiftyMb / 4096, bsize: 4096 },
		});
		const manager = new Model_Download_Manager(http, fs, {
			statfsPollIntervalMs: 5, // 매우 짧게 설정해 빠르게 트리거.
			diskLowThresholdBytes: 100 * 1024 * 1024,
		});
		const captured = captureCallbacks();

		manager.download(entry, "/tmp/models", captured.callbacks);
		// polling 이 임계치를 감지해 abort 하도록 시간을 준다.
		await new Promise<void>((resolve) => setTimeout(resolve, 30));
		releaseSecondChunk();
		await waitForSettlement(captured);

		expect(captured.completedRecords).toEqual([]);
		expect(captured.errors).toHaveLength(1);
		const err = captured.errors[0];
		expect(err.code).toBe("disk-low");
		if (err.code === "disk-low") {
			expect(err.freeMb).toBe(50);
		}
		expect(state.unlinkCalls).toContain("/tmp/models/model.onnx");
	});
});
