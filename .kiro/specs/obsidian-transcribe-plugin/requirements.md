# Requirements Document

## Introduction

본 문서는 Obsidian 에디터에서 동작하는 음성-텍스트 전사(Speech-to-Text) 플러그인의 요구사항을 정의한다. 이 플러그인은 AWS Transcribe 서비스를 이용하여 사용자의 음성을 실시간으로 텍스트로 변환하고, Obsidian 사이드바에 결과를 표시한다. 사용자는 전사 결과를 수동으로 편집하거나 AWS Bedrock 기반의 AI 모델을 통해 분석(요약, 정리 등)할 수 있다. 플러그인은 TypeScript(Obsidian Plugin API 기반)로 구현되며, Obsidian 커뮤니티 플러그인 심사 기준(Developer Policies, Submission Requirements, Plugin Guidelines 2026-03)을 준수한다. 사용자는 설정 화면에서 표시 언어, AWS 자격 증명, Bedrock 모델 등을 구성할 수 있다.

## Glossary

- **Plugin**: 본 요구사항이 정의하는 Obsidian 플러그인 전체 시스템
- **Sidebar_View**: Obsidian 워크스페이스의 사이드바에 표시되는 본 Plugin의 전용 뷰 (`ItemView` 상속)
- **Transcribe_Service**: AWS Transcribe Streaming API를 호출하고 결과를 수신하는 Plugin 내부 모듈
- **Bedrock_Service**: AWS Bedrock API를 호출하여 선택된 AI 모델로 텍스트 분석을 수행하는 Plugin 내부 모듈
- **Settings_Module**: 표시 언어, AWS 자격 증명, Bedrock 모델, 저장 폴더 등 Plugin 설정을 관리하는 모듈
- **Transcript_Buffer**: 전사 진행 중 누적되는 텍스트를 메모리에 보관하는 저장소
- **Transcript_Note**: 전사 결과가 저장되는 Obsidian 노트(마크다운 파일)
- **Transcript_Folder**: `Transcript_Note`가 생성되는 vault 내부 폴더. 사용자가 설정에서 지정하며 기본값은 vault 루트(빈 문자열)
- **AWS_Credentials**: `access_key_id`와 `secret_access_key`로 구성된 AWS 인증 정보
- **Bedrock_Model**: 사용자가 설정에서 선택한 AWS Bedrock의 특정 파운데이션 모델 식별자 (예: `anthropic.claude-3-sonnet-*`)
- **Streaming_State**: 전사 상태. `idle`, `streaming`, `stopped`, `error` 중 하나의 값을 가짐
- **Start_Streaming_Button**: 사이드바의 "스트리밍 시작/중지" 버튼
- **Edit_Button**: 저장된 전사 텍스트를 편집 모드로 전환하는 버튼
- **Analyze_Button**: 전사 텍스트를 Bedrock 모델로 분석하는 버튼
- **Partial_Result**: AWS Transcribe가 스트리밍 도중 반환하는 중간 전사 결과
- **Final_Result**: AWS Transcribe가 확정한 최종 전사 결과
- **UI_Locale**: 사용자가 선택한 Plugin UI 표시 언어. `en`(영어, 기본) 또는 `ko`(한국어) 중 하나
- **PluginDataStore**: Obsidian `Plugin.loadData()`/`Plugin.saveData()`가 관리하는 `.obsidian/plugins/<plugin-id>/data.json` 파일

## Requirements

### Requirement 1: 플러그인 설치 및 사이드바 뷰 등록

**User Story:** Obsidian 사용자로서, 플러그인을 활성화했을 때 사이드바에서 전사 기능을 바로 사용할 수 있기를 원한다. 이는 별도 창 전환 없이 작업 중인 노트와 나란히 전사 결과를 확인하기 위함이다.

#### Acceptance Criteria

