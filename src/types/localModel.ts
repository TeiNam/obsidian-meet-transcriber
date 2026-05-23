/**
 * 로컬 Whisper 모델 설치 메타데이터 타입 정의.
 *
 * `TranscribeSettings`(사용자 설정)와 같은 `data.json` 파일에 저장되지만,
 * 사용자가 직접 편집하는 값이 아니라 `Model_Download_Manager`가 다운로드 성공 후
 * 무결성 검증(SHA-256)을 통과한 시점에만 기록하는 **다운로드 결과 메타데이터**이다.
 * 따라서 `TranscribeSettings`와 분리하여 별도 키(`localModelInstalled`)로 보관한다.
 *
 * 관련 요구사항: Requirement 2.10, 2.11 (design §Data Models 2)
 */

/**
 * 한 모델의 설치 상태 1건.
 *
 * `data.json`에 다음과 같은 형태로 직렬화된다:
 *
 * ```json
 * {
 *   "...TranscribeSettings 필드들": "...",
 *   "localModelInstalled": {
 *     "whisper-large-v3-turbo": {
 *       "modelId": "whisper-large-v3-turbo",
 *       "filePath": "/Users/foo/Library/Application Support/.../model.bin",
 *       "sha256": "ab12...",
 *       "installedAt": "2025-11-15T09:30:00+09:00",
 *       "sizeBytes": 1683234567
 *     }
 *   }
 * }
 * ```
 *
 * 키가 없거나 빈 객체이면 "미설치" 로 간주한다(Requirement 2.11).
 */
export interface Local_Model_Installation_Record {
	/**
	 * `LOCAL_MODEL_CATALOG`의 식별자(예: `"whisper-large-v3-turbo"`).
	 *
	 * 부모 맵의 키와 동일한 값을 중복 보관하여 단일 레코드만으로도
	 * 모델을 식별할 수 있게 한다.
	 */
	readonly modelId: string;

	/**
	 * 가중치 파일의 운영체제 절대 경로.
	 *
	 * `Model_Folder` 하위에 위치하며 vault 외부 경로이다(Requirement 1.4, 2.12).
	 */
	readonly filePath: string;

	/**
	 * 다운로드 후 검증된 SHA-256 해시값(lowercase hex 64자).
	 *
	 * `LocalModelCatalogEntry.sha256`과 일치한 경우에만 본 레코드가 기록된다
	 * (Requirement 2.6, 2.10). 플러그인 활성화 시 파일이 실재하는지 + 해시가
	 * 여전히 일치하는지 재확인되어 불일치 시 본 레코드는 즉시 제거된다(Requirement 2.11).
	 */
	readonly sha256: string;

	/**
	 * 다운로드 완료 시각 ISO 8601 문자열(예: `"2025-11-15T09:30:00+09:00"`).
	 *
	 * 사용자 진단/디버깅 용도이며 정렬/비교에 사용하지 않는다.
	 */
	readonly installedAt: string;

	/**
	 * 다운로드된 파일 크기(바이트).
	 *
	 * `LocalModelCatalogEntry.sizeMb`와의 비교 검증이 아닌, 디스크 사용량
	 * 진단을 위한 메타데이터이다.
	 */
	readonly sizeBytes: number;
}

/**
 * 모델 식별자(`Local_Model_Id`)를 키로 갖는 설치 레코드 맵.
 *
 * 키가 부재하거나 값이 `undefined`이면 해당 모델은 "미설치" 상태이다.
 * `data.json`의 별도 최상위 키(`localModelInstalled`)로 직렬화되며
 * `TranscribeSettings`와 별개로 관리된다(Requirement 2.10, 2.11).
 */
export type Local_Model_Installed_Map = Record<
	string,
	Local_Model_Installation_Record
>;
