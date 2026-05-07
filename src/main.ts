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

import { createI18n, detectLocale, type Translations } from "./i18n";
import type { SupportedLocale } from "./i18n";
import { SettingsStore } from "./settings/SettingsStore";
import { TranscribeSettingTab } from "./settings/TranscribeSettingTab";
import { StreamingStateMachine } from "./state/StreamingStateMachine";
import type { StreamingState } from "./state/StreamingStateMachine";
import { AudioCapture } from "./services/AudioCapture";
import { BedrockService } from "./services/BedrockService";
import { NoteStore, type TranscriptNoteMeta } from "./services/NoteStore";
import {
	TranscribeService,
	type TranscribeCallbacks,
} from "./services/TranscribeService";
import { TranscribeError } from "./types/errors";
import type { AwsCredentials, TranscribeSettings } from "./types/settings";
import {
	SidebarView,
	VIEW_TYPE_TRANSCRIBE,
	type SidebarEnvironmentInputs,
} from "./views/SidebarView";

// ── 보조 상수 ────────────────────────────────────────────────────────────

/**
 * 분석 본문 길이 한계(Requirement 6.5). `BedrockService` 와 동일한 값을 참조한다.
 */
const MAX_TRANSCRIPT_LENGTH = 100_000;

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

	/** AI 분석 서비스. */
	bedrockService!: BedrockService;

	/** Transcript_Note I/O 래퍼. */
	noteStore!: NoteStore;

	/** 현재 세션과 연결된 Transcript_Note 파일. 저장 후 세팅된다. */
	private currentTranscriptFile: TFile | null = null;

	/** 현재 세션이 시작된 시각(ISO 8601). 저장 시 프론트매터에 기록된다. */
	private sessionStartedAt: string | null = null;

	/** Bedrock 분석 진행 중 여부. 버튼 정책 입력. */
	private isAnalyzing = false;

	/** 사이드바가 편집 모드인지 여부. 버튼 정책 입력. */
	private isEditing = false;

	/** 상태 머신 onChange 리스너 해제 함수(onunload 에서 호출). */
	private stateUnsubscribe: (() => void) | null = null;

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
		// pcm-worklet.js 는 플러그인 폴더에 함께 배포되며, Obsidian Vault adapter 로
		// 런타임 리소스 URL 을 해석한다. manifest.dir 이 없는 초기 상태에는 빈 문자열을
		// 사용해 안전하게 fallback 한다(테스트에서는 workletUrl 옵션을 주입해 우회).
		const workletRelativePath = `${this.manifest.dir ?? ""}/pcm-worklet.js`;
		const audioCapture = new AudioCapture({
			workletUrl: this.app.vault.adapter.getResourcePath(workletRelativePath),
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

		// 상태 머신 구독 해제.
		if (this.stateUnsubscribe) {
			this.stateUnsubscribe();
			this.stateUnsubscribe = null;
		}
	}

	/**
	 * 사이드바 뷰를 열거나 이미 열려 있으면 포커스를 이동한다(Requirement 1.2, 1.3).
	 */
	async activateView(): Promise<void> {
		const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_TRANSCRIBE);
		if (existing.length > 0) {
			this.app.workspace.revealLeaf(existing[0]);
			return;
		}
		const leaf: WorkspaceLeaf | null = this.app.workspace.getRightLeaf(false);
		if (leaf === null) {
			return;
		}
		await leaf.setViewState({ type: VIEW_TYPE_TRANSCRIBE, active: true });
		this.app.workspace.revealLeaf(leaf);
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
	 */
	getEnvironmentInputs(): SidebarEnvironmentInputs {
		return {
			hasTranscriptNote: this.currentTranscriptFile !== null,
			transcriptLength: this.transcribeService.getTranscriptBuffer().length(),
			hasCredentials: this.hasAwsCredentials(),
			hasBedrockModel: this.settings.bedrockModelId.trim().length > 0,
		};
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
	 * 순서(Requirement 2.14, 3.1, 3.2, 3.3, 3.9, 3.10, 7.5, 7.6):
	 * 1. 자격 증명/리전 누락 검사 → Notice 후 중단(상태/버퍼 불변).
	 * 2. 이미 세션 활성 시 Notice 후 중단.
	 * 3. `state.dispatch("START_REQUESTED")` + 세션 시작 시각 기록.
	 * 4. 이전 세션의 버퍼/뷰 콘텐츠 초기화(중복 저장 방지).
	 * 5. `TranscribeService.start(...)` 호출. 세션 수립/오디오 실패는 콜백을 통해
	 *    `handleSessionError` 로 통지되어 상태 머신과 Notice 를 연쇄 처리한다.
	 */
	private async startStreaming(): Promise<void> {
		const missing = this.collectMissingStreamingFields();
		if (missing.length > 0) {
			new Notice(
				this.t.notices.missingSettings(missing),
				NOTICE_DURATION_MS,
			);
			return;
		}

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
		this.currentTranscriptFile = null;
		this.forEachSidebar((view) => view.loadNoteContent(""));

		try {
			await this.transcribeService.start({
				credentials: this.currentCredentials(),
				region: this.settings.region,
				languageCode: this.settings.languageCode,
				callbacks: this.buildTranscribeCallbacks(),
			});
		} catch (err) {
			// start() 자체가 예외를 던지는 경우에 대한 방어적 처리.
			console.error("[TranscribePlugin] transcribeService.start threw:", err);
			this.state.dispatch({ type: "SESSION_FAILED", reason: "start_failed" });
			new Notice(this.t.notices.sessionTimeout, NOTICE_DURATION_MS);
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

		try {
			await this.transcribeService.stop(STOP_TIMEOUT_MS);
		} catch (err) {
			console.error("[TranscribePlugin] transcribeService.stop threw:", err);
		}

		const buffer = this.transcribeService.getTranscriptBuffer();
		if (buffer.isEmpty()) {
			new Notice(this.t.notices.bufferEmpty, NOTICE_DURATION_MS);
			this.state.dispatch({ type: "SESSION_CLOSED" });
			return;
		}

		try {
			const file = await this.saveBufferAsTranscript();
			if (file !== null) {
				this.currentTranscriptFile = file;
				const body = await this.noteStore.readTranscriptBody(file);
				this.forEachSidebar((view) => view.loadNoteContent(body));
			}
			this.state.dispatch({ type: "SESSION_CLOSED" });
		} catch (err) {
			console.error("[TranscribePlugin] saveTranscript failed:", err);
			new Notice(this.t.notices.ioError, NOTICE_DURATION_MS);
			// 상태는 stopped 유지 — 사용자가 재시도 가능(Requirement 4.8).
		}
	}

	/**
	 * TranscribeService 콜백 번들 — 세션 이벤트를 상태 머신/뷰/Notice 로 중계한다.
	 */
	private buildTranscribeCallbacks(): TranscribeCallbacks {
		return {
			onPartial: (text) => {
				this.forEachSidebar((view) => view.appendPartial(text));
			},
			onFinal: (text) => {
				this.forEachSidebar((view) => view.commitFinal(text));
				this.refreshSidebarButtons();
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
	 * TranscribeService 가 보고하는 reason 코드를 상태 머신 전이 + Notice 로 매핑한다.
	 */
	private handleSessionError(reason: string): void {
		switch (reason) {
			case "timeout":
				new Notice(this.t.notices.sessionTimeout, NOTICE_DURATION_MS);
				this.state.dispatch({ type: "SESSION_FAILED", reason });
				return;
			case "start_failed":
				new Notice(
					this.t.notices.micPermissionDenied,
					NOTICE_DURATION_MS,
				);
				this.state.dispatch({ type: "SESSION_FAILED", reason });
				return;
			case "reconnect_exhausted":
				new Notice(this.t.notices.reconnectFailed, NOTICE_DURATION_MS);
				this.state.dispatch({ type: "RECONNECT_EXHAUSTED" });
				// 재연결 실패 시 현재까지의 버퍼를 보존한다(Requirement 8.7).
				void this.saveBufferAsTranscriptQuietly();
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
				return;
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
		const buffer = this.transcribeService?.getTranscriptBuffer();
		if (!buffer || buffer.isEmpty()) {
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
		const buffer = this.transcribeService.getTranscriptBuffer();
		if (buffer.isEmpty()) {
			return null;
		}
		const body = buffer.getCommittedText();
		const meta: TranscriptNoteMeta = {
			startedAt: this.sessionStartedAt ?? new Date().toISOString(),
			endedAt: new Date().toISOString(),
			language: this.settings.languageCode,
		};
		const file = await this.noteStore.saveTranscript(
			body,
			meta,
			this.settings.transcriptFolder,
			new Date(),
			this.t.notices.folderCreateFailed,
		);
		// 자동 저장 이후 버퍼를 비워 다음 세션이 깨끗하게 시작되도록 한다.
		this.transcribeService.clearBuffer();
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
			missing.push(this.t.settings.bedrockModelId.name);
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
}
