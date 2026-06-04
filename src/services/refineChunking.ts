/**
 * `refineTranscript` 의 긴 전사 청크 분할 유틸리티.
 *
 * AI 교정(refine)은 입력 본문을 거의 같은 길이로 되돌려야 하는 작업이라, 모델의
 * 출력 토큰 한도를 넘는 긴 회의는 한 번의 호출로 교정할 수 없다(출력이 중간에서
 * 잘림). 이 모듈은 전사 본문을 **줄 경계** 기준으로 안전한 크기의 청크들로 나눠,
 * 각 청크를 개별 호출로 교정한 뒤 다시 합칠 수 있게 한다.
 *
 * ## 설계 원칙
 * - 줄(`\n`) 경계에서만 분할한다. 한 줄(한 발화/세그먼트)은 절대 쪼개지 않아
 *   교정 품질과 라인 라운드트립(타임스탬프/화자 라벨 보존)을 해치지 않는다.
 * - 한 청크의 문자 수가 `charLimit` 를 넘지 않도록 줄을 누적한다.
 * - 단일 줄이 `charLimit` 보다 길면(아주 긴 단일 발화) 그 줄을 단독 청크로 둔다.
 *   분할로 품질을 망치는 것보다 한 청크가 다소 큰 편이 안전하다.
 *
 * 본 모듈은 외부 I/O / SDK 의존성이 없는 순수 함수만 포함하여 단위 테스트가 쉽다.
 */

/**
 * 전사 본문을 줄 경계 기준으로 청크 배열로 분할한다.
 *
 * - 입력이 `charLimit` 이하이면 분할 없이 `[transcript]` 한 개만 반환한다.
 * - 빈 문자열/공백 전용 입력은 빈 배열을 반환한다(교정할 내용 없음).
 * - 각 청크는 원본의 줄 구분(`\n`)을 보존한다. 청크들을 `\n` 으로 다시 이으면
 *   (정확히는 `joinRefinedChunks` 사용) 원본의 줄 구조가 복원된다.
 *
 * @param transcript 교정 대상 전사 본문.
 * @param charLimit  한 청크의 최대 문자 수(권장: 모델 출력 토큰 한도 환산값).
 * @returns 줄 경계로 나뉜 청크 문자열 배열.
 */
export function splitTranscriptIntoChunks(
	transcript: string,
	charLimit: number,
): string[] {
	if (transcript.trim().length === 0) {
		return [];
	}
	if (transcript.length <= charLimit) {
		return [transcript];
	}

	const lines = transcript.split("\n");
	const chunks: string[] = [];
	let current: string[] = [];
	let currentLen = 0;

	for (const line of lines) {
		// 줄 자체 길이 + 합류 시 추가될 개행(1) 을 고려한 예상 길이.
		const addition = current.length === 0 ? line.length : line.length + 1;

		if (currentLen + addition > charLimit && current.length > 0) {
			// 현재 청크를 확정하고 새 청크를 시작한다.
			chunks.push(current.join("\n"));
			current = [line];
			currentLen = line.length;
			continue;
		}

		current.push(line);
		currentLen += addition;
	}

	if (current.length > 0) {
		chunks.push(current.join("\n"));
	}

	return chunks;
}

/**
 * 교정된 청크들을 원본 줄 구조로 다시 합친다.
 *
 * `splitTranscriptIntoChunks` 가 줄 경계에서 나눴으므로, 청크들을 `\n` 으로 이으면
 * 원본의 줄 수/순서가 보존된다. 각 청크 결과의 앞뒤 개행만 정리해 이중 빈 줄을 막는다.
 *
 * @param chunks 교정된 청크 문자열 배열(분할 순서 유지).
 * @returns 합쳐진 교정 본문.
 */
export function joinRefinedChunks(chunks: string[]): string {
	return chunks.map((c) => c.replace(/^\n+|\n+$/g, "")).join("\n");
}