1. WHEN 사용자가 Obsidian에서 Plugin을 활성화하면, THE Plugin SHALL 2초 이내에 Obsidian 워크스페이스에 `VIEW_TYPE_TRANSCRIBE` 타입으로 Sidebar_View를 등록한다.
2. WHEN 사용자가 리본 아이콘 또는 커맨드 팔레트의 "Open transcribe view" 명령을 실행하면, THE Plugin SHALL 1초 이내에 Sidebar_View를 우측 사이드바(`workspace.getRightLeaf(false)`)에 표시한다.
3. IF Sidebar_View가 이미 열려 있는 상태에서 사용자가 "Open transcribe view" 명령을 다시 실행하면, THEN THE Plugin SHALL 새로운 뷰를 추가로 생성하지 않고 `workspace.revealLeaf`로 기존 Sidebar_View에 포커스를 이동시킨다.
4. THE Plugin SHALL 커맨드를 등록할 때 기본 단축키(hotkey)를 지정하지 않는다.
5. THE Plugin SHALL `registerView` 콜백에서 뷰 참조를 저장하지 않고 매 호출마다 `new SidebarView(leaf, this)`를 반환한다.
6. THE Plugin SHALL `onunload`에서 `detachLeavesOfType`을 호출하지 않고, Obsidian이 관리하는 leaf 복원 절차를 방해하지 않는다.
7. THE Sidebar_View SHALL Start_Streaming_Button, Edit_Button, Analyze_Button 세 개의 버튼을 각각 UI_Locale에 맞는 텍스트 레이블과 함께 `createEl`/`createDiv` API로 렌더링한다.
8. THE Sidebar_View SHALL 현재 Streaming_State를 UI_Locale에 맞는 텍스트 레이블로 표시하는 상태 표시 영역을 포함한다.
9. WHEN Streaming_State가 변경되면, THE Sidebar_View SHALL 500밀리초 이내에 상태 표시 영역의 레이블을 새 상태 값에 맞게 갱신한다.
10. THE Sidebar_View SHALL 전사된 텍스트를 표시하는 스크롤 가능한 텍스트 영역을 포함하며, Transcript_Buffer 또는 Transcript_Note의 내용이 비어 있으면 UI_Locale에 맞는 빈 상태 안내 문구(영어 "No transcript available.", 한국어 "전사된 내용이 없습니다.")를 표시한다.

### Requirement 2: 설정 및 AWS 자격 증명 / Bedrock 모델 관리

**User Story:** 플러그인 사용자로서, 설정 화면에서 표시 언어와 AWS 자격 증명, Bedrock 모델, 저장 폴더 등을 지정할 수 있기를 원한다. 이는 내 계정과 환경에 맞게 전사 및 AI 분석을 수행하기 위함이다.

#### Acceptance Criteria

