/**
 * `TranscribePlugin` — 플러그인 진입점.
 *
 * Obsidian `Plugin` 수명 주기를 관리하고 하위 컴포넌트(상태 머신, 서비스, 뷰,
 * 설정 저장소, 국제화) 를 조립한다. 본 파일은 두 개 태스크의 산출물이다:
 *
 * - Task 17.1 — 플러그인 수명 주기 / 뷰·커맨드·리본·설정 탭 등록, `changeLocale`.
 * - Task 17.2 — 사이드바 3개 버튼 핸들러(시작·중지 / 편집 / 분석) 통합.
 *
 * ## 설계 원칙
 * - **자원 누수 방지**: Transcribe 세션과 마이크 자원은 `TranscribeService.dispose()` 로만
 *   종료하고, 플러그인 언로드 시 남은 버퍼 내용을 자동 저장한다(Requirement 8.2~8.4).
 *   `detachLeavesOfType` 는 호출하지 않는다(Requirement 1.6).
 * - **상태 불변식**: 스트리밍/분석/편집 중인 상태에서의 임의 버튼 조합은
 *   `ButtonStatePolicy` 가 UI 레벨로 막고, 핸들러도 방어적으로 한 번 더 차단한다
 *   (Requirement 7.4, Property 14).
 * - **로깅 제약**: 모든 로깅은 `console.error` 만 사용(Requirement 9.6). 민감 정보
 *   (자격 증명, 오디오 샘플, AWS 응답 본문)는 기록하지 않는다.
 * - **DI 경계**: AWS SDK 클라이언트는 팩토리로 지연 생성하여, 자격 증명 변경이 즉시 반영되고
 *   테스트에서 `aws-sdk-client-mock` 으로 치환할 수 있도록 한다.
 */

import {
	Notice,
	Plugin,
	type TFile,
	type WorkspaceLeaf,
} from "obsidian";

import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { TranscribeStreamingClient } from "@aws-sdk/client-transcribe-streaming";
import { TranslateClient } from "@aws-sdk/client-translate";

import { createI18n, detectLocale, type Translations } from "./i18n";
import type { SupportedLocale } from "./i18n";
import type { Transcript_Segment } from "./domain/segments";
import { selectBackend } from "./domain/selectBackend";
import { selectTargetLanguage } from "./domain/selectTargetLanguage";
import { SettingsStore } from "./settings/SettingsStore";
import { computeDefaultModelFolder } from "./settings/LocalModelSettingsSection";
import { TranscribeSettingTab } from "./settings/TranscribeSettingTab";
import { StreamingStateMachine } from "./state/StreamingStateMachine";
import type { StreamingState } from "./state/StreamingStateMachine";
import { AudioCapture } from "./services/AudioCapture";
import { BedrockService } from "./services/BedrockService";
import {
	BedrockModelCatalog,
	type BedrockCatalogEntry,
} from "./services/BedrockModelCatalog";
import {
	Local_Whisper_Service,
	type LocalWhisperCallbacks,
} from "./services/Local_Whisper_Service";
import {
	Model_Download_Manager,
	createDefaultHttpStreamClient,
	createDefaultNodeFs,
} from "./services/Model_Download_Manager";
import type {
	Local_Model_Installation_Record,
	Local_Model_Installed_Map,
} from "./types/localModel";
import { NoteStore, type TranscriptNoteMeta } from "./services/NoteStore";
import {
	TranscribeService,
	type TranscribeCallbacks,
} from "./services/TranscribeService";
import {
	Translation_Service,
	buildTranslationQueueItem,
} from "./services/Translation_Service";
import { WhisperWorkerClient } from "./services/WhisperWorkerClient";
import { TranscribeError } from "./types/errors";
import type {
	AwsCredentials,
	LanguageCode,
	TranscribeSettings,
} from "./types/settings";
import {
	SidebarView,
	VIEW_TYPE_TRANSCRIBE,
	type SidebarEnvironmentInputs,
} from "./views/SidebarView";

// ─ AudioWorklet 소스 — 번들 단계에서 문자열로 인라인된다(esbuild workletTextPlugin).
//   런타임에 Blob URL 을 만들어 audioWorklet.addModule 에 전달한다. 별도 배포 파일 불필요.
import pcmWorkletSource from "./audio/pcm-worklet.js?worklet";

// ── 보조 상수 ────────────────────────────────────────────────────────────

/**
 * 분석 본문 길이 한계(Requirement 6.5). `BedrockService` 와 동일한 값을 참조한다.
 *
 * Claude 4.5 의 200K 토큰 컨텍스트 윈도우를 기준으로 200,000 자로 설정한다.
 * 실제 검증은 `BedrockService.analyze` 내부에서도 동일 값으로 수행되며,
 * 본 상수는 서버 호출 전 UI 에서 조기 차단하기 위한 이중 방어선이다.
 */
const MAX_TRANSCRIPT_LENGTH = 200_000;

/**
 * Notice 기본 표시 시간(밀리초). 3초 이상 표시 요구(예: Requirement 2.14)를 충족.
 */
const NOTICE_DURATION_MS = 5_000;

/**
 * stop() 타임아웃(밀리초). Requirement 4.2/4.10.
 */
const STOP_TIMEOUT_MS = 5_000;

// ── 플러그인 본체 ────────────────────────────────────────────────────────

export default class TranscribePlugin extends Plugin {
	// ---- 필드 ------------------------------------------------------------
	/** 현재 로드된 설정 스냅샷. 저장 탭/로케일 변경 시에도 이 참조가 유지된다. */
	settings!: TranscribeSettings;

	/** 설정 로드/저장/검증 책임. SettingTab 이 이 인스턴스에 접근한다. */
	settingsStore!: SettingsStore;

	/** 현재 로케일에 해당하는 번역 객체. `changeLocale` 시 재할당된다. */
	t!: Translations;

	/** 스트리밍 상태 머신(FSM). */
	state!: StreamingStateMachine;

	/** 실시간 전사 서비스. */
	transcribeService!: TranscribeService;

	/**
	 * 로컬 Whisper 전사 서비스 (v1.1, Requirement 4).
	 *
	 * `Backend_Selection_Mode === "local-only"` 또는 `"auto"` 의 폴백 경로에서 사용된다.
	 * 인스턴스 자체는 항상 생성되며, 활성 세션이 cloud 인 동안에는 idle 상태로 머무른다.
	 *
	 * `LocalInferenceClient` 는 `WhisperWorkerClient` 어댑터를 통해 `whisper-worker.js`
	 * Web Worker 와 통신한다. 워커 entrypoint URL 은 onload 시점에 vault adapter 의
	 * resource path 헬퍼로 해석된다.
	 */
	localWhisperService!: Local_Whisper_Service;

	/** AI 분석 서비스. */
	bedrockService!: BedrockService;

	/**
	 * 실시간 자막 번역 서비스 (v1.1, Requirement 13).
	 *
	 * 세션 lifecycle 동안 1 회 `beginSession` 으로 콜백을 등록하고, Final segment 가
	 * 도착할 때마다 `enqueue` 로 비동기 호출을 발사한다. 자동 비활성화 / 오프라인 게이트
	 * 정책은 본 서비스 내부에서 처리되므로 main 측에서는 게이트 분기 없이 enqueue 만
	 * 호출하면 된다.
	 */
	translationService!: Translation_Service;

	/**
	 * 로컬 Whisper 모델 다운로드 매니저 (v1.1, Requirement 2).
	 *
	 * 설정 탭의 "Download model" 버튼이 본 인스턴스를 통해 Hugging Face 에서
	 * 모델 가중치를 다운로드한다. globalThis.fetch + node:fs 기반 기본 어댑터를
	 * 주입하며, 다운로드 완료 시 `localModelInstalled` 맵에 기록한다.
	 */
	modelDownloadManager!: Model_Download_Manager;

	/**
	 * Bedrock 모델 카탈로그 조회 서비스.
	 *
	 * 설정 탭/사이드바 양쪽에서 "호출 가능한 모델 목록" 을 공유해야 하므로
	 * 플러그인 레벨에 단일 인스턴스를 둔다. 상태(캐시)는 `cachedModels` 에 별도로 보관.
	 */
	modelCatalog!: BedrockModelCatalog;

	/**
	 * 가장 최근에 성공한 모델 카탈로그 조회 결과.
	 *
	 * 사이드바가 열릴 때/설정 탭이 열릴 때 즉시 드롭다운을 채울 수 있도록 메모리에 유지한다.
	 * AWS 호출은 사용자가 명시적으로 새로고침 아이콘을 눌렀을 때에만 발생한다.
	 */
	private cachedModels: BedrockCatalogEntry[] = [];

	/** Transcript_Note I/O 래퍼. */
	noteStore!: NoteStore;

	/** 현재 세션과 연결된 Transcript_Note 파일. 저장 후 세팅된다. */
	private currentTranscriptFile: TFile | null = null;

	/**
	 * 현재 편집/분석 대상인 노트의 본문 문자 길이.
	 * 저장 직후 `clearBuffer()` 때문에 `TranscriptBuffer.length()` 가 0 으로 떨어져도
	 * 이 값은 보존되어 편집/분석 버튼의 활성 조건(Requirement 5.1, 6.3)을 만족시킨다.
	 */
	private currentNoteBodyLength = 0;

	/** 현재 세션이 시작된 시각(ISO 8601). 저장 시 프론트매터에 기록된다. */
	private sessionStartedAt: string | null = null;

	/** Bedrock 분석 진행 중 여부. 버튼 정책 입력. */
	private isAnalyzing = false;

	/** 사이드바가 편집 모드인지 여부. 버튼 정책 입력. */
	private isEditing = false;

	/** 상태 머신 onChange 리스너 해제 함수(onunload 에서 호출). */
	private stateUnsubscribe: (() => void) | null = null;

	// ─── v1.1 신규 (task 26, 27) — 백엔드 모드 / 번역 게이트 추적 ───

	/**
	 * 현재 활성 세션의 백엔드 식별자.
	 *
	 * 세션 시작 시점에 task 26 의 `selectBackend` 결과로 결정되며, idle 상태에서는
	 * `null`. 본 필드는 task 27 의 오프라인 게이트 Notice 분기 (활성 백엔드 = `local`
	 * 인 경우 1 회 표시) 및 task 26 의 noteStore frontmatter 기록 (Requirement 3.10) 에
	 * 사용된다.
	 *
	 * `auto` 모드의 인-세션 폴백이 발생하면 본 필드는 `cloud` → `local` 로 1 회 갱신된다
	 * (Requirement 3.8 EXCEPT). 본 v1 범위에서 한 세션 내 추가 변경은 허용되지 않는다.
	 *
	 * Requirement 3.8, 3.10, 14.4, 14.6, 13.7(v1.1 갱신본).
	 */
	private currentBackend: "cloud" | "local" | null = null;

