# Implementation Plan: obsidian-transcribe-plugin

## Overview

본 구현 계획은 `obsidian-transcribe-plugin` 스펙의 요구사항(requirements.md)과 설계(design.md)를 바탕으로, 순수 로직 모듈을 먼저 테스트 가능한 형태로 구축한 뒤 AWS SDK와 Obsidian Plugin API에 의존하는 I/O 계층을 쌓고, 마지막에 진입점에서 모든 구성 요소를 조립하는 **아래에서 위로(bottom-up)** 접근을 따른다.

- **언어/빌드**: TypeScript (`strict: true`) + `esbuild` (Obsidian 공식 샘플 템플릿, `external: [...builtin-modules]`)
- **테스트**: `vitest` + `fast-check` (PBT) + `aws-sdk-client-mock` (AWS SDK 모킹)
- **PBT 우선 적용 대상**: 상태 머신, 버튼 정책, 전사 버퍼, 설정 검증, 파일명 충돌 회피, 프론트매터 직렬화, 분석 결과 부착, 경로 정규화 등 순수 결정적 로직
- **예시/모킹 테스트 대상**: AWS Transcribe Streaming 세션 수립/재연결, Bedrock 오류 분기, 마이크 캡처, Vault I/O, 사이드바 DOM 렌더링, i18n 전환
- **심사 준수**: `createEl`만 사용(innerHTML 금지), `Vault.process` API 사용, `registerEvent`/`registerDomEvent`로 리스너 관리, CSS 변수 기반 스타일, `console.error`만 사용, `normalizePath` 적용

설계 문서의 **15개 Correctness Property** 각각은 별도의 optional 테스트 sub-task로 분리하여 대응 구현 직후에 배치한다.

## Tasks

- [x] 1. 프로젝트 스캐폴딩 및 매니페스트 구성
  - [x] 1.1 프로젝트 루트 구성 파일 작성
    - `package.json`에 스크립트(`dev`, `build`, `test`, `lint`)와 개발 의존성(`obsidian`, `typescript`, `esbuild`, `builtin-modules`, `vitest`, `fast-check`, `aws-sdk-client-mock`, `@types/node`) 및 런타임 의존성(`@aws-sdk/client-transcribe-streaming`, `@aws-sdk/client-bedrock-runtime`) 정의
    - `tsconfig.json`에 `target: ES2020`, `module: ESNext`, `strict: true`, `moduleResolution: node`, `esModuleInterop: true`, `isolatedModules: true` 구성
    - `esbuild.config.mjs`에 `entryPoints: ["src/main.ts"]`, `external: ["obsidian", "electron", "@codemirror/*", "@lezer/*", ...builtins]`, `format: "cjs"`, `target: "chrome106"`, 프로덕션 모드에서 `minify: true`와 소스맵 비활성화 설정
    - `.gitignore`에 `node_modules/`, `main.js`, `*.log`, `data.json` 추가
    - _Requirements: 9.10_

  - [x] 1.2 `manifest.json`과 `versions.json` 작성
    - `manifest.json`: `id: "obsidian-transcribe-plugin"`, `name: "Transcribe"`, `version: "0.1.0"`, `minAppVersion: "1.4.0"`, `description`(250자 이하, 행동 문장, 마침표 종료, 이모지 없음), `author`, `authorUrl`, `isDesktopOnly: true`
    - `versions.json`: `{"0.1.0": "1.4.0"}`
    - _Requirements: 9.1, 9.2_

  - [x] 1.3 저장소 루트에 `LICENSE`와 `README.md` 작성
    - `LICENSE`: MIT 라이선스 전문
    - `README.md`: (a) 외부 네트워크 사용(AWS Transcribe, AWS Bedrock 엔드포인트 호출), (b) 사용자의 AWS 계정 및 자격 증명 필요, (c) AWS 사용에 따른 과금 책임은 사용자, (d) AWS 자격 증명이 `.obsidian/plugins/<plugin-id>/data.json`에 평문으로 저장됨을 명시
    - _Requirements: 9.3, 9.4_

