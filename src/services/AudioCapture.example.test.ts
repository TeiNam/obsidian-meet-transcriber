/**
 * `AudioCapture`의 `getUserMedia` 모킹 예시 테스트 (Task 10.3).
 *
 * 검증 목표:
 * - 권한 허용 / 거부(`NotAllowedError`, `PermissionDeniedError`, 기타 에러,
 *   `navigator.mediaDevices` 자체 부재) 분기별 동작 (Requirements 3.1, 3.9).
 * - `stop(stream)` 호출 시 모든 트랙의 `stop()` 이 호출되며, 멱등성과 예외 내성이
 *   유지되는지 검증 (Requirement 8.3).
 *
 * 테스트 전략:
 * - `AudioCapture` 생성자는 `getUserMedia`, `AudioContextCtor`, `workletSource`,
 *   `workletUrl` 을 옵션으로 주입 받으므로, 브라우저 전역을 건드리지 않고도
 *   단위 테스트가 가능하다. 본 테스트는 모두 `getUserMedia` 주입 경로를 사용한다.
 * - `navigator.mediaDevices` 가 없는 환경 시나리오에서만 해당 프로토타입 프로퍼티를
 *   임시 제거하고 `afterEach`에서 원복한다.
 * - jsdom 은 실제 AudioWorklet/AudioContext 를 제공하지 않으므로 본 파일은
 *   `pcmChunks` 경로는 다루지 않는다. (하위 테스트 태스크의 범위 외)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TranscribeError } from "../types/errors";
import { AudioCapture } from "./AudioCapture";

/**
 * 트랙 모킹 팩토리.
 * `getTracks()` 가 반환할 각 트랙의 `stop()` 을 `vi.fn()` 으로 만들어 호출을 관측한다.
 */
function createMockTrack(kind: "audio" | "video" = "audio"): MediaStreamTrack {
	const track = {
		kind,
		stop: vi.fn(),
	};
	// jsdom 에는 `MediaStreamTrack` 타입이 없거나 불완전하므로 런타임 객체만 넘긴다.
	return track as unknown as MediaStreamTrack;
}

/**
 * 여러 트랙을 갖는 `MediaStream` 모킹 팩토리.
 * `getTracks()` 는 호출 시점의 최신 배열을 반환한다.
 */
function createMockStream(tracks: MediaStreamTrack[]): MediaStream {
	return {
		getTracks: () => tracks,
	} as unknown as MediaStream;
}

describe("AudioCapture.requestPermission — 권한 허용 (Requirement 3.1)", () => {
	it("주입된 getUserMedia가 resolve하면 해당 MediaStream을 그대로 반환한다", async () => {
		const tracks = [createMockTrack("audio")];
		const mockStream = createMockStream(tracks);
		const getUserMedia = vi.fn().mockResolvedValue(mockStream);

		const capture = new AudioCapture({ getUserMedia });

		const result = await capture.requestPermission();

		expect(result).toBe(mockStream);
		expect(getUserMedia).toHaveBeenCalledTimes(1);
	});

	it("getUserMedia에 모노/에코캔슬 ideal 힌트를 전달한다 (sampleRate는 AudioWorklet이 다운샘플링)", async () => {
		// Requirements 3.1 — 일부 장치/OS(특히 macOS Chromium)는 sampleRate 엄격 제약에
		// OverconstrainedError 를 던지므로, 권한 흐름 차단을 피하기 위해 sampleRate 는
		// 요청하지 않고 channelCount/echoCancellation 만 ideal 힌트로 전달한다.
		const getUserMedia = vi.fn().mockResolvedValue(createMockStream([]));
		const capture = new AudioCapture({ getUserMedia });

		await capture.requestPermission();

		expect(getUserMedia).toHaveBeenCalledWith({
			audio: {
				channelCount: { ideal: 1 },
				echoCancellation: { ideal: true },
			},
		});
	});

	it("OverconstrainedError가 나면 { audio: true }로 재시도해 스트림을 획득한다", async () => {
		// 일부 하드웨어는 ideal 힌트조차도 문제 삼지 않지만, 다른 제약 조합에서 OverconstrainedError 가
		// 나올 수 있다. 이 경우 가장 관대한 제약으로 한 번 더 시도해 사용자 흐름을 차단하지 않는다.
		const stream = createMockStream([createMockTrack("audio")]);
		const overconstrained = new Error("sample rate not supported");
		overconstrained.name = "OverconstrainedError";
		const getUserMedia = vi
			.fn()
			.mockRejectedValueOnce(overconstrained)
			.mockResolvedValueOnce(stream);
		// requestPermission 은 fallback 경로의 console.error 를 남긴다 — 캡처만 하고 출력은 막는다.
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			const capture = new AudioCapture({ getUserMedia });
			const result = await capture.requestPermission();

			expect(result).toBe(stream);
			expect(getUserMedia).toHaveBeenCalledTimes(2);
			expect(getUserMedia).toHaveBeenNthCalledWith(2, { audio: true });
		} finally {
			errorSpy.mockRestore();
		}
	});
});