1. THE Settings_Module SHALL Obsidian 설정 탭에 Plugin 전용 설정 화면을 `PluginSettingTab`으로 제공한다.
2. THE Settings_Module SHALL 설정 화면의 **첫 번째 항목**으로 UI_Locale(표시 언어) 선택 드롭다운을 제공하며, `en`(English)과 `ko`(한국어) 두 옵션을 포함하고 초기값은 `navigator.language`에서 감지된 언어 또는 `en`으로 설정한다.
3. WHEN 사용자가 UI_Locale을 변경하면, THE Settings_Module SHALL 설정 저장 후 `display()`를 재호출하여 설정 탭을 다시 렌더링하고, 열려 있는 Sidebar_View의 레이블을 새 언어로 갱신한다.
4. THE Settings_Module SHALL 섹션 구분에 `createEl("h2")`가 아닌 `new Setting(containerEl).setName(...).setHeading()` 패턴을 사용하고, 모든 설정 텍스트를 Sentence case로 작성한다.
5. THE Settings_Module SHALL AWS access_key_id 입력 필드를 제공하며, 최대 128자까지 입력을 허용한다.
6. THE Settings_Module SHALL AWS secret_access_key 입력 필드를 제공하며, 최대 256자까지 입력을 허용하고 `text.inputEl.type = "password"`로 마스킹하여 표시한다.
7. THE Settings_Module SHALL AWS 리전 선택 드롭다운 필드를 제공하며, 초기 기본값을 `us-east-1`로 설정한다.
8. THE Settings_Module SHALL Bedrock_Model을 선택할 수 있는 드롭다운 필드를 제공하며, 최대 256자의 모델 식별자를 허용하고 초기 상태는 빈 값으로 둔다.
9. THE Settings_Module SHALL 전사 언어 코드(`ko-KR`, `en-US` 중 하나)를 선택할 수 있는 드롭다운 필드를 제공하며, 초기 기본값을 `ko-KR`로 설정한다.
10. THE Settings_Module SHALL Transcript_Folder 경로를 입력하는 텍스트 필드를 제공하며, 입력값은 `normalizePath`로 정규화되고 `FolderSuggest`로 vault 폴더 자동완성을 지원한다. 초기 기본값은 빈 문자열(vault 루트)이다.
11. WHEN 사용자가 설정 값을 변경하고 저장하면, THE Settings_Module SHALL 3초 이내에 변경된 값을 PluginDataStore에 `saveData()`로 영속화하고 성공 여부를 `Notice`로 표시한다.
12. THE Settings_Module SHALL AWS_Credentials를 PluginDataStore(`loadData`/`saveData`)에만 저장하고, vault 내부의 마크다운 노트나 별도 평문 파일로 기록하지 않는다.
13. THE Settings_Module SHALL 설정 탭과 README에 "AWS 자격 증명이 `.obsidian/plugins/<plugin-id>/data.json`에 평문으로 저장되며, vault를 공유하거나 동기화할 때 해당 파일이 함께 전송될 수 있다"는 취지의 보안 고지를 표시한다.
14. IF 사용자가 Start_Streaming_Button 또는 Analyze_Button을 클릭한 시점에 access_key_id, secret_access_key, Bedrock_Model 중 하나 이상이 비어 있으면, THEN THE Plugin SHALL 누락된 항목명을 포함한 `Notice`를 3초 이상 표시하고 해당 동작을 중단하며, Streaming_State와 Transcript_Note를 변경하지 않는다.
15. IF 설정 저장 중 I/O 오류가 발생하면, THEN THE Settings_Module SHALL 저장 실패 사유를 포함한 `Notice`를 표시하고 이전에 저장된 값을 유지한다.
16. IF 사용자가 입력한 access_key_id 또는 secret_access_key가 허용 길이(각각 128자, 256자)를 초과하면, THEN THE Settings_Module SHALL 길이 초과를 알리는 인라인 메시지를 표시하고 저장 버튼을 비활성화한다.

### Requirement 3: 실시간 음성 전사 시작

**User Story:** 플러그인 사용자로서, 사이드바의 버튼 하나로 음성 전사를 시작하고 실시간으로 결과를 보기를 원한다. 이는 회의나 강의 내용을 즉시 노트화하기 위함이다.

#### Acceptance Criteria

1. WHEN 사용자가 Streaming_State가 `idle`인 상태에서 Start_Streaming_Button을 클릭하면, THE Plugin SHALL `navigator.mediaDevices.getUserMedia({ audio: true })`로 마이크 접근 권한을 요청한다.
2. WHEN 마이크 접근 권한이 허용되면, THE Transcribe_Service SHALL 설정된 AWS_Credentials, 리전, 언어 코드로 AWS Transcribe Streaming 세션 시작을 시도한다.
3. WHEN Transcribe Streaming 세션이 10초 이내에 성공적으로 수립되면, THE Plugin SHALL Streaming_State를 `streaming`으로 전환한다.
4. WHILE Streaming_State가 `streaming`이면, THE Transcribe_Service SHALL 마이크에서 캡처한 PCM 16kHz/16-bit/mono 오디오 청크를 최대 200밀리초 간격으로 AWS Transcribe에 전송한다.
5. WHEN AWS Transcribe가 Partial_Result를 반환하면, THE Sidebar_View SHALL 500밀리초 이내에 해당 텍스트를 텍스트 영역의 마지막 위치에 Final_Result와 시각적으로 구분되는 잠정 스타일(CSS 변수 `var(--text-muted)` 기반 옅은 색상 또는 이탤릭)로 표시한다.
6. WHEN AWS Transcribe가 Final_Result를 반환하면, THE Plugin SHALL 직전의 Partial_Result를 Final_Result 텍스트로 치환한다.
7. WHEN AWS Transcribe가 Final_Result를 반환하면, THE Plugin SHALL Final_Result 텍스트를 Transcript_Buffer 끝에 추가한다.
8. WHILE Streaming_State가 `streaming`이면, THE Start_Streaming_Button SHALL UI_Locale에 맞는 중지 레이블(영어 "Stop streaming", 한국어 "스트리밍 중지")을 표시한다.
9. IF 사용자가 마이크 권한 요청 창에서 권한을 거부하거나 창을 닫으면, THEN THE Plugin SHALL 마이크 권한이 필요함을 알리는 `Notice`를 3초 이상 표시하고 Streaming_State를 `idle`로 유지한다.
10. IF Transcribe Streaming 세션 수립이 10초 이내에 완료되지 않거나 수립 과정에서 오류가 발생하면, THEN THE Plugin SHALL 실패 원인을 포함한 에러 `Notice`를 표시하고 Streaming_State를 `error`로 전환하며 마이크 캡처를 중단한다.
11. IF Streaming_State가 `streaming`인 동안 AWS Transcribe 연결이 단절되거나 서비스 오류가 수신되면, THEN THE Plugin SHALL Requirement 8의 재연결 절차(기준 5, 7)를 실행한다.

