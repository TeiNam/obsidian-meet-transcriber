# Meeting Transcriber — Obsidian plugin for real-time speech-to-text via AWS

![TypeScript](https://img.shields.io/badge/TypeScript-5.4-blue.svg)
![AWS](https://img.shields.io/badge/AWS-Cloud-FF9900.svg)
![License](https://img.shields.io/badge/License-MIT-green.svg)

[![Buy Me A Coffee](https://img.shields.io/badge/Buy%20Me%20A%20Coffee-FFDD00?style=for-the-badge&logo=buy-me-a-coffee&logoColor=black)](https://buymeacoffee.com/teinam)

> Capture microphone audio, stream it to AWS Transcribe in real time, save the result as a Markdown note, and analyze it with AWS Bedrock — all from the Obsidian sidebar.

- **Plugin ID**: `obsidian-transcribe-plugin`
- **Platform**: Desktop only (`isDesktopOnly: true`)
- **License**: [MIT](./LICENSE)

---

## 🇰🇷 한국어

### 개요

Obsidian 사이드바에서 마이크 오디오를 실시간으로 AWS Transcribe Streaming에 전송해 텍스트로 받아 적고, 결과를 마크다운 노트로 저장한 뒤 AWS Bedrock 모델로 요약/분석할 수 있는 커뮤니티 플러그인입니다.

### ⚠️ 사용 전 반드시 확인하세요 (중요 고지)

본 플러그인을 설치·사용하기 전에 다음 네 가지 사항을 반드시 이해하고 동의해야 합니다.

1. **외부 네트워크 사용**
   본 플러그인은 동작에 다음 외부 엔드포인트를 호출합니다. 트리거 조건이 충족될 때만 호출되며, 트리거 조건이 발생하지 않으면 해당 엔드포인트로의 통신은 일어나지 않습니다.

   | 엔드포인트 | 트리거 조건 | 전송 데이터 |
   |---|---|---|
   | `transcribestreaming.<region>.amazonaws.com` | 클라우드 모드(`cloud-only`, `auto` 의 클라우드 단계) 세션 | 마이크 PCM 오디오 (16 kHz mono) |
   | `bedrock-runtime.<region>.amazonaws.com` | 분석 버튼 클릭 (사용자 명시 동의) | 전사 노트 본문 텍스트 |
   | `bedrock.<region>.amazonaws.com` | 설정 화면의 모델 목록 새로고침 | (요청 본문 없음) |
   | `huggingface.co` | 로컬 모델 다운로드 모달에서 사용자가 명시 동의 시 — 1회 다운로드 후 재호출 없음 | (HTTPS GET, 요청 본문 없음) |
   | `translate.<region>.amazonaws.com` | `Translation_Enabled = true` 이고 Final_Result 도착 시 | Final_Result 의 원본 텍스트만 (마이크 PCM 은 절대 전송하지 않음) |

   **로컬 모드의 "no-network for audio" 약속** — `Backend_Selection_Mode` 가 `local-only` 이거나 `auto` 가 로컬로 폴백한 세션에서는 마이크에서 캡처한 PCM 오디오가 어떠한 외부 엔드포인트로도 전송되지 않습니다. 모델 가중치는 사용자 동의 후 Hugging Face 에서 1회 다운로드되며, 이후 세션에서는 디스크에 저장된 로컬 파일만 사용합니다. `Translation_Enabled = true` 인 경우에만 AWS Translate 로 **Final_Result 텍스트만** 송신되며, 원본 PCM 은 포함되지 않습니다.

2. **AWS 계정 및 자격 증명 필요**
   본 플러그인은 독자적인 AI 서버를 제공하지 않습니다. 사용자가 **본인의 AWS 계정**을 만들고, IAM access key ID 와 secret access key 를 직접 발급·입력해야 합니다. Transcribe 및 Bedrock 서비스 활성화(리전별 모델 액세스 승인 포함)도 사용자 책임입니다.

3. **AWS 사용에 따른 과금은 사용자 부담**
   AWS Transcribe Streaming 과 AWS Bedrock 은 **종량제 유료 서비스**입니다. 본 플러그인이 호출하는 모든 API 요청에 대한 **요금은 전적으로 사용자의 AWS 계정에 청구**되며, 플러그인 제작자는 과금 금액에 대해 어떠한 책임도 지지 않습니다. 비용 관리가 필요한 경우 AWS Cost Explorer 및 Budgets 를 통해 직접 모니터링하세요.

4. **AWS 자격 증명은 data.json 에 평문으로 저장됩니다**
   입력한 AWS access key ID 및 secret access key 는 Obsidian 이 관리하는 플러그인 데이터 파일
   `<vault>/.obsidian/plugins/obsidian-transcribe-plugin/data.json`
   에 **암호화 없이 평문(JSON)** 으로 저장됩니다. 다음 사항에 유의하세요.
   - vault 디렉터리 전체를 Git, iCloud, Dropbox, OneDrive, Obsidian Sync 등으로 동기화하는 경우 **자격 증명이 함께 전송·백업될 수 있습니다**.
   - vault 를 타인과 공유하거나 압축하여 전달할 때 `data.json` 이 포함되지 않도록 주의하세요.
   - AWS 모범 사례에 따라 **최소 권한(least privilege) IAM 사용자 또는 역할**을 별도로 만들고, 정기적으로 키를 로테이션하는 것을 강력히 권장합니다.

### 주요 기능

- 사이드바의 시작/중지 버튼 하나로 실시간 전사 개시·종료
- 스트리밍 중 **빨간 펄스 녹음 인디케이터** + 빨간 중지 버튼으로 상태 명확히 표시
- Partial result(잠정) 와 Final result(확정) 를 시각적으로 구분하여 표시
- 전사 보드에서 **텍스트 드래그 선택** 가능 (편집 모드 진입 불필요)
- 전사 보드 우상단 **클립보드 복사 아이콘** — 한 번의 클릭으로 전체 본문 복사
- 전사 종료 시 `YYYY-MM-DD HH-mm.md` 형식으로 마크다운 노트 자동 저장 (프론트매터 포함)
- **최근 전사 5개 리스트** — 사이드바 하단에 표시, 클릭하면 즉시 로드·편집·분석 가능
- 저장된 노트의 직접 편집(후보정) 지원
- AWS Bedrock 을 통한 요약·키워드·**체크박스 형식 액션 아이템** 분석 결과 노트에 부착
- **사이드바 인라인 컨트롤** — 전사 언어와 Bedrock 모델을 설정 탭을 거치지 않고 사이드바에서 즉시 선택
- **Bedrock 모델 드롭다운** — 새로고침 버튼으로 사용 가능한 모델/추론 프로필 자동 조회
- **커스텀 단어장 자동 동기화** — 설정에서 단어 입력 후 동기화 버튼으로 AWS Transcribe에 자동 등록
- **커스텀 분석 프롬프트** — 자유 텍스트로 AI 분석에 추가 지시 전달
- 영어 / 한국어 UI (설정에서 전환)
- 본문 길이 최대 200,000자(약 8~12시간 회의) 분석 지원

### 설치

#### 수동 설치 (현재 권장)

1. 이 저장소의 GitHub Releases 페이지에서 최신 릴리스의 `main.js`, `manifest.json`, `styles.css` 를 다운로드합니다.
2. Obsidian vault 내부의 다음 경로에 세 파일을 복사합니다.
   ```
   <vault>/.obsidian/plugins/obsidian-transcribe-plugin/
   ```
3. Obsidian 을 재시작한 뒤 `Settings → Community plugins` 에서 `Transcribe` 를 활성화합니다.

#### BRAT 을 통한 베타 설치

1. [BRAT](https://github.com/TfTHacker/obsidian42-brat) 플러그인을 설치·활성화합니다.
2. BRAT 설정에서 `Add Beta Plugin` 을 선택하고 본 저장소 주소를 입력합니다.

### AWS 사전 준비

#### 1. IAM 사용자 생성 및 최소 권한 부여

AWS 콘솔 또는 CLI 로 프로그래밍 방식 액세스(access key) 전용 IAM 사용자를 생성한 뒤 다음 최소 권한 정책을 부여합니다.

```json
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Sid": "TranscribeStreaming",
            "Effect": "Allow",
            "Action": [
                "transcribe:StartStreamTranscription",
                "transcribe:StartStreamTranscriptionWebSocket",
                "transcribe:CreateVocabulary",
                "transcribe:UpdateVocabulary",
                "transcribe:GetVocabulary",
                "transcribe:DeleteVocabulary"
            ],
            "Resource": "*"
        },
        {
            "Sid": "BedrockAnalysis",
            "Effect": "Allow",
            "Action": [
                "bedrock:InvokeModel",
                "bedrock:ListFoundationModels",
                "bedrock:GetFoundationModel"
            ],
            "Resource": "*"
        },
        {
            "Sid": "TranslateRealtime",
            "Effect": "Allow",
            "Action": [
                "translate:TranslateText"
            ],
            "Resource": "*"
        }
    ]
}
```

> **`TranslateRealtime` statement 는 옵션입니다.** 설정에서 `Translation_Enabled = true` 로 실시간 번역을 활성화하는 경우에만 필요합니다. 실시간 번역을 사용하지 않는다면 해당 statement 를 제외해도 클라우드 전사/분석 기능은 정상 동작합니다.
>
> 실무에서는 `Resource` 를 특정 Bedrock 모델 ARN 으로 제한하여 권한 범위를 더 좁히는 것을 권장합니다.

#### 2. Bedrock 모델 액세스 승인

AWS 콘솔 → Bedrock → Model access 에서 사용하려는 파운데이션 모델(예: `anthropic.claude-3-sonnet-*`, `anthropic.claude-3-haiku-*` 등) 의 액세스를 요청·승인받아야 합니다.

> **Claude 4.5 계열 참고**: Claude Sonnet 4.5, Claude Haiku 4.5 같은 최신 모델은 **cross-Region inference profile** 을 통해서만 호출 가능합니다. 설정의 모델 드롭다운에서 ⚡ 아이콘이 붙은 항목(예: `global.anthropic.claude-haiku-4-5-20251001-v1:0`)을 선택하세요.

#### 3. 리전 선택

Transcribe Streaming 과 Bedrock 이 **동일 리전에서 모두 지원**되는 값을 사용하세요. 초기 기본값은 `us-east-1` 입니다.

### 설정 개요

`Settings → Community plugins → Transcribe → Options` 에서 다음 항목을 구성합니다.

| 구분 | 항목 | 설명 |
|---|---|---|
| 언어 | Display language | UI 표시 언어 (`English` / `한국어`). 첫 항목에 배치됩니다. |
| AWS credentials | AWS access key ID | IAM 사용자의 access key ID (최대 128자) |
| | AWS secret access key | IAM 사용자의 secret access key (최대 256자, 입력은 마스킹 표시) |
| | AWS region | Transcribe 및 Bedrock 호출 리전 (기본값 `us-east-1`) |
| Transcription | Transcription language | 전사 언어 코드 (`ko-KR` 또는 `en-US`). 사이드바에서도 즉시 변경 가능 |
| | Transcript folder | 전사 노트를 저장할 vault 내 폴더 경로. 빈 값이면 vault 루트 사용. vault 폴더 자동완성 제공 |
| Analysis | Bedrock model ID | 드롭다운에서 선택하거나 직접 입력. 새로고침 버튼으로 AWS에서 사용 가능한 모델 자동 조회. 사이드바에서도 즉시 변경 가능 |
| | 분석 추가 지시 | 분석 모델에 전달할 추가 지시사항 (자유 텍스트) |
| Vocabulary | 커스텀 단어 목록 | AWS Transcribe가 인식할 단어 목록. 한 줄에 하나. 'AWS에 동기화' 버튼으로 등록 |

### 사용 방법

1. 명령 팔레트 또는 리본 아이콘의 `Open transcribe view` 명령으로 사이드바를 엽니다.
2. 사이드바 상단의 인라인 드롭다운에서 **전사 언어** 와 **Bedrock 모델** 을 선택합니다. 설정 탭에 저장한 값이 그대로 반영되며, 사이드바에서 바꾸면 설정 탭에도 즉시 동기화됩니다.
3. **Start streaming** 버튼을 눌러 마이크 권한을 허용합니다.
4. 발화를 시작하면 잠정(희미한 글씨) → 확정(일반 글씨) 순으로 텍스트가 누적됩니다. 빨간 펄스 인디케이터가 녹음 중임을 표시합니다.
5. **Stop streaming** (빨간 버튼) 을 누르면 누적된 내용이 `YYYY-MM-DD HH-mm.md` 로 저장됩니다.
6. 전사 보드에서 텍스트를 드래그해 선택하거나, 우상단 📋 아이콘으로 전체 복사할 수 있습니다.
7. **Edit** 버튼으로 오탈자를 교정하거나, **Analyze** 버튼으로 Bedrock 분석 결과(요약, 키워드, 결정사항, 액션 아이템, 참고사항 섹션의 회의록 형식)를 노트 끝에 추가합니다.
8. 하단 **최근 전사** 리스트에서 이전 노트를 클릭하면 즉시 로드되어 편집·복사·분석이 가능합니다.

### 로컬 모드(Local Whisper)

> 로컬 모드는 마이크 PCM 오디오가 장치를 떠나지 않는 오프라인 전사 모드입니다. 설정의 `Backend_Selection_Mode` 가 `local-only` 이거나 `auto` 가 로컬로 폴백한 세션에서 활성화됩니다.

#### 지원 모델 카탈로그

| 모델 ID | 표시명 | 예상 크기 (MB) | 라이선스 | Hugging Face |
|---|---|---|---|---|
| `whisper-large-v3-turbo` | Whisper Large V3 Turbo | 1,700 | MIT | [onnx-community/whisper-large-v3-turbo](https://huggingface.co/onnx-community/whisper-large-v3-turbo) |
| `distil-whisper-large-v3` | Distil-Whisper Large V3 | 800 | MIT | [distil-whisper/distil-large-v3](https://huggingface.co/distil-whisper/distil-large-v3) |

각 모델은 사용자가 모델 다운로드 모달에서 명시 동의한 경우에만 Hugging Face 에서 1회 다운로드되며, 이후 세션에서는 디스크의 로컬 파일만 사용합니다.

#### 성능 안내

로컬 모드의 처리 속도는 사용자의 CPU/GPU 환경과 선택한 모드에 따라 다음과 같이 달라집니다.

- **x86 CPU (Intel/AMD 데스크톱·노트북)**: 일반적으로 **실시간보다 느립니다**. 30초 분량 오디오 1청크를 전사하는 데 약 60–90초가 걸려, 누적 처리 시간이 오디오 길이의 2–3배에 도달할 수 있습니다. 회의가 끝난 뒤 일괄 모드로 처리하는 사용 흐름이 더 적합합니다.
- **Apple Silicon (M1/M2/M3/M4 계열 Mac)**: ANE/Metal 가속 덕분에 **거의 실시간** 으로 동작합니다. 회의 중 사이드바에서 결과를 따라가며 볼 수 있는 수준입니다.
- **청크 단위(chunked-streaming) 모드**: 30초 단위로 잘라 추론하며, 청크가 완료될 때마다 사이드바에 부분 결과가 누적되어 회의 중에도 진행 상황을 확인할 수 있습니다. 한 청크의 결과가 200ms 를 넘겨 지연되면 진행 인디케이터가 노출됩니다.
- **일괄(progress-only) 모드**: 회의 종료 후 전체 오디오를 한 번에 추론합니다. 회의 중에는 진행률만 표시되고, 추론이 끝난 시점에 전체 전사 결과가 한꺼번에 노트에 기록됩니다.

#### 화자 분리(Speaker Diarization)

화자 분리(`Speaker_Diarization_Enabled = true`) 는 **클라우드 모드에서만** 동작하며, AWS Transcribe 의 `ShowSpeakerLabel` 옵션을 통해 제공됩니다. 로컬 모드 v1 에서는 화자 분리를 지원하지 않으므로, 로컬 세션에서는 해당 토글이 비활성화되어 있습니다.

### 비용 안내

이 플러그인은 다음 AWS 서비스의 사용량 기반 과금 정책을 따릅니다. 모든 비용은 사용자의 AWS 계정에 청구됩니다.

- **AWS Transcribe Streaming** — 클라우드 전사 사용 시 오디오 분 단위 과금.
- **AWS Bedrock** — 분석 버튼 클릭 시 모델별 입력/출력 토큰 단위 과금.
- **AWS Translate** — `Translation_Enabled = true` 인 경우 **번역 입력 문자 수 단위로 과금**됩니다 (현재 표준 요금 기준 1백만 문자당 과금).

번역 비용을 사용자가 직접 가늠할 수 있도록 사이드바에는 `Translation_Cost_Counter` 가 노출됩니다. 이 카운터는 **현재 세션 동안 AWS Translate 에 입력으로 전달된 원본 텍스트의 누적 문자 수(코드포인트 단위)** 를 표시하며, 1초 이내 간격으로 갱신됩니다. 카운터는 청구 금액 자체가 아니라 사용량 추정용 지표이며, 실제 요금은 AWS 콘솔의 Cost Explorer / Bills 에서 확인하세요. 플러그인은 카운터에 하드 상한을 적용하지 않습니다.

### 보안 권장 사항

- vault 를 Git 이나 클라우드 서비스로 동기화하는 경우, `.obsidian/plugins/obsidian-transcribe-plugin/data.json` 을 별도로 제외할 수 없다면 **전용 저권한 IAM 키** 사용 + **정기 키 로테이션** 을 반드시 병행하세요.
- access key 가 외부에 노출되었다고 의심되는 즉시 AWS 콘솔에서 해당 키를 비활성화·삭제하세요.
- 공용 또는 공유 컴퓨터에서는 본 플러그인 사용을 권장하지 않습니다.

### 라이선스

[MIT License](./LICENSE)

### 개발자 — 릴리스 절차

다음 버전을 배포할 때는 `npm version` 을 사용해 세 파일(`package.json`, `manifest.json`, `versions.json`)을 한 번에 동기화한 뒤 태그를 푸시합니다. 태그 푸시 이벤트가 GitHub Actions `Release` 워크플로우를 트리거해 자동으로 번들을 빌드하고 `main.js`, `manifest.json`, `styles.css` 를 릴리스 자산으로 업로드합니다.

```bash
# 1.0.1 등 다음 버전으로 올리기 (커밋 + 태그 자동 생성, v 접두사 없음)
npm version 1.0.1 -m "chore(release): %s"

# 커밋과 태그를 함께 푸시
git push --follow-tags origin main
```

태그 이름은 `manifest.json.version` 과 정확히 일치해야 합니다(워크플로우가 검증합니다).

---

## 🇺🇸 English

### Overview

Transcribe is an Obsidian community plugin that streams microphone audio to AWS Transcribe in real time, saves the result as a Markdown note, and lets you analyze the transcript with an AWS Bedrock foundation model — all from a dedicated sidebar view.

### ⚠️ Read Before Use — Required Disclosures

Before installing or using this plugin, you must understand and agree to the following four points.

1. **External network usage**
   This plugin calls the following external endpoints to operate. Each endpoint is contacted only when its trigger condition is met; if the trigger never occurs, no traffic is sent to that endpoint.

   | Endpoint | Trigger | Data sent |
   |---|---|---|
   | `transcribestreaming.<region>.amazonaws.com` | Cloud-mode session (`cloud-only`, or `auto` while still on the cloud step) | Microphone PCM audio (16 kHz mono) |
   | `bedrock-runtime.<region>.amazonaws.com` | Analyze button (explicit user action) | Transcript note body text |
   | `bedrock.<region>.amazonaws.com` | Refreshing the model list in the settings screen | (no request body) |
   | `huggingface.co` | One-time download after explicit user consent in the local-model download modal — never re-contacted afterwards | (HTTPS GET, no request body) |
   | `translate.<region>.amazonaws.com` | `Translation_Enabled = true` and a Final_Result arrives | Final_Result source text only — microphone PCM is never sent |

   **Local-mode "no-network for audio" promise** — When `Backend_Selection_Mode` is `local-only`, or when `auto` falls back to local for a session, microphone PCM captured by the plugin is **not transmitted to any external endpoint**. Model weights are downloaded once from Hugging Face after explicit user consent; subsequent sessions use only the locally stored files. AWS Translate is contacted only when `Translation_Enabled = true`, and the request body contains **only the Final_Result text** — never the raw PCM.

2. **Your own AWS account and credentials are required**
   This plugin does **not** provide any hosted AI service. You must create your own AWS account, issue your own IAM access key ID and secret access key, and enable the Transcribe and Bedrock services (including per-region model access approval) yourself.

3. **You are solely responsible for AWS usage charges**
   AWS Transcribe Streaming and AWS Bedrock are **paid, usage-based services**. Every API call this plugin makes is billed to **your** AWS account. The plugin author assumes no responsibility for any charges incurred. Use AWS Cost Explorer and AWS Budgets to monitor spending.

4. **AWS credentials are stored in plain text in `data.json`**
   The AWS access key ID and secret access key you enter are stored **unencrypted** (plain JSON) in the plugin data file managed by Obsidian:
   `<vault>/.obsidian/plugins/obsidian-transcribe-plugin/data.json`
   Be aware of the following:
   - If you sync the vault directory via Git, iCloud, Dropbox, OneDrive, Obsidian Sync, etc., **your credentials will be transmitted and backed up alongside the vault**.
   - When sharing or archiving the vault, make sure `data.json` is excluded.
   - Following AWS best practices, use a **dedicated least-privilege IAM user or role** and **rotate the keys regularly**.

### Features

- Start and stop real-time transcription with a single sidebar button
- **Red pulsing recording indicator** + red stop button for clear state feedback
- Partial and final results rendered with distinct visual styles
- **Drag-select text** directly on the transcript board (no edit mode needed)
- **Clipboard copy icon** floating on the transcript board — one click to copy all
- Auto-save the transcript as `YYYY-MM-DD HH-mm.md` with YAML front matter
- **Recent transcripts list** (5 items) at the bottom of the sidebar — click to load, edit, or analyze
- Post-edit the saved transcript directly from the sidebar
- Append AWS Bedrock analysis (summary, keywords, **checkbox-style action items**) to the note
- **Sidebar inline controls** — pick transcription language and Bedrock model directly in the sidebar, no need to open Settings
- **Bedrock model dropdown** — refresh button auto-discovers available models and inference profiles
- **Custom vocabulary auto-sync** — enter words in settings, click sync to automatically register with AWS Transcribe
- **Custom analysis prompt** — add free-form instructions to guide the AI analysis
- English / Korean UI (switch in settings)
- Supports transcripts up to 200,000 characters (~8–12 hour meetings)

### Installation

#### Manual install (recommended for now)

1. Download `main.js`, `manifest.json`, and `styles.css` from the latest GitHub Release.
2. Copy the three files into your vault at:
   ```
   <vault>/.obsidian/plugins/obsidian-transcribe-plugin/
   ```
3. Restart Obsidian, then enable **Transcribe** under `Settings → Community plugins`.

#### Beta install via BRAT

1. Install and enable the [BRAT](https://github.com/TfTHacker/obsidian42-brat) plugin.
2. In BRAT, choose `Add Beta Plugin` and provide this repository URL.

### AWS Prerequisites

#### 1. Create an IAM user with least-privilege permissions

Create a programmatic-access IAM user and attach the following minimal policy:

```json
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Sid": "TranscribeStreaming",
            "Effect": "Allow",
            "Action": [
                "transcribe:StartStreamTranscription",
                "transcribe:StartStreamTranscriptionWebSocket",
                "transcribe:CreateVocabulary",
                "transcribe:UpdateVocabulary",
                "transcribe:GetVocabulary",
                "transcribe:DeleteVocabulary"
            ],
            "Resource": "*"
        },
        {
            "Sid": "BedrockAnalysis",
            "Effect": "Allow",
            "Action": [
                "bedrock:InvokeModel",
                "bedrock:ListFoundationModels",
                "bedrock:GetFoundationModel"
            ],
            "Resource": "*"
        },
        {
            "Sid": "TranslateRealtime",
            "Effect": "Allow",
            "Action": [
                "translate:TranslateText"
            ],
            "Resource": "*"
        }
    ]
}
```

> **The `TranslateRealtime` statement is OPTIONAL.** It is required only if you enable real-time translation by setting `Translation_Enabled = true`. If you do not use real-time translation, you can omit this statement entirely and cloud transcription/analysis will continue to work normally.
>
> For production, scope `Resource` down to specific Bedrock model ARNs.

#### 2. Approve Bedrock model access

In the AWS console, go to Bedrock → Model access and request/approve access to the foundation model you plan to use (for example `anthropic.claude-3-sonnet-*`, `anthropic.claude-3-haiku-*`).

> **Claude 4.5 note**: Claude Sonnet 4.5 and Claude Haiku 4.5 are only available through **cross-Region inference profiles**. In the model dropdown, select items with the ⚡ icon (e.g. `global.anthropic.claude-haiku-4-5-20251001-v1:0`).

#### 3. Pick a region

Choose a region where **both** Transcribe Streaming and Bedrock are available. The default is `us-east-1`.

### Settings overview

Configure the following under `Settings → Community plugins → Transcribe → Options`:

| Section | Field | Description |
|---|---|---|
| Language | Display language | UI language (`English` / `한국어`). Always the first item. |
| AWS credentials | AWS access key ID | IAM access key ID (max 128 chars) |
| | AWS secret access key | IAM secret access key (max 256 chars, masked input) |
| | AWS region | Region used for Transcribe and Bedrock (default `us-east-1`) |
| Transcription | Transcription language | Transcription language code (`ko-KR` or `en-US`). Also switchable from the sidebar |
| | Transcript folder | Folder path inside the vault where transcripts are saved. Empty means vault root. Vault folder autocompletion provided. |
| Analysis | Bedrock model ID | Select from dropdown or keep custom value. Refresh button auto-discovers models from AWS. Also switchable from the sidebar |
| | Custom analysis prompt | Additional instructions for the analysis model (free-form text) |
| Vocabulary | Custom vocabulary words | Words for AWS Transcribe to recognize. One per line. Click 'Sync to AWS' to register. |

### Usage

1. Open the sidebar via the `Open transcribe view` command or the ribbon icon.
2. At the top of the sidebar, use the inline dropdowns to pick the **transcription language** and the **Bedrock model**. These reflect the values saved in Settings and stay in sync both ways — changes in the sidebar update the settings tab and vice versa.
3. Click **Start streaming** and grant microphone permission.
4. As you speak, partial results appear in a muted style and are replaced by final results. A red pulsing indicator shows recording is active.
5. Click **Stop streaming** (red button) to save the transcript as `YYYY-MM-DD HH-mm.md`.
6. Drag-select text on the transcript board, or click the 📋 icon in the top-right corner to copy all.
7. Use **Edit** to correct errors, or **Analyze** to append Bedrock-generated meeting minutes (Summary, Keywords, Decisions, Action items, and Notes sections).
8. Click any item in the **Recent transcripts** list at the bottom to instantly load a previous note for editing, copying, or analysis.

### Local mode (Local Whisper)

> Local mode is an offline transcription mode where microphone PCM never leaves the device. It is active when `Backend_Selection_Mode` is `local-only`, or when `auto` falls back to local for a given session.

#### Supported model catalog

| Model ID | Display name | Approx. size (MB) | License | Hugging Face |
|---|---|---|---|---|
| `whisper-large-v3-turbo` | Whisper Large V3 Turbo | 1,700 | MIT | [onnx-community/whisper-large-v3-turbo](https://huggingface.co/onnx-community/whisper-large-v3-turbo) |
| `distil-whisper-large-v3` | Distil-Whisper Large V3 | 800 | MIT | [distil-whisper/distil-large-v3](https://huggingface.co/distil-whisper/distil-large-v3) |

Each model is downloaded from Hugging Face exactly once, only after explicit user consent in the download modal. Subsequent sessions read the locally stored file and never re-contact the network for weights.

#### Performance expectations

Throughput depends on the host CPU/GPU and the chosen streaming mode.

- **x86 CPUs (Intel/AMD desktops and laptops)**: typically **slower than real time**. A 30-second audio chunk often takes 60–90 seconds to transcribe, so total processing time can reach 2–3× the audio duration. Batch-style use after the meeting is a better fit for these machines.
- **Apple Silicon (M1/M2/M3/M4 Macs)**: **near real time**, thanks to ANE/Metal acceleration. You can typically follow along in the sidebar while the meeting is still happening.
- **Chunked-streaming mode**: audio is sliced into 30-second chunks; each chunk's transcript is appended to the sidebar as it completes, so partial results are visible during the recording. If a chunk's result is delayed beyond 200 ms, a progress indicator is shown.
- **Progress-only (batch) mode**: the full audio is transcribed in one pass after the recording stops. Only a progress percentage is shown during the recording, and the full transcript is appended to the note when inference completes.

#### Speaker diarization

Speaker diarization (`Speaker_Diarization_Enabled = true`) is **cloud-mode only**, delivered through AWS Transcribe's `ShowSpeakerLabel` option. **Local mode v1 does not support diarization**, so the toggle is disabled in the sidebar while a local-mode session is active.

### Cost guidance

This plugin uses the standard usage-based pricing of the underlying AWS services. All charges are billed to your AWS account.

- **AWS Transcribe Streaming** — billed per audio minute when cloud transcription is used.
- **AWS Bedrock** — billed per input/output token, model-dependent, when the Analyze button is used.
- **AWS Translate** — when `Translation_Enabled = true`, billed **per character of input submitted to AWS Translate** (currently per million characters under the standard rate).

To help you estimate translation cost during a session, the sidebar exposes a `Translation_Cost_Counter`. The counter shows the **cumulative number of source-text code points submitted to AWS Translate during the current session**, refreshed at least once per second. It is a usage proxy, not a billing total — verify the actual bill in the AWS console (Cost Explorer / Bills). The plugin does not impose a hard cap on this counter.

### Security recommendations

- If you sync your vault, prefer a **dedicated low-privilege IAM key** and **rotate it regularly**, because excluding a single file inside `.obsidian/plugins/` from sync is often not possible.
- If you suspect your access key has been exposed, **deactivate and delete it immediately** in the AWS console.
- Avoid using this plugin on shared or public computers.

### License

[MIT License](./LICENSE)

### Developer — release flow

To cut a new version, use `npm version` so that `package.json`, `manifest.json`, and `versions.json` all move together in a single commit, then push the tag. The tag push triggers the GitHub Actions `Release` workflow, which builds the bundle and uploads `main.js`, `manifest.json`, and `styles.css` as release assets automatically.

```bash
# Bump to the next version (creates a commit and tag, no "v" prefix)
npm version 1.0.1 -m "chore(release): %s"

# Push the commit and tag together
git push --follow-tags origin main
```

The tag name must exactly match `manifest.json.version` — the workflow verifies this.