describe("AudioCapture.requestPermission — 권한 거부 및 실패 분기 (Requirement 3.9)", () => {
	/**
	 * DOMException 과 유사하게 `name` 프로퍼티를 가진 에러 팩토리.
	 * jsdom 의 DOMException 을 직접 사용하지 않아 테스트 코드가 간결해진다.
	 */
	function makeNamedError(name: string, message: string): Error {
		const err = new Error(message);
		err.name = name;
		return err;
	}

	it("NotAllowedError를 MIC_PERMISSION_DENIED TranscribeError로 래핑하고 cause를 보존한다", async () => {
		const original = makeNamedError("NotAllowedError", "User denied permission");
		const getUserMedia = vi.fn().mockRejectedValue(original);
		const capture = new AudioCapture({ getUserMedia });

		try {
			await capture.requestPermission();
			expect.unreachable("requestPermission should reject");
		} catch (err) {
			expect(err).toBeInstanceOf(TranscribeError);
			const tErr = err as TranscribeError;
			expect(tErr.code).toBe("MIC_PERMISSION_DENIED");
			// 원인 에러가 cause 로 보존되어야 상위 계층의 로깅/디버깅이 가능하다.
			expect(tErr.cause).toBe(original);
		}
	});

	it("PermissionDeniedError도 MIC_PERMISSION_DENIED로 매핑한다", async () => {
		const original = makeNamedError(
			"PermissionDeniedError",
			"OS level block",
		);
		const getUserMedia = vi.fn().mockRejectedValue(original);
		const capture = new AudioCapture({ getUserMedia });

		try {
			await capture.requestPermission();
			expect.unreachable("requestPermission should reject");
		} catch (err) {
			expect(err).toBeInstanceOf(TranscribeError);
			expect((err as TranscribeError).code).toBe("MIC_PERMISSION_DENIED");
		}
	});

	it("NotFoundError 등 그 외 실패도 MIC_PERMISSION_DENIED로 매핑하며 메시지에 원인을 포함한다", async () => {
		// 장치 미발견 같은 상황도 사용자 경험상 "마이크 사용 불가" 로 같이 분류한다.
		const original = makeNamedError("NotFoundError", "No microphone");
		const getUserMedia = vi.fn().mockRejectedValue(original);
		const capture = new AudioCapture({ getUserMedia });

		try {
			await capture.requestPermission();
			expect.unreachable("requestPermission should reject");
		} catch (err) {
			expect(err).toBeInstanceOf(TranscribeError);
			const tErr = err as TranscribeError;
			expect(tErr.code).toBe("MIC_PERMISSION_DENIED");
			// 구현은 권한 거부가 아닌 경우 원인 메시지를 보존한다.
			expect(tErr.message).toContain("No microphone");
		}
	});

	describe("환경에 navigator.mediaDevices가 없을 때", () => {
		let originalDescriptor: PropertyDescriptor | undefined;

		beforeEach(() => {
			// jsdom 은 기본적으로 navigator.mediaDevices 를 제공하지 않지만,
			// 다른 테스트가 이를 주입했을 가능성에 대비해 명시적으로 삭제한다.
			originalDescriptor = Object.getOwnPropertyDescriptor(
				Object.getPrototypeOf(navigator),
				"mediaDevices",
			);
			// 테스트 목적의 전역 조작 — 캐스트로 타입을 좁혀 `delete` 를 합법화한다.
			delete (navigator as { mediaDevices?: unknown }).mediaDevices;
		});

		afterEach(() => {
			if (originalDescriptor) {
				Object.defineProperty(
					Object.getPrototypeOf(navigator),
					"mediaDevices",
					originalDescriptor,
				);
			}
		});

		it("옵션을 주입하지 않으면 MIC_PERMISSION_DENIED로 즉시 실패한다", async () => {
			const capture = new AudioCapture();

			try {
				await capture.requestPermission();
				expect.unreachable("requestPermission should reject");
			} catch (err) {
				expect(err).toBeInstanceOf(TranscribeError);
				expect((err as TranscribeError).code).toBe("MIC_PERMISSION_DENIED");
			}
		});
	});
});