### Requirement 4: 실시간 음성 전사 중지 및 저장

**User Story:** 플러그인 사용자로서, 전사를 원하는 시점에 중지하고 결과가 노트로 저장되기를 원한다. 이는 전사 결과를 Obsidian의 마크다운 자산으로 보관하기 위함이다.

#### Acceptance Criteria

1. WHEN 사용자가 Streaming_State가 `streaming`인 상태에서 Start_Streaming_Button을 클릭하면, THE Plugin SHALL Streaming_State를 `stopped`로 전환한다.
2. WHEN Streaming_State가 `stopped`로 전환되면, THE Transcribe_Service SHALL 5초 이내에 AWS Transcribe Streaming 세션에 종료 신호를 전송하고 마이크 캡처를 중단한다.
3. WHEN Streaming_State가 `stopped`로 전환되고 Transcript_Buffer의 텍스트 길이가 1자 이상이면, THE Plugin SHALL 3초 이내에 Transcript_Buffer의 누적 텍스트를 Transcript_Note로 저장한다.
4. WHEN Plugin이 Transcript_Note를 저장할 때, THE Plugin SHALL 파일 경로를 `normalizePath(Transcript_Folder + "/" + "Transcribe-YYYYMMDD-HHmmss.md")` 형식(플러그인 실행 환경의 로컬 타임존 기준)으로 생성하며, 동일 파일명이 이미 존재하는 경우 `Transcribe-YYYYMMDD-HHmmss-N.md` 형식(N은 1부터 시작하여 사용 가능한 값을 찾을 때까지 1씩 증가하는 정수)으로 충돌을 회피한다.
5. IF Transcript_Folder가 지정되었으나 해당 폴더가 vault에 존재하지 않으면, THEN THE Plugin SHALL `Vault.createFolder`로 폴더를 생성하거나, 생성 실패 시 vault 루트에 저장하고 사용자에게 대체 경로를 `Notice`로 알린다.
6. WHEN Plugin이 Transcript_Note를 저장할 때, THE Plugin SHALL 프론트매터에 전사 시작 시각과 종료 시각을 ISO 8601 형식(예: `2025-01-15T09:30:00+09:00`)으로 포함하고, 사용된 언어 코드(`ko-KR` 또는 `en-US`)를 포함한다.
7. WHEN Transcript_Note 저장이 성공하면, THE Plugin SHALL 1초 이내에 Sidebar_View의 텍스트 영역이 해당 Transcript_Note의 내용을 가리키도록 갱신한다.
8. IF Transcript_Note 저장 중 파일 I/O 오류가 발생하면, THEN THE Plugin SHALL 실패 원인(권한 오류, 디스크 공간 부족, 경로 오류 등)을 포함한 에러 `Notice`를 표시하고, Transcript_Buffer의 내용을 유지하며, Streaming_State를 `stopped`로 유지하여 사용자가 재시도할 수 있도록 한다.
9. IF Streaming_State가 `stopped`로 전환될 때 Transcript_Buffer가 비어 있거나 공백 문자만 포함하면, THEN THE Plugin SHALL Transcript_Note를 생성하지 않고 UI_Locale에 맞는 빈 전사 알림을 표시한다.
10. IF AWS Transcribe Streaming 세션 종료가 5초 이내에 완료되지 않으면, THEN THE Transcribe_Service SHALL 세션 연결을 강제 종료하고 마이크 캡처를 중단한 후, 세션 종료 지연을 알리는 경고 `Notice`를 표시한다.

