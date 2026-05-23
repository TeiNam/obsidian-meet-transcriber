/**
 * `mapSpeakerLabel` — AWS Transcribe Streaming 의 `spk_N` 화자 식별자를 표시용 라벨
 * `Speaker 1`, `Speaker 2`, ... 로 변환하는 외부 I/O 가 없는 순수 함수 모듈.
 *
 * 본 모듈은 `design.md §4.10` 의 시그니처와 `requirements.md` Requirement 6.4, 12.3 을
 * 1:1 로 추적하며, `design.md §Correctness Properties` 의 Property 3 (화자 라벨 매핑 안정성)
 * 을 만족한다.
 *
 * - Property 3: 화자 라벨 매핑 안정성 (Validates Requirements 6.4, 12.3)
 *   - 안정성: 같은 raw label → 같은 displayLabel (동일 세션 내).
 *   - Injective: 서로 다른 raw label → 서로 다른 displayLabel.
 *   - 첫 등장 순서대로 `Speaker 1`, `Speaker 2`, ... 부여.
 *   - 입력 `sessionState` 는 변형하지 않고 새 객체를 반환 (immutability).
 *
 * 본 함수는 외부 효과(AWS SDK 호출, Obsidian API, 네트워크) 에 의존하지 않으므로
 * Requirement 12.3 의 테스트 가능성 규칙을 만족하며 fast-check 속성 테스트로 자유롭게
 * 호출할 수 있다.
 */

/**
 * 한 세션 동안의 화자 라벨 매핑 상태.
 *
 * - `mapping` — 이미 등장한 raw 화자 식별자(`spk_0`, `spk_1`, ...) 를 표시 라벨
 *   (`Speaker 1`, `Speaker 2`, ...) 로 매핑한다. `ReadonlyMap` 타입으로 표현되어 외부에서
 *   변형되는 일을 타입 시스템 수준에서 차단한다.
 * - `nextIndex` — 다음 신규 raw label 에 부여할 1-based 인덱스. 초기값은 1.
 *
 * 본 인터페이스는 불변 객체로만 사용된다. `mapSpeakerLabel` 는 입력 `sessionState` 를
 * 변형하지 않고 새 객체를 반환한다.
 */
export interface Speaker_Label_Session_State {
	readonly mapping: ReadonlyMap<string, string>;
	readonly nextIndex: number;
}

/**
 * 비어 있는 초기 `Speaker_Label_Session_State` 를 생성한다.
 *
 * 세션 시작 시점(`TranscribeService.start`) 에 1 회 호출하여 반환값을 보관해 두고,
 * 매 Final 결과마다 `mapSpeakerLabel(rawLabel, sessionState)` 의 결과로 갱신한다.
 *
 * @returns 빈 `mapping` 과 `nextIndex = 1` 을 가진 신규 세션 상태.
 */
export function createInitialSpeakerLabelSessionState(): Speaker_Label_Session_State {
	return {
		mapping: new Map<string, string>(),
		nextIndex: 1,
	};
}

/**
 * raw 화자 식별자(`spk_N`) 를 표시용 라벨(`Speaker M`) 로 변환한다.
 *
 * 변환 규칙 (Requirement 6.4):
 * - 입력 `rawLabel` 이 `sessionState.mapping` 에 이미 존재하면, 캐시된 `displayLabel` 을
 *   그대로 반환하고 `sessionState` 를 변경하지 않는다 (안정성).
 * - 존재하지 않으면 `Speaker ${sessionState.nextIndex}` 를 부여하고, 새 매핑을 추가한
 *   복사본 + `nextIndex + 1` 을 가진 새 `sessionState` 를 반환한다 (injectivity 보존).
 *
 * 본 함수는 외부 효과 없는 순수 함수이며, 입력 `sessionState` 는 변형하지 않는다
 * (immutability). 입력으로 받은 `mapping` 의 참조나 내용물은 그대로 유지된다.
 *
 * @param rawLabel - AWS Transcribe Streaming 응답의 `Item.Speaker` 값(예: `"spk_0"`,
 *   `"spk_1"`). 빈 문자열도 정상 입력으로 취급한다 — 캐시되어 다음 호출에 재사용된다.
 * @param sessionState - 현재 세션의 누적 매핑 상태. 호출자는 반환된 새 `sessionState` 를
 *   다음 호출에 전달해야 한다.
 * @returns `displayLabel` (예: `"Speaker 1"`) 과 갱신된 `sessionState` 를 포함한 객체.
 *   `rawLabel` 이 캐시 hit 이면 반환된 `sessionState` 는 입력 `sessionState` 와
 *   참조 동일성(`===`) 을 가진다.
 */
export function mapSpeakerLabel(
	rawLabel: string,
	sessionState: Speaker_Label_Session_State,
): { displayLabel: string; sessionState: Speaker_Label_Session_State } {
	// 캐시 hit: 이미 등장한 raw label 은 캐시된 표시 라벨을 그대로 재사용한다.
	// sessionState 는 변형 없이 그대로 반환되므로 호출자는 동일 참조를 유지할 수 있다.
	const cached = sessionState.mapping.get(rawLabel);
	if (cached !== undefined) {
		return { displayLabel: cached, sessionState };
	}

	// 캐시 miss: 첫 등장 순서대로 `Speaker {nextIndex}` 를 부여한다.
	// 입력 `mapping` 을 복사한 새 Map 에 신규 항목을 추가하여 immutability 를 보존한다.
	const displayLabel = `Speaker ${sessionState.nextIndex}`;
	const nextMapping = new Map<string, string>(sessionState.mapping);
	nextMapping.set(rawLabel, displayLabel);

	const nextSessionState: Speaker_Label_Session_State = {
		mapping: nextMapping,
		nextIndex: sessionState.nextIndex + 1,
	};

	return { displayLabel, sessionState: nextSessionState };
}