- [x] 2. 공통 타입 및 상수 정의
  - [x] 2.1 `src/types/settings.ts` — `TranscribeSettings`, `AwsCredentials`, `DEFAULT_SETTINGS` 정의
    - `SupportedLocale`, `LanguageCode("ko-KR" | "en-US")` 등 리터럴 타입
    - `DEFAULT_SETTINGS`: `uiLocale: "en"`, `region: "us-east-1"`, `languageCode: "ko-KR"`, 나머지 빈 문자열
    - _Requirements: 2.5, 2.6, 2.7, 2.8, 2.9, 2.10_

  - [x] 2.2 `src/types/errors.ts` — `TranscribeError` 클래스와 에러 코드 유니온 타입
    - `code`: `"MIC_PERMISSION_DENIED" | "SESSION_TIMEOUT" | "CONNECTION_LOST" | "RECONNECT_EXHAUSTED" | "AWS_AUTH" | "AWS_MODEL_UNAVAILABLE" | "AWS_NETWORK" | "IO_ERROR" | "SETTINGS_INCOMPLETE" | "BUFFER_EMPTY" | "TRANSCRIPT_TOO_LONG" | "FOLDER_CREATE_FAILED"`
    - `cause?: unknown` 필드 포함
    - _Requirements: 3.10, 6.11, 6.13, 6.14, 6.15, 8.7_

- [x] 3. 국제화(i18n) 모듈 구축
  - [x] 3.1 `src/i18n/en.ts` — 기본 영어 번역과 `Translations` 타입 export
    - 키 그룹: `view`, `commands`, `buttons`, `states`, `ui`, `settings`, `notices`
    - `notices.missingSettings: (fields: string[]) => string` 같은 함수형 키 포함
    - _Requirements: 10.1, 10.2, 10.6_

  - [x] 3.2 `src/i18n/ko.ts` — 한국어 번역(`Translations` 타입 준수)
    - `import type { Translations } from "./en"` → `const ko: Translations = { ... }`로 키 누락 컴파일 타임 검출
    - _Requirements: 10.1, 10.2_

  - [x] 3.3 `src/i18n/index.ts` — `detectLocale`, `createI18n`, `SupportedLocale`
    - `detectLocale(setting?: string)`: 설정 > `navigator.language.split("-")[0]` > `"en"` 순
    - `createI18n(locale)`: `LOCALES[locale] ?? en` 반환
    - _Requirements: 10.3_

  - [x]* 3.4 `src/i18n/index.test.ts` — `detectLocale` 예시 테스트
    - 설정 우선, 시스템 언어 감지, fallback 동작
    - _Requirements: 10.3_

- [x] 4. 상태 머신 구현 및 속성 테스트
  - [x] 4.1 `src/state/StreamingStateMachine.ts` — FSM 구현
    - `StreamingState`, `StreamingEvent` 타입, `dispatch`, `isReconnecting`, `onChange` 리스너 등록/해제
    - 전이 테이블(design.md §3)에 따라 유효하지 않은 전이는 상태 불변 또는 `IllegalTransitionError`
    - `CONNECTION_LOST` 시 외부 상태는 `streaming` 유지, 내부 `reconnecting` 플래그 on
    - _Requirements: 3.3, 3.11, 4.1, 8.5, 8.7_

  - [x]* 4.2 `src/state/StreamingStateMachine.property.test.ts` — 속성 테스트
    - **Property 1: 상태 머신 전이 규칙**
    - **Validates: Requirements 3.3, 3.10, 3.11, 4.1, 7.5, 7.6, 8.7**
    - `fc.assert(fc.property(fc.array(eventArb), ...), { numRuns: 200 })`

- [x] 5. 버튼 정책 구현 및 속성 테스트
  - [x] 5.1 `src/state/ButtonStatePolicy.ts` — 순수 함수 `computeButtonStates`
    - `ButtonStateInputs` → `ButtonStates`
    - `startStop.labelKey = streamingState === "streaming" ? "stop" : "start"`
    - `startStop.enabled = !isAnalyzing && !isEditing`
    - `edit.enabled = hasTranscriptNote && transcriptLength >= 1 && streamingState !== "streaming" && !isAnalyzing && !isEditing`
    - `analyze.enabled = edit.enabled + hasCredentials && hasBedrockModel`
    - _Requirements: 3.8, 5.1, 5.2, 6.1, 6.2, 6.3, 6.7, 7.1, 7.2, 7.3_

  - [x]* 5.2 `src/state/ButtonStatePolicy.property.test.ts` — 속성 테스트
    - **Property 2: 버튼 상태 결정 규칙**
    - **Validates: Requirements 3.8, 5.1, 5.2, 6.1, 6.2, 6.3, 6.7, 7.1, 7.2, 7.3, 8.8**