### Requirement 5: 전사 결과 편집(후보정)

**User Story:** 플러그인 사용자로서, 저장된 전사 텍스트를 직접 수정하여 오탈자나 문맥 오류를 교정하기를 원한다. 이는 최종 노트 품질을 확보하기 위함이다.

#### Acceptance Criteria

1. WHILE Transcript_Note가 존재하고 그 본문 길이가 1자 이상이며 Streaming_State가 `streaming`이 아니면, THE Edit_Button SHALL 활성화된 상태로 표시된다.
2. WHILE Streaming_State가 `streaming`이면, THE Edit_Button SHALL 비활성화 상태로 표시되고 클릭 이벤트를 무시한다.
3. WHEN 사용자가 Edit_Button을 클릭하면, THE Plugin SHALL 500밀리초 이내에 Sidebar_View의 텍스트 영역을 편집 가능한 `textarea`로 전환하고 현재 Transcript_Note의 본문을 초기값으로 로드한다.
4. WHILE Sidebar_View가 편집 모드이면, THE Sidebar_View SHALL UI_Locale에 맞는 "저장"(영어 "Save") 버튼과 "취소"(영어 "Cancel") 버튼을 표시하고 Edit_Button을 비활성화 상태로 표시한다.
5. WHEN 사용자가 편집 모드에서 "저장" 버튼을 클릭하면, THE Plugin SHALL 3초 이내에 편집된 내용을 `Vault.process(file, callback)` API로 Transcript_Note에 덮어쓰고 편집 모드를 종료한다.
6. WHEN 사용자가 편집 모드에서 "취소" 버튼을 클릭하면, THE Plugin SHALL 편집 내용을 파기하고 편집 모드를 종료하며 Transcript_Note의 기존 내용을 다시 표시한다.
7. IF 편집 저장 중 파일 I/O 오류(권한 오류, 디스크 공간 부족, 파일 잠김 등)가 발생하면, THEN THE Plugin SHALL 실패 원인을 포함한 에러 `Notice`를 표시하고 편집 모드와 편집 중이던 내용을 유지하여 사용자가 재시도할 수 있도록 한다.
8. IF 사용자가 편집 모드에서 "저장" 버튼을 클릭한 시점의 편집 내용이 비어 있거나 공백 문자만 포함하면, THEN THE Plugin SHALL 저장을 거부하고 UI_Locale에 맞는 "내용이 비어 있습니다" 알림을 표시하며 편집 모드를 유지한다.
9. IF Sidebar_View가 편집 모드인 동안 Streaming_State가 `streaming`으로 전환되려고 하면, THEN THE Plugin SHALL 사용자에게 편집 내용을 저장 또는 취소해야 함을 알리고 Streaming_State 전환을 차단한다.

### Requirement 6: Bedrock 모델을 통한 텍스트 분석

**User Story:** 플러그인 사용자로서, 전사된 텍스트를 선택된 Bedrock 모델로 분석(요약, 키워드 추출 등)하기를 원한다. 이는 긴 전사 결과에서 핵심 내용을 빠르게 파악하기 위함이다.

#### Acceptance Criteria

