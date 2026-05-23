/**
 * 실시간 전사 중 누적되는 텍스트와 segment 시퀀스를 메모리에 보관하는 순수 도메인 버퍼.
 *
 * AWS Transcribe Streaming은 두 종류의 결과를 반환한다.
 * - Partial_Result: 아직 확정되지 않은 중간 결과. 다음 Partial_Result가 오면 교체되어야 한다.
 * - Final_Result: 확정된 최종 결과. 이후 치환되지 않고 누적된다.
 *
 * 본 클래스는 이 두 개념을 각각 `pendingPartial`(단일 슬롯)과 `chunks`(배열 누적)로 분리해 관리하며,
 * 외부에서는 `getSnapshot()`으로 한 번에 두 상태를 원자적으로 조회한다.
 *
 * v1.1 확장 (Task 10, design §4.7) — Final 결과를 단순 문자열 누적이 아니라 구조화된
 * `Transcript_Segment` 시퀀스로도 보관하기 위해 `segments` 필드를 추가한다. 기존
 * `appendFinal` / `setPartial` 흐름은 변경 없이 유지되어 v1.0 호환성을 보장한다
 * (Requirement 8.5).
 *
 * 설계 문서(design.md) "Data Models → TranscriptBuffer" 참고.
 *
 * ## 불변식 (Invariants)
 * - `pendingPartial`은 `chunks`에 반영되지 않은 임시 텍스트이며, partial은 누적되지 않는다.
 * - `appendFinal(text)` 호출 후에는 항상 `pendingPartial === ""`가 된다.
 * - `length() === getCommittedText().length` (partial 길이는 포함하지 않는다).
 * - `getSegments()` 의 `segmentId` 는 한 세션 내에서 단조 증가한다 (Requirement 13.5).
 * - `appendSegment(s)` 는 `getCommittedText()` 의 길이를 `s.text.length` 이상 증가시킨다.
 *
 * ## 관련 요구사항
 * - Requirements 3.6: Final_Result 수신 시 직전 Partial_Result를 Final_Result로 치환.
 * - Requirements 3.7: Final_Result 텍스트를 버퍼 끝에 추가.
 * - Requirements 4.9: 버퍼가 비어 있거나 공백 문자만 포함하면 Transcript_Note 생성 중단.
 * - Requirements 5.1, 6.5: `Sentence_Formatter` 가 본 버퍼의 segment 시퀀스를 입력으로 받는다.
 * - Requirements 5.8: 편집 저장 시 내용이 공백 전용이면 저장 거부.
 * - Requirements 8.5: 신규 필드/메서드 도입 후에도 v1.0 동작은 변경되지 않는다.
 * - Requirements 13.4, 13.5: `segmentId` 단조 증가로 번역 라인 표시 순서를 결정한다.
 */

/**
 * AWS Transcribe Streaming 1 회 Final 또는 Local Whisper 1 청크의 "원시 transcript 단위".
 *
 * TODO(task-9): 본 정의는 task 9 가 `src/domain/segments.ts` 에 정식 `Transcript_Segment`
 * 타입을 추가하면 해당 파일에서 import 하도록 교체된다. design §Data Models 4 의 정의와
 * 1:1 일치한다.
 */
export interface Transcript_Segment {
	/** 한 세션 내 단조 증가 ID. Requirement 13.5 의 표시 순서 보장에 사용. */
	readonly segmentId: number;
	/** 세션 시작 후 경과 초. */
	readonly startSeconds: number;
	/** 세션 시작 후 경과 초. startSeconds <= endSeconds 불변식. */
	readonly endSeconds: number;
	/** 원시 텍스트. 양쪽 공백을 trim 하지 않는다 (formatter 가 수행). */
	readonly text: string;
	/**
	 * 화자 라벨 ("Speaker 1" 등). 클라우드 + ShowSpeakerLabel=true 시에만 채워짐.
	 * Requirement 6.4, 6.7.
	 */
	readonly speakerLabel?: string;
}

export class TranscriptBuffer {
	/**
	 * 확정된 Final_Result 청크들의 누적 배열.
	 *
	 * `getCommittedText()`는 이 배열을 단일 공백(`" "`)으로 join 하여 반환한다.
	 * Partial 중간 결과는 여기에 들어가지 않는다.
	 */
	private chunks: string[] = [];

	/**
	 * 아직 확정되지 않은 Partial_Result 텍스트.
	 *
	 * `setPartial(text)`로 교체되고, `appendFinal(text)`가 호출되면 빈 문자열로 초기화된다.
	 * 따라서 partial 값은 메모리에 하나만 유지되며, 연속된 partial들이 누적되지 않는다.
	 */
	private pendingPartial: string = "";

	/**
	 * v1.1 확장: 구조화된 `Transcript_Segment` 시퀀스 (design §4.7).
	 *
	 * `appendSegment(s)` 가 push 만 수행하므로 호출 순서가 그대로 보존된다. 호출자는
	 * `segmentId` 를 단조 증가하도록 부여해야 하며 (Requirement 13.5),
	 * `getSegments()` 는 외부 변형을 막기 위해 `ReadonlyArray` 로 노출한다.
	 */
	private segments: Transcript_Segment[] = [];

	/**
	 * Final_Result 텍스트를 버퍼 끝에 추가하고 현재 Partial_Result를 비운다.
	 *
	 * 이 호출 후에는 `getSnapshot().partial === ""`가 보장된다.
	 *
	 * @param text - Final_Result로 확정된 텍스트 (공백 문자 포함 가능).
	 *
	 * Requirements 3.6, 3.7.
	 */
	appendFinal(text: string): void {
		this.chunks.push(text);
		this.pendingPartial = "";
	}