- [x] 6. 전사 버퍼 구현 및 속성 테스트
  - [x] 6.1 `src/domain/TranscriptBuffer.ts` — 누적/치환/공백 검출
    - `appendFinal`, `setPartial`, `getSnapshot`, `getCommittedText`, `length`, `clear`, `isEmpty`
    - `isEmpty`: 유니코드 공백(`\s` + 전각 공백 `\u3000`) 전용일 때 `true`
    - _Requirements: 3.6, 3.7, 4.9, 5.8_

  - [x]* 6.2 `src/domain/TranscriptBuffer.property.test.ts` — 속성 테스트 2종
    - **Property 3: 누적 및 치환 규칙**
    - **Validates: Requirements 3.6, 3.7**
    - **Property 4: 공백 전용 검출**
    - **Validates: Requirements 4.9, 5.8**

- [x] 7. 설정 저장소와 검증 구현
  - [x] 7.1 `src/settings/SettingsStore.ts` — `load`, `save`, `validate` 순수 함수
    - `load`: `Object.assign({}, DEFAULT_SETTINGS, await plugin.loadData())`
    - `save`: `await plugin.saveData(settings)`
    - `validate(settings)`: 길이/로케일/리전 비어있음/언어 코드 검증 후 `{ errors: string[] }`
    - _Requirements: 2.5, 2.6, 2.7, 2.8, 2.9, 2.11, 2.12, 2.15, 2.16, 10.3_

  - [x]* 7.2 `src/settings/SettingsStore.property.test.ts` — 속성 테스트
    - **Property 5: 설정 길이 검증 규칙**
    - **Validates: Requirements 2.5, 2.6, 2.8, 2.16, 10.3**

  - [x]* 7.3 `src/settings/SettingsStore.example.test.ts` — `load`/`save` 예시 테스트
    - 기본값 머지, Plugin.loadData 목 사용 저장 성공 / I/O 실패 시 이전 값 유지
    - _Requirements: 2.11, 2.15_

- [x] 8. 노트 저장소 구현 및 속성 테스트
  - [x] 8.1 `src/services/NoteStore.ts` — 파일 I/O 래퍼
    - `resolveUniqueFilename(base, existing)`: 순수 함수, `-N` 접미사 규칙
    - `ensureFolder(folder)`: `normalizePath` → `createFolder` 시도 → 실패 시 vault 루트 fallback 후 `Notice`
    - `saveTranscript(body, meta, folder, now?)`: 프론트매터 직렬화(ISO 8601, `language` 검증), `Transcribe-YYYYMMDD-HHmmss.md` 생성
    - `overwriteTranscript(file, newBody)`: `Vault.process` 사용, 기존 프론트매터 보존
    - `appendAnalysis(file, analysis, locale)`: `Vault.process`로 본문 끝에 locale별 헤더 + 분석 결과 섹션 추가
    - `readTranscriptBody(file)`: 프론트매터 제외 본문 반환
    - _Requirements: 4.4, 4.5, 4.6, 4.7, 4.8, 5.5, 6.8, 6.9, 6.10, 9.8, 9.9_

  - [x]* 8.2 `src/services/NoteStore.property.test.ts` — 속성 테스트 5종
    - **Property 6: 파일명 충돌 회피 규칙**
    - **Validates: Requirement 4.4**
    - **Property 7: 프론트매터 직렬화 보존**
    - **Validates: Requirement 4.6**
    - **Property 8: 편집 덮어쓰기 본문 보존 규칙**
    - **Validates: Requirements 5.5, 9.9**
    - **Property 9: 분석 결과 부착 규칙**
    - **Validates: Requirements 6.8, 6.9, 6.10**
    - **Property 15: 경로 정규화 안전성**
    - **Validates: Requirement 9.8**

  - [x]* 8.3 `src/services/NoteStore.example.test.ts` — Vault 모킹 예시 테스트
    - 폴더 부재 시 루트 fallback + Notice 발생
    - I/O 오류 시 에러 전파, Transcript_Buffer 유지(호출 측 책임)
    - _Requirements: 4.5, 4.8_

- [x] 9. 첫 번째 체크포인트 — 순수 로직 계층 검증
  - Ensure all tests pass, ask the user if questions arise.

