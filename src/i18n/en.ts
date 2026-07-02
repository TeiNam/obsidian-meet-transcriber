// 영어(기본) 번역 파일
// - 모든 로케일 파일의 기준이 되는 소스이며, 누락 키가 있어서는 안 된다.
// - `Translations` 타입을 export하여 다른 로케일 파일이 컴파일 타임에 키 누락을 검출한다.
// - 모든 UI 라벨은 Sentence case로 작성한다 (Requirement 10.6).

export const en = {
    view: {
        displayText: "Transcribe",
        // 사이드바 최상단에 표시되는 섹션 제목. 탭 라벨(displayText)과 별개로
        // 사이드바가 독립 뷰처럼 보이도록 컨텐츠 영역 내부에도 타이틀을 노출한다.
        sidebarTitle: "Meeting Transcriber",
    },
    commands: {
        openView: "Open transcribe view",
    },
    buttons: {
        start: "Start streaming",
        stop: "Stop streaming",
        edit: "Edit",
        analyze: "Analyze",
        copy: "Copy",
        save: "Save",
        cancel: "Cancel",
        newSession: "New transcript",
    },
    states: {
        idle: "Idle",
        streaming: "Streaming",
        stopped: "Stopped",
        error: "Error",
        reconnecting: "Reconnecting...",
    },
    ui: {
        // Sidebar_View 빈 상태 안내 (Requirement 1.10)
        empty: "No transcript available.",
        // Bedrock 분석 진행 중 스피너 레이블 (Requirement 6.6)
        analyzing: "Analyzing...",
        // 중지 후 노트 저장 중 스피너 레이블
        saving: "Saving...",
        // 편집 모드 빈 내용 안내
        editorEmpty: "No content to edit.",
        // 복사 성공 Notice
        copied: "Transcript copied to clipboard.",
        // 복사 실패 Notice
        copyFailed: "Failed to copy transcript to clipboard.",
        // 이어하기 세션 구분선 — 같은 노트에 이어 쓸 때 이전/새 구간을 시각적으로 구분한다.
        sessionDivider: (time: string) => `--- Resumed at ${time} ---`,
    },
    // 사이드바 인라인 컨트롤(언어/모델 선택) 라벨.
    // 설정 탭을 거치지 않고도 빠르게 세션 언어/분석 모델을 바꿀 수 있도록 하는 영역의 i18n.
    sidebar: {
        // 카테고리 그룹 헤더 — 입력/엔진/출력으로 컨트롤을 묶어 시각적 위계를 부여한다.
        groupInput: "Input",
        groupEngine: "Engine",
        groupOutput: "Output",
        // 라벨 표현은 제품 사용자가 더 직관적으로 이해하도록 정리한다 (사용자 요구).
        language: "Input language",
        model: "Analysis model",
        refreshModels: "Refresh models",
        modelsLoading: "Loading...",
        noModelsHint: "Enter credentials and refresh.",
        // 마이크 선택 드롭다운 — 사이드바에서 입력 장치를 즉시 변경.
        microphone: "Microphone",
        microphoneDefault: "System default",
        refreshMicrophones: "Refresh microphones",
        // 권한 미부여 / 장치 enumerate 실패 시 라벨 fallback.
        microphoneUnknown: (idx: number): string => `Microphone ${idx}`,
        // 화자 분리/번역 컨트롤 라벨.
        speaker: "Speaker labels",
        translation: "Translation",
        targetLanguage: "Translation language",
        // 화자 분리 활성 시 사이드바 상단에 항상 노출되는 안내 라벨.
        speakerCapacityNotice:
            "Up to 10 simultaneous speakers can be identified",
        // 번역 활성 동안 status row 에 표시되는 누적 문자 수 prefix.
        costCounter: (n: number): string => `Translated chars: ${n}`,
    },
    settings: {
        // UI_Locale 드롭다운 (Requirement 2.2 — 설정 탭의 첫 항목)
        language: {
            name: "Display language",
            desc: "Select the display language for the plugin UI.",
            options: {
                en: "English",
                ko: "한국어",
            },
        },
        // AWS 자격 증명 섹션 (Requirement 2.4 — setHeading 사용)
        awsHeading: "AWS credentials",
        accessKeyId: {
            name: "AWS access key ID",
            desc: "Your AWS IAM access key ID (up to 128 characters).",
        },
        secretAccessKey: {
            name: "AWS secret access key",
            desc: "Your AWS IAM secret access key (up to 256 characters). Masked input.",
        },
        region: {
            name: "AWS region",
            desc: "Region used for AWS Transcribe and Bedrock requests.",
        },
        // 전사 설정 섹션
        transcriptionHeading: "Transcription",
        languageCode: {
            name: "Transcription language",
            desc: "Language code of the spoken audio to transcribe.",
        },
        transcriptFolder: {
            name: "Transcript folder",
            desc: "Vault folder where transcript notes are saved. Leave empty to use the vault root.",
        },
        // 분석 설정 섹션 — Bedrock 모델 ID 컨트롤은 v1.1 정리에서 사이드바 인라인
        // 컨트롤로 이전되었다 (i18n: `sidebar.model`).
        analysisHeading: "Analysis",
        // Vocabulary 섹션 (A) — 전사 정확도를 높이는 AWS Transcribe 커스텀 어휘 이름
        vocabularyHeading: "Vocabulary",
        transcribeVocabularyName: {
            name: "Custom vocabulary words",
            desc: "Words and phrases that AWS Transcribe should recognize accurately. One per line. Click 'Sync to AWS' to register them as a Custom Vocabulary.",
            placeholder: "e.g.\nKubernetes\nObsidian\nJohn Smith",
            sync: "Sync to AWS",
            syncing: "Syncing...",
            syncSuccess: "Vocabulary synced successfully. It will be used on next transcription.",
            syncFailed: "Vocabulary sync failed. Check credentials and try again.",
            syncReady: "Ready",
            syncPending: "Processing...",
        },
        // Glossary 섹션 (B) — 분석 프롬프트에 삽입되는 사용자 지시
        analysisGlossary: {
            name: "Custom analysis prompt",
            desc: "Additional instructions for the analysis model. Write freely — for example, ask it to focus on certain topics, use a specific format, or explain domain-specific terms. Included before the transcript when present.",
            placeholder: "e.g.\nFocus on budget-related decisions.\nKPI = Key Performance Indicator",
        },
        // About 섹션 — 보안 고지 (Requirement 2.13)
        aboutHeading: "About",
        aboutNotice:
            "AWS credentials are stored in plain text at .obsidian/plugins/obsidian-transcribe-plugin/data.json. When you share or sync your vault, this file may be transferred together.",

        // Output 섹션 — 문장 타임스탬프.
        // 화자 분리 토글은 사이드바 인라인 컨트롤로 이전됨 (i18n: `sidebar.speaker`).
        outputHeading: "Output",
        timestampOutput: {
            name: "Sentence timestamps",
            desc: "Save transcripts as sentence-level lines prefixed with [mm:ss] or [hh:mm:ss].",
        },
        // Translation 섹션은 v1.1 정리에서 사이드바 인라인 컨트롤로 이전되었다.
        // 다만 출력 형식(`outputFormat`) 라벨/옵션 텍스트는 사이드바 드롭다운이 그대로
        // 사용하므로 본 키만 남겨 둔다 (i18n 키 트리는 영/한 동일하게 유지).
        translation: {
            outputFormat: {
                name: "Translation in saved note",
                desc: "Choose whether the translated text is included in the saved transcript note.",
                options: {
                    inline: "Include below each line",
                    none: "Sidebar only (do not save)",
                },
            },
        },
    },
    notices: {
        // 마이크 권한 거부 (Requirement 3.9)
        micPermissionDenied: "Microphone permission is required to start transcription.",
        // Transcribe 세션 수립 타임아웃 (Requirement 3.10)
        sessionTimeout: "Could not establish the transcription session within 10 seconds.",
        // 연결 단절 (Requirement 3.11, 8.5)
        connectionLost: "Connection to AWS Transcribe was lost.",
        // 재연결 시도 중 (Requirement 8.6)
        reconnecting: "Reconnecting to AWS Transcribe...",
        // 재연결 최종 실패 (Requirement 8.7, 8.8)
        reconnectFailed:
            "Failed to reconnect to AWS Transcribe. The current transcript has been saved.",
        // AWS 인증/권한 오류 (Requirement 6.13)
        awsAuthError:
            "AWS authentication failed. Check your access key ID and secret access key.",
        // Bedrock 모델 리전 미지원 (Requirement 6.14)
        awsModelUnavailable:
            "The selected Bedrock model is not available in the configured region.",
        // AWS 네트워크 오류 (Requirement 6.15)
        awsNetworkError: "A network error occurred while contacting AWS.",
        // 파일 I/O 오류 (Requirement 4.8, 5.7)
        ioError: "A file I/O error occurred. Your content has been preserved.",
        // 설정 미완료 일반 메시지
        settingsIncomplete: "Settings are incomplete. Fill in the missing fields and try again.",
        // 누락된 설정 항목을 나열하는 함수형 메시지 (Requirement 2.14)
        missingSettings: (fields: string[]): string => `Missing settings: ${fields.join(", ")}`,
        // 전사 버퍼가 비어 있어 노트를 생성하지 않음 (Requirement 4.9)
        bufferEmpty: "The transcript is empty. No note was created.",
        // 본문 길이 초과로 분석 중단 (Requirement 6.5)
        transcriptTooLong:
            "The transcript exceeds 200,000 characters and cannot be analyzed.",
        // Transcript_Folder 생성 실패 fallback (Requirement 4.5)
        folderCreateFailed:
            "Could not create the transcript folder. Saving to the vault root instead.",
        // 세션 종료 지연 경고 (Requirement 4.10)
        sessionTerminateSlow:
            "The transcription session did not terminate in time and was forced to close.",
        // 편집 저장 시 내용이 비어 있음 (Requirement 5.8)
        editEmpty: "The content is empty. Save cancelled.",
        // 스트리밍 중 편집/분석 차단 (Requirement 7.4)
        streamingBlockEditAnalyze: "Edit and analyze are unavailable while streaming.",
        // 설정 저장 성공 (Requirement 2.11)
        settingsSaved: "Settings saved.",
        // 설정 저장 실패 (Requirement 2.15)
        settingsSaveFailed: "Failed to save settings.",
        // 단일 세션 불변식 위반 방지 (Requirement 7.6)
        singleSessionActive: "A transcription session is already active.",

        // 사이드바 안내 라벨 — 화자 분리 활성 시 노출.
        speakerCapacityNotice:
            "Up to 10 simultaneous speakers can be identified.",

        // 번역 실패 메시지.
        translationFailedSingle: "(translation failed)",
        translationAutoDisabled:
            "Translation auto-disabled after repeated failures.",
    },
    // 콜아웃 섹션 제목. 노트 본문은 분석(summary) → 원본(quote) 순서의 콜아웃 구조로
    // 고정 기록된다. `## ` prefix 없이 제목 텍스트만 둔다.
    // `refinedHeader`는 AI 교정 기능 제거 후에도 과거에 생성된 노트의 `tip` 콜아웃을
    // 이어쓰기(재직렬화) 할 때 제목을 유지하기 위해 남아 있다.
    analysisHeader: "Analysis result",
    refinedHeader: "Refined transcript",
    originalHeader: "Original transcript",
};

// 모든 로케일 파일이 준수해야 하는 번역 키 구조 타입.
// ko.ts 등 다른 로케일 파일은 `import type { Translations } from "./en"`로 불러와
// 컴파일 타임에 누락 키를 검출한다 (Requirement 10.1, 10.2).
export type Translations = typeof en;
