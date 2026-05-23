/**
 * Transcript / Sentence / Translated 계층 segment 타입 정의.
 *
 * 본 모듈은 외부 I/O 또는 Obsidian/AWS SDK 의존성이 없는 순수 타입 파일이다.
 * design.md §Data Models 4 의 정의와 1:1 일치하며, `Sentence_Formatter`,
 * `Translation_Service`, `TranscribeService`, `Local_Whisper_Service` 등 여러
 * 도메인/서비스 모듈이 공통 import 한다.
 *
 * 관련 요구사항: Requirements 5.2, 5.5, 5.9, 6.4, 6.7, 13.4, 13.5
 *               (design §Data Models 4, §Sentence_Formatter, §Translation Queue)
 */

/**
 * AWS Transcribe Streaming 의 Final 결과 1 회 또는 Local Whisper 1 청크의
 * "원시 transcript 단위". 한 segment 는 0 개 이상의 문장을 포함할 수 있으며,
 * Requirement 5.2 의 문장 분할은 본 단위를 입력으로 받는다.
 *
 * - `segmentId`: 한 세션 내 단조 증가 ID. 세션 시작 시 1 부터 부여되며 재연결 후에도
 *   카운터를 유지한다. 사이드바 표시 순서와 번역 큐 표시 순서 결정에 사용된다.
 *   (Requirement 13.5).
 * - `startSeconds`, `endSeconds`: 세션 시작 후 경과 초. `startSeconds <= endSeconds`
 *   불변식을 만족한다. 음수가 아니다.
 * - `text`: 원시 텍스트. 양쪽 공백을 trim 하지 않는다 (formatter 가 수행한다).
 * - `speakerLabel`: 화자 라벨 ("Speaker 1" 형식). 클라우드 백엔드에서
 *   `ShowSpeakerLabel = true` 인 경우에만 채워지며, 로컬 백엔드 또는
 *   화자 분리 비활성 시에는 `undefined` 이다 (Requirement 6.4, 6.7).
 */
export interface Transcript_Segment {
	readonly segmentId: number;
	readonly startSeconds: number;
	readonly endSeconds: number;
	readonly text: string;
	readonly speakerLabel?: string;
}

/**
 * `Sentence_Formatter` 가 `Transcript_Segment` 시퀀스를 문장 단위로 분할한 결과 1 건.
 *
 * Requirement 5.9 에 따라 1 개 `Transcript_Segment` 가 N 개의 문장을 포함하는
 * 경우 모든 `Sentence_Segment` 의 `startSeconds` 는 원본 segment 의 `startSeconds`
 * 와 동일하며, 마지막 문장의 `endSeconds` 만 원본의 `endSeconds` 가 된다.
 *
 * - `text`: 양쪽 공백이 trim 된 비공백 문자열 (Requirement 5.3).
 * - `speakerLabel`: 원본 segment 의 `speakerLabel` 을 그대로 승계.
 */
export interface Sentence_Segment {
	readonly startSeconds: number;
	readonly endSeconds: number;
	readonly text: string;
	readonly speakerLabel?: string;
}

/**
 * 번역 결과가 부착된 segment. `Transcript_Segment` 를 확장하여
 * 원본 텍스트와 번역 텍스트를 함께 표현한다 (Requirement 13.4).
 *
 * - `sourceText`: 번역 호출에 입력으로 전달된 원본 텍스트. 일반적으로 `text` 와
 *   동일하지만, 사이드바 placeholder 부착 시점에 별도로 보관해야 하는 경우가
 *   있어 명시적으로 분리한다.
 * - `translatedText`: 번역 호출이 성공한 경우의 결과. 호출 미완료 또는 실패
 *   시 `undefined`.
 * - `translationFailed`: 번역 호출이 최종적으로 실패한 경우 `true` (Requirement 13.6).
 */
export interface Translated_Segment extends Transcript_Segment {
	readonly sourceText: string;
	readonly translatedText?: string;
	readonly translationFailed?: boolean;
}
