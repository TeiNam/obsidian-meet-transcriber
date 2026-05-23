// Transcribe 사이드바 — 상태 영역 부가 위젯 모음 (TASK 25).
//
// 본 모듈은 다음 4 종 위젯의 DOM 생성/토글만 담당한다. 모두 `createEl` /
// `setText` / `addClass` / `toggleClass` / `empty` 만 사용하며 `innerHTML`
// 계열은 사용하지 않는다(Requirement 9.5). 실제 색상/레이아웃은 styles.css
// 의 CSS 변수가 결정하며 본 모듈은 클래스 부여만 수행한다.
//
//  1. Speaker capacity notice (Requirement 6.8): 화자 분리 활성 시 사이드바
//     상단에 "최대 10명까지 동시 화자 인식 가능" 라벨을 항상 노출.
//  2. Translation cost counter (Requirement 13.9): 번역 활성 동안 status row
//     하단에 누적 문자 수를 1초 이내 갱신해 표시.
//  3. Throttle indicator (Requirement 10.2): 청크 결과가 200ms 초과 지연될
//     때 진행 인디케이터를 노출.
//  4. Final line renderer (Requirement 4.4, 5.5, 6.2, 13.2, 13.5): 화자 라벨
//     + 본문 + (옵션) 번역 placeholder 를 한 라인 단위로 렌더한다.
//
// `SidebarView` 본체가 800라인 한계에 가깝기 때문에 본 모듈로 분리했다.
// (KISS / no-over-abstraction — 위젯 수가 늘어나면 추가 분리 검토)

import type { Translations } from "../i18n";
import type { Transcript_Segment } from "../domain/segments";

/** 화자별 색상 클래스 최댓값 (`speaker-1` ~ `speaker-10`). Requirement 6.8. */
const MAX_SPEAKER_COLOR_CLASSES = 10;

/**
 * `appendFinalLine` 의 호출 시 옵션.
 *
 * - `translationEnabled`: `true` 면 라인 아래 `.translation-line` placeholder
 *   `<div>` 를 미리 생성한다. `Translation_Service` 가 이 노드를 `Segment_Id`
 *   기준 키로 사용해 결과를 부착한다 (Requirement 13.4, 13.5).
 */
export interface AppendFinalLineOptions {
	readonly translationEnabled: boolean;
}

/**
 * `appendFinalLine` 결과 — 호출자가 placeholder DOM 을 큐에 보관할 수 있도록
 * 반환한다. `translationEnabled === false` 면 `placeholderEl` 은 `null`.
 */
export interface AppendFinalLineResult {
	readonly lineEl: HTMLDivElement;
	readonly placeholderEl: HTMLDivElement | null;
}

/**
 * 화자 라벨 ("Speaker 3") 에서 인덱스를 추출해 색상 클래스 이름을 반환한다.
 *
 * 정상 입력은 `Speaker N` (N >= 1). 비정상 입력 (라벨 없음 또는 인덱스 추출
 * 실패) 은 `null` 을 반환해 호출자가 색상 클래스를 부여하지 않게 한다.
 *
 * - N 이 1~10 범위면 `speaker-${N}` 반환 (CSS 에서 정의된 10개 슬롯).
 * - N 이 11 이상이면 modulo 10 으로 슬롯을 회전해 `speaker-1` ~ `speaker-10`
 *   범위로 매핑한다 (Requirement 6.8 가 동시 인식 상한을 10명으로 제한하므로
 *   실제로는 도달하지 않지만, 안전망 차원에서 ranged 처리).
 */
function speakerColorClass(speakerLabel: string | undefined): string | null {
	if (!speakerLabel) return null;
	const match = speakerLabel.match(/^Speaker\s+(\d+)$/);
	if (!match) return null;
	const idx = Number.parseInt(match[1], 10);
	if (!Number.isFinite(idx) || idx < 1) return null;
	const slot = ((idx - 1) % MAX_SPEAKER_COLOR_CLASSES) + 1;
	return `speaker-${slot}`;
}

/**
 * 본문 컨테이너에 한 Final 라인을 추가한다.
 *
 * 구조 (translationEnabled === true):
 *   <div class="line">
 *     <span class="speaker-label speaker-3">Speaker 3:</span>
 *     <span class="line-text">안녕하세요</span>
 *     <div class="translation-line"></div>
 *   </div>
 *
 * 구조 (translationEnabled === false):
 *   <div class="line">
 *     <span class="speaker-label speaker-3">Speaker 3:</span>
 *     <span class="line-text">안녕하세요</span>
 *   </div>
 *
 * 화자 라벨이 없는 segment 는 `.speaker-label` span 자체를 만들지 않는다.
 *
 * 매핑: Requirement 4.4 (placeholder 반환 — Translation_Service 큐 키),
 *      4.5 (라인 단위 렌더 — Local_Whisper 청크별 결과),
 *      6.2 (화자 라벨 prefix + 색상 클래스),
 *      13.2 (translation placeholder 미리 생성),
 *      13.5 (Segment_Id 단조 증가 순서로 라인 추가).
 */