	/**
	 * 현재의 Partial_Result 텍스트를 교체한다.
	 *
	 * 이전 partial 값은 즉시 폐기되며, `chunks`에는 영향을 주지 않는다.
	 *
	 * @param text - 새 Partial_Result 텍스트.
	 *
	 * Requirements 3.6.
	 */
	setPartial(text: string): void {
		this.pendingPartial = text;
	}

	/**
	 * 구조화된 `Transcript_Segment` 1 건을 버퍼에 누적하고, 동일한 본문을 v1.0 호환 chunk
	 * 경로(`appendFinal`)로도 함께 흘려보낸다 (design §4.7).
	 *
	 * 이로써 v1.0 호환성을 위한 `getCommittedText()` 와 v1.1 신규 경로인 `getSegments()`
	 * 가 같은 본문에 대해 일관된 상태를 유지한다.
	 *
	 * 호출 측은 `segmentId` 의 단조 증가를 보장해야 한다 (Requirement 13.5). 본 메서드는
	 * 입력 검증을 수행하지 않으며, 단조 증가 위반은 `Sentence_Formatter` 단계에서
	 * `console.error` 와 함께 해당 segment 가 출력에서 제외된다 (Requirement 5.10).
	 *
	 * @param segment 추가할 segment 객체. 호출 후 본 객체는 변형되지 않는다.
	 *
	 * Requirements 5.1, 6.5, 13.4, 13.5.
	 */
	appendSegment(segment: Transcript_Segment): void {
		this.segments.push(segment);
		// chunks 와 segments 의 본문 일관성을 위해 v1.0 호환 경로도 함께 갱신한다.
		// 결과적으로 `getCommittedText().length` 는 `segment.text.length` 이상 증가한다
		// (chunks.join(" ") 는 구분자 1 글자를 더 추가할 수 있으므로 "이상" 보장).
		this.appendFinal(segment.text);
	}

	/**
	 * 누적된 `Transcript_Segment` 시퀀스를 외부에 노출한다.
	 *
	 * `ReadonlyArray` 로 반환하여 호출자가 내부 배열을 변형하지 못하게 한다. 반환 시점의
	 * 스냅샷이 아니라 내부 배열의 readonly 뷰이므로, 후속 `appendSegment` 호출은 반환된
	 * 배열에도 반영된다. 호출 측이 안정적인 스냅샷이 필요하면 `Array.from(...)` 으로
	 * 복사하여 사용한다.
	 *
	 * Requirements 5.1, 6.5, 13.4.
	 */
	getSegments(): ReadonlyArray<Transcript_Segment> {
		return this.segments;
	}

	/**
	 * 현재 확정 텍스트와 partial 텍스트를 한 번에 원자적으로 조회한다.
	 *
	 * UI 렌더링 측에서 두 값을 개별 getter로 가져올 때 발생할 수 있는
	 * 중간 상태 노출(레이스 컨디션)을 방지하기 위해 단일 스냅샷을 반환한다.
	 *
	 * @returns 확정 텍스트(`committed`)와 partial 텍스트(`partial`)를 담은 객체.
	 */
	getSnapshot(): { committed: string; partial: string } {
		return {
			committed: this.getCommittedText(),
			partial: this.pendingPartial,
		};
	}

	/**
	 * 확정된 Final_Result 청크들을 단일 공백으로 join 하여 반환한다.
	 *
	 * Partial_Result는 포함하지 않는다. 저장 대상 Transcript_Note의 본문은
	 * 이 메서드의 반환값을 기반으로 구성된다.
	 *
	 * @returns 누적된 Final_Result 텍스트.
	 */
	getCommittedText(): string {
		return this.chunks.join(" ");
	}

	/**
	 * 확정 텍스트의 문자 길이.
	 *
	 * 불변식: `length() === getCommittedText().length`. Partial 길이는 포함되지 않는다.
	 *
	 * @returns 확정 텍스트의 길이.
	 */
	length(): number {
		return this.getCommittedText().length;
	}

	/**
	 * 버퍼를 초기화한다. `chunks`, `pendingPartial`, `segments` 를 모두 비운다.
	 *
	 * 새 전사 세션을 시작할 때 호출하여 이전 세션의 잔여 상태가 섞이지 않도록 한다.
	 * v1.1 에서 `segments` 필드가 추가되었으므로 본 메서드도 함께 초기화한다 (design §4.7).
	 */
	clear(): void {
		this.chunks = [];
		this.pendingPartial = "";
		this.segments = [];
	}

	/**
	 * 확정 텍스트가 유니코드 공백 문자로만 구성되어 있는지 판정한다.
	 *
	 * 검출 대상 공백:
	 * - 정규식 `\s`로 매칭되는 모든 공백(스페이스, 탭, 줄바꿈, non-breaking space 등).
	 * - 전각 공백(`\u3000`). 한국어/일본어 텍스트에서 흔히 발생하며, 대부분의 JS 엔진에서는
	 *   `\s`가 이미 `\u3000`을 포함하지만 설계 문서가 명시적으로 언급하므로 안전하게 병기한다.
	 *
	 * Partial_Result는 검사 대상에 포함되지 않는다. 즉, 아직 확정되지 않은 중간 텍스트가
	 * 존재하더라도 확정 텍스트가 비어 있거나 공백뿐이면 `true`를 반환한다.
	 *
	 * @returns 확정 텍스트가 공백 전용이거나 빈 문자열이면 `true`, 그렇지 않으면 `false`.
	 *
	 * Requirements 4.9, 5.8.
	 */
	isEmpty(): boolean {
		return /^[\s\u3000]*$/.test(this.getCommittedText());
	}
}
