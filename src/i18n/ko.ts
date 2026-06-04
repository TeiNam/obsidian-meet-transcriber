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
        newSession: "새 전사",
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
        // 이어하기 세션 구분선 — 같은 노트에 이어 쓸 때 이전/새 구간을 시각적으로 구분한다.
        sessionDivider: (time: string) => `--- ${time} 이어서 ---`,
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
        // 화자 분리/번역 컨트롤 라벨.
        speaker: "화자 분리",
        translation: "번역",
        targetLanguage: "번역 언어",
        // 화자 분리 활성 시 사이드바 상단에 항상 노출되는 안내 라벨.
        speakerCapacityNotice: "최대 10명까지 동시 화자를 인식할 수 있습니다",
        // 번역 활성 동안 status row 에 표시되는 누적 문자 수 prefix.
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

        // Output 섹션 — 문장 타임스탬프.
        // 화자 분리 토글은 사이드바 인라인 컨트롤로 이전됨 (i18n: `sidebar.speaker`).
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
        // AI 교정 섹션 — Bedrock 모델로 노트 저장 직전 본문 표면 표기를 다듬는다.
        refine: {
            enabled: {
                name: "저장 시 AI 교정",
                desc: "노트로 저장하기 직전에 분석 모델로 맞춤법·띄어쓰기·문장부호만 교정합니다. 노트에는 교정본과 원본이 모두 함께 저장됩니다.",
            },
            instruction: {
                name: "교정 지시사항",
                desc: "교정 프롬프트에 덧붙일 자유 입력 지시문(선택). '단어 변경 금지·의역 금지' 같은 엄격한 규칙은 사용자 입력과 무관하게 항상 적용됩니다.",
                placeholder: "예시)\n'Obsidian' 같은 브랜드명은 표기 유지\n전체적으로 존댓말로 통일",
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

        // 사이드바 안내 라벨 — 화자 분리 활성 시 노출.
        speakerCapacityNotice:
            "최대 10명까지 동시 화자를 인식할 수 있습니다.",

        // 번역 실패 메시지.
        translationFailedSingle: "(번역 실패)",
        translationAutoDisabled:
            "반복된 실패로 번역이 자동 비활성화되었습니다.",

        // AI 교정 실패 — 원본 그대로 저장됨을 알림.
        refineFailed:
            "AI 교정에 실패했습니다. 원본 전사가 그대로 저장되었습니다.",
    },
    // 분석 결과를 Transcript_Note에 부착할 때 사용하는 섹션 헤더 (Requirement 6.8)
    analysisHeader: "## 분석 결과",
    // AI 교정본 / 원본 두 섹션 헤더. 사용자 결정 "원본 보존" 정책으로 양쪽 모두 노트에 저장.
    refinedHeader: "## 교정본",
    originalHeader: "## 원본",
};
