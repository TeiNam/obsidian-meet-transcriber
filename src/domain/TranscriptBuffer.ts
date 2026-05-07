/**
 * 실시간 전사 중 누적되는 텍스트를 메모리에 보관하는 순수 도메인 버퍼.
 *
 * AWS Transcribe Streaming은 두 종류의 결과를 반환한다.
 * - Partial_Result: 아직 확정되지 않은 중간 결과. 다음 Partial_Result가 오면 교체되어야 한다.
 * - Final_Result: 확정된 최종 결과. 이후 치환되지 않고 누적된다.
 *
 * 본 클래스는 이 두 개념을 각각 `pendingPartial`(단일 슬롯)과 `chunks`(배열 누적)로 분리해 관리하며,
 * 외부에서는 `getSnapshot()`으로 한 번에 두 상태를 원자적으로 조회한다.
 *
 * 설계 문서(design.md) "Data Models → TranscriptBuffer" 참고.
 *
 * ## 불변식 (Invariants)
 * - `pendingPartial`은 `chunks`에 반영되지 않은 임시 텍스트이며, partial은 누적되지 않는다.
 * - `appendFinal(text)` 호출 후에는 항상 `pendingPartial === ""`가 된다.
 * - `length() === getCommittedText().length` (partial 길이는 포함하지 않는다).
 *
 * ## 관련 요구사항
 * - Requirements 3.6: Final_Result 수신 시 직전 Partial_Result를 Final_Result로 치환.
 * - Requirements 3.7: Final_Result 텍스트를 버퍼 끝에 추가.
 * - Requirements 4.9: 버퍼가 비어 있거나 공백 문자만 포함하면 Transcript_Note 생성 중단.
 * - Requirements 5.8: 편집 저장 시 내용이 공백 전용이면 저장 거부.
 */
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
	 * 버퍼를 초기화한다. `chunks`와 `pendingPartial`을 모두 비운다.
	 *
	 * 새 전사 세션을 시작할 때 호출하여 이전 세션의 잔여 상태가 섞이지 않도록 한다.
	 */
	clear(): void {
		this.chunks = [];
		this.pendingPartial = "";
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
