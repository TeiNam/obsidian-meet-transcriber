# Changelog

본 프로젝트의 모든 주목할 만한 변경 사항이 이 파일에 기록됩니다.

## [1.1.0] — 2025-05

> **요약**: v1.0 의 클라우드 전사·분석 기능을 그대로 유지하면서 세 가지 신규 기능 축
> (로컬 Whisper 전사 / 화자 분리 / 실시간 번역) 을 추가합니다. **기본값은 모두 비활성**
> 이며, 기존 사용자의 노트/설정/동작은 v1.0 과 비트 단위로 동치입니다.

### ✨ 신규 기능

#### 1. 로컬 Whisper 전사 (Local Whisper Transcription)

오프라인에서 Whisper 모델로 전사하는 모드를 추가했습니다. 마이크 PCM 오디오는
**장치를 절대 떠나지 않으며**, 모델 가중치는 사용자 동의 후 Hugging Face 에서
1회만 다운로드됩니다.

- **백엔드 선택**: `cloud-only` / `local-only` / `auto` 3가지 모드 (기본값: `cloud-only`)
- **자동 폴백 (`auto`)**: AWS 자격 증명 누락 / 오프라인 / 클라우드 시작 실패 시 로컬로 자동 전환
- **지원 모델 카탈로그**:
  - `whisper-large-v3-turbo` — 약 1700 MB, MIT
  - `distil-whisper-large-v3` — 약 800 MB, MIT
- **스트리밍 모드**: chunked-streaming(30초 청크별 부착) / progress-only(일괄 후 한 번에)
- **성능**: Apple Silicon → 거의 실시간, x86 CPU → 실시간의 2~3배 (회의 후 일괄 처리 권장)

#### 2. 화자 분리 (Speaker Diarization)

AWS Transcribe 의 `ShowSpeakerLabel` 을 통해 발화자를 자동 식별하고 `Speaker 1`,
`Speaker 2` ... 라벨을 부여합니다.

- **클라우드 모드 전용** (로컬 v1 미지원 — 토글이 자동 비활성화됩니다)
- 사이드바에 화자별 색상 구분으로 표시 (최대 10명)
- frontmatter 에 `speaker_diarization: true`, `speaker_count: N` 기록

#### 3. 실시간 번역 (Real-time Translation)

Final 결과가 도착할 때마다 AWS Translate 로 번역하여 사이드바에 부착합니다.

- **대상 언어**: en / ko / ja / zh / es / fr / de (7개 화이트리스트)
- **출력 형식**: `inline` (전사 라인 아래에 `→ 번역` 부착) / `none` (UI 만 표시, 노트 저장 시 제외)
- **자동 비활성화**: 30초 윈도우 내 3회 실패 시 1회 Notice 후 토글 자동 OFF
- **비용 카운터**: 사이드바에 누적 입력 문자 수가 1초 이내 갱신
- **오프라인 게이트**: 활성 백엔드가 `local` 인 경우 enqueue 자동 no-op + 1회 Notice
- **선택 IAM 권한**: `translate:TranslateText` (사용 시에만 필요)

### 🔒 기본값 변경 없음 (v1.0 호환)

기존 사용자의 영향은 **0** 입니다.

- 모든 신규 토글의 기본값은 비활성 (`cloud-only`, `false`, `inline`, ...)
- 기존 `data.json` 의 v1.0 키는 한 글자도 변경되지 않음
- 신규 frontmatter 키는 모두 optional — undefined 시 출력에서 제외
- v1.0 통짜 본문 직렬화 분기는 그대로 보존 (회귀 게이트로 snapshot 보호 — Requirement 8.2)

### 📦 모델 다운로드 안내

`local-only` 또는 `auto` 폴백을 처음 사용하려면 모델 다운로드가 필요합니다.

1. `Settings → Community plugins → Transcribe → Local model` 섹션에서 모델 선택
2. **Model folder** 에 OS 절대 경로 입력 (Vault 외부, OS 별 기본값 자동 prefill)
3. **Download model** 버튼 클릭 → 동의 모달에서 출처(`huggingface.co`)·크기·경로 확인 후 동의
4. 다운로드 진행률은 1초 이내 간격으로 갱신 (취소 가능)
5. 다운로드 완료 시 SHA-256 검증 후 `data.json.localModelInstalled` 에 메타데이터 기록
6. 이후 세션은 디스크의 로컬 파일만 사용 (네트워크 재호출 없음)

### 🔐 신규 IAM 권한 (선택)

실시간 번역을 사용하려면 IAM 정책에 다음 statement 를 추가하세요.

```json
{
    "Sid": "TranslateRealtime",
    "Effect": "Allow",
    "Action": ["translate:TranslateText"],
    "Resource": "*"
}
```

번역을 사용하지 않으면 추가 권한 없이 v1.0 권한 그대로 동작합니다.

### 🌐 신규 외부 엔드포인트 (선택)

| 엔드포인트 | 트리거 | 전송 데이터 |
|---|---|---|
| `huggingface.co` | 로컬 모델 다운로드 모달 동의 시 1회 | (HTTPS GET, 요청 본문 없음) |
| `translate.<region>.amazonaws.com` | `Translation_Enabled = true` + Final 도착 시 | Final 텍스트만 (PCM 절대 미전송) |

**로컬 모드의 "no-network for audio" 약속**: 마이크 PCM 은 어떠한 외부 엔드포인트로도 전송되지 않습니다.

### 📊 빌드 산출물 크기

| 파일 | 크기 |
|---|---|
| `main.js` | 484.6 KB |
| `whisper-worker.js` | 848.1 KB (신규 — 로컬 Whisper 추론 워커) |
| `styles.css` | 17 KB |
| **합계** | 1332.6 KB |

### 🧪 테스트 결과

- **TypeScript**: `tsc --noEmit` 통과
- **Vitest**: 287 / 287 passed (30 test files)
- **PBT (Property-Based Test)**: 14개 property 모두 통과
- **회귀 게이트**: NoteStore snapshot 으로 v1.0 비트 단위 동치 보장

### 🚀 릴리스 명령

```bash
# 1. 변경사항 커밋 (수동 QA 완료 후)
git add -A
git commit -m "chore(release): v1.1.0"

# 2. 태그 생성 + 푸시 (GitHub Actions 가 자동으로 산출물 업로드)
git tag 1.1.0
git push --follow-tags origin main
```

태그 이름은 `manifest.json.version` 과 정확히 일치해야 하며, 워크플로우가 검증합니다.

---

## [1.0.0]

초기 릴리스 — AWS Transcribe Streaming 기반 실시간 전사 + AWS Bedrock 분석.