export function appendFinalLine(
	container: HTMLElement,
	segment: Transcript_Segment,
	options: AppendFinalLineOptions,
): AppendFinalLineResult {
	const lineEl = container.createDiv({ cls: "line" });
	lineEl.setAttr("data-segment-id", String(segment.segmentId));

	if (segment.speakerLabel) {
		const speakerSpan = lineEl.createSpan({
			cls: "speaker-label",
			text: `${segment.speakerLabel}: `,
		});
		const colorClass = speakerColorClass(segment.speakerLabel);
		if (colorClass) {
			speakerSpan.addClass(colorClass);
		}
	}

	lineEl.createSpan({ cls: "line-text", text: segment.text });

	let placeholderEl: HTMLDivElement | null = null;
	if (options.translationEnabled) {
		// 비어 있는 placeholder. `Translation_Service.onResolved` 가 setText 호출.
		placeholderEl = lineEl.createDiv({ cls: "translation-line" });
	}

	return { lineEl, placeholderEl };
}

// ──────────────────────────────────────────────────────────────────────
// Speaker capacity notice (Requirement 6.8)
// ──────────────────────────────────────────────────────────────────────

/**
 * 화자 분리 활성 시 노출되는 안내 라벨의 핸들.
 *
 * 라벨 노드는 항상 DOM 에 존재하며 `is-hidden` 클래스 토글로 가시성을 제어한다.
 * 이렇게 두면 가시성 변경 시 DOM 을 다시 만들 필요가 없고, 테스트에서 노드의
 * 클래스만 검사하면 된다.
 */
export interface SpeakerCapacityNoticeHandle {
	setVisible(visible: boolean): void;
}

export function renderSpeakerCapacityNotice(
	root: HTMLElement,
	t: Translations,
): SpeakerCapacityNoticeHandle {
	const el = root.createDiv({
		cls: "transcribe-speaker-capacity is-hidden",
		text: t.sidebar.speakerCapacityNotice,
	});
	return {
		setVisible(visible: boolean) {
			el.toggleClass("is-hidden", !visible);
		},
	};
}

// ──────────────────────────────────────────────────────────────────────
// Translation cost counter (Requirement 13.9)
// ──────────────────────────────────────────────────────────────────────

/**
 * 누적 문자 수 카운터의 핸들.
 *
 * - `update(n)`: 텍스트만 갱신.
 * - `setEnabled(enabled)`: `translationEnabled` 토글에 맞춰 가시성 제어.
 *   비활성 시 `is-hidden` 클래스를 부여한다 (DOM 자체는 보존 → 다음 활성화
 *   시 즉시 노출 가능).
 */
export interface TranslationCostCounterHandle {
	update(charCount: number): void;
	setEnabled(enabled: boolean): void;
}

export function renderTranslationCostCounter(
	root: HTMLElement,
	t: Translations,
): TranslationCostCounterHandle {
	const el = root.createDiv({
		cls: "transcribe-cost-counter is-hidden",
		text: t.sidebar.costCounter(0),
	});
	return {
		update(charCount: number) {
			el.setText(t.sidebar.costCounter(charCount));
		},
		setEnabled(enabled: boolean) {
			el.toggleClass("is-hidden", !enabled);
		},
	};
}

// ──────────────────────────────────────────────────────────────────────
// Throttle indicator (Requirement 10.2)
// ──────────────────────────────────────────────────────────────────────

/**
 * 청크 처리 지연 인디케이터의 핸들.
 *
 * `Local_Whisper_Service` 가 청크 추론이 200ms 를 초과해 지연되는 것을 감지
 * 하면 `setActive(true)` 를 호출하고, 결과 도착 직후 `setActive(false)` 로
 * 숨긴다. 노드는 항상 DOM 에 두고 `is-hidden` 으로 토글한다.
 */
export interface ThrottleIndicatorHandle {
	setActive(active: boolean): void;
}

export function renderThrottleIndicator(
	root: HTMLElement,
	t: Translations,
): ThrottleIndicatorHandle {
	const el = root.createDiv({
		cls: "transcribe-throttle-indicator is-hidden",
		text: t.sidebar.throttleIndicator,
	});
	return {
		setActive(active: boolean) {
			el.toggleClass("is-hidden", !active);
		},
	};
}