describe("AudioCapture.stop — MediaStream 트랙 정리 (Requirement 8.3)", () => {
	// Vitest 의 `vi.spyOn(console, "error").mockImplementation(...)` 반환 타입은 버전에 따라
	// 제네릭 기본형이 달라져 직관적인 주석으로는 TS2322/TS2344 를 유발한다.
	// `ReturnType<typeof vi.spyOn>` + 필요한 필드(mock.calls)만 교차 타입으로 확장하고,
	// 실제 할당 시 `as typeof consoleErrorSpy` 캐스트로 타입 경계를 넘는다.
	let consoleErrorSpy!: ReturnType<typeof vi.spyOn> & {
		mock: { calls: unknown[][] };
	};

	beforeEach(() => {
		// stop() 내부의 console.error 를 캡처만 하고 실제 출력은 막는다.
		consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {
			/* noop */
		}) as typeof consoleErrorSpy;
	});

	afterEach(() => {
		consoleErrorSpy.mockRestore();
	});

	it("모든 트랙의 stop()을 정확히 한 번씩 호출한다", () => {
		const audioTrack = createMockTrack("audio");
		const videoTrack = createMockTrack("video");
		const stream = createMockStream([audioTrack, videoTrack]);

		const capture = new AudioCapture();
		capture.stop(stream);

		expect(audioTrack.stop).toHaveBeenCalledTimes(1);
		expect(videoTrack.stop).toHaveBeenCalledTimes(1);
	});

	it("트랙이 없는 스트림에도 안전하게 동작한다", () => {
		const stream = createMockStream([]);
		const capture = new AudioCapture();

		expect(() => capture.stop(stream)).not.toThrow();
	});

	it("동일 스트림에 stop()을 두 번 호출해도 예외 없이 멱등하게 동작한다", () => {
		// 구현은 이중 호출을 안전하게 허용하며, 트랙의 stop() 은 호출마다 1회씩 실행된다.
		const track = createMockTrack("audio");
		const stream = createMockStream([track]);
		const capture = new AudioCapture();

		expect(() => {
			capture.stop(stream);
			capture.stop(stream);
		}).not.toThrow();
		expect(track.stop).toHaveBeenCalledTimes(2);
	});

	it("일부 트랙의 stop()이 예외를 던져도 다른 트랙은 계속 정리한다", () => {
		const failingTrack = createMockTrack("audio");
		(failingTrack.stop as ReturnType<typeof vi.fn>).mockImplementation(() => {
			throw new Error("track already ended");
		});
		const okTrack = createMockTrack("audio");
		const stream = createMockStream([failingTrack, okTrack]);

		const capture = new AudioCapture();

		expect(() => capture.stop(stream)).not.toThrow();
		expect(okTrack.stop).toHaveBeenCalledTimes(1);
		// 실패한 트랙에 대해서는 에러 로깅이 한 번 이상 이루어져야 한다.
		expect(consoleErrorSpy).toHaveBeenCalled();
	});

	it("getTracks() 자체가 throw해도 stop()은 예외 없이 종료된다", () => {
		// 실무에서 MediaStream 이 이미 해제된 뒤 getTracks() 가 에러를 던질 수 있는
		// 경계 상황을 모델링한다. 구현은 이 예외를 잡아 로깅만 한다.
		const stream = {
			getTracks: () => {
				throw new Error("stream detached");
			},
		} as unknown as MediaStream;

		const capture = new AudioCapture();
		expect(() => capture.stop(stream)).not.toThrow();
		expect(consoleErrorSpy).toHaveBeenCalled();
	});
});