1. WHILE Transcript_Note의 본문 길이가 1자 이상이고 Streaming_State가 `streaming`이 아니며 AWS_Credentials와 Bedrock_Model이 모두 설정되어 있으면, THE Analyze_Button SHALL 클릭 가능한 활성화 상태로 표시된다.
2. WHILE Streaming_State가 `streaming`이면, THE Analyze_Button SHALL 클릭 불가능한 비활성화 상태로 표시된다.
3. WHILE Transcript_Note의 본문 길이가 0자이거나 AWS_Credentials 또는 Bedrock_Model 중 하나라도 설정되지 않았으면, THE Analyze_Button SHALL 클릭 불가능한 비활성화 상태로 표시된다.
4. WHEN 사용자가 Analyze_Button을 클릭하면, THE Bedrock_Service SHALL 설정된 AWS_Credentials와 Bedrock_Model을 사용하여 Transcript_Note 본문(최대 100,000자)과 사전 정의된 분석 프롬프트를 Bedrock에 전달하여 요청을 개시한다.
5. IF Analyze_Button 클릭 시점의 Transcript_Note 본문 길이가 100,000자를 초과하면, THEN THE Plugin SHALL 분석 요청을 개시하지 않고 본문 길이 초과 사유를 포함한 `Notice`를 5초 이상 표시한다.
6. WHILE Bedrock_Service의 분석 요청이 진행 중이면, THE Sidebar_View SHALL 스피너 형태의 로딩 인디케이터를 노출한다.
7. WHILE Bedrock_Service의 분석 요청이 진행 중이면, THE Analyze_Button SHALL 클릭 불가능한 비활성화 상태로 표시된다.
8. WHEN Bedrock 응답이 성공 상태로 수신되면, THE Plugin SHALL `Vault.process` API로 Transcript_Note 본문의 끝에 UI_Locale에 맞는 분석 결과 헤더(영어 "## Analysis result", 한국어 "## 분석 결과")와 분석 결과 텍스트를 새 섹션으로 추가한다.
9. WHEN Plugin이 분석 결과를 Transcript_Note에 추가할 때, THE Plugin SHALL 기존 본문의 모든 문자와 프론트매터를 변경 없이 보존한다.
10. WHEN Transcript_Note 본문에 이미 분석 결과 섹션이 존재하는 상태에서 새 분석 결과가 수신되면, THE Plugin SHALL 기존 섹션을 유지한 채 본문 끝에 새로운 분석 결과 섹션을 추가한다.
11. IF Bedrock 요청이 개시 시점으로부터 30초 이내에 응답을 반환하지 않으면, THEN THE Plugin SHALL `AbortController.abort()`로 해당 요청을 중단한다.
12. WHEN Bedrock 요청이 타임아웃으로 중단되면, THE Plugin SHALL 타임아웃 사유를 포함한 `Notice`를 5초 이상 표시하고 Transcript_Note 본문을 변경하지 않는다.
13. IF Bedrock 요청이 인증 오류 또는 권한 오류로 실패하면, THEN THE Plugin SHALL 실패 원인을 포함한 `Notice`를 5초 이상 표시하고 Transcript_Note 본문을 변경하지 않는다.
14. IF 선택된 Bedrock_Model이 설정된 리전에서 사용 불가능한 것으로 Bedrock_Service가 확인하면, THEN THE Plugin SHALL 모델을 사용할 수 없음을 알리는 `Notice`를 5초 이상 표시하고 분석을 중단하며 Transcript_Note 본문을 변경하지 않는다.
15. IF Bedrock 요청이 네트워크 오류 또는 그 외 원인으로 실패하면, THEN THE Plugin SHALL 실패 원인을 포함한 `Notice`를 5초 이상 표시하고 Transcript_Note 본문을 변경하지 않는다.
16. WHEN 분석 요청이 성공, 실패, 타임아웃 중 어느 상태로든 종료되면, THE Sidebar_View SHALL 로딩 인디케이터를 제거하고 기준 1의 조건에 따라 Analyze_Button의 활성화 상태를 재평가한다.

### Requirement 7: 버튼 상태 및 동시성 제어

**User Story:** 플러그인 사용자로서, 현재 수행 가능한 작업만 버튼으로 활성화되어 혼동 없이 사용하기를 원한다. 이는 잘못된 동시 실행으로 인한 데이터 손실을 방지하기 위함이다.

#### Acceptance Criteria

