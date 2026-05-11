// 사이드바 최근 전사 리스트에서 사용하는 표시 문자열 포맷터.
//
// `SidebarView` 본체가 크기 제약을 넘지 않도록 별도 모듈로 추출했다.
// 로직은 순수 함수이며 Obsidian API 에 의존하지 않으므로 단위 테스트가 쉽다.

/**
 * 파일 수정 시각 타임스탬프(ms)를 사용자 친화적 상대 시각 문자열로 변환한다.
 *
 * `Intl.RelativeTimeFormat` 을 사용해 "방금 전", "3분 전", "2시간 전" 같은 표현을
 * 로케일에 맞게 생성한다. Obsidian 이 내부적으로 `navigator.language` 를 이미 반영하므로
 * 별도의 로케일 인자는 받지 않는다.
 */
export function formatRelativeMtime(mtime: number): string {
	const diffSec = Math.round((mtime - Date.now()) / 1000);
	const rtf = new Intl.RelativeTimeFormat(navigator.language, {
		numeric: "auto",
	});
	if (Math.abs(diffSec) < 60) {
		return rtf.format(diffSec, "second");
	}
	const diffMin = Math.round(diffSec / 60);
	if (Math.abs(diffMin) < 60) {
		return rtf.format(diffMin, "minute");
	}
	const diffHour = Math.round(diffMin / 60);
	if (Math.abs(diffHour) < 24) {
		return rtf.format(diffHour, "hour");
	}
	const diffDay = Math.round(diffHour / 24);
	return rtf.format(diffDay, "day");
}

/**
 * 전사 노트의 `basename` 을 사용자 친화적인 표시용 문자열로 변환한다.
 *
 * 파일 시스템 호환성을 위해 저장 시에는 콜론 대신 하이픈을 사용한다(`HH-mm`).
 * UI 에서는 일반적인 시각 표기(`HH:mm`)로 되돌려 가독성을 높인다.
 *
 * 매칭 규칙:
 * - `YYYY-MM-DD HH-mm[-N]` → `YYYY-MM-DD HH:mm` (충돌 회피 suffix 는 제거)
 * - 구 포맷 `Transcribe-YYYYMMDD-HHmmss[-N]` 도 동일하게 변환해 이전 노트도 예쁘게 표시.
 * - 매칭되지 않는 파일명은 원본 그대로 반환한다(사용자 정의 이름 존중).
 */
export function formatTranscriptDisplayName(basename: string): string {
	// 새 포맷: 2025-11-10 14-23 또는 2025-11-10 14-23-1
	const newFmt = /^(\d{4}-\d{2}-\d{2}) (\d{2})-(\d{2})(?:-\d+)?$/.exec(basename);
	if (newFmt) {
		const [, date, hh, mm] = newFmt;
		return `${date} ${hh}:${mm}`;
	}
	// 구 포맷: Transcribe-20251110-142345 또는 Transcribe-20251110-142345-1
	const oldFmt = /^Transcribe-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})\d{2}(?:-\d+)?$/.exec(
		basename,
	);
	if (oldFmt) {
		const [, y, mo, d, hh, mm] = oldFmt;
		return `${y}-${mo}-${d} ${hh}:${mm}`;
	}
	return basename;
}