- [x] 10. 오디오 캡처 파이프라인 구현
  - [x] 10.1 `src/services/AudioCapture.ts` — 마이크 권한 요청 및 PCM 변환
    - `requestPermission()`: `navigator.mediaDevices.getUserMedia({ audio: { sampleRate: 16000, channelCount: 1, echoCancellation: true } })`
    - `pcmChunks(stream, chunkMs = 100)`: `AudioContext` + `AudioWorkletNode`로 Float32 → Int16 PCM 변환, 48kHz 입력 시 3:1 다운샘플링
    - `stop(stream)`: 모든 트랙 `stop()` + `AudioContext.close()`
    - _Requirements: 3.1, 3.4, 8.3_

  - [x] 10.2 `src/audio/pcm-worklet.js` — AudioWorklet 프로세서 스크립트
    - 샘플 수집 → Int16 변환 → `postMessage`로 청크 전달
    - _Requirements: 3.4_

  - [x]* 10.3 `src/services/AudioCapture.example.test.ts` — `getUserMedia` 모킹 예시 테스트
    - 권한 허용 / 거부(NotAllowedError) 분기
    - `stop()` 호출 시 트랙 `stop()` 검증
    - _Requirements: 3.1, 3.9, 8.3_

- [x] 11. Bedrock 분석 서비스 구현 및 속성 테스트
  - [x] 11.1 `src/services/BedrockService.ts` — AWS Bedrock Runtime 호출
    - 길이 사전 검증: `transcript.length > 100000` → `TranscribeError("TRANSCRIPT_TOO_LONG")` 즉시 throw, SDK `send` 미호출
    - `AbortController`로 30초 타임아웃 강제
    - Claude 3 계열 요청 본문 구성, locale별 분석 프롬프트
    - 에러 분기: `AccessDeniedException`/`UnrecognizedClientException` → `AWS_AUTH`, `ValidationException` → `AWS_MODEL_UNAVAILABLE`, 그 외 → `AWS_NETWORK`
    - _Requirements: 6.4, 6.5, 6.11, 6.12, 6.13, 6.14, 6.15_

  - [x]* 11.2 `src/services/BedrockService.property.test.ts` — 속성 테스트
    - **Property 10: 본문 길이 경계 검증 규칙**
    - **Validates: Requirement 6.5**
    - `aws-sdk-client-mock`의 `send` 호출 카운트 검증

  - [x]* 11.3 `src/services/BedrockService.example.test.ts` — 오류 분기 모킹 테스트
    - `AccessDeniedException` / `ValidationException` / 타임아웃 / 네트워크 오류 각각에 대한 `TranscribeError.code` 매핑 검증
    - _Requirements: 6.11, 6.12, 6.13, 6.14, 6.15_

- [x] 12. Transcribe 스트리밍 서비스 구현 및 속성 테스트
  - [x] 12.1 `src/services/TranscribeService.ts` — 세션 수명주기 및 재연결
    - `start(params)`: `StartStreamTranscriptionCommand` + async generator로 PCM 청크 전송
    - 10초 내 첫 이벤트 없으면 `onSessionError("timeout")`
    - 수신 이벤트의 `IsPartial` 분기 → `onPartial` / `onFinal` 콜백
    - 연결 단절 감지 시 `reconnectWithBackoff(attempts=2, intervalMs=2000)`
    - `stop(timeoutMs=5000)`: 종료 신호 송신 → 5초 경과 시 `AbortController.abort()`
    - `dispose()`: `activeSession?.abort()` + `audioCapture.stop(stream)`
    - `activeSession` 필드로 단일 세션 불변식 강제(동시 1개 초과 시 `start` 거부)
    - _Requirements: 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.10, 3.11, 4.2, 4.10, 7.5, 7.6, 8.2, 8.5_

  - [x]* 12.2 `src/services/TranscribeService.property.test.ts` — 속성 테스트 2종
    - **Property 12: 단일 Transcribe 세션 불변식**
    - **Validates: Requirement 7.5**
    - **Property 13: 재연결 시도 횟수 상한**
    - **Validates: Requirements 8.5, 8.7**
    - `fakeTimers`로 재연결 타이밍 제어, `aws-sdk-client-mock`로 세션 결과 주입

  - [x]* 12.3 `src/services/TranscribeService.example.test.ts` — 수립/실패/타임아웃 모킹 테스트
    - 수립 성공 → `onSessionEstablished` 호출
    - 10초 타임아웃 → `onSessionError("timeout")` + 세션 abort
    - Partial/Final 이벤트 수신 → 콜백 순서 검증
    - 중지 신호 전송 후 5초 내 미종료 → 강제 abort + 경고 발생
    - _Requirements: 3.3, 3.10, 4.2, 4.10_