	/**
	 * `auto` 모드의 인-세션 폴백이 이미 한 번 수행되었는지 추적한다 (Requirement 3.8 EXCEPT).
	 *
	 * 본 v1 범위에서 한 세션은 최대 1 회의 폴백만 허용된다. `selectBackend` 가
	 * `cloud` 를 반환한 직후 `false` 로 초기화되며, 폴백 경로 진입 시점에 `true` 로
	 * 갱신되고 그 이후의 추가 폴백 트리거는 무시된다.
	 */
	private fallbackPerformed = false;

	/**
	 * 한 세션 내에서 `translationOfflineUnsupported` Notice 가 이미 발사되었는지.
	 *
	 * 세션 시작 시 false 로 초기화. Requirement 14.5 / 13.7(v1.1 갱신본): 세션당
	 * 정확히 1 회만 표시된다. 세션 종료 시점에 다시 false 로 리셋된다.
	 */
	private translationOfflineNoticeShown = false;

	/**
	 * 설치된 로컬 Whisper 모델의 메타데이터 맵 (Requirement 2.10, 2.11).
	 *
	 * `data.json` 의 별도 최상위 키 `localModelInstalled` 로 직렬화되며, settings 와는
	 * 분리되어 관리된다. 키는 `LOCAL_MODEL_CATALOG` 의 `id`(예: `"whisper-large-v3-turbo"`)
	 * 이고 값은 `Local_Model_Installation_Record`(`filePath`, `sha256`, `installedAt` 등).
	 *
	 * 본 task 26 시점에는 다운로드 완료 시 본 맵을 갱신하는 와이어링 (`onLocalModelDownloaded`)
	 * 은 다른 task 의 책임이며, 본 필드는 `startStreaming()` 의 local 분기에서 모델
	 * 설치 여부를 조회하는 용도로만 사용된다 (Requirement 3.5: 미설치 시 `localModelMissing`
	 * Notice + 상태 idle 유지).
	 */
	private localModelInstalled: Local_Model_Installed_Map = {};

	// ---------------------------------------------------------------------
	// Plugin 수명 주기
	// ---------------------------------------------------------------------

	/**
	 * 플러그인 활성화 진입점.
	 *
	 * Obsidian 이 워크스페이스 준비 후 1회 호출한다. 내부에서는 설정 로드,
	 * 번역 객체 구성, 서비스 초기화, 뷰/커맨드/리본/설정 탭 등록을 순차 수행한다.
	 */
	async onload(): Promise<void> {
		// 1) 설정 로드 + 로케일 감지 → 번역 객체 생성.
		this.settingsStore = new SettingsStore(this);
		this.settings = await this.settingsStore.load();
		this.t = createI18n(detectLocale(this.settings.uiLocale));

		// task 26 — `localModelInstalled` 맵 로드 (Requirement 2.10, 2.11).
		// `SettingsStore` 가 settings 만 처리하므로 본 맵은 별도 경로로 `loadData()` 의
		// 결과에서 직접 추출한다. `data.json` 미존재 / 빈 객체 / 신규 사용자에 대해서는
		// 빈 맵으로 초기화하여 v1.0 호환을 보존한다.
		try {
			const raw = (await this.loadData()) as
				| { localModelInstalled?: Local_Model_Installed_Map }
				| null;
			if (
				raw &&
				typeof raw.localModelInstalled === "object" &&
				raw.localModelInstalled !== null
			) {
				this.localModelInstalled = raw.localModelInstalled;
			}
		} catch (err) {
			console.error(
				"[TranscribePlugin] localModelInstalled load failed:",
				err,
			);
		}

		// 2) 도메인 서비스 조립.
		this.noteStore = new NoteStore(this.app.vault);
		this.bedrockService = new BedrockService(
			(credentials, region) =>
				new BedrockRuntimeClient({
					region,
					credentials: {
						accessKeyId: credentials.accessKeyId,
						secretAccessKey: credentials.secretAccessKey,
					},
				}),
		);
		this.modelCatalog = new BedrockModelCatalog();
		// AudioWorklet 소스는 번들에 문자열로 인라인되어 있다(esbuild workletTextPlugin).
		// `AudioCapture` 가 이 소스로 Blob URL 을 생성해 audioWorklet.addModule 에 전달한다.
		// 별도 리소스 파일 배포가 불필요하며, Obsidian 의 `app://` 리소스 URL 에서 발생하는
		// `AbortError: Unable to load a worklet's module` 도 우회한다.
		const audioCapture = new AudioCapture({
			workletSource: pcmWorkletSource,
		});
		this.transcribeService = new TranscribeService(
			audioCapture,
			(credentials, region) =>
				new TranscribeStreamingClient({
					region,
					credentials: {
						accessKeyId: credentials.accessKeyId,
						secretAccessKey: credentials.secretAccessKey,
					},
				}),
		);

		// Local_Whisper_Service — task 26. cloud / local 양쪽 백엔드 모두 같은 audioCapture
		// 인스턴스를 공유한다(한 시점에 1 개 세션만 활성이므로 충돌 없음). 워커 진입점
		// 은 esbuild 가 플러그인 루트에 떨어뜨린 `whisper-worker.js` 로, vault adapter 의
		// `getResourcePath` 헬퍼로 `app://` URL 을 만들어 `WhisperWorkerClient` 에 주입한다.
		// 본 인스턴스는 활성 백엔드가 cloud 인 동안에는 idle 상태로 머무르며 자원을
		// 점유하지 않는다 (Requirement 10.4 단일 워커 불변식: 워커는 첫 `start()` 시점에
		// 만들어지고 `dispose()` 시 해제됨).
		this.localWhisperService = new Local_Whisper_Service(
			audioCapture,
			() => new WhisperWorkerClient(this.resolveWhisperWorkerUrl()),
		);

		// Translation_Service — task 27. 자격 증명/리전은 enqueue 시점에 인자로 받으므로
		// 본 단계에서는 클라이언트 팩토리만 주입한다 (BedrockService 와 같은 패턴).
		this.translationService = new Translation_Service(
			(credentials, region) =>
				new TranslateClient({
					region,
					credentials: {
						accessKeyId: credentials.accessKeyId,
						secretAccessKey: credentials.secretAccessKey,
					},
				}),
		);

		// Model_Download_Manager — Requirement 2. 설정 탭의 "Download model" 버튼이
		// 본 인스턴스를 통해 모델 가중치를 다운로드한다. 기본 어댑터는 globalThis.fetch +
		// node:fs 기반이며, 테스트에서는 다른 어댑터를 주입할 수 있다.
		this.modelDownloadManager = new Model_Download_Manager(
			createDefaultHttpStreamClient(),
			createDefaultNodeFs(),
		);

		// 3) 상태 머신 + 구독 — 상태가 바뀌면 열린 사이드바 뷰에 반영한다.
		this.state = new StreamingStateMachine();
		this.stateUnsubscribe = this.state.onChange((next, reconnecting) => {
			this.propagateStateToViews(next, reconnecting);
		});

		// 4) 사이드바 뷰 등록. 콜백 내부에 참조를 저장하지 않는다(Requirement 1.5).
		this.registerView(
			VIEW_TYPE_TRANSCRIBE,
			(leaf) => new SidebarView(leaf, this),
		);

		// 5) 리본 아이콘 + 커맨드. 커맨드에는 기본 hotkey 를 지정하지 않는다(Requirement 1.4).
		this.addRibbonIcon("mic", this.t.commands.openView, () => {
			void this.activateView();
		});
		this.addCommand({
			id: "open-transcribe-view",
			name: this.t.commands.openView,
			callback: () => {
				void this.activateView();
			},
		});

		// 6) 설정 탭 등록.
		this.addSettingTab(new TranscribeSettingTab(this.app, this));
	}

	/**
	 * 플러그인 비활성화 / Obsidian 종료 진입점.
	 *
	 * - Transcribe 세션 abort 및 마이크 트랙 해제(Requirement 8.2, 8.3).
	 * - 버퍼 내용이 남아 있으면 Transcript_Note 로 자동 저장(Requirement 8.4).
	 * - `detachLeavesOfType` 는 호출하지 않는다(Requirement 1.6).
	 * - 상태 머신 리스너는 plugin 전역 자동 해제 대상이 아니므로 명시 해제한다.
	 */
	async onunload(): Promise<void> {
		// 버퍼에 미저장 본문이 있으면 보존한다. 실패해도 예외를 밖으로 던지지 않는다.
		try {
			await this.autoSaveBufferIfAny();
		} catch (err) {
			console.error("[TranscribePlugin] auto-save during onunload failed:", err);
		}

		// 세션/마이크 정리(동기).
		try {
			this.transcribeService?.dispose();
		} catch (err) {
			console.error("[TranscribePlugin] transcribeService.dispose failed:", err);
		}

		// task 26 — Local_Whisper_Service 자원 정리. 활성 워커가 있으면 5 초 한도 내
		// 종료를 시도하고, 초과 시 클라이언트가 자체적으로 terminate 한다 (Requirement
		// 10.5). dispose 는 멱등하므로 여러 번 호출해도 안전.
		try {
			this.localWhisperService?.dispose();
		} catch (err) {
			console.error(
				"[TranscribePlugin] localWhisperService.dispose failed:",
				err,
			);
		}

		// task 27 — 번역 서비스 정리. in-flight 호출은 abort 하지 않으며 도착해도
		// 콜백 null 로 인해 조용히 무시된다.
		try {
			this.translationService?.endSession();
		} catch (err) {
			console.error(
				"[TranscribePlugin] translationService.endSession failed:",
				err,
			);
		}

		// 상태 머신 구독 해제.
		if (this.stateUnsubscribe) {
			this.stateUnsubscribe();
			this.stateUnsubscribe = null;
		}
	}

