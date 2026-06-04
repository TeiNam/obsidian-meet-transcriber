import type { StreamingState } from "./StreamingStateMachine";

/**
 * 버튼 활성화 정책의 입력값.
 *
 * 세 개 버튼(시작/중지, 편집, 분석)의 활성 여부와 시작/중지 버튼의 레이블을
 * 결정하는 데 필요한 모든 외부 조건을 담는다. UI와 정책을 분리해 테스트 가능성을
 * 확보하기 위해 이 구조는 순수 값(primitive)만 포함한다.
 */
export interface ButtonStateInputs {
    /** 현재 스트리밍 상태(FSM). */
    streamingState: StreamingState;
    /** Bedrock 분석 진행 중 여부. */
    isAnalyzing: boolean;
    /** 사용자가 전사 본문 편집 모드에 있는지 여부. */
    isEditing: boolean;
    /** 현재 세션에 연결된 전사 노트 파일이 존재하는지 여부. */
    hasTranscriptNote: boolean;
    /** 전사 버퍼의 확정 본문 길이(문자 수). */
    transcriptLength: number;
    /** AWS 자격 증명(access key, secret key, region)이 모두 설정되었는지. */
    hasCredentials: boolean;
    /** Bedrock 모델 ID가 설정되었는지. */
    hasBedrockModel: boolean;
}

/**
 * 각 버튼의 활성 여부와 시작/중지 버튼의 레이블 키.
 *
 * 실제 레이블 문자열은 `SidebarView`에서 `t.buttons[labelKey]`로 로케일에 맞게
 * 해석한다. 정책은 키만 결정하고 문자열 해석에는 관여하지 않는다.
 */
export interface ButtonStates {
    startStop: { enabled: boolean; labelKey: "start" | "stop" };
    edit: { enabled: boolean };
    analyze: { enabled: boolean };
    /**
     * "새 전사 시작(초기화)" 버튼.
     *
     * 누르면 현재 버퍼/노트 참조를 비워 다음 `start`가 새 세션으로 시작되도록 한다.
     * 이어할 대상(노트 또는 버퍼 본문)이 있고, 스트리밍/분석/편집 중이 아닐 때만 활성.
     */
    newSession: { enabled: boolean };
}

/**
 * 입력값으로부터 버튼 활성화 상태를 결정한다(순수 함수, 부수효과 없음).
 *
 * 결정 규칙(design.md §4):
 * - `startStop.enabled`는 분석/편집 중이 아닐 때만 참이다. 즉 분석 중이나 편집
 *   중에는 스트리밍을 새로 시작하거나 중지할 수 없다.
 * - `startStop.labelKey`는 스트리밍 중이면 `"stop"`, 그 외에는 `"start"`이다.
 *   재연결 중(내부 플래그)도 외부 상태는 `streaming`이므로 레이블은 `"stop"`.
 * - `edit.enabled`는 전사 노트가 존재하고 본문이 1자 이상이며, 스트리밍 중이
 *   아니고, 분석/편집 중이 아닐 때만 참이다.
 * - `analyze.enabled`는 `edit.enabled`의 모든 조건에 더해 자격 증명과 Bedrock
 *   모델이 모두 설정되어 있을 때만 참이다.
 */
export function computeButtonStates(inputs: ButtonStateInputs): ButtonStates {
    const {
        streamingState,
        isAnalyzing,
        isEditing,
        hasTranscriptNote,
        transcriptLength,
        hasCredentials,
        hasBedrockModel,
    } = inputs;

    // 시작/중지 버튼: 분석/편집 중이 아닐 때만 활성, 레이블은 스트리밍 상태로 결정.
    const startStopEnabled = !isAnalyzing && !isEditing;
    const startStopLabelKey: "start" | "stop" =
        streamingState === "streaming" ? "stop" : "start";

    // 편집 버튼: 전사 노트와 본문이 존재하고, 스트리밍/분석/편집 중이 아닐 때만 활성.
    const editEnabled =
        hasTranscriptNote &&
        transcriptLength >= 1 &&
        streamingState !== "streaming" &&
        !isAnalyzing &&
        !isEditing;

    // 분석 버튼: 편집 조건 + AWS 자격 증명과 Bedrock 모델이 모두 필요.
    const analyzeEnabled = editEnabled && hasCredentials && hasBedrockModel;

    // 새 전사 시작(초기화) 버튼: 이어할 대상(노트 또는 버퍼 본문)이 있고,
    // 스트리밍/분석/편집 중이 아닐 때만 활성. 초기화할 게 없으면(빈 상태) 비활성.
    const newSessionEnabled =
        (hasTranscriptNote || transcriptLength >= 1) &&
        streamingState !== "streaming" &&
        !isAnalyzing &&
        !isEditing;

    return {
        startStop: { enabled: startStopEnabled, labelKey: startStopLabelKey },
        edit: { enabled: editEnabled },
        analyze: { enabled: analyzeEnabled },
        newSession: { enabled: newSessionEnabled },
    };
}
