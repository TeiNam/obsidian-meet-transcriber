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
        // 편집 모드 빈 내용 안내
        editorEmpty: "No content to edit.",
        // 최근 전사 섹션 헤더
        recentTranscripts: "Recent transcripts",
        // 최근 전사 리스트에 항목이 없을 때
        noRecentTranscripts: "No previous transcripts.",
        // 복사 성공 Notice
        copied: "Transcript copied to clipboard.",
        // 복사 실패 Notice
        copyFailed: "Failed to copy transcript to clipboard.",
    },
    // 사이드바 인라인 컨트롤(언어/모델 선택) 라벨.
    // 설정 탭을 거치지 않고도 빠르게 세션 언어/분석 모델을 바꿀 수 있도록 하는 영역의 i18n.
    sidebar: {
        language: "Language",
        model: "Model",
        refreshModels: "Refresh models",
        modelsLoading: "Loading...",
        noModelsHint: "Enter credentials and refresh.",
        // 백엔드 선택 컨트롤 (task 33) — 사이드바에서 클라우드/로컬/자동 모드를 즉시 전환.
        backend: "Backend",
        backendOptions: {
            "cloud-only": "Cloud only",
            "local-only": "Local only",
            "auto": "Auto",
        },
        // 활성 전사 엔진 표시 라벨 (task 33). cloud 백엔드 시 "AWS Transcribe", local 백엔드 시
        // "Hugging Face model (<localModelId>)" 형태로 노출된다.
        activeEngine: "Engine",
        cloudEngineLabel: "AWS Transcribe",
        localEngineLabel: (modelId: string): string =>
            `Hugging Face model (${modelId.length > 0 ? modelId : "—"})`,
        // 화자 분리/번역 컨트롤 라벨 — task 24 에서 도입, task 28 에서 톤 정렬.
        speaker: "Speaker labels",
        translation: "Translation",
        targetLanguage: "Target language",
        // 화자 분리 활성 시 사이드바 상단에 항상 노출되는 안내 라벨 (Requirement 6.8).
        speakerCapacityNotice:
            "Up to 10 simultaneous speakers can be identified",
        // 청크 결과가 200ms 초과 지연될 때 표시되는 인디케이터 텍스트 (Requirement 10.2).
        throttleIndicator: "Processing chunk...",
        // 번역 활성 동안 status row 에 표시되는 누적 문자 수 prefix (Requirement 13.9).
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

        // ─── v1.1 신규 (task 24) ───
        // 본 섹션 키들은 task 28 (i18n 정리) 단계에서 정식 톤/이름으로 정렬되었다.

        // Local model 섹션 — 백엔드 선택 / 로컬 모델 / 모델 폴더 (Requirement 1.1~1.6, task 23)
        localModelHeading: "Local model",
        backendSelectionMode: {
            name: "Backend selection mode",
            desc: "Choose how transcription is performed. Cloud uses AWS Transcribe; local runs Whisper on your device; auto tries cloud first and falls back to local when offline or credentials are missing.",
            options: {
                "cloud-only": "Cloud only",
                "local-only": "Local only",
                "auto": "Auto (cloud first, fallback to local)",
            },
        },
        localModelId: {
            name: "Local model",
            desc: "Whisper model used for local transcription. Larger models give higher accuracy but require more memory and disk space.",
            empty: "Not selected",
            // 다운로드 버튼 라벨 — 설정 탭의 "Download model" 버튼과 옵션 표시명에서 공통 사용.
            download: "Download model",
            // 카탈로그 항목 1개의 표시명에 예상 크기를 함께 노출하기 위한 포매터.
            // 예: "Whisper Small (~466 MB)" — 옵션 라벨/desc 양쪽에서 일관되게 사용.
            sizeFormat: (sizeMb: number): string => `~${sizeMb} MB`,
        },
        modelFolder: {
            name: "Model folder",
            desc: "Absolute filesystem path where downloaded local models are stored. Leave empty to use the OS-specific default location.",
            placeholder: "Absolute path (e.g. /Users/you/Library/Application Support/obsidian-transcribe-plugin/models)",
        },
        streamingDisplayMode: {
            name: "Streaming display mode",
            desc: "How local transcription results are surfaced. Progress only commits the full transcript when streaming stops; chunked streaming surfaces partial results every 30 seconds.",
            options: {
                "progress-only": "Progress only (commit at end)",
                "chunked-streaming": "Chunked streaming (every 30s)",
            },
        },

        // Output 섹션 — 문장 타임스탬프 (Requirement 5.1).
        // 화자 분리 토글은 v1.1 정리에서 사이드바 인라인 컨트롤로 이전됨 (i18n: `sidebar.speaker`).
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

        // ─── v1.1 신규 (task 28, design §Error Handling) ───
        // 백엔드 / 모델 (Requirement 3.7 auto 폴백 사유, Requirement 4 로컬 모델 상태)
        backendFallbackOffline:
            "Auto fallback to local mode: device is offline.",
        backendFallbackNoCredentials:
            "Auto fallback to local mode: AWS credentials missing.",
        backendFallbackTimeout:
            "Auto fallback to local mode: AWS Transcribe timed out.",
        backendFallbackAuth:
            "Auto fallback to local mode: AWS authentication failed.",
        // 네트워크 일반 오류로 인한 자동 폴백 — Auth/Timeout/Offline 어느 카테고리에도
        // 정확히 들어맞지 않는 일반 네트워크 오류(DNS 실패, ECONNREFUSED 등) 시에 사용.
        backendFallbackNetwork:
            "Auto fallback to local mode: network error.",
        localModelMissing: (modelId: string): string =>
            `Local model "${modelId}" is not installed. Open settings to download it.`,
        localModelCorrupted:
            "Local model file is corrupted. Please re-download it.",
        localSlowerThanRealtime:
            "Local mode may transcribe slower than real-time.",
        localSpeakerDiarizationUnsupported:
            "Speaker diarization is not supported in local mode (v1).",
        // 사이드바 안내 라벨 — 화자 분리 활성 시 노출 (Requirement 6.8). sidebar.speakerCapacityNotice 와
        // 같은 문구이지만 Notice 토스트 경로에서도 사용할 수 있도록 별도 키로 둔다 (design §Error Handling).
        speakerCapacityNotice:
            "Up to 10 simultaneous speakers can be identified.",
        diskSpaceLowDuringDownload: (freeMb: number): string =>
            `Free disk space below 100MB (${freeMb}MB). Download cancelled.`,
        diskSpaceLowDuringInference: (freeMb: number): string =>
            `Free disk space below 100MB (${freeMb}MB). Inference continues but please free up space.`,

        // 다운로드 모달 (Requirement 2.1~2.3, 2.5, 2.9)
        downloadConfirmTitle: "Download local model",
        downloadConfirmDescription: (size: number, host: string): string =>
            `This will download approximately ${size}MB from ${host}. Continue?`,
        downloadConfirmAgree: "Agree and download",
        downloadConfirmCancel: "Cancel",
        downloadCancelled: "Download cancelled.",
        downloadFailedNetwork: (status: number): string =>
            `Download failed (HTTP ${status}). Check your network connection.`,
        downloadFailedChecksum:
            "Model integrity check failed. The file has been deleted.",
        downloadFailedDisk:
            "Disk write error during download. The file has been deleted.",

        // 번역 (Requirement 13.6, 14.5)
        translationFailedSingle: "(translation failed)",
        translationAutoDisabled:
            "Translation auto-disabled after repeated failures.",

        // 모드 게이트 (Requirement 14.8)
        // NOTE: 구 Requirement 13.8 의 `translationLocalNeedsNetwork` 는 v1.1 에서 제거되었고,
        // 그 자리를 아래 `translationOfflineUnsupported` 가 대체한다.
        translationOfflineUnsupported:
            "Real-time translation is disabled in offline mode.",
        analysisOfflineUnsupported:
            "AI analysis is disabled in offline mode.",
        // 사이드바 비활성 컨트롤 4종(번역 토글/대상 언어/화자 분리/분석 버튼) 공통 툴팁 (Requirement 14.2)
        tooltipOnlineOnlyFeature: "Available in cloud mode only",
        // 분석 버튼 단독 비활성 시 툴팁. 본 키는 `analysisOfflineUnsupported` 와 동일 문구를 재사용하지만,
        // 호출 위치(분석 버튼 단독 vs 4종 일괄)를 구분 가능하도록 별도 키로 분리한다 (design §4.8, task 25).
        tooltipAnalysisOfflineDisabled:
            "AI analysis is disabled in offline mode.",
    },
    // 분석 결과를 Transcript_Note에 부착할 때 사용하는 섹션 헤더 (Requirement 6.8)
    analysisHeader: "## Analysis result",
};

// 모든 로케일 파일이 준수해야 하는 번역 키 구조 타입.
// ko.ts 등 다른 로케일 파일은 `import type { Translations } from "./en"`로 불러와
// 컴파일 타임에 누락 키를 검출한다 (Requirement 10.1, 10.2).
export type Translations = typeof en;