1. WHILE Streaming_State가 `idle`이고 Transcript_Note가 존재하지 않는 동안, THE Plugin SHALL Edit_Button과 Analyze_Button을 비활성화 상태(클릭 이벤트 무시 및 비활성 시각 표시 포함)로 렌더링한다.
2. WHILE Bedrock_Service의 분석 요청이 진행 중인 동안, THE Plugin SHALL Start_Streaming_Button, Edit_Button, Analyze_Button을 비활성화 상태(클릭 이벤트 무시 및 비활성 시각 표시 포함)로 렌더링한다.
3. WHEN Bedrock_Service의 분석 요청이 성공 또는 실패로 종료되면, THE Plugin SHALL 현재 Streaming_State와 Transcript_Note 존재 여부에 따라 각 버튼의 활성화 상태를 200밀리초 이내에 갱신한다.
4. IF 사용자가 Streaming_State가 `streaming`인 동안 Edit_Button 또는 Analyze_Button 호출을 시도하면, THEN THE Plugin SHALL 해당 동작을 거부하고 스트리밍 중 사용 불가 사유를 나타내는 `Notice`를 3초 이상 5초 이하 표시하며, Transcript_Note와 Streaming_State를 변경하지 않는다.
5. THE Plugin SHALL 동시에 최대 1개의 Transcribe Streaming 세션만 유지한다.
6. IF Transcribe Streaming 세션이 이미 활성 상태에서 사용자가 Start_Streaming_Button을 통한 신규 세션 시작을 시도하면, THEN THE Plugin SHALL 새 세션 시작 요청을 거부하고 기존 세션이 유지되고 있음을 나타내는 `Notice`를 3초 이상 5초 이하 표시한다.

### Requirement 8: 오류 처리 및 자원 정리

**User Story:** 플러그인 사용자로서, 네트워크 문제나 플러그인 비활성화 상황에서도 마이크 및 AWS 세션이 안전하게 정리되기를 원한다. 이는 자원 누수와 불필요한 비용 발생을 방지하기 위함이다.

#### Acceptance Criteria

1. THE Plugin SHALL 모든 Obsidian 이벤트와 DOM 이벤트 리스너를 `this.registerEvent` 또는 `this.registerDomEvent`로 등록하여 `onunload` 시 자동으로 해제되도록 한다.
2. WHEN 사용자가 Plugin을 비활성화하거나 Obsidian을 종료하면, THE Plugin SHALL `onunload` 내에서 5초 이내에 진행 중인 Transcribe Streaming 세션에 종료 신호를 전송한다.
3. WHEN 사용자가 Plugin을 비활성화하거나 Obsidian을 종료하면, THE Plugin SHALL 진행 중인 마이크 캡처를 중단하고 MediaStream의 모든 트랙(`stream.getTracks().forEach(t => t.stop())`)을 해제한다.
4. WHEN 사용자가 Plugin을 비활성화하거나 Obsidian을 종료하는 시점에 Transcript_Buffer의 텍스트 길이가 1자 이상이면, THE Plugin SHALL Requirement 4의 기준 4, 6을 따르는 Transcript_Note로 해당 내용을 자동 저장한다.
5. IF Streaming_State가 `streaming`인 동안 AWS Transcribe 서비스로부터 10초 이상 응답이 없거나 연결이 단절되면, THEN THE Plugin SHALL 2초 간격으로 최대 2회 재연결을 시도한다.
6. WHILE 재연결을 시도하는 동안, THE Sidebar_View SHALL 상태 표시 영역에 UI_Locale에 맞는 "재연결 시도 중" 메시지를 노출한다.
7. IF 재연결이 2회 모두 실패하면, THEN THE Plugin SHALL Streaming_State를 `error`로 전환하고 Transcript_Buffer의 현재 내용을 Requirement 4의 기준 4, 6을 따르는 Transcript_Note로 저장한다.
8. WHEN Streaming_State가 `error`로 전환되면, THE Plugin SHALL 네트워크 연결 실패 또는 재연결 실패 사유를 포함한 에러 `Notice`를 5초 이상 표시하고 Start_Streaming_Button의 라벨을 UI_Locale에 맞는 시작 레이블로 복원하여 재시도 가능하게 한다.

### Requirement 9: Obsidian 커뮤니티 플러그인 심사 준수

**User Story:** 플러그인 개발자로서, Obsidian 커뮤니티 플러그인 저장소에 등록 가능한 품질 기준을 준수하기를 원한다. 이는 심사 거부 사유를 사전에 제거하기 위함이다.

#### Acceptance Criteria