- [x] 13. 두 번째 체크포인트 — 서비스 계층 검증
  - Ensure all tests pass, ask the user if questions arise.

- [x] 14. 설정 탭 UI 구현
  - [x] 14.1 `src/settings/FolderSuggest.ts` — `AbstractInputSuggest<TFolder>` 구현
    - `getSuggestions`, `renderSuggestion`, `selectSuggestion` — vault 폴더 자동완성, 최대 20개
    - _Requirements: 2.10_

  - [x] 14.2 `src/settings/TranscribeSettingTab.ts` — `PluginSettingTab` 구현
    - `display()` 렌더링 순서: (1) UI Locale 드롭다운 [첫 항목], (2) `setHeading("AWS credentials")` → access key id / secret key(password 타입) / region, (3) `setHeading("Transcription")` → language code / transcript folder(FolderSuggest 연결), (4) `setHeading("Analysis")` → bedrock model id, (5) `setHeading("About")` → 보안 고지 텍스트
    - UI Locale 변경 시 설정 저장 → `plugin.changeLocale(locale)` 호출 → `display()` 재호출
    - 길이 초과 입력에 인라인 메시지 표시 및 저장 버튼 비활성화
    - 모든 레이블 Sentence case, `createEl("h2")` 금지
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 2.9, 2.10, 2.13, 2.16_

  - [x]* 14.3 `src/settings/TranscribeSettingTab.example.test.ts` — 렌더 예시 테스트
    - 첫 항목이 UI Locale 드롭다운인지 확인, 각 섹션 헤딩 유무, password 타입 적용, 길이 초과 시 저장 버튼 비활성화
    - _Requirements: 2.2, 2.4, 2.6, 2.16_

- [x] 15. 사이드바 뷰 구현
  - [x] 15.1 `src/views/SidebarView.ts` — `ItemView` 확장
    - `VIEW_TYPE_TRANSCRIBE = "transcribe-view"` export
    - DOM 구조는 모두 `createEl`/`createDiv`로 구성 (innerHTML 금지)
    - `render()`: 상태 영역, 3개 버튼, 스피너, 트랜스크립트/에디터 영역
    - `updateState(state, reconnecting)`, `appendPartial`, `commitFinal`, `loadNoteContent`, `enterEditMode`, `exitEditMode(save)`, `showAnalyzeSpinner`, `refreshButtons`, `onLocaleChange(t)`
    - 버튼 활성화는 `ButtonStatePolicy.computeButtonStates` 결과로 결정
    - DOM 이벤트는 `plugin.registerDomEvent`로 등록
    - _Requirements: 1.7, 1.8, 1.9, 1.10, 3.5, 3.6, 3.7, 3.8, 4.7, 5.3, 5.4, 5.6, 5.8, 5.9, 6.6, 6.16, 7.3, 7.4, 9.5, 10.4, 10.5_

  - [x]* 15.2 `src/views/SidebarView.example.test.ts` — 렌더 예시 테스트
    - 상태 레이블이 UI_Locale에 맞게 표시, 빈 상태 안내 문구 전환, 편집 모드 토글, 스피너 표시/숨김
    - `onLocaleChange` 호출 시 500ms 이내 버튼/레이블 재렌더링
    - `createEl`만 사용하는지(`innerHTML` 사용 검증)
    - _Requirements: 1.9, 1.10, 3.5, 5.3, 5.4, 6.6, 9.5, 10.5_

- [x] 16. 스타일시트 작성
  - [x] 16.1 `styles.css` — CSS 변수 기반 스타일
    - `.transcribe-sidebar`, `.transcribe-status[data-state="..."]`, `.transcribe-controls`, `.start-stop-btn`, `.transcript-text`, `.transcript-text .partial`, `.transcribe-spinner`, 편집 모드 스타일
    - 모든 색상/여백은 `var(--text-normal)`, `var(--background-secondary)`, `var(--interactive-accent)`, `var(--size-4-*)`, `var(--radius-m)` 등 Obsidian 변수 사용
    - 하드코딩 스타일 없음
    - _Requirements: 3.5, 9.7_

