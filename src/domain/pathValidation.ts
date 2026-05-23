/**
 * 운영체제 경로 검증 헬퍼.
 *
 * 본 모듈은 사용자가 설정에서 입력한 `Model_Folder` 가 OS 절대 경로인지 검증하는 순수 함수
 * `isAbsoluteOSPath` 만을 export 한다. 외부 효과(파일 시스템 접근, Obsidian API 호출, 네트워크) 는
 * 일체 수행하지 않으므로 단위 테스트와 fast-check 속성 테스트로 자유롭게 호출할 수 있다.
 *
 * 본 모듈은 `design.md §Correctness Properties` 의 Property 12 와 `requirements.md` 의
 * Requirement 1.4 를 1:1 로 추적한다.
 *
 * - Property 12: 모델 폴더 경로 검증 (Validates Requirements 1.4)
 *   - POSIX 절대 경로(`/` 로 시작) 또는 Windows 드라이브 절대 경로(`[A-Za-z]:[/\\]` 로 시작) 는 `true`.
 *   - 빈 문자열, 상대 경로, vault 정규화 경로(`normalizePath` 결과) 는 `false`.
 *   - 동일 입력에 대해 항상 동일 결과(결정성).
 */

/**
 * Windows 드라이브 절대 경로 패턴.
 *
 * 단일 영문 알파벳(A-Za-z) + 콜론 + 슬래시 또는 백슬래시 로 시작하는 형태를 매치한다.
 * 예: `C:/Users/foo`, `D:\\models`, `z:/path/to/file`.
 *
 * 본 정규식은 입력 시작 위치(`^`) 만 검사하며 그 외 부분은 검사하지 않는다.
 * UNC 경로(`\\\\server\\share`) 는 본 함수의 적용 범위 밖이며 false 로 분류된다 — 본 plugin
 * 이 지원하는 모델 폴더는 단일 호스트의 로컬 디스크 절대 경로로 한정한다.
 */
const WINDOWS_DRIVE_ABSOLUTE_PATTERN = /^[A-Za-z]:[/\\]/;

/**
 * 입력 문자열이 운영체제 절대 경로인지 검증한다.
 *
 * @param path - 검증할 경로 문자열. `null` / `undefined` 는 호출 측이 미리 처리해야 한다
 *   (TypeScript 타입으로 강제됨).
 * @returns 입력이 POSIX 절대 경로 또는 Windows 드라이브 절대 경로이면 `true`, 그 외(빈 문자열,
 *   상대 경로, vault 정규화 경로) 이면 `false`.
 *
 * 분류 규칙(Property 12):
 * - POSIX 절대 경로 — `path` 가 `/` 로 시작하면 `true`.
 * - Windows 드라이브 절대 경로 — `path` 가 `[A-Za-z]:[/\\]` 패턴으로 시작하면 `true`.
 * - 그 외 — 빈 문자열, 상대 경로, `normalizePath` 결과(vault 상대 경로) 등은 모두 `false`.
 *
 * 본 함수는 외부 효과 없는 순수 함수이며, 동일 입력에 대해 항상 동일한 결과를 반환한다(결정성).
 */
export function isAbsoluteOSPath(path: string): boolean {
	// 빈 문자열은 어떤 절대 경로 패턴에도 해당하지 않으므로 즉시 false.
	if (path.length === 0) {
		return false;
	}

	// POSIX 절대 경로: 단일 슬래시(`/`) 로 시작.
	// vault 정규화 경로는 `normalizePath` 가 선행 슬래시를 제거하므로 이 분기에 걸리지 않는다.
	if (path.startsWith("/")) {
		return true;
	}

	// Windows 드라이브 절대 경로: 영문 알파벳 + `:` + 슬래시/백슬래시 로 시작.
	if (WINDOWS_DRIVE_ABSOLUTE_PATTERN.test(path)) {
		return true;
	}

	// 위 두 패턴 중 어느 것에도 해당하지 않으면 상대 경로로 분류.
	return false;
}