	/**
	 * 사이드바 뷰를 열거나 이미 열려 있으면 포커스를 이동한다(Requirement 1.2, 1.3).
	 *
	 * 열린 직후 최근 전사 리스트를 주입하여 첫 표시가 지연되지 않게 한다.
	 */
	async activateView(): Promise<void> {
		const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_TRANSCRIBE);
		if (existing.length > 0) {
			this.app.workspace.revealLeaf(existing[0]);
			this.forEachSidebar((view) =>
				view.setRecentTranscripts(this.getRecentTranscripts()),
			);
			return;
		}
		const leaf: WorkspaceLeaf | null = this.app.workspace.getRightLeaf(false);
		if (leaf === null) {
			return;
		}
		await leaf.setViewState({ type: VIEW_TYPE_TRANSCRIBE, active: true });
		this.app.workspace.revealLeaf(leaf);
		// setViewState 이후 뷰가 초기화되므로 리스트 주입은 마이크로태스크로 한 번 지연.
		queueMicrotask(() => {
			this.forEachSidebar((view) =>
				view.setRecentTranscripts(this.getRecentTranscripts()),
			);
		});
	}

	/**
	 * UI 언어 전환(Requirement 10.5).
	 *
	 * 설정 저장 → 번역 갱신 → 열린 `SidebarView` 에 새 번역 전달. 저장 실패 시 기존 설정은
	 * 유지하고 사용자에게 Notice 를 보인다(Requirement 2.15).
	 */
	async changeLocale(locale: SupportedLocale): Promise<void> {
		const previous = this.settings.uiLocale;
		this.settings.uiLocale = locale;
		try {
			await this.settingsStore.save(this.settings);
		} catch (err) {
			console.error("[TranscribePlugin] changeLocale save failed:", err);
			this.settings.uiLocale = previous;
			new Notice(this.t.notices.settingsSaveFailed, NOTICE_DURATION_MS);
			return;
		}
		this.t = createI18n(locale);
		this.forEachSidebar((view) => view.onLocaleChange(this.t));
	}

	// ---------------------------------------------------------------------
	// SidebarView 계약 — TranscribePluginLike 구현 (Task 17.2 핵심)
	// ---------------------------------------------------------------------

	/**
	 * 버튼 활성화 정책에 넘길 현재 환경 스냅샷을 반환한다.
	 *
	 * 순수 조회만 수행하며 부작용이 없어야 한다(정책이 멱등하게 계산되도록).
	 * `transcriptLength` 는 **현재 뷰에 로드된 노트 본문 길이**를 사용한다.
	 * 스트리밍 중에는 버퍼 길이를 대신 사용하며, 저장 후에는 저장된 노트 본문 길이가 유지되어
	 * 편집/분석 버튼 활성화가 보장된다.
	 */
	getEnvironmentInputs(): SidebarEnvironmentInputs {
		const bufferLength = this.transcribeService.getTranscriptBuffer().length();
		// 스트리밍 중에는 실시간 버퍼 길이가 의미 있고, 저장 이후에는 currentNoteBodyLength 가 정답.
		const isStreaming = this.state.getState() === "streaming";
		const effectiveLength = isStreaming
			? bufferLength
			: Math.max(bufferLength, this.currentNoteBodyLength);
		return {
			hasTranscriptNote: this.currentTranscriptFile !== null,
			transcriptLength: effectiveLength,
			hasCredentials: this.hasAwsCredentials(),
			hasBedrockModel: this.settings.bedrockModelId.trim().length > 0,
		};
	}

	// ─ 사이드바 인라인 컨트롤(언어/모델 빠른 선택) 핸들러 ───────────

	/** 현재 설정에 저장된 전사 언어 코드. */
	getCurrentLanguage(): LanguageCode {
		return this.settings.languageCode;
	}

	/** 현재 설정에 저장된 Bedrock 모델 ID. */
	getCurrentModelId(): string {
		return this.settings.bedrockModelId;
	}

	// ─ v1.1 신규 (task 24) — 사이드바 인라인 미러 컨트롤 getter ─

	/** 화자 분리 활성 여부 (Requirement 6.2 의 미러 동기화). */
	getCurrentSpeakerDiarizationEnabled(): boolean {
		return this.settings.speakerDiarizationEnabled;
	}

	/** 실시간 번역 활성 여부 (Requirement 13.2 의 미러 동기화). */
	getCurrentTranslationEnabled(): boolean {
		return this.settings.translationEnabled;
	}

	/** 번역 대상 언어 (Requirement 13.3). */
	getCurrentTranslationTargetLanguage(): TranscribeSettings["translationTargetLanguage"] {
		return this.settings.translationTargetLanguage;
	}

	/** 번역 출력 형식 (Requirement 13.7) — 사이드바 미러 컨트롤용 getter. */
	getCurrentTranslationOutputFormat(): TranscribeSettings["translationOutputFormat"] {
		return this.settings.translationOutputFormat;
	}

	/**
	 * 백엔드 선택 모드 (Requirement 14.2, 14.3 의 사이드바 모드 게이트).
	 *
	 * 사이드바 인라인 컨트롤과 분석 버튼의 idle 상태 disabled 판단에 사용된다.
	 */
	getCurrentBackendSelectionMode(): TranscribeSettings["backendSelectionMode"] {
		return this.settings.backendSelectionMode;
	}

	/**
	 * 사이드바의 활성 엔진 표시 라벨에서 사용하는 로컬 모델 ID (task 33).
	 *
	 * 빈 문자열은 "미선택" 으로 간주한다. 본 메서드는 read-only 이므로 별도 캐싱 없이
	 * settings 의 현재 값을 그대로 반환한다.
	 */
	getCurrentLocalModelId(): string {
		return this.settings.localModelId;
	}

	/**
	 * 백엔드 선택 모드를 즉시 변경하고 저장한다 (task 33).
	 *
	 * 설정 탭과 사이드바 인라인 드롭다운 양쪽에서 호출되며, 한쪽에서 변경하면 다른쪽도
	 * 즉시 갱신되도록 `rerenderOpenSettingTab` + `forEachSidebar(render)` 를 모두 호출한다.
	 * 활성 엔진 표시 라벨과 모드 게이트(분석 버튼/번역/화자 분리/대상 언어)의 idle 상태가
	 * 모드 변경에 즉시 반영되어야 하기 때문이다.
	 */
	async setBackendSelectionMode(
		mode: TranscribeSettings["backendSelectionMode"],
	): Promise<void> {
		if (this.settings.backendSelectionMode === mode) return;
		this.settings.backendSelectionMode = mode;
		await this.persistSettings();
		this.rerenderOpenSettingTab();
		this.forEachSidebar((view) => view.render());
	}

	/**
	 * 전사 언어를 즉시 변경하고 저장한다.
	 *
	 * 스트리밍 중 변경은 허용되지만, 다음 세션부터 적용된다(현재 세션의 AWS Transcribe
	 * 파라미터는 세션 생성 시 고정되므로 재시작이 필요하다). 필요 시 사용자에게 안내한다.
	 */
	async setLanguage(code: LanguageCode): Promise<void> {
		if (this.settings.languageCode === code) return;
		this.settings.languageCode = code;
		await this.persistSettings();
		if (this.state.getState() === "streaming") {
			new Notice(this.t.notices.singleSessionActive, NOTICE_DURATION_MS);
		}
		// 열린 설정 탭을 최신 값으로 재렌더해 UI 불일치를 피한다.
		this.rerenderOpenSettingTab();
	}

	/**
	 * Bedrock 분석 모델 ID 를 즉시 변경하고 저장한다.
	 *
	 * 설정 탭/사이드바 어느 쪽에서 변경하든 동일한 경로를 타도록 한다.
	 */
	async setModelId(modelId: string): Promise<void> {
		if (this.settings.bedrockModelId === modelId) return;
		this.settings.bedrockModelId = modelId;
		await this.persistSettings();
		this.rerenderOpenSettingTab();
		// 모델 입력이 생기면 분석 버튼 활성 조건이 바뀌므로 재계산.
		this.refreshSidebarButtons();
	}

	/**
	 * 화자 분리 활성화 여부를 즉시 변경하고 저장한다 (Requirement 6.1, 6.2).
	 *
	 * 설정 탭과 사이드바 인라인 토글 양쪽에서 호출되며, 한쪽에서 변경하면
	 * 다른쪽도 즉시 갱신되도록 `rerenderOpenSettingTab` + `forEachSidebar(render)`
	 * 를 둘 다 호출한다 (Requirement 6.2 의 미러 동기화).
	 */
	async setSpeakerDiarizationEnabled(enabled: boolean): Promise<void> {
		if (this.settings.speakerDiarizationEnabled === enabled) return;
		this.settings.speakerDiarizationEnabled = enabled;
		await this.persistSettings();
		this.rerenderOpenSettingTab();
		// 사이드바 인라인 토글의 표시 상태를 새 값으로 다시 그린다.
		this.forEachSidebar((view) => view.render());
	}

	/**
	 * 실시간 번역 활성화 여부를 즉시 변경하고 저장한다 (Requirement 13.1, 13.2).
	 *
	 * 설정 탭과 사이드바 인라인 토글 양쪽에서 호출되며 양방향 미러 동기화한다.
	 */
	async setTranslationEnabled(enabled: boolean): Promise<void> {
		if (this.settings.translationEnabled === enabled) return;
		this.settings.translationEnabled = enabled;
		await this.persistSettings();
		this.rerenderOpenSettingTab();
		this.forEachSidebar((view) => view.render());
	}

	/**
	 * 번역 대상 언어를 즉시 변경하고 저장한다 (Requirement 13.3).
	 */
	async setTranslationTargetLanguage(
		lang: TranscribeSettings["translationTargetLanguage"],
	): Promise<void> {
		if (this.settings.translationTargetLanguage === lang) return;
		this.settings.translationTargetLanguage = lang;
		await this.persistSettings();
		this.rerenderOpenSettingTab();
		this.forEachSidebar((view) => view.render());
	}

	/**
	 * 번역 결과 직렬화 방식을 즉시 변경하고 저장한다 (Requirement 13.7).
	 *
	 * v1.1 정리에서 사이드바 인라인 미러 컨트롤로 이전되었으므로, 사이드바도 함께
	 * 재렌더해 드롭다운 값을 즉시 반영한다.
	 */
	async setTranslationOutputFormat(
		format: TranscribeSettings["translationOutputFormat"],
	): Promise<void> {
		if (this.settings.translationOutputFormat === format) return;
		this.settings.translationOutputFormat = format;
		await this.persistSettings();
		this.rerenderOpenSettingTab();
		this.forEachSidebar((view) => view.render());
	}

	/** 현재 메모리에 캐시된 Bedrock 모델 카탈로그. */
	getAvailableModels(): BedrockCatalogEntry[] {
		return this.cachedModels;
	}

	/**
	 * AWS Bedrock 카탈로그를 재조회해 캐시를 갱신한다.
	 *
	 * 자격 증명/리전이 누락되면 Notice 로 안내하고 빈 배열을 반환한다(throw 는 하지 않는다 —
	 * 사용자가 자격 증명을 넣는 중 빈번히 호출될 수 있으므로). AWS 호출 실패는 code 별
	 * Notice 로 분기한 뒤 다시 throw 하여 호출자(설정 탭/사이드바)가 로딩 상태를 해제할 수 있게 한다.
	 */
	async refreshAvailableModels(): Promise<BedrockCatalogEntry[]> {
		const missing = this.collectMissingStreamingFields();
		if (missing.length > 0) {
			new Notice(
				this.t.notices.missingSettings(missing),
				NOTICE_DURATION_MS,
			);
			return this.cachedModels;
		}
		try {
			const models = await this.modelCatalog.listInvokableModels({
				credentials: this.currentCredentials(),
				region: this.settings.region,
			});
			this.cachedModels = models;
			this.rerenderOpenSettingTab();
			return models;
		} catch (err) {
			if (err instanceof TranscribeError && err.code === "AWS_AUTH") {
				new Notice(this.t.notices.awsAuthError, NOTICE_DURATION_MS);
			} else {
				console.error(
					"[TranscribePlugin] refreshAvailableModels failed:",
					err,
				);
				new Notice(this.t.notices.awsNetworkError, NOTICE_DURATION_MS);
			}
			throw err;
		}
	}

	/**
	 * 설정을 저장하되 실패 시 Notice 만 띄우고 조용히 넘어간다(사이드바 경로에서는
	 * 저장 실패가 연쇄 UI 중단으로 이어지지 않도록 함).
	 */
	private async persistSettings(): Promise<void> {
		try {
			await this.settingsStore.save(this.settings);
		} catch (err) {
			console.error("[TranscribePlugin] persistSettings failed:", err);
			new Notice(this.t.notices.settingsSaveFailed, NOTICE_DURATION_MS);
		}
	}

	/**
	 * 열려 있는 설정 탭이 있다면 재렌더해서 사이드바에서 바꾼 값이 탭에도 반영되도록 한다.
	 *
	 * Obsidian 의 설정 UI 가 열려 있지 않을 수도 있으므로 실패해도 무시한다.
	 */
	private rerenderOpenSettingTab(): void {
		try {
			const setting = (this.app as unknown as {
				setting?: { activeTab?: { display?: () => void } };
			}).setting;
			const tab = setting?.activeTab;
			if (tab && tab instanceof TranscribeSettingTab) {
				tab.display();
			}
		} catch (err) {
			console.error(
				"[TranscribePlugin] rerenderOpenSettingTab failed:",
				err,
			);
		}
	}

	/**
	 * 시작/중지 버튼 클릭 핸들러.
	 *
	 * 현재 상태가 `streaming` 이면 중지, 그 외에는 시작으로 분기한다.
	 * 두 분기 모두 내부에서 예외를 catch 하여 상태 머신을 에러로 전이하고
	 * Notice 로 사용자에게 알린다.
	 */
	async handleStartStopClick(): Promise<void> {
		if (this.state.getState() === "streaming") {
			await this.stopStreaming();
		} else {
			await this.startStreaming();
		}
	}

	/**
	 * 편집 버튼 클릭 핸들러.
	 *
	 * 스트리밍/분석 중에는 `ButtonStatePolicy` 가 버튼을 비활성화해 이 핸들러로 도달하지
	 * 않는다. 방어적으로 streaming 일 때 호출되면 Notice 후 중단한다(Requirement 7.4).
	 */
	handleEditClick(): void {
		if (this.state.getState() === "streaming") {
			new Notice(
				this.t.notices.streamingBlockEditAnalyze,
				NOTICE_DURATION_MS,
			);
			return;
		}
		if (this.currentTranscriptFile === null) {
			return;
		}
		this.isEditing = true;
		this.forEachSidebar((view) => view.enterEditMode());
		this.refreshSidebarButtons();
	}

	/**
	 * 편집 저장 핸들러. 공백 전용 거부 후 `NoteStore.overwriteTranscript` 호출.
	 *
	 * 본 메서드는 검증/저장 실패 시 예외를 그대로 던져 뷰가 편집 모드를 유지하도록 한다
	 * (Requirement 5.7, 5.8).
	 */
	async handleSaveEditClick(newBody: string): Promise<void> {
		// 공백 전용 판정(유니코드 공백 + 전각 공백, Requirement 5.8).
		if (/^[\s\u3000]*$/.test(newBody)) {
			new Notice(this.t.notices.editEmpty, NOTICE_DURATION_MS);
			throw new Error("edit body is empty");
		}
		const file = this.currentTranscriptFile;
		if (file === null) {
			// 저장 대상이 없다면 조용히 편집 취소로 간주한다.
			this.isEditing = false;
			this.refreshSidebarButtons();
			return;
		}
		try {
			await this.noteStore.overwriteTranscript(file, newBody);
		} catch (err) {
			console.error("[TranscribePlugin] overwriteTranscript failed:", err);
			new Notice(this.t.notices.ioError, NOTICE_DURATION_MS);
			throw err;
		}
		// 성공 — 뷰 본문 갱신 + 플래그 해제.
		this.isEditing = false;
		this.currentNoteBodyLength = newBody.length;
		this.forEachSidebar((view) => view.loadNoteContent(newBody));
		this.refreshSidebarButtons();
	}

	/**
	 * 편집 취소 핸들러. 버퍼/노트에는 영향을 주지 않는다.
	 */
	handleCancelEditClick(): void {
		this.isEditing = false;
		this.refreshSidebarButtons();
	}

	/**
	 * 복사 버튼 클릭 핸들러.
	 *
	 * 현재 뷰에 로드된 본문(편집 중이면 editor textarea 값, 아니면 committed 버퍼/노트)을
	 * 시스템 클립보드에 복사한다. 복사할 내용이 비어 있으면 Notice 로 안내하고 조기 종료.
	 *
	 * `navigator.clipboard.writeText` 를 우선 사용하되 실패 시 Notice 로 fallback 안내.
	 */
	async handleCopyClick(text: string): Promise<void> {
		if (text.length === 0) {
			new Notice(this.t.notices.bufferEmpty, NOTICE_DURATION_MS);
			return;
		}
		try {
			await navigator.clipboard.writeText(text);
			new Notice(this.t.ui.copied, NOTICE_DURATION_MS);
		} catch (err) {
			console.error("[TranscribePlugin] clipboard write failed:", err);
			new Notice(this.t.ui.copyFailed, NOTICE_DURATION_MS);
		}
	}

	/**
	 * 사이드바의 "최근 전사" 리스트에 노출할 파일 목록을 반환한다.
	 *
	 * 현재 설정된 `transcriptFolder` 를 대상으로 최대 5개를 mtime 내림차순으로 조회한다.
	 * 순수 조회 메서드이며 부작용은 없다.
	 */
	getRecentTranscripts(): TFile[] {
		return this.noteStore.listRecentTranscripts(
			this.settings.transcriptFolder,
			5,
		);
	}

	/**
	 * 최근 전사 리스트에서 항목을 클릭했을 때의 핸들러.
	 *
	 * - 스트리밍 중에는 차단(현재 세션을 덮어쓰면 데이터 손실 가능).
	 * - 선택된 파일 본문을 읽어 현재 편집/분석 대상으로 승격한다.
	 * - 상태는 유지하고 버튼 활성 정책만 재계산한다.
	 */
	async handleRecentTranscriptClick(file: TFile): Promise<void> {
		if (this.state.getState() === "streaming") {
			new Notice(
				this.t.notices.streamingBlockEditAnalyze,
				NOTICE_DURATION_MS,
			);
			return;
		}
		let body: string;
		try {
			body = await this.noteStore.readTranscriptBody(file);
		} catch (err) {
			console.error("[TranscribePlugin] readTranscriptBody failed:", err);
			new Notice(this.t.notices.ioError, NOTICE_DURATION_MS);
			return;
		}
		this.currentTranscriptFile = file;
		this.currentNoteBodyLength = body.length;
		// 새 세션이 아니라 기존 노트 로드이므로 현재 버퍼/세션 시작 시각은 유지하지 않는다.
		this.transcribeService.clearBuffer();
		this.sessionStartedAt = null;
		this.forEachSidebar((view) => view.loadNoteContent(body));
		this.refreshSidebarButtons();
	}

	/**
	 * 분석 버튼 클릭 핸들러.
	 *
	 * 실행 순서:
	 * 1. 스트리밍 중이면 차단(Requirement 7.4).
	 * 2. 자격 증명/모델 누락 검사 → 누락 필드 Notice 후 중단(Requirement 2.14).
	 * 3. 현재 노트 본문 읽기 → 길이 초과 시 Notice 후 중단(Requirement 6.5).
	 * 4. 스피너 on → `BedrockService.analyze` 호출 → 성공 시 `appendAnalysis`.
	 * 5. 실패/타임아웃 코드별 Notice 매핑(Requirement 6.11~6.15).
	 * 6. finally: 스피너 off + 버튼 상태 재계산.
	 */
	async handleAnalyzeClick(): Promise<void> {
		if (this.state.getState() === "streaming") {
			new Notice(
				this.t.notices.streamingBlockEditAnalyze,
				NOTICE_DURATION_MS,
			);
			return;
		}

		const missing = this.collectMissingAnalysisFields();
		if (missing.length > 0) {
			new Notice(
				this.t.notices.missingSettings(missing),
				NOTICE_DURATION_MS,
			);
			return;
		}

		const file = this.currentTranscriptFile;
		if (file === null) {
			return;
		}

		let body: string;
		try {
			body = await this.noteStore.readTranscriptBody(file);
		} catch (err) {
			console.error("[TranscribePlugin] readTranscriptBody failed:", err);
			new Notice(this.t.notices.ioError, NOTICE_DURATION_MS);
			return;
		}

		if (body.length > MAX_TRANSCRIPT_LENGTH) {
			new Notice(this.t.notices.transcriptTooLong, NOTICE_DURATION_MS);
			return;
		}

		this.isAnalyzing = true;
		this.forEachSidebar((view) => view.showAnalyzeSpinner(true));
		this.refreshSidebarButtons();

		try {
			const analysis = await this.bedrockService.analyze({
				credentials: this.currentCredentials(),
				region: this.settings.region,
				modelId: this.settings.bedrockModelId,
				transcript: body,
				locale: this.settings.uiLocale,
				glossary: this.settings.analysisGlossary,
			});
			try {
				await this.noteStore.appendAnalysis(
					file,
					analysis,
					this.settings.uiLocale,
				);
			} catch (err) {
				console.error("[TranscribePlugin] appendAnalysis failed:", err);
				new Notice(this.t.notices.ioError, NOTICE_DURATION_MS);
				return;
			}
			// 본문이 바뀌었으므로 뷰를 최신 노트 내용으로 갱신한다.
			try {
				const updated = await this.noteStore.readTranscriptBody(file);
				this.currentNoteBodyLength = updated.length;
				this.forEachSidebar((view) => view.loadNoteContent(updated));
			} catch (err) {
				console.error(
					"[TranscribePlugin] reload after appendAnalysis failed:",
					err,
				);
			}
		} catch (err) {
			this.notifyAnalysisError(err);
		} finally {
			this.isAnalyzing = false;
			this.forEachSidebar((view) => view.showAnalyzeSpinner(false));
			this.refreshSidebarButtons();
		}
	}

	// ---------------------------------------------------------------------
	// 내부 — 스트리밍 시작/중지 구현
	// ---------------------------------------------------------------------

	/**
	 * 스트리밍 시작 플로우.
	 *
	 * 본 메서드는 task 26 에서 `selectBackend` 기반으로 cloud / local 백엔드를 분기하도록
	 * 확장되었다. 흐름:
	 *
	 * 1. 이미 세션 활성 시 Notice 후 중단 (Requirement 7.6).
	 * 2. `state.dispatch("START_REQUESTED")` + 세션 시작 시각 기록.
	 * 3. 이전 버퍼/뷰 콘텐츠 초기화 + 번역 세션 시작.
	 * 4. `selectBackend(settings, networkProbe)` 로 백엔드 결정 (Requirement 3.1~3.4).
	 * 5. 모드 게이트 통지 (Requirement 14.4): `Translation_Service.markBackendChanged` +
	 *    `SidebarView.setOnlineOnlyControlsEnabled(backend === "cloud")` + (local 인 경우)
	 *    `SidebarView.setAnalysisButtonEnabled(false)`.
	 * 6. 백엔드별 분기:
	 *    - `cloud`: 자격 증명 검증 → `TranscribeService.start(...)`.
	 *    - `local`: 모델 설치 검증 → `Local_Whisper_Service.start(...)`.
	 *    실패는 `handleSessionError` 로 통지되며, `auto` 모드의 cloud 실패는 폴백으로
	 *    이어진다 (Requirement 3.4 후반부, 3.8 EXCEPT, 14.6).
	 */
	private async startStreaming(): Promise<void> {
		if (this.state.getState() === "streaming") {
			new Notice(
				this.t.notices.singleSessionActive,
				NOTICE_DURATION_MS,
			);
			return;
		}

		this.state.dispatch({ type: "START_REQUESTED" });
		this.sessionStartedAt = new Date().toISOString();

		// 새 세션 전에 이전 버퍼/노트 참조를 정리한다. 이전 노트 파일 자체는
		// 사용자가 별도로 편집/분석할 수 있도록 vault 에 남겨 둔다.
		this.transcribeService.clearBuffer();
		this.localWhisperService.clearBuffer();
		this.currentTranscriptFile = null;
		this.currentNoteBodyLength = 0;
		this.forEachSidebar((view) => view.loadNoteContent(""));

		// task 27 — 번역 세션 시작.
		this.translationOfflineNoticeShown = false;
		this.beginTranslationSession();

		// task 26 — 백엔드 결정 + 모드 게이트 통지.
		const decision = selectBackend(this.settings, {
			hasCredentials: this.hasAwsCredentials(),
			isOnline: typeof navigator !== "undefined" ? navigator.onLine : true,
		});
		this.fallbackPerformed = false;
		this.applyBackendDecision(decision.backend);

		// auto 모드의 사전 감지 폴백 — Notice 로 사유를 알리고 즉시 local 경로로 진입.
		if (decision.preflightFallbackReason !== undefined) {
			new Notice(
				decision.preflightFallbackReason === "no-credentials"
					? this.t.notices.backendFallbackNoCredentials
					: this.t.notices.backendFallbackOffline,
				NOTICE_DURATION_MS,
			);
			console.error(
				`backend_preflight_fallback: ${decision.preflightFallbackReason}`,
			);
		}

		// 백엔드별 분기 — cloud 면 TranscribeService, local 이면 Local_Whisper_Service.
		if (decision.backend === "cloud") {
			await this.startCloudSession();
		} else {
			await this.startLocalSession();
		}
	}

	/**
	 * cloud 백엔드 세션 시작 — 자격 증명 검증 후 `TranscribeService.start(...)` 발사.
	 *
	 * 자격 증명 누락은 본 메서드 진입 전에 `selectBackend` 가 `auto` 모드에서 사전
	 * 감지로 잡아내지만, `cloud-only` 모드에서는 본 메서드에서 추가로 검증한다 (사용자가
	 * 자격 증명을 비운 채 cloud-only 로 시작 시도). 누락이면 Notice + 상태 idle 복귀.
	 */
	private async startCloudSession(): Promise<void> {
		const missing = this.collectMissingStreamingFields();
		if (missing.length > 0) {
			new Notice(
				this.t.notices.missingSettings(missing),
				NOTICE_DURATION_MS,
			);
			this.state.dispatch({ type: "SESSION_FAILED", reason: "missing_credentials" });
			this.endTranslationSession();
			return;
		}

		try {
			await this.transcribeService.start({
				credentials: this.currentCredentials(),
				region: this.settings.region,
				languageCode: this.settings.languageCode,
				vocabularyName: this.settings.transcribeVocabularyName,
				showSpeakerLabel: this.settings.speakerDiarizationEnabled,
				callbacks: this.buildTranscribeCallbacks(),
			});
		} catch (err) {
			console.error("[TranscribePlugin] transcribeService.start threw:", err);
			this.state.dispatch({ type: "SESSION_FAILED", reason: "start_failed" });
			new Notice(this.t.notices.sessionTimeout, NOTICE_DURATION_MS);
			this.endTranslationSession();
		}
	}

	/**
	 * local 백엔드 세션 시작 — 모델 설치 검증 후 `Local_Whisper_Service.start(...)`.
	 *
	 * Requirement 3.5: `localModelInstalled[id]` 가 비어 있거나 `localModelId` 가 빈
	 * 값이면 모델 미설치 사유를 포함한 Notice 5 초+ 표시 + 상태 idle 복귀.
	 *
	 * `localModelInstalled` 는 plugin 의 `loadData()` 결과의 별도 키에 저장되며, 본
	 * 메서드는 활성 세션 시점에 직접 조회한다.
	 */
	private async startLocalSession(): Promise<void> {
		const modelId = this.settings.localModelId;
		const installation = await this.getLocalModelInstallation(modelId);
		if (!installation) {
			new Notice(
				this.t.notices.localModelMissing(modelId || "(none)"),
				NOTICE_DURATION_MS,
			);
			this.state.dispatch({
				type: "SESSION_FAILED",
				reason: "model_not_installed",
			});
			this.endTranslationSession();
			return;
		}

		try {
			await this.localWhisperService.start({
				modelId,
				modelFilePath: installation.filePath,
				streamingDisplayMode: this.settings.streamingDisplayMode,
				callbacks: this.buildLocalWhisperCallbacks(),
			});
		} catch (err) {
			console.error("[TranscribePlugin] localWhisperService.start threw:", err);
			this.state.dispatch({ type: "SESSION_FAILED", reason: "start_failed" });
			new Notice(this.t.notices.sessionTimeout, NOTICE_DURATION_MS);
			this.endTranslationSession();
		}
	}

	/**
	 * 백엔드 결정을 모든 관계된 모듈에 통지한다 (Requirement 14.4).
	 *
	 * - `currentBackend` 필드 갱신 (저장 시 frontmatter 기록용).
	 * - `Translation_Service.markBackendChanged(backend)` — `local` 이면 enqueue 가 G0
	 *   가드에서 즉시 no-op 처리된다.
	 * - `SidebarView.setOnlineOnlyControlsEnabled(backend === "cloud")` — 4 개 컨트롤
	 *   disabled / 활성 토글.
	 * - `local` 인 경우 `setAnalysisButtonEnabled(false)` 도 호출 (Requirement 14.4 의
	 *   분석 버튼 비활성 명시 요구).
	 */
	private applyBackendDecision(backend: "cloud" | "local"): void {
		this.currentBackend = backend;
		this.translationService.markBackendChanged(backend);
		this.forEachSidebar((view) =>
			view.setOnlineOnlyControlsEnabled(backend === "cloud"),
		);
		if (backend === "local") {
			this.forEachSidebar((view) => view.setAnalysisButtonEnabled(false));
		}
	}

	/**
	 * 스트리밍 중지 플로우.
	 *
	 * 순서(Requirement 4.1, 4.2, 4.3, 4.8, 4.9, 4.10):
	 * 1. 상태 머신을 `stopped` 로 전이.
	 * 2. `TranscribeService.stop(5000)` 으로 세션 종료 신호 + 5초 타임아웃.
	 * 3. 버퍼가 공백 전용이면 `bufferEmpty` Notice + `SESSION_CLOSED` 로 idle 복귀.
	 * 4. 본문이 있으면 Transcript_Note 저장 → 뷰에 로드 → `SESSION_CLOSED`.
	 * 5. 저장 실패 시 `ioError` Notice, 상태는 `stopped` 유지(재시도 허용).
	 */
	private async stopStreaming(): Promise<void> {
		this.state.dispatch({ type: "STOP_REQUESTED" });

		// task 26 — cloud / local 두 서비스 모두 stop 호출. 활성이 아닌 쪽은 idle 이므로
		// stop 은 빠르게 resolve 한다. 양쪽을 병렬로 호출해 사용자 대기 시간을 단축한다.
		const stopResults = await Promise.allSettled([
			this.transcribeService.stop(STOP_TIMEOUT_MS),
			this.localWhisperService.stop(STOP_TIMEOUT_MS),
		]);
		for (const r of stopResults) {
			if (r.status === "rejected") {
				console.error(
					"[TranscribePlugin] backend stop rejected:",
					r.reason,
				);
			}
		}

		// task 27 — 세션 종료 시 번역 큐/카운터/콜백을 모두 해제한다.
		// in-flight `TranslateClient.send` 는 abort 하지 않으며, 도착하더라도 콜백이
		// null 이므로 조용히 무시된다 (Translation_Service.endSession 계약).
		this.endTranslationSession();

		// 활성 백엔드의 버퍼를 사용. cloud 인 경우 transcribeService, local 인 경우
		// localWhisperService. 백엔드 미결정(중단된 idle stop 등) 이면 cloud 를 기본으로.
		const buffer =
			this.currentBackend === "local"
				? this.localWhisperService.getTranscriptBuffer()
				: this.transcribeService.getTranscriptBuffer();
		if (buffer.isEmpty()) {
			new Notice(this.t.notices.bufferEmpty, NOTICE_DURATION_MS);
			this.state.dispatch({ type: "SESSION_CLOSED" });
			this.resetSessionBackend();
			return;
		}

		try {
			const file = await this.saveBufferAsTranscript();
			if (file !== null) {
				this.currentTranscriptFile = file;
				const body = await this.noteStore.readTranscriptBody(file);
				this.currentNoteBodyLength = body.length;
				this.forEachSidebar((view) => view.loadNoteContent(body));
				// 저장 직후 "최근 전사" 리스트를 새로고침해 방금 저장된 항목이 즉시 노출되도록 한다.
				this.forEachSidebar((view) =>
					view.setRecentTranscripts(this.getRecentTranscripts()),
				);
			}
			this.state.dispatch({ type: "SESSION_CLOSED" });
			this.resetSessionBackend();
		} catch (err) {
			console.error("[TranscribePlugin] saveTranscript failed:", err);
			new Notice(this.t.notices.ioError, NOTICE_DURATION_MS);
			// 상태는 stopped 유지 — 사용자가 재시도 가능(Requirement 4.8).
		}
	}

	/**
	 * 세션 종료 후 백엔드 추적 상태를 idle 로 복귀시킨다 (Requirement 14.4 의 역방향).
	 *
	 * - `currentBackend = null`: 다음 세션이 깨끗한 상태에서 시작.
	 * - `setOnlineOnlyControlsEnabled(true)`: 4 개 컨트롤의 런타임 override 해제 (idle
	 *   게이트는 settings 기반으로 자동 적용됨).
	 * - `setAnalysisButtonEnabled(true)`: 분석 버튼 단독 강제 비활성 해제.
	 */
	private resetSessionBackend(): void {
		this.currentBackend = null;
		this.fallbackPerformed = false;
		this.forEachSidebar((view) => {
			view.setOnlineOnlyControlsEnabled(true);
			view.setAnalysisButtonEnabled(true);
		});
	}

	/**
	 * TranscribeService 콜백 번들 — 세션 이벤트를 상태 머신/뷰/Notice 로 중계한다.
	 *
	 * task 27 — `onFinalSegment` 분기에서 번역 활성 시 placeholder DOM 을 사이드바에서
	 * 받아 `Translation_Service.enqueue` 로 넘긴다. `onPartial` 경로에서는 번역을
	 * 호출하지 않는다 (Requirement 13.12).
	 */
	private buildTranscribeCallbacks(): TranscribeCallbacks {
		return {
			onPartial: (text) => {
				this.forEachSidebar((view) => view.appendPartial(text));
				// Requirement 13.12 — Partial 에 대해서는 Translation_Service 를 호출하지 않는다.
			},
			onFinal: (text) => {
				this.forEachSidebar((view) => view.commitFinal(text));
				this.refreshSidebarButtons();
			},
			onFinalSegment: (segment) => {
				this.handleFinalSegment(segment);
			},
			onSessionEstablished: () => {
				this.state.dispatch({ type: "SESSION_ESTABLISHED" });
			},
			onSessionError: (reason) => {
				this.handleSessionError(reason);
			},
			onReconnectAttempt: (_attempt) => {
				new Notice(this.t.notices.reconnecting, NOTICE_DURATION_MS);
			},
			onConnectionLost: () => {
				this.state.dispatch({ type: "CONNECTION_LOST" });
			},
		};
	}

	/**
	 * `Local_Whisper_Service` 콜백 번들 — 세션 이벤트를 상태 머신/뷰/Notice 로 중계한다.
	 *
	 * cloud 콜백과 매핑:
	 * - `onFinal(segment)` ← TranscribeService.onFinalSegment (구조화된 segment 직접 전달)
	 *   + 화자 라벨 없는 경우 `commitFinal(text)` 호환 경로도 같이 호출하여 사이드바
	 *   v1.0 합쳐 표시 경로를 지원한다.
	 * - `onSessionEstablished` ← state machine SESSION_ESTABLISHED 전이.
	 * - `onSessionError(reason)` ← `handleSessionError` 로 통일 처리. 단, local 백엔드의
	 *   "model_corrupted" 사유는 `localModelInstalled` 키 정리도 함께 수행해야 하지만,
	 *   본 task 26 범위에서는 main 측에서 별도 처리하지 않는다 (Requirement 4.8 후속 추적).
	 * - `onLoadingProgress(elapsedMs)` ← 로딩 30 초 초과 안내. 본 v1 에서는 console.error
	 *   로만 진단 기록 — Notice 표시는 후속 task 에서 추가 가능.
	 *
	 * Requirement 4.1, 4.2, 4.6, 4.7, 4.8.
	 */
	private buildLocalWhisperCallbacks(): LocalWhisperCallbacks {
		return {
			onPartial: (_text) => {
				// 본 v1 범위에서 로컬은 partial 결과를 노출하지 않는다 (chunk 단위 final 만).
			},
			onFinal: (segment) => {
				// v1.0 호환 텍스트 경로 — 사이드바의 committed/partial 합쳐 표시.
				this.forEachSidebar((view) => view.commitFinal(segment.text));
				// v1.1 화자 라벨 / 번역 placeholder 경로 — 동일 segment 를 한 번 더
				// handleFinalSegment 로 보내 task 27 의 번역 enqueue 가 작동하게 한다.
				this.handleFinalSegment(segment);
				this.refreshSidebarButtons();
			},
			onSessionEstablished: () => {
				this.state.dispatch({ type: "SESSION_ESTABLISHED" });
			},
			onSessionError: (reason) => {
				this.handleSessionError(reason);
			},
			onLoadingProgress: (elapsedMs) => {
				console.error(`local_model_loading_slow: ${elapsedMs}ms`);
			},
		};
	}

	/**
	 * `localModelInstalled[modelId]` 메타데이터를 plugin 의 메모리 캐시에서 조회한다
	 * (Requirement 2.10, 3.5).
	 *
	 * 본 메서드는 onload() 시점에 `loadData()` 결과에서 추출하여 `this.localModelInstalled`
	 * 에 보관한 메타데이터 맵을 lookup 한다 (design §Data Models 2). `TranscribeSettings` 와
	 * 별개의 최상위 키 `localModelInstalled` 가 사용된다. 키가 없거나 해당 modelId 의 설치
	 * 레코드가 없으면 `null` 을 반환한다.
	 *
	 * 본 v1 범위에서는 plugin 활성화 시점의 파일 실재 검증(Requirement 2.11) 은 수행하지
	 * 않으며, 활성 세션 시작 시점에 단순 lookup 으로만 작동한다. 필요 시 후속 task 에서
	 * `fs.statSync(filePath)` 검증을 추가할 수 있다.
	 */
	private async getLocalModelInstallation(
		modelId: string,
	): Promise<{ filePath: string } | null> {
		if (!modelId) return null;
		const record = this.localModelInstalled[modelId];
		if (!record || !record.filePath) return null;
		return { filePath: record.filePath };
	}

	/**
	 * 모델 다운로드 완료 시 plugin 측 책임으로 `localModelInstalled` 맵을 갱신하고
	 * `data.json` 에 영속화한다 (Requirement 2.10, 2.11).
	 *
	 * 본 메서드는 `LocalModelSettingsSection` 의 다운로드 모달이 호출한다.
	 * 영속화 실패는 console.error 로 로깅만 하고 throw 하지 않는다 (사용자가
	 * 다음 세션 시작 시 재다운로드 안내를 받게 됨).
	 */
	onLocalModelDownloaded(record: Local_Model_Installation_Record): void {
		this.localModelInstalled = {
			...this.localModelInstalled,
			[record.modelId]: record,
		};
		void this.persistLocalModelInstalled();
	}

	/**
	 * 모델 폴더 prefill 의 기본 경로를 합성한다 (task 33).
	 *
	 * 우선순위:
	 *   1. Obsidian 데스크톱 vault 의 절대 경로 + `/Attached Files`.
	 *      (`FileSystemAdapter.getBasePath()` 가 가용한 경우)
	 *   2. OS 별 기본 경로 (`computeDefaultModelFolder()`).
	 *      basePath 헬퍼가 없거나 빈 문자열을 반환할 때만 사용.
	 *
	 * 본 메서드는 `LocalModelSectionHost.getDefaultModelFolder` 로 노출되어
	 * `LocalModelSettingsSection.renderModelFolderField` 의 prefill 값으로 사용된다.
	 * 이미 사용자가 `modelFolder` 를 입력해 둔 경우에는 prefill 이 일어나지 않으므로
	 * 본 메서드 결과가 사용자 설정을 덮어쓸 일은 없다.
	 */
	getDefaultModelFolder(): string {
		const adapter = this.app.vault.adapter as unknown as {
			getBasePath?(): string;
		};
		if (typeof adapter.getBasePath === "function") {
			const basePath = adapter.getBasePath();
			if (typeof basePath === "string" && basePath.length > 0) {
				const normalized = basePath.replace(/\\/g, "/").replace(/\/$/, "");
				return `${normalized}/Attached Files`;
			}
		}
		return computeDefaultModelFolder();
	}

	/**
	 * `localModelInstalled` 맵을 `data.json` 에 저장한다.
	 *
	 * `SettingsStore.save()` 가 settings 만 다루므로, 본 맵은 `loadData()` 결과의
	 * 다른 키들을 보존하면서 별도 최상위 키로 직렬화한다. 실패는 로깅만 하고
	 * throw 하지 않는다 — UX 흐름을 끊지 않기 위함.
	 */
	private async persistLocalModelInstalled(): Promise<void> {
		try {
			const raw = (await this.loadData()) as Record<string, unknown> | null;
			const next = {
				...(raw ?? {}),
				localModelInstalled: this.localModelInstalled,
			};
			await this.saveData(next);
		} catch (err) {
			console.error(
				"[TranscribePlugin] persistLocalModelInstalled failed:",
				err,
			);
		}
	}

	// ---------------------------------------------------------------------
	// 내부 — 번역 세션 / Final segment 처리 (task 27)
	// ---------------------------------------------------------------------

	/**
	 * Final segment 1 건에 대해 사이드바 라인을 추가하고, 번역이 활성화된 경우에
	 * `Translation_Service.enqueue` 로 비동기 번역 호출을 발사한다.
	 *
	 * 본 메서드는 `TranscribeService.onFinalSegment` 와 `Local_Whisper_Service.onFinal`
	 * 양쪽에서 동일한 경로로 호출된다 (task 27 의 "동일 경로 통일" 요구사항).
	 *
	 * 실행 순서:
	 *  1. 사이드바에 라인 추가 + (번역 활성 시) placeholder DOM 생성.
	 *  2. 번역 활성 + 활성 백엔드 = `local` 인 경우 세션당 1 회 오프라인 Notice 표시.
	 *     실제 호출 차단은 `Translation_Service.enqueue` 의 진입 가드(task 19, task 26 의
	 *     `markBackendChanged("local")` 호출 결과) 가 자동 no-op 처리한다.
	 *  3. `translationEnabled === true` 이고 `placeholderEl` 이 생성된 경우에만 enqueue.
	 *  4. 사이드바 버튼 상태 재계산.
	 *
	 * Requirement 13.4, 13.5, 13.7(v1.1 갱신본), 14.5.
	 */
	handleFinalSegment(segment: Transcript_Segment): void {
		const translationEnabled = this.settings.translationEnabled;

		// 1) 사이드바에 라인 추가 + placeholder 회수.
		//    `appendFinalLine` 은 `translationEnabled === false` 인 경우에도 라인 자체는
		//    그려주지만, 본 v1.0 호환 표시 경로는 `commitFinal(text)` 가 이미 처리하므로
		//    번역 활성 시에만 호출하여 라인 중복을 피한다.
		let placeholderEl: HTMLElement | null = null;
		if (translationEnabled) {
			this.forEachSidebar((view) => {
				const el = view.appendFinalLine(segment, {
					translationEnabled: true,
				});
				// 첫 사이드바 인스턴스의 placeholder 만 큐 키로 사용한다 — 일반적으로
				// 사이드바는 하나만 열려 있으므로 첫 항목으로 충분하다.
				if (placeholderEl === null) {
					placeholderEl = el;
				}
			});
		}

		// 2) 오프라인 게이트 — 활성 백엔드 = `local` 인 경우 세션당 1 회 안내.
		//    실제 호출 차단은 Translation_Service 가 처리하므로 main 측은 Notice 만.
		if (
			translationEnabled &&
			this.currentBackend === "local" &&
			!this.translationOfflineNoticeShown
		) {
			new Notice(
				this.t.notices.translationOfflineUnsupported,
				NOTICE_DURATION_MS,
			);
			this.translationOfflineNoticeShown = true;
		}

		// 3) 번역 호출 — 진입 가드는 Translation_Service 내부에서 평가된다.
		//    `markBackendChanged("local")` 가 task 26 에 의해 이미 통지되었다면 enqueue 는
		//    조용히 no-op 처리되며, autoDisabled 진입 후에도 마찬가지다.
		//    placeholderEl 이 null 이라는 것은 사이드바가 열려 있지 않거나
		//    translationEnabled === false 라는 의미이므로 호출하지 않는다.
		if (translationEnabled && placeholderEl !== null) {
			this.enqueueTranslation(segment, placeholderEl);
		}

		this.refreshSidebarButtons();
	}

	/**
	 * 한 Final segment 에 대해 `Translation_Service.enqueue` 호출을 빌드/발사한다.
	 *
	 * source language 는 `selectTargetLanguage` 와 동일한 매핑 규칙을 적용해
	 * `languageCode === "ko-KR"` → `"ko"`, 그 외 → `"en"` 으로 결정한다 (design §4.10
	 * 의 source 추론 규칙). target language 는 사용자 설정 + override 화이트리스트 검증을
	 * 거친 `selectTargetLanguage` 결과를 사용한다.
	 *
	 * 자격 증명/리전이 누락된 경우(예: 로컬 모드에서 사용자가 자격 증명을 비운 상태)에는
	 * 서비스 측 가드가 작동하지 않을 수 있으므로 main 에서 빈 자격 증명을 사전 차단한다.
	 * 단, 차단 시 placeholder 는 그대로 남겨 두어 사이드바의 빈 줄 깜빡임을 방지한다.
	 */
	private enqueueTranslation(
		segment: Transcript_Segment,
		placeholderEl: HTMLElement,
	): void {
		// 자격 증명/리전이 비어 있으면 호출 자체를 건너뛴다 — Translation_Service 는
		// AWS 호출 시점에 자격 증명 오류로 실패할 텐데 그 경로는 비용/실패 카운터에
		// 불필요한 영향을 주므로 main 에서 사전 차단한다 (Requirement 13.6 자동 비활성화
		// 의도와 정합).
		if (!this.hasAwsCredentials()) {
			return;
		}

		const sourceLanguage =
			this.settings.languageCode === "ko-KR" ? "ko" : "en";
		const targetLanguage = selectTargetLanguage(
			this.settings.languageCode,
			this.settings.translationTargetLanguage,
		);

		const item = buildTranslationQueueItem({
			segment,
			placeholderEl,
			sourceLanguage,
			targetLanguage,
		});

		this.translationService.enqueue(item, {
			credentials: this.currentCredentials(),
			region: this.settings.region,
		});
	}

	/**
	 * 세션 시작 시 1 회 호출 — `Translation_Service.beginSession` 으로 콜백을 등록한다.
	 *
	 * 콜백 동작:
	 *  - `onResolved`: 사이드바 placeholder 의 텍스트를 번역 결과로 채운다 (Requirement 13.5).
	 *  - `onRejected`: placeholder 에 "(번역 실패)" 문구 + 경고 아이콘 클래스 부착 (Requirement 13.6).
	 *  - `onAutoDisabled`: 30 초 윈도우 3 회 실패 시 1 회 발사. 사용자 설정 토글을
	 *    꺼서 사이드바 미러 컨트롤이 시각적으로 비활성화되도록 한다 (Requirement 13.6).
	 *  - `onCostCounterChanged`: 사이드바 status row 의 누적 카운터를 갱신한다 (Requirement 13.9).
	 */
	private beginTranslationSession(): void {
		this.translationService.beginSession({
			onResolved: (segmentId, translatedText) => {
				this.applyTranslationToPlaceholder(
					segmentId,
					translatedText,
					"resolved",
				);
			},
			onRejected: (segmentId, _errorCode) => {
				this.applyTranslationToPlaceholder(
					segmentId,
					this.t.notices.translationFailedSingle,
					"failed",
				);
			},
			onAutoDisabled: () => {
				this.handleTranslationAutoDisabled();
			},
			onCostCounterChanged: (totalCharCount) => {
				this.forEachSidebar((view) =>
					view.updateCostCounter(totalCharCount),
				);
			},
		});
	}

	/**
	 * 세션 종료 시 호출 — `Translation_Service.endSession` 으로 콜백/큐/카운터를 모두 해제.
	 *
	 * `endSession` 후 도착하는 in-flight `TranslateClient.send` 응답은 콜백이 null 이므로
	 * 조용히 무시된다 (Requirement 3.9 와 정합 — abort 하지 않음).
	 */
	private endTranslationSession(): void {
		this.translationService.endSession();
		this.translationOfflineNoticeShown = false;
	}

	/**
	 * Final segment 의 placeholder DOM 에 번역 결과 또는 실패 문구를 부착한다.
	 *
	 * placeholder 는 라인 컨테이너의 `data-segment-id` 속성으로 segmentId 를 보관하므로
	 * 사이드바 컨테이너에서 `[data-segment-id="N"] .translation-line` 로 직접 lookup 한다.
	 * 본 메서드는 placeholder 가 detached 거나 사이드바가 닫혀서 찾을 수 없을 경우
	 * 조용히 종료한다 (Requirement 13.5 표시 순서 보장은 placeholder 위치 안정성으로
	 * 자동 보장됨).
	 */
	private applyTranslationToPlaceholder(
		segmentId: number,
		text: string,
		state: "resolved" | "failed",
	): void {
		this.forEachSidebar((view) => {
			const root = view.containerEl;
			const placeholder = root.querySelector<HTMLElement>(
				`[data-segment-id="${segmentId}"] .translation-line`,
			);
			if (!placeholder) return;
			placeholder.setText(state === "resolved" ? `→ ${text}` : text);
			if (state === "failed") {
				placeholder.addClass("translation-failed");
			}
		});
	}

	/**
	 * `onAutoDisabled` 발사 시 호출되는 처리 — 사용자 설정 토글을 OFF 로 강제하고
	 * 사이드바를 재렌더하여 토글이 시각적으로 비활성 상태로 보이도록 한다.
	 *
	 * Notice 1 회 표시는 본 메서드가 직접 담당한다 (Requirement 13.6: "5 초 이상 1 회").
	 * 설정 저장은 사용자가 다음 세션에 다시 사용할 수 있도록 끄지 않고 메모리 상의
	 * `translationEnabled` 만 false 로 두는 방식도 고려할 수 있으나, design §4.5 의
	 * 자동 비활성화 의도(반복 실패 시 사용자에게 명확히 알림)를 따라 영구 저장한다.
	 */
	private handleTranslationAutoDisabled(): void {
		new Notice(this.t.notices.translationAutoDisabled, NOTICE_DURATION_MS);
		void this.setTranslationEnabled(false);
	}

	/**
	 * TranscribeService 가 보고하는 reason 코드를 상태 머신 전이 + Notice 로 매핑한다.
	 *
	 * task 27 — 세션이 실패/종료 상태로 전이되는 경로(timeout, start_failed,
	 * reconnect_exhausted)에서는 `Translation_Service` 의 세션도 함께 종료하여 다음 세션
	 * 시작 시점에 깨끗한 상태로 다시 `beginSession` 이 호출되도록 보장한다.
	 *
	 * task 26 — `auto` 모드의 cloud 시도 후 `timeout` / `auth` / `network` 사유로 실패한
	 * 경우 인-세션 폴백을 수행한다 (Requirement 3.4 후반부, 3.8 EXCEPT, 14.6). 폴백 1 회만
	 * 허용되며, 두 번째 트리거는 정상 실패 경로로 처리된다.
	 */
	private handleSessionError(reason: string): void {
		// task 26 — auto 모드의 cloud 시도 실패 시 폴백 트리거 평가.
		// 본 분기는 일반 실패 경로(상태 머신 전이 + Notice + endTranslationSession) 를
		// 모두 우회하여, 활성 세션을 그대로 유지하면서 local 백엔드로 전환한다.
		if (
			this.settings.backendSelectionMode === "auto" &&
			this.currentBackend === "cloud" &&
			!this.fallbackPerformed &&
			(reason === "timeout" || reason === "auth" || reason === "network")
		) {
			void this.performAutoFallback(reason);
			return;
		}

		switch (reason) {
			case "timeout":
				new Notice(this.t.notices.sessionTimeout, NOTICE_DURATION_MS);
				this.state.dispatch({ type: "SESSION_FAILED", reason });
				this.endTranslationSession();
				return;
			case "start_failed":
				new Notice(
					this.t.notices.micPermissionDenied,
					NOTICE_DURATION_MS,
				);
				this.state.dispatch({ type: "SESSION_FAILED", reason });
				this.endTranslationSession();
				return;
			case "reconnect_exhausted":
				new Notice(this.t.notices.reconnectFailed, NOTICE_DURATION_MS);
				this.state.dispatch({ type: "RECONNECT_EXHAUSTED" });
				// 재연결 실패 시 현재까지의 버퍼를 보존한다(Requirement 8.7).
				void this.saveBufferAsTranscriptQuietly();
				this.endTranslationSession();
				return;
			case "stop_timeout":
				new Notice(
					this.t.notices.sessionTerminateSlow,
					NOTICE_DURATION_MS,
				);
				return;
			case "already_active":
				new Notice(
					this.t.notices.singleSessionActive,
					NOTICE_DURATION_MS,
				);
				return;
			default:
				console.error(
					"[TranscribePlugin] unknown session error reason:",
					reason,
				);
				this.state.dispatch({ type: "SESSION_FAILED", reason });
				this.endTranslationSession();
				return;
		}
	}

	/**
	 * `auto` 모드의 인-세션 폴백 (Requirement 3.4 후반부, 3.8 EXCEPT, 14.6).
	 *
	 * 흐름:
	 * 1. `fallbackPerformed = true` 로 마킹 (한 세션에 한 번만).
	 * 2. cloud 측 transcribeService 정리 — `dispose()` 로 in-flight 세션을 abort.
	 * 3. 폴백 사유 Notice 3 초+ 표시 (Requirement 3.7).
	 * 4. `Translation_Service.markBackendChanged("local")` + `setAnalysisButtonEnabled(false)`
	 *    + `setOnlineOnlyControlsEnabled(false)` (Requirement 14.6).
	 *    인-flight `TranslateClient.send` 는 abort 하지 않고 그대로 완료시킨다 (Requirement 3.9).
	 * 5. `currentBackend = "local"` 갱신 (저장 시 frontmatter 에 `backend: local` 기록).
	 * 6. local 모델 설치 검증 후 `Local_Whisper_Service.start(...)` 진입.
	 *
	 * 본 메서드는 fire-and-forget 으로 호출된다 — 호출 측 `handleSessionError` 는 동기
	 * 컨텍스트이므로 본 메서드의 에러는 본 메서드 내부에서 흡수해야 한다.
	 */
	private async performAutoFallback(reason: string): Promise<void> {
		this.fallbackPerformed = true;

		// (1) cloud 측 정리 — dispose 가 멱등하므로 안전.
		try {
			this.transcribeService.dispose();
		} catch (err) {
			console.error(
				"[TranscribePlugin] dispose during fallback failed:",
				err,
			);
		}

		// (2) Notice 3 초+ — 사유별 분기.
		const reasonNotice =
			reason === "timeout"
				? this.t.notices.backendFallbackTimeout
				: reason === "auth"
					? this.t.notices.backendFallbackAuth
					: this.t.notices.backendFallbackNetwork;
		new Notice(reasonNotice, NOTICE_DURATION_MS);
		console.error(`backend_inflight_fallback: ${reason}`);

		// (3) 모드 게이트 통지 (Requirement 14.6). in-flight TranslateClient.send 는
		//     abort 하지 않으며 도착하면 정상 콜백된다 (Requirement 3.9).
		this.applyBackendDecision("local");

		// (4) local 모델 설치 검증 + Local_Whisper_Service.start.
		const modelId = this.settings.localModelId;
		const installation = await this.getLocalModelInstallation(modelId);
		if (!installation) {
			new Notice(
				this.t.notices.localModelMissing(modelId || "(none)"),
				NOTICE_DURATION_MS,
			);
			this.state.dispatch({
				type: "SESSION_FAILED",
				reason: "model_not_installed",
			});
			this.endTranslationSession();
			return;
		}

		try {
			await this.localWhisperService.start({
				modelId,
				modelFilePath: installation.filePath,
				streamingDisplayMode: this.settings.streamingDisplayMode,
				callbacks: this.buildLocalWhisperCallbacks(),
			});
		} catch (err) {
			console.error(
				"[TranscribePlugin] localWhisperService.start (fallback) threw:",
				err,
			);
			this.state.dispatch({
				type: "SESSION_FAILED",
				reason: "fallback_failed",
			});
			new Notice(this.t.notices.sessionTimeout, NOTICE_DURATION_MS);
			this.endTranslationSession();
		}
	}

	// ---------------------------------------------------------------------
	// 내부 — 저장/에러/뷰 전파 헬퍼
	// ---------------------------------------------------------------------

	/**
	 * `BedrockService.analyze` 가 throw 한 에러를 분류하고 Notice 로 매핑한다.
	 */
	private notifyAnalysisError(err: unknown): void {
		if (!(err instanceof TranscribeError)) {
			console.error("[TranscribePlugin] analyze failed (unknown):", err);
			new Notice(this.t.notices.awsNetworkError, NOTICE_DURATION_MS);
			return;
		}
		switch (err.code) {
			case "TRANSCRIPT_TOO_LONG":
				new Notice(this.t.notices.transcriptTooLong, NOTICE_DURATION_MS);
				return;
			case "AWS_AUTH":
				new Notice(this.t.notices.awsAuthError, NOTICE_DURATION_MS);
				return;
			case "AWS_MODEL_UNAVAILABLE":
				new Notice(
					this.t.notices.awsModelUnavailable,
					NOTICE_DURATION_MS,
				);
				return;
			case "AWS_NETWORK":
			default:
				new Notice(this.t.notices.awsNetworkError, NOTICE_DURATION_MS);
				return;
		}
	}

	/**
	 * 버퍼 내용이 있으면 Transcript_Note 로 저장한다. 언로드/재연결 실패 경로에서
	 * 조용히 호출될 수 있도록 예외를 catch 하여 로그만 남긴다(Requirement 8.4, 8.7).
	 */
	private async autoSaveBufferIfAny(): Promise<void> {
		// task 26 — cloud / local 두 버퍼 모두 검사. 둘 중 하나라도 비어있지 않으면
		// 활성 백엔드 기준으로 저장한다 (saveBufferAsTranscript 내부에서 분기).
		const cloudBuffer = this.transcribeService?.getTranscriptBuffer();
		const localBuffer = this.localWhisperService?.getTranscriptBuffer();
		const hasContent =
			(cloudBuffer && !cloudBuffer.isEmpty()) ||
			(localBuffer && !localBuffer.isEmpty());
		if (!hasContent) {
			return;
		}
		await this.saveBufferAsTranscriptQuietly();
	}

	/**
	 * 재연결 실패/언로드 경로에서 버퍼를 저장하되 UX 를 방해하지 않도록 예외를 삼킨다.
	 */
	private async saveBufferAsTranscriptQuietly(): Promise<void> {
		try {
			await this.saveBufferAsTranscript();
		} catch (err) {
			console.error("[TranscribePlugin] quiet save failed:", err);
		}
	}

	/**
	 * 현재 TranscriptBuffer 의 본문을 Transcript_Note 로 저장하고 저장된 파일을 반환한다.
	 * 버퍼가 비어 있으면 null 을 반환한다(Requirement 4.9).
	 */
	private async saveBufferAsTranscript(): Promise<TFile | null> {
		// task 26 — 활성 백엔드의 버퍼 사용. 폴백이 발생했더라도 종료 시점의 활성
		// 백엔드는 `local` 이므로 그쪽 버퍼가 사용된다 (Requirement 3.10).
		const buffer =
			this.currentBackend === "local"
				? this.localWhisperService.getTranscriptBuffer()
				: this.transcribeService.getTranscriptBuffer();
		if (buffer.isEmpty()) {
			return null;
		}
		const body = buffer.getCommittedText();
		const meta: TranscriptNoteMeta = {
			startedAt: this.sessionStartedAt ?? new Date().toISOString(),
			endedAt: new Date().toISOString(),
			language: this.settings.languageCode,
			// task 26 — 활성 백엔드를 frontmatter 에 기록한다 (Requirement 3.10).
			// 폴백이 발생한 경우 종료 시점의 활성 백엔드 = `local` 이 기록된다.
			backend: this.currentBackend ?? "cloud",
		};
		const file = await this.noteStore.saveTranscript(
			body,
			meta,
			this.settings.transcriptFolder,
			new Date(),
			this.t.notices.folderCreateFailed,
		);
		// 자동 저장 이후 양쪽 버퍼를 비워 다음 세션이 깨끗하게 시작되도록 한다.
		this.transcribeService.clearBuffer();
		this.localWhisperService.clearBuffer();
		this.sessionStartedAt = null;
		return file;
	}

	/**
	 * 상태 전이를 열린 사이드바 뷰로 전파한다.
	 */
	private propagateStateToViews(
		next: StreamingState,
		reconnecting: boolean,
	): void {
		this.forEachSidebar((view) => view.updateState(next, reconnecting));
	}

	/**
	 * 열린 모든 사이드바 뷰 인스턴스에 대해 fn 을 실행한다.
	 * fn 에서 예외가 나도 다른 뷰 처리에 영향을 주지 않도록 개별 try/catch 로 감싼다.
	 */
	private forEachSidebar(fn: (view: SidebarView) => void): void {
		const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_TRANSCRIBE);
		for (const leaf of leaves) {
			const view = leaf.view;
			if (view instanceof SidebarView) {
				try {
					fn(view);
				} catch (err) {
					console.error("[TranscribePlugin] sidebar update failed:", err);
				}
			}
		}
	}

	/**
	 * 사이드바 버튼을 재계산해 최신 환경에 맞게 토글한다.
	 */
	private refreshSidebarButtons(): void {
		this.forEachSidebar((view) => view.refreshButtons());
	}

	// ---------------------------------------------------------------------
	// 내부 — 설정 검증 헬퍼
	// ---------------------------------------------------------------------

	/**
	 * 스트리밍 시작에 필요한 필드 누락 목록을 i18n 필드명으로 반환한다.
	 */
	private collectMissingStreamingFields(): string[] {
		const missing: string[] = [];
		if (this.settings.accessKeyId.trim().length === 0) {
			missing.push(this.t.settings.accessKeyId.name);
		}
		if (this.settings.secretAccessKey.trim().length === 0) {
			missing.push(this.t.settings.secretAccessKey.name);
		}
		if (this.settings.region.trim().length === 0) {
			missing.push(this.t.settings.region.name);
		}
		return missing;
	}

	/**
	 * 분석에 필요한 필드 누락 목록을 반환한다(자격 증명 + 리전 + Bedrock 모델).
	 */
	private collectMissingAnalysisFields(): string[] {
		const missing = this.collectMissingStreamingFields();
		if (this.settings.bedrockModelId.trim().length === 0) {
			// v1.1 정리 — Bedrock 모델 컨트롤이 사이드바 인라인 컨트롤로 이전되어
			// 사용자가 보는 라벨은 `sidebar.model` 이다 (i18n: "Model" / "모델").
			missing.push(this.t.sidebar.model);
		}
		return missing;
	}

	/**
	 * 현재 설정에서 AWS 자격 증명 객체를 구성해 반환한다.
	 */
	private currentCredentials(): AwsCredentials {
		return {
			accessKeyId: this.settings.accessKeyId,
			secretAccessKey: this.settings.secretAccessKey,
		};
	}

	/**
	 * 자격 증명 3종(access key / secret / region)이 모두 입력되었는지 여부.
	 */
	private hasAwsCredentials(): boolean {
		return (
			this.settings.accessKeyId.trim().length > 0 &&
			this.settings.secretAccessKey.trim().length > 0 &&
			this.settings.region.trim().length > 0
		);
	}

	/**
	 * `whisper-worker.js` 의 런타임 URL 을 해석한다 (task 26).
	 *
	 * esbuild 가 플러그인 루트(`<vault>/.obsidian/plugins/<plugin-id>/whisper-worker.js`)
	 * 에 떨어뜨린 워커 진입점을 Obsidian 의 `vault.adapter.getResourcePath()` 헬퍼로
	 * `app://` URL 로 변환해 `WhisperWorkerClient` 의 `new Worker(url)` 호출에 주입한다.
	 *
	 * 본 헬퍼는 호출 시점에만 평가되므로 plugin 비활성화 → 활성화 사이클로 워커 entrypoint
	 * 가 재배포되더라도 다음 `start()` 시 새 URL 로 자동 갱신된다.
	 *
	 * Plugin 의 `manifest.dir` 은 vault 루트로부터의 상대 경로(예:
	 * `.obsidian/plugins/obsidian-transcribe-plugin`) 이므로, 워커 파일은 그 디렉터리 직하에
	 * 위치한다. 어댑터의 type 정의가 `getResourcePath` 를 명시하지 않을 수 있어 좁은 cast 를
	 * 사용한다.
	 */
	private resolveWhisperWorkerUrl(): string {
		const dir = this.manifest.dir ?? "";
		const relativePath =
			dir.length > 0 ? `${dir}/whisper-worker.js` : "whisper-worker.js";
		const adapter = this.app.vault.adapter as unknown as {
			getResourcePath?(path: string): string;
		};
		if (typeof adapter.getResourcePath === "function") {
			return adapter.getResourcePath(relativePath);
		}
		// adapter 가 헬퍼를 제공하지 않는 환경 (예: 테스트 더블) 에서는 상대 경로를
		// 그대로 반환한다 — 실제 워커 생성은 cloud 흐름에서는 일어나지 않으므로
		// 무해하다.
		return relativePath;
	}
}