- [x] 17. 플러그인 진입점 및 버튼 핸들러 구현
  - [x] 17.1 `src/main.ts` — `TranscribePlugin extends Plugin` 구현
    - `onload()`: `loadSettings` → `createI18n(detectLocale(...))` → `registerView(VIEW_TYPE_TRANSCRIBE, (leaf) => new SidebarView(leaf, this))`(콜백에서 참조 저장 금지) → `addRibbonIcon("mic", t.commands.openView, ...)` → `addCommand({ id: "open-transcribe-view", name: t.commands.openView, callback })`(hotkey 미지정) → `addSettingTab(new TranscribeSettingTab(...))` → 서비스 인스턴스 생성
    - `activateView()`: 이미 존재 시 `workspace.revealLeaf`, 아니면 `workspace.getRightLeaf(false).setViewState(...)`
    - `changeLocale(locale)`: 설정 저장 → `t` 갱신 → 열린 `SidebarView` 인스턴스에 `onLocaleChange(t)` 전달 (500ms 이내)
    - `onunload()`: `transcribeService.dispose()` 호출 + 버퍼 내용 있으면 `NoteStore.saveTranscript`로 자동 저장. `detachLeavesOfType` 호출 금지
    - 모든 로깅은 `console.error`만 사용
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 8.1, 8.2, 8.3, 8.4, 9.5, 9.6, 10.3, 10.4, 10.5_

  - [x] 17.2 `src/main.ts` — 버튼 핸들러(시작/중지, 편집, 분석) 통합
    - 시작 핸들러: 설정 검증(`validate`) 후 자격 증명/모델 누락 시 `Notice`(누락 필드명 포함) 발생 + 동작 중단, 상태/노트 불변. 통과 시 `state.dispatch("START_REQUESTED")` → `audioCapture.requestPermission()` → `transcribeService.start(...)`
    - 중지 핸들러: `state.dispatch("STOP_REQUESTED")` → `transcribeService.stop(5000)` → 버퍼 비어있지 않으면 `NoteStore.saveTranscript` → Sidebar 텍스트 영역 갱신
    - 편집 저장 핸들러: 공백 전용 거부, 통과 시 `NoteStore.overwriteTranscript`
    - 분석 핸들러: 설정 검증 → 본문 길이 100000자 초과 시 `Notice` 후 중단 → 스피너 표시 → `BedrockService.analyze(...)` → 성공 시 `NoteStore.appendAnalysis` → 실패/타임아웃 분기별 `Notice`
    - 스트리밍 중 편집/분석 호출 시 `Notice` 발생 + 상태/노트/버퍼 불변
    - _Requirements: 2.14, 3.1, 3.9, 4.1, 4.3, 5.5, 5.7, 5.8, 5.9, 6.4, 6.5, 6.8, 6.11, 6.12, 6.13, 6.14, 6.15, 6.16, 7.4_

  - [ ]* 17.3 `src/main.property.test.ts` — 버튼 핸들러 속성 테스트 2종
    - **Property 11: 자격 증명/모델 누락 보호 불변식**
    - **Validates: Requirement 2.14**
    - **Property 14: Streaming 중 Edit/Analyze 상태 보존**
    - **Validates: Requirement 7.4**
    - 서비스들을 모킹한 상태에서 핸들러 호출 전후 `send` 호출 카운트, 상태/버퍼/파일 불변 검증

  - [ ]* 17.4 `src/main.example.test.ts` — 플러그인 수명주기 예시 테스트
    - `onload` 시 커맨드/리본/뷰/설정 탭 등록, `onunload` 시 `transcribeService.dispose` 호출 순서, 버퍼 있을 때 자동 저장
    - `changeLocale` 호출 시 열린 `SidebarView.onLocaleChange` 실행
    - `registerView` 콜백이 참조를 저장하지 않고 매번 새 인스턴스 반환하는지
    - _Requirements: 1.1, 1.2, 1.3, 1.5, 1.6, 8.1, 8.2, 8.3, 8.4, 10.5_

- [x] 18. 세 번째 체크포인트 — UI 및 진입점 통합 검증
  - Ensure all tests pass, ask the user if questions arise.

