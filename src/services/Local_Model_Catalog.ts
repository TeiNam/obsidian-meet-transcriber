/**
 * `Local_Model_Catalog` — 로컬 Whisper 추론에서 사용할 수 있는 모델의 정적 카탈로그.
 *
 * 본 모듈은 단순 데이터 export 모듈이며, 외부 I/O(네트워크, 파일 시스템) 또는 런타임 변경이
 * 일어나지 않는다. 따라서 별도의 단위 테스트 없이 `tsc --noEmit` 만으로 충분히 검증된다.
 *
 * Requirement 1.1 (모델 카탈로그 최소 항목), 9.2 (README 카탈로그 표) 와 1:1 로 매핑되며,
 * design.md §4.4 / §Data Models 3 의 인터페이스 정의를 그대로 구현한다.
 *
 * SHA-256 해시는 v1 에서 placeholder 로 두고, 실제 Hugging Face release 의 해시 측정 후
 * 하드코딩으로 교체한다(Requirement 2.6 의 무결성 검증 게이트). 이 단계까지는 빌드를 깨뜨리지
 * 않도록 64자 hex 형태의 placeholder 상수(`PLACEHOLDER_SHA256`) 를 사용한다.
 */

/**
 * 한 모델의 카탈로그 항목 1건. 모든 필드는 readonly — 런타임 변경 금지.
 *
 * design §Data Models 3 와 1:1 일치. 필드 의미는 다음과 같다:
 * - `id`: `Local_Model_Id`. 설정 / data.json / 디스크 파일명 prefix 에 사용.
 * - `displayName`: 사용자 표시명. 모델 자체의 고유 명칭(브랜드 보존).
 * - `downloadUrl`: Hugging Face 다운로드 URL. HTTPS 만 허용.
 * - `sha256`: 파일 무결성 검증용 SHA-256(lowercase hex, 64자).
 * - `sizeMb`: 다운로드 후 디스크 사용량(MB). UI 표시 + 사전 안내용.
 * - `transformersJsId`: transformers.js 가 인식하는 모델 식별자(HF repo id).
 */
export interface LocalModelCatalogEntry {
	readonly id: string;
	readonly displayName: string;
	readonly downloadUrl: string;
	readonly sha256: string;
	readonly sizeMb: number;
	readonly transformersJsId: string;
}

/**
 * SHA-256 placeholder 상수.
 *
 * 64자 lowercase hex 형태를 유지해 빌드 / 검증 코드 경로의 형식 검사를 통과시키되, 실제
 * 무결성 검증은 의도적으로 항상 실패하도록 모든 자릿수를 `0` 으로 둔다. 실제 해시 측정 전에는
 * 사용자가 다운로드해도 `Model_Download_Manager` 의 SHA-256 비교에서 자동으로 거부된다.
 *
 * TODO: replace with HF release sha (measured on YYYY-MM-DD)
 */
const PLACEHOLDER_SHA256 = "0".repeat(64);

/**
 * v1.1 시점에서 지원되는 로컬 모델 목록. 신규 모델 추가는 v1.2 이후로 deferred
 * (design.md §"v1.1 범위 (제외)" 참조).
 *
 * 항목 순서는 사용자에게 노출되는 드롭다운 순서이기도 하다. 큰 모델 → 작은 모델 순으로
 * 배치해 정확도가 높은 기본 추천을 상단에 둔다.
 */
export const LOCAL_MODEL_CATALOG: readonly LocalModelCatalogEntry[] = [
	{
		id: "whisper-large-v3-turbo",
		displayName: "Whisper Large V3 Turbo",
		downloadUrl:
			"https://huggingface.co/onnx-community/whisper-large-v3-turbo/resolve/main/onnx/model.onnx",
		// TODO: replace with HF release sha (measured on YYYY-MM-DD)
		sha256: PLACEHOLDER_SHA256,
		sizeMb: 1700,
		transformersJsId: "onnx-community/whisper-large-v3-turbo",
	},
	{
		id: "distil-whisper-large-v3",
		displayName: "Distil-Whisper Large V3",
		downloadUrl:
			"https://huggingface.co/distil-whisper/distil-large-v3/resolve/main/onnx/model.onnx",
		// TODO: replace with HF release sha (measured on YYYY-MM-DD)
		sha256: PLACEHOLDER_SHA256,
		sizeMb: 800,
		transformersJsId: "distil-whisper/distil-large-v3",
	},
];
