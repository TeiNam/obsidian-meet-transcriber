// 한국어 번역 파일
// - en.ts의 `Translations` 타입을 `import type`으로 가져와 준수한다.
// - 누락된 키가 있으면 컴파일 타임(tsc --noEmit)에 검출된다 (Requirement 10.1, 10.2).
// - 모든 UI 라벨은 자연스러운 한국어 표현을 우선하여 번역한다.

import type { Translations } from "./en";

export const ko: Translations = {
    view: {
        displayText: "전사",
        // 사이드바 최상단에 표시되는 섹션 제목. 탭 라벨(displayText)과 별개로
        // 사이드바가 독립 뷰처럼 보이도록 컨텐츠 영역 내부에도 타이틀을 노출한다.
        // 제품 아이덴티티를 드러내는 고유명사 성격이므로 로케일과 무관하게 영어로 통일한다.
        sidebarTitle: "Meeting Transcriber",
    },
    commands: {
        openView: "전사 뷰 열기",
    },
    buttons: {
        start: "스트리밍 시작",
        stop: "스트리밍 중지",
        edit: "편집",
        analyze: "분석",
        copy: "복사",
        save: "저장",
        cancel: "취소",
    },
    states: {
        idle: "대기",
        streaming: "스트리밍 중",
        stopped: "중지됨",
        error: "오류",
        reconnecting: "재연결 시도 중...",
    },
    ui: {
        // Sidebar_View 빈 상태 안내 (Requirement 1.10)
        empty: "전사된 내용이 없습니다.",
        // Bedrock 분석 진행 중 스피너 레이블 (Requirement 6.6)
        analyzing: "분석 중...",
        // 편집 모드 빈 내용 안내
        editorEmpty: "편집할 내용이 없습니다.",
        // 최근 전사 섹션 헤더
        recentTranscripts: "최근 전사",
        // 최근 전사 리스트에 항목이 없을 때
        noRecentTranscripts: "이전 전사 내역이 없습니다.",
        // 복사 성공 Notice
        copied: "전사 내용을 클립보드에 복사했습니다.",
        // 복사 실패 Notice
        copyFailed: "전사 내용을 클립보드에 복사하지 못했습니다.",
    },
    // 사이드바 인라인 컨트롤(언어/모델 선택) 라벨.
    // 설정 탭을 거치지 않고도 빠르게 세션 언어/분석 모델을 바꿀 수 있도록 하는 영역의 i18n.
    sidebar: {
        // 카테고리 그룹 헤더 — 입력/엔진/출력으로 컨트롤을 묶는다.
        groupInput: "입력",
        groupEngine: "엔진",
        groupOutput: "출력",
        // 라벨은 사용자 직관성을 위해 명확하게 표현한다 (사용자 요구).
        language: "입력 언어",
        model: "분석 모델",
        refreshModels: "모델 목록 새로고침",
        modelsLoading: "불러오는 중...",
        noModelsHint: "자격 증명을 입력하고 새로고침을 눌러 주세요.",
        // 마이크 선택 드롭다운 — 사이드바에서 입력 장치를 즉시 변경.
        microphone: "마이크",
        microphoneDefault: "시스템 기본 장치",
        refreshMicrophones: "마이크 목록 새로고침",
        microphoneUnknown: (idx: number): string => `마이크 ${idx}`,
        // 백엔드 선택 컨트롤 (task 33) — 사이드바에서 클라우드/로컬/자동 모드를 즉시 전환.
        backend: "백엔드",
        backendOptions: {
            "cloud-only": "클라우드 전용",
            "local-only": "로컬 전용",
            "auto": "자동",
        },
        // 활성 전사 엔진 표시 라벨 (task 33). cloud 백엔드 시 "AWS Transcribe", local 백엔드 시
        // "Hugging Face 모델 (<localModelId>)" 형태로 노출된다.
        activeEngine: "활성 엔진",
        cloudEngineLabel: "AWS Transcribe",
        localEngineLabel: (modelId: string): string =>
            `Hugging Face 모델 (${modelId.length > 0 ? modelId : "—"})`,
        // 화자 분리/번역 컨트롤 라벨 — task 24 에서 도입, task 28 에서 톤 정렬.
        speaker: "화자 분리",
        translation: "번역",
        targetLanguage: "번역 언어",
        // 화자 분리 활성 시 사이드바 상단에 항상 노출되는 안내 라벨 (Requirement 6.8).
        speakerCapacityNotice: "최대 10명까지 동시 화자를 인식할 수 있습니다",
        // 청크 결과가 200ms 초과 지연될 때 표시되는 인디케이터 텍스트 (Requirement 10.2).
        throttleIndicator: "청크 처리 중...",
        // 번역 활성 동안 status row 에 표시되는 누적 문자 수 prefix (Requirement 13.9).
        costCounter: (n: number): string => `번역 문자 수: ${n}`,
    },
    settings: {
        // UI_Locale 드롭다운 (Requirement 2.2 — 설정 탭의 첫 항목)
        language: {
            name: "표시 언어",
            desc: "플러그인 UI에서 사용할 표시 언어를 선택합니다.",
            options: {
                en: "English",
                ko: "한국어",
            },
        },
        // AWS 자격 증명 섹션 (Requirement 2.4 — setHeading 사용)
        awsHeading: "AWS 자격 증명",
        accessKeyId: {
            name: "AWS 액세스 키 ID",
            desc: "AWS IAM 액세스 키 ID (최대 128자).",
        },
        secretAccessKey: {
            name: "AWS 비밀 액세스 키",
            desc: "AWS IAM 비밀 액세스 키 (최대 256자). 마스킹되어 입력됩니다.",
        },
        region: {
            name: "AWS 리전",
            desc: "AWS Transcribe 및 Bedrock 요청에 사용할 리전입니다.",
        },
        // 전사 설정 섹션
        transcriptionHeading: "전사",
        languageCode: {
            name: "전사 언어",
            desc: "전사할 음성의 언어 코드입니다.",
        },
        transcriptFolder: {
            name: "전사 저장 폴더",
            desc: "전사 노트를 저장할 볼트 폴더입니다. 비워두면 볼트 루트에 저장됩니다.",
        },
        // 분석 설정 섹션 — Bedrock 모델 ID 컨트롤은 v1.1 정리에서 사이드바 인라인
        // 컨트롤로 이전되었다 (i18n: `sidebar.model`).
        analysisHeading: "분석",
        // Vocabulary 섹션 (A) — 전사 정확도를 높이는 AWS Transcribe 커스텀 어휘 이름
        vocabularyHeading: "단어장",
        transcribeVocabularyName: {
            name: "커스텀 단어 목록",
            desc: "AWS Transcribe 가 정확히 인식해야 할 단어와 구문입니다. 한 줄에 하나씩 입력하세요. 'AWS에 동기화' 버튼을 누르면 Custom Vocabulary 로 등록됩니다.",
            placeholder: "예시)\n쿠버네티스\nObsidian\n김철수 팀장",
            sync: "AWS에 동기화",
            syncing: "동기화 중...",
            syncSuccess: "단어장이 동기화되었습니다. 다음 전사부터 적용됩니다.",
            syncFailed: "단어장 동기화에 실패했습니다. 자격 증명을 확인하고 다시 시도하세요.",
            syncReady: "준비됨",
            syncPending: "처리 중...",
        },
        // Glossary 섹션 (B) — 분석 프롬프트에 삽입되는 사용자 지시
        analysisGlossary: {
            name: "분석 추가 지시",
            desc: "분석 모델에 전달할 추가 지시사항입니다. 자유롭게 작성하세요 — 특정 주제에 집중하거나, 형식을 지정하거나, 도메인 용어를 설명할 수 있습니다. 값이 있으면 전사 본문 앞에 삽입됩니다.",
            placeholder: "예시)\n예산 관련 결정 사항에 집중해 주세요.\nKPI = 핵심 성과 지표",
        },
        // About 섹션 — 보안 고지 (Requirement 2.13)
        aboutHeading: "정보",
        aboutNotice:
            "AWS 자격 증명은 .obsidian/plugins/obsidian-transcribe-plugin/data.json에 평문으로 저장됩니다. 볼트를 공유하거나 동기화할 때 이 파일도 함께 전송될 수 있습니다.",

        // ─── v1.1 신규 (task 24) ───
        // 본 섹션 키들은 task 28 (i18n 정리) 단계에서 정식 톤/이름으로 정렬되었다.

        // Local model 섹션 — 백엔드 선택 / 로컬 모델 / 모델 폴더 (Requirement 1.1~1.6, task 23)
        localModelHeading: "로컬 모델",
        backendSelectionMode: {
            name: "백엔드 선택 모드",
            desc: "전사 방식을 선택합니다. 클라우드는 AWS Transcribe 를, 로컬은 기기 내 Whisper 를 사용합니다. 자동은 클라우드를 먼저 시도하고 오프라인이거나 자격 증명이 누락되면 로컬로 폴백합니다.",
            options: {
                "cloud-only": "클라우드 전용",
                "local-only": "로컬 전용",
                "auto": "자동 (클라우드 우선, 실패 시 로컬)",
            },
        },
        localModelId: {
            name: "로컬 모델",
            desc: "로컬 전사에 사용할 Whisper 모델입니다. 큰 모델일수록 정확도가 높지만 더 많은 메모리와 디스크 공간이 필요합니다.",
            empty: "선택되지 않음",
            // 다운로드 버튼 라벨 — 설정 탭의 "모델 다운로드" 버튼과 옵션 표시명에서 공통 사용.
            download: "모델 다운로드",
            // 카탈로그 항목 1개의 표시명에 예상 크기를 함께 노출하기 위한 포매터.
            // 예: "Whisper Small (~466 MB)" — 옵션 라벨/desc 양쪽에서 일관되게 사용.
            sizeFormat: (sizeMb: number): string => `~${sizeMb} MB`,
        },
        modelFolder: {
            name: "모델 폴더",
            desc: "다운로드한 로컬 모델이 저장될 절대 경로입니다. 비워 두면 운영체제별 기본 위치를 사용합니다.",
            placeholder: "절대 경로 (예: /Users/you/Library/Application Support/obsidian-transcribe-plugin/models)",
        },
        streamingDisplayMode: {
            name: "스트리밍 표시 방식",
            desc: "로컬 전사 결과를 화면에 표시하는 방식입니다. '진행률만'은 스트리밍 종료 시점에 전체 본문을 한 번에 커밋하고, '청크 스트리밍'은 30 초마다 부분 결과를 노출합니다.",
            options: {
                "progress-only": "진행률만 표시 (종료 시 일괄 커밋)",
                "chunked-streaming": "청크 스트리밍 (30초 단위)",
            },
        },

        // Output 섹션 — 문장 타임스탬프 (Requirement 5.1).
        // 화자 분리 토글은 v1.1 정리에서 사이드바 인라인 컨트롤로 이전됨 (i18n: `sidebar.speaker`).
        outputHeading: "출력",
        timestampOutput: {
            name: "문장 타임스탬프",
            desc: "전사 결과를 [mm:ss] 또는 [hh:mm:ss] 프리픽스가 붙은 문장 단위 라인으로 저장합니다.",
        },
        // Translation 섹션은 v1.1 정리에서 사이드바 인라인 컨트롤로 이전되었다.
        // 다만 출력 형식(`outputFormat`) 라벨/옵션 텍스트는 사이드바 드롭다운이 그대로
        // 사용하므로 본 키만 남겨 둔다 (i18n 키 트리는 영/한 동일하게 유지).
        translation: {
            outputFormat: {
                name: "노트 저장 시 번역 포함",
                desc: "저장되는 전사 노트에 번역 텍스트를 함께 포함할지 여부를 선택합니다.",
                options: {
                    inline: "각 라인 아래에 포함",
                    none: "사이드바에만 표시(저장하지 않음)",
                },
            },
        },
    },
    notices: {
        // 마이크 권한 거부 (Requirement 3.9)
        micPermissionDenied: "전사를 시작하려면 마이크 권한이 필요합니다.",
        // Transcribe 세션 수립 타임아웃 (Requirement 3.10)
        sessionTimeout: "10초 이내에 전사 세션을 수립하지 못했습니다.",
        // 연결 단절 (Requirement 3.11, 8.5)
        connectionLost: "AWS Transcribe 연결이 끊어졌습니다.",
        // 재연결 시도 중 (Requirement 8.6)
        reconnecting: "AWS Transcribe에 재연결하고 있습니다...",
        // 재연결 최종 실패 (Requirement 8.7, 8.8)
        reconnectFailed:
            "AWS Transcribe 재연결에 실패했습니다. 현재까지의 전사 내용은 저장되었습니다.",
        // AWS 인증/권한 오류 (Requirement 6.13)
        awsAuthError:
            "AWS 인증에 실패했습니다. 액세스 키 ID와 비밀 액세스 키를 확인해 주세요.",
        // Bedrock 모델 리전 미지원 (Requirement 6.14)
        awsModelUnavailable:
            "선택한 Bedrock 모델은 설정된 리전에서 사용할 수 없습니다.",
        // AWS 네트워크 오류 (Requirement 6.15)
        awsNetworkError: "AWS와 통신하는 중 네트워크 오류가 발생했습니다.",
        // 파일 I/O 오류 (Requirement 4.8, 5.7)
        ioError: "파일 입출력 오류가 발생했습니다. 작성 중인 내용은 보존되었습니다.",
        // 설정 미완료 일반 메시지
        settingsIncomplete: "설정이 완료되지 않았습니다. 누락된 항목을 입력한 뒤 다시 시도해 주세요.",
        // 누락된 설정 항목을 나열하는 함수형 메시지 (Requirement 2.14)
        missingSettings: (fields: string[]): string => `누락된 설정: ${fields.join(", ")}`,
        // 전사 버퍼가 비어 있어 노트를 생성하지 않음 (Requirement 4.9)
        bufferEmpty: "전사 내용이 비어 있어 노트를 생성하지 않았습니다.",
        // 본문 길이 초과로 분석 중단 (Requirement 6.5)
        transcriptTooLong:
            "전사 본문이 200,000자를 초과하여 분석할 수 없습니다.",
        // Transcript_Folder 생성 실패 fallback (Requirement 4.5)
        folderCreateFailed:
            "전사 폴더를 생성하지 못했습니다. 볼트 루트에 저장합니다.",
        // 세션 종료 지연 경고 (Requirement 4.10)
        sessionTerminateSlow:
            "전사 세션이 제때 종료되지 않아 강제로 종료했습니다.",
        // 편집 저장 시 내용이 비어 있음 (Requirement 5.8)
        editEmpty: "내용이 비어 있어 저장하지 않았습니다.",
        // 스트리밍 중 편집/분석 차단 (Requirement 7.4)
        streamingBlockEditAnalyze: "스트리밍 중에는 편집과 분석을 사용할 수 없습니다.",
        // 설정 저장 성공 (Requirement 2.11)
        settingsSaved: "설정이 저장되었습니다.",
        // 설정 저장 실패 (Requirement 2.15)
        settingsSaveFailed: "설정을 저장하지 못했습니다.",
        // 단일 세션 불변식 위반 방지 (Requirement 7.6)
        singleSessionActive: "이미 진행 중인 전사 세션이 있습니다.",

        // ─── v1.1 신규 (task 28, design §Error Handling) ───
        // 백엔드 / 모델 (Requirement 3.7 auto 폴백 사유, Requirement 4 로컬 모델 상태)
        backendFallbackOffline:
            "오프라인 상태이므로 로컬 모드로 자동 전환됩니다.",
        backendFallbackNoCredentials:
            "AWS 자격 증명이 누락되어 로컬 모드로 자동 전환됩니다.",
        backendFallbackTimeout:
            "AWS Transcribe 응답 시간이 초과되어 로컬 모드로 자동 전환됩니다.",
        backendFallbackAuth:
            "AWS 인증에 실패하여 로컬 모드로 자동 전환됩니다.",
        // 네트워크 일반 오류로 인한 자동 폴백 — Auth/Timeout/Offline 어느 카테고리에도
        // 정확히 들어맞지 않는 일반 네트워크 오류(DNS 실패, ECONNREFUSED 등) 시에 사용.
        backendFallbackNetwork:
            "네트워크 오류로 인해 로컬 모드로 자동 전환됩니다.",
        localModelMissing: (modelId: string): string =>
            `로컬 모델 "${modelId}" 이(가) 설치되어 있지 않습니다. 설정에서 다운로드해 주세요.`,
        localModelCorrupted:
            "로컬 모델 파일이 손상되었습니다. 다시 다운로드해 주세요.",
        localSlowerThanRealtime:
            "로컬 모드는 실시간보다 느리게 전사될 수 있습니다.",
        localSpeakerDiarizationUnsupported:
            "로컬 모드(v1) 에서는 화자 분리가 지원되지 않습니다.",
        // 사이드바 안내 라벨 — 화자 분리 활성 시 노출 (Requirement 6.8). sidebar.speakerCapacityNotice 와
        // 같은 문구이지만 Notice 토스트 경로에서도 사용할 수 있도록 별도 키로 둔다 (design §Error Handling).
        speakerCapacityNotice:
            "최대 10명까지 동시 화자를 인식할 수 있습니다.",
        diskSpaceLowDuringDownload: (freeMb: number): string =>
            `사용 가능한 디스크 공간이 100MB 미만입니다(${freeMb}MB). 다운로드를 취소했습니다.`,
        diskSpaceLowDuringInference: (freeMb: number): string =>
            `사용 가능한 디스크 공간이 100MB 미만입니다(${freeMb}MB). 추론은 계속되지만 공간을 확보해 주세요.`,

        // 다운로드 모달 (Requirement 2.1~2.3, 2.5, 2.9)
        downloadConfirmTitle: "로컬 모델 다운로드",
        downloadConfirmDescription: (size: number, host: string): string =>
            `${host} 에서 약 ${size}MB 를 다운로드합니다. 계속하시겠습니까?`,
        downloadConfirmAgree: "동의 후 다운로드",
        downloadConfirmCancel: "취소",
        downloadCancelled: "다운로드가 취소되었습니다.",
        downloadFailedNetwork: (status: number): string =>
            `다운로드에 실패했습니다 (HTTP ${status}). 네트워크 연결을 확인해 주세요.`,
        downloadFailedChecksum:
            "모델 무결성 검증에 실패했습니다. 파일이 삭제되었습니다.",
        downloadFailedDisk:
            "다운로드 중 디스크 쓰기 오류가 발생했습니다. 파일이 삭제되었습니다.",

        // 번역 (Requirement 13.6, 14.5)
        translationFailedSingle: "(번역 실패)",
        translationAutoDisabled:
            "반복된 실패로 번역이 자동 비활성화되었습니다.",

        // 모드 게이트 (Requirement 14.8)
        // NOTE: 구 Requirement 13.8 의 `translationLocalNeedsNetwork` 는 v1.1 에서 제거되었고,
        // 그 자리를 아래 `translationOfflineUnsupported` 가 대체한다.
        translationOfflineUnsupported:
            "오프라인 모드에서는 실시간 번역이 비활성화됩니다.",
        analysisOfflineUnsupported:
            "오프라인 모드에서는 AI 분석이 비활성화됩니다.",
        // 사이드바 비활성 컨트롤 4종(번역 토글/대상 언어/화자 분리/분석 버튼) 공통 툴팁 (Requirement 14.2)
        tooltipOnlineOnlyFeature: "클라우드 모드에서만 사용할 수 있습니다",
        // 분석 버튼 단독 비활성 시 툴팁. 본 키는 `analysisOfflineUnsupported` 와 동일 문구를 재사용하지만,
        // 호출 위치(분석 버튼 단독 vs 4종 일괄)를 구분 가능하도록 별도 키로 분리한다 (design §4.8, task 25).
        tooltipAnalysisOfflineDisabled:
            "오프라인 모드에서는 AI 분석이 비활성화됩니다.",
    },
    // 분석 결과를 Transcript_Note에 부착할 때 사용하는 섹션 헤더 (Requirement 6.8)
    analysisHeader: "## 분석 결과",
};