- [x] 19. 최종 통합 및 빌드 검증
  - [x] 19.1 `vitest.config.ts` — 테스트 러너 설정
    - `environment: "jsdom"`, 커버리지 리포터(`v8` 또는 `istanbul`) 활성화, `exclude`에 빌드 산출물 제외
    - PBT 테스트 파일 패턴 `**/*.property.test.ts` 인식

  - [x] 19.2 프로덕션 빌드 실행 및 산출물 점검
    - `npm run build`로 `main.js` 생성, minify 적용, 소스맵 미포함 확인
    - `manifest.json` + `main.js` + `styles.css` 배포 3종 세트 점검
    - `if (DEV) { ... }` 블록이 프로덕션에서 제거되는지 확인
    - _Requirements: 9.10_

- [x] 20. 최종 체크포인트 — 모든 테스트 통과 및 심사 체크리스트 재확인
  - Ensure all tests pass, ask the user if questions arise.
  - 심사 금지 API 미사용(`innerHTML`/`var`/`console.log`/`workspace.activeLeaf`/`eval`/`new Function`) 최종 점검
  - `Vault.process` 사용 확인, `normalizePath` 적용 확인, `registerEvent`/`registerDomEvent` 기반 리스너 관리 확인

## Notes

- `*` 표기가 붙은 sub-task는 선택적 테스트 작업으로 빠른 MVP를 위해 건너뛸 수 있다. 단, 본 스펙은 PBT를 핵심 품질 장치로 채택하므로 프로덕션 출시 전에는 모두 실행하여 통과시키는 것을 권장한다.
- 각 작업은 특정 Requirement 번호를 참조하며, 모든 Requirement 조항이 구현 또는 테스트 작업에서 한 번 이상 커버된다.
- 체크포인트(Task 9, 13, 18, 20)에서 누적된 변경을 검증하고, 문제가 발견되면 해당 에픽으로 되돌아가 수정한다.
- 15개 Correctness Property는 각각 별도의 sub-task로 분리되어 구현 모듈 바로 다음에 배치됨으로써, 오류를 조기에 검출할 수 있도록 한다.
- 테스트 러너 명령은 `npm test` (watch 없이 단일 실행). `npx vitest run src/state/StreamingStateMachine.property.test.ts`처럼 개별 실행 가능.
- AWS SDK 모킹은 `aws-sdk-client-mock`의 `mockClient(TranscribeStreamingClient)` 및 `mockClient(BedrockRuntimeClient)` 패턴을 사용한다.
- Obsidian `Vault`, `Plugin`, `WorkspaceLeaf` 등의 모킹은 수동 목 객체로 처리하되, `registerEvent`/`registerDomEvent`는 리스너 해제를 검증하기 위해 호출 스파이로 구성한다.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2", "1.3"] },
    { "id": 1, "tasks": ["2.1", "2.2"] },
    { "id": 2, "tasks": ["3.1"] },
    { "id": 3, "tasks": ["3.2", "3.3"] },
    { "id": 4, "tasks": ["3.4", "4.1", "5.1", "6.1", "7.1", "10.2", "16.1"] },
    { "id": 5, "tasks": ["4.2", "5.2", "6.2", "7.2", "7.3", "8.1", "10.1", "11.1"] },
    { "id": 6, "tasks": ["8.2", "8.3", "10.3", "11.2", "11.3", "12.1", "14.1"] },
    { "id": 7, "tasks": ["12.2", "12.3", "14.2", "15.1"] },
    { "id": 8, "tasks": ["14.3", "15.2", "17.1"] },
    { "id": 9, "tasks": ["17.2"] },
    { "id": 10, "tasks": ["17.3", "17.4", "19.1"] },
    { "id": 11, "tasks": ["19.2"] }
  ]
}
```

## 워크플로우 완료 안내

본 워크플로우는 **설계 및 계획 산출물(requirements.md, design.md, tasks.md) 생성만을 범위로 한다**. 실제 구현은 본 문서의 각 Task 항목에 대해 진행하며, Obsidian Plugin 심사 기준을 지속적으로 준수해야 한다.

다음 단계:
1. `tasks.md` 파일을 연다.
2. 각 Task 항목 옆의 "Start task"를 클릭해 하나씩 실행한다.
3. 체크포인트 Task에서는 전체 테스트 수트를 실행하여 누적 변경을 검증한다.