1. THE Plugin SHALL `manifest.json`에 `id`(소문자+하이픈), `name`, `version`, `minAppVersion`, `description`(250자 이하, 마침표로 종료, 행동 문장, 이모지 제외), `author`, `authorUrl`, `isDesktopOnly` 필드를 포함한다.
2. THE Plugin SHALL 마이크/Node.js/Electron API 의존성을 이유로 `manifest.json`의 `isDesktopOnly`를 `true`로 설정한다.
3. THE Plugin SHALL 저장소 루트에 `LICENSE` 파일을 포함한다.
4. THE Plugin SHALL `README.md`에 다음 항목을 명시적으로 공개한다: (a) 외부 네트워크 사용(AWS Transcribe, AWS Bedrock 엔드포인트 호출), (b) 사용자의 AWS 계정 및 자격 증명 필요, (c) AWS 사용에 따른 과금 책임은 사용자에게 있음, (d) AWS 자격 증명이 PluginDataStore에 평문으로 저장됨.
5. THE Plugin SHALL 다음 금지 API를 사용하지 않는다: `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `window.app`(전역), `var`, `console.log`/`console.warn`/`console.debug`, `workspace.activeLeaf`(직접 접근), `eval`, `new Function`, 코드 난독화.
6. THE Plugin SHALL 모든 로깅을 `console.error`로만 수행하며 민감 정보(AWS 자격 증명, 마이크 오디오 샘플 값, Transcribe/Bedrock 응답 본문)는 로그에 기록하지 않는다.
7. THE Plugin SHALL 모든 하드코딩 스타일을 배제하고, 사이드바와 설정 화면의 색상/여백 등은 `var(--text-normal)`, `var(--background-secondary)`, `var(--interactive-accent)` 등 Obsidian CSS 변수를 사용한 CSS 클래스로 정의한다.
8. THE Plugin SHALL 사용자 입력 파일 경로(Transcript_Folder 등)에 `normalizePath`를 적용한 뒤 Vault API에 전달한다.
9. THE Plugin SHALL Vault 파일 수정 시 `Vault.modify` 대신 `Vault.process(file, callback)`를 사용하여 동시 편집 충돌을 방지한다.
10. THE Plugin SHALL 프로덕션 빌드(`esbuild --minify`)에서 `DEV` 플래그로 감싼 디버그 코드를 제거하고, 소스맵을 포함하지 않는다.

### Requirement 10: 국제화(i18n)

**User Story:** 다양한 언어 사용자가 Plugin을 사용할 수 있도록 영어와 한국어를 지원하고, 기본 언어는 브라우저 언어 설정을 따르기를 원한다. 이는 Obsidian 커뮤니티 플러그인 가이드라인을 준수하기 위함이다.

#### Acceptance Criteria

1. THE Plugin SHALL `src/i18n/` 디렉터리에 `en.ts`(기본, 누락 키 없음)와 `ko.ts` 두 개의 로케일 파일을 포함한다.
2. THE Plugin SHALL `en.ts`에서 `Translations` 타입을 `export`하고, 모든 로케일 파일이 해당 타입을 `import`하여 컴파일 타임에 키 누락을 검출한다.
3. THE Plugin SHALL 플러그인 로드 시 사용자가 설정에서 선택한 UI_Locale을 우선 적용하고, 설정이 비어 있으면 `navigator.language.split("-")[0]` 값이 지원 로케일에 포함되는 경우 해당 값을, 그 외에는 `en`을 적용한다.
4. THE Plugin SHALL 사이드바 UI, 설정 탭, 커맨드 이름, 모든 `Notice` 메시지를 UI_Locale에 따라 번역된 문자열로 표시한다.
5. WHEN 사용자가 UI_Locale을 변경하면, THE Plugin SHALL 열려 있는 Sidebar_View 인스턴스에 새로운 번역을 전달하고 500밀리초 이내에 버튼 레이블, 상태 영역 레이블, 빈 상태 안내 문구를 재렌더링한다.
6. THE Plugin SHALL 모든 설정 탭 레이블을 Sentence case로 작성하고, 번역 키에는 UI 표시용 Sentence case 문자열을 담는다.
