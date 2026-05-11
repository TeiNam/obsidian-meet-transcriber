// Transcribe 사이드바 뷰 — `ItemView` 확장.
//
// 모든 DOM은 `createEl` / `createDiv` / `createSpan` API로 생성하며
// `innerHTML` 계열은 사용하지 않는다(Requirement 9.5, 커뮤니티 검수 기준).
// 상태/버퍼 로직은 외부(플러그인)가 소유하며, 이 클래스는 "표시"와 "사용자 입력
// 전달"만 담당한다.
//
// 관련 요구사항: 1.7, 1.8, 1.9, 1.10, 3.5, 3.6, 3.7, 3.8, 4.7, 5.3, 5.4, 5.6,
// 5.8, 5.9, 6.6, 6.16, 7.3, 7.4, 9.5, 10.4, 10.5

import { ItemView, setIcon, type App, type TFile, type WorkspaceLeaf } from "obsidian";
import type { Translations } from "../i18n";
import {
	computeButtonStates,
	type ButtonStates,
} from "../state/ButtonStatePolicy";
import type { StreamingState } from "../state/StreamingStateMachine";

/**
 * 사이드바 뷰 타입 식별자.
 *
 * `workspace.getLeavesOfType(VIEW_TYPE_TRANSCRIBE)`로 활성 리프를 조회하거나,
 * `registerView` 호출에서 뷰 팩토리 키로 사용된다.
 */
export const VIEW_TYPE_TRANSCRIBE = "transcribe-view";

/**
 * 버튼 활성화 정책에 필요한 "환경 입력" 묶음.
 *
 * 뷰가 자체적으로 알 수 없는 값(노트 존재 여부, 본문 길이, 자격 증명/모델 설정
 * 여부)을 플러그인으로부터 pull 하기 위한 계약이다. 뷰 내부에서만 결정 가능한
 * `streamingState`, `isAnalyzing`, `isEditing`은 이 계약에 포함되지 않는다.
 */
export interface SidebarEnvironmentInputs {
	/** 현재 세션에 연결된 전사 노트 파일이 존재하는지. */
	hasTranscriptNote: boolean;
	/** 전사 본문(확정)의 문자 수. */
	transcriptLength: number;
	/** AWS 자격 증명이 모두 설정되었는지. */
	hasCredentials: boolean;
	/** Bedrock 모델 ID가 설정되었는지. */
	hasBedrockModel: boolean;
}

/**
 * `SidebarView`가 의존하는 플러그인의 최소 계약.
 *
 * 실제 구현체(`TranscribePlugin`, 태스크 17에서 구현)는 이 인터페이스를
 * 이행한다. 뷰 테스트에서는 stub 객체로 치환할 수 있도록 `Plugin` 타입이
 * 아니라 공개된 필드/메서드 집합만 노출한다.
 */
export interface TranscribePluginLike {
	/** Obsidian `App` 인스턴스. */
	app: App;
	/** 현재 로케일에 해당하는 번역 객체. `changeLocale` 시 재할당된다. */
	t: Translations;

	/**
	 * DOM 이벤트 등록(Plugin 기본 제공). 플러그인 unload 시 자동 해제되어
	 * 리스너 누수를 방지한다(Requirement 8.1).
	 */
	registerDomEvent(
		el: HTMLElement | Document | Window,
		type: string,
		cb: (evt: Event) => void,
	): void;

	/**
	 * 버튼 활성화 정책에 필요한 환경 입력을 조회한다.
	 *
	 * 뷰는 `refreshButtons()` 호출 시 이 메서드를 호출하여 최신 값을 얻는다.
	 * 플러그인은 부작용 없이 즉시 현재 상태 스냅샷을 반환해야 한다.
	 */
	getEnvironmentInputs(): SidebarEnvironmentInputs;

	/** 시작/중지 버튼 클릭 핸들러. */
	handleStartStopClick(): void | Promise<void>;
	/** 편집 버튼 클릭 핸들러. 플러그인이 `view.enterEditMode()`를 호출한다. */
	handleEditClick(): void;
	/** 분석 버튼 클릭 핸들러. */
	handleAnalyzeClick(): void | Promise<void>;
	/**
	 * 편집 저장 핸들러. 검증/파일 쓰기 오류 시 예외를 던져 뷰가 편집 모드를
	 * 유지하도록 한다.
	 */
	handleSaveEditClick(newBody: string): void | Promise<void>;
	/** 편집 취소 핸들러. 버퍼/노트에는 영향을 주지 않아야 한다. */
	handleCancelEditClick(): void;
	/** 복사 버튼 핸들러. 현재 뷰에 표시된 본문 텍스트를 받아 클립보드로 보낸다. */
	handleCopyClick?(text: string): void | Promise<void>;
	/** 최근 전사 리스트에서 항목을 선택했을 때 호출된다. */
	handleRecentTranscriptClick?(file: TFile): void | Promise<void>;
	/**
	 * 최근 전사 파일 목록 조회(선택 구현).
	 *
	 * 뷰가 `onOpen()` 에서 직접 호출해 초기 로딩 시 리스트를 즉시 채울 때 사용한다.
	 * 플러그인이 이 메서드를 구현하지 않아도 뷰는 빈 배열로 동작한다.
	 */
	getRecentTranscripts?(): TFile[];
}

/**
 * Transcribe 사이드바 뷰.
 *
 * 세 개 영역으로 구성된다:
 * 1) 상태 영역 — 현재 `StreamingState` 레이블 + 재연결 보조 라벨.
 * 2) 컨트롤 — 시작/중지, 편집, 분석 3 버튼.
 * 3) 콘텐츠 — 읽기 모드(스크롤 가능한 트랜스크립트 텍스트) / 편집 모드(textarea).
 *
 * 버튼 활성 여부는 `ButtonStatePolicy.computeButtonStates`가 결정하며,
 * 정책 입력은 뷰 내부 플래그 + 플러그인 `getEnvironmentInputs()`에서 합성한다.
 */
export class SidebarView extends ItemView {
	// ──────────────────────────────────────────────────────────
	// 뷰가 소유하는 UI 상태
	// ──────────────────────────────────────────────────────────

	/** 현재 외부 스트리밍 상태. `updateState()`로 갱신. */
	private currentState: StreamingState = "idle";
	/** 재연결 보조 플래그. */
	private reconnecting = false;
	/** 분석 진행 중 여부. `showAnalyzeSpinner()`로 갱신. */
	private isAnalyzing = false;
	/** 편집 모드 활성 여부. */
	private isEditing = false;

	/** 누적 확정 텍스트(읽기 모드에서 표시). */
	private committedText = "";
	/** 현재 partial 텍스트(읽기 모드에서 committed 뒤에 뮤트로 표시). */
	private partialText = "";

	// ──────────────────────────────────────────────────────────
	// DOM 참조 (render()마다 재생성)
	// ──────────────────────────────────────────────────────────

	private statusEl: HTMLDivElement | null = null;
	private recordingIndicatorEl: HTMLSpanElement | null = null;
	private stateLabelEl: HTMLSpanElement | null = null;
	private reconnectLabelEl: HTMLSpanElement | null = null;
	private startStopBtn: HTMLButtonElement | null = null;
	private editBtn: HTMLButtonElement | null = null;
	private analyzeBtn: HTMLButtonElement | null = null;
	private copyBtn: HTMLButtonElement | null = null;
	private spinnerEl: HTMLDivElement | null = null;
	private transcribeContentEl: HTMLDivElement | null = null;
	private transcriptTextEl: HTMLDivElement | null = null;
	private emptyHintEl: HTMLSpanElement | null = null;
	private committedSpan: HTMLSpanElement | null = null;
	private partialSpan: HTMLSpanElement | null = null;
	private editorTextareaEl: HTMLTextAreaElement | null = null;
	private recentListEl: HTMLDivElement | null = null;

	/** 최근 전사 파일 목록(플러그인에서 주입). 기본은 빈 배열. */
	private recentTranscripts: TFile[] = [];

	constructor(leaf: WorkspaceLeaf, private plugin: TranscribePluginLike) {
		super(leaf);
	}

	// ──────────────────────────────────────────────────────────
	// ItemView 오버라이드
	// ──────────────────────────────────────────────────────────

	getViewType(): string {
		return VIEW_TYPE_TRANSCRIBE;
	}

	getDisplayText(): string {
		// 뷰 탭/헤더 제목. 로케일 변경 시 `render()` 내에서 Obsidian이 재조회한다.
		return this.plugin.t.view.displayText;
	}

	getIcon(): string {
		// 리본/탭 아이콘. Obsidian 기본 Lucide 아이콘 `mic` 사용(Requirement 10.4).
		return "mic";
	}

	async onOpen(): Promise<void> {
		this.render();
		// 앱 시작 시 사이드바가 이미 열려 있는 상태로 복원되면 activateView()가 호출되지 않는다.
		// 뷰 자신이 초기 리스트를 주입해 "항상 최신 상태"를 보장한다.
		try {
			const files = this.plugin.getRecentTranscripts?.() ?? [];
			this.setRecentTranscripts(files);
		} catch (err) {
			console.error("[SidebarView] initial recent list load failed:", err);
		}
	}

	async onClose(): Promise<void> {
		this.clearDomRefs();
		this.contentEl.empty();
	}

	// ──────────────────────────────────────────────────────────
	// 공개 API (플러그인이 호출)
	// ──────────────────────────────────────────────────────────

	/**
	 * 전체 UI를 다시 그린다.
	 *
	 * 로케일 변경(`onLocaleChange`)이나 편집 모드 전환 시 호출된다. 기존 DOM은
	 * `contentEl.empty()`로 제거되고 모든 참조가 재생성된다.
	 */
	render(): void {
		this.contentEl.empty();
		this.clearDomRefs();

		const root = this.contentEl.createDiv({ cls: "transcribe-sidebar" });

		this.renderStatus(root);
		this.renderControls(root);
		this.renderSpinner(root);

		this.transcribeContentEl = root.createDiv({ cls: "transcribe-content" });
		if (this.isEditing) {
			this.renderEditMode();
		} else {
			this.renderReadMode();
		}

		// 최근 전사 리스트 — 컨텐츠 영역 아래 배치.
		this.renderRecentList(root);

		this.refreshButtons();
	}

	/**
	 * 로케일 변경 알림 — 전체 UI를 새 번역으로 재렌더한다(Requirement 10.5).
	 *
	 * 호출 시점에는 이미 `plugin.t`가 새 번역으로 교체되어 있다고 가정한다.
	 * 파라미터는 호출 규약을 명확히 하기 위해 유지한다.
	 */
	onLocaleChange(_t: Translations): void {
		this.render();
	}

	/**
	 * 외부 스트리밍 상태/재연결 플래그를 반영한다(Requirement 1.9).
	 *
	 * 상태 변경은 상태 레이블, `data-state` 속성, 재연결 보조 라벨 가시성,
	 * 녹음 중 인디케이터 가시성, 그리고 버튼 활성화 정책까지 전파된다.
	 */
	updateState(state: StreamingState, reconnecting: boolean): void {
		this.currentState = state;
		this.reconnecting = reconnecting;

		if (this.statusEl) {
			this.statusEl.setAttr("data-state", state);
		}
		if (this.stateLabelEl) {
			this.stateLabelEl.setText(this.plugin.t.states[state]);
		}
		if (this.reconnectLabelEl) {
			this.reconnectLabelEl.toggleClass("is-hidden", !reconnecting);
		}
		// 녹음 중 인디케이터는 스트리밍 상태일 때만 노출한다(재연결 중에도 유지).
		if (this.recordingIndicatorEl) {
			this.recordingIndicatorEl.toggleClass(
				"is-hidden",
				state !== "streaming",
			);
		}

		this.refreshButtons();
	}

	/**
	 * Partial_Result를 표시에 반영한다(Requirement 3.5).
	 *
	 * 이전 partial은 즉시 교체되며, 누적되지 않는다. partial 표시 이후 본문 영역을
	 * 자동으로 하단 스크롤한다(Requirement 3.8).
	 */
	appendPartial(text: string): void {
		this.partialText = text;
		this.updatePartialDom();
		this.applyEmptyState();
		this.scrollToBottom();
	}

	/**
	 * Final_Result를 버퍼 끝에 추가하고 현재 partial을 비운다(Requirement 3.6, 3.7).
	 *
	 * committed 텍스트는 단일 공백으로 이어 붙여서 문단을 자연스럽게 유지한다.
	 */
	commitFinal(finalText: string): void {
		if (finalText.length > 0) {
			if (this.committedText.length > 0) {
				this.committedText = `${this.committedText} ${finalText}`;
			} else {
				this.committedText = finalText;
			}
		}
		this.partialText = "";
		this.updateCommittedDom();
		this.updatePartialDom();
		this.applyEmptyState();
		this.scrollToBottom();
		// committed 가 생기면 Copy 버튼도 활성화되어야 한다.
		this.refreshButtons();
	}

	/**
	 * 저장된 Transcript_Note 본문을 뷰에 로드한다(Requirement 4.7).
	 *
	 * 읽기 모드에서는 전체 committed 표시가 교체되고, partial은 초기화된다.
	 * 편집 모드에서는 textarea 값이 갱신된다(편집 중 저장 후 반영 용).
	 */
	loadNoteContent(content: string): void {
		this.committedText = content;
		this.partialText = "";

		if (this.isEditing && this.editorTextareaEl) {
			this.editorTextareaEl.value = content;
		} else {
			this.updateCommittedDom();
			this.updatePartialDom();
			this.applyEmptyState();
			this.scrollToBottom();
		}
		// 본문 변경에 따라 Copy 버튼 활성화 조건이 달라지므로 함께 갱신한다.
		this.refreshButtons();
	}

	/**
	 * 편집 모드로 진입한다(Requirement 5.3).
	 *
	 * textarea에 현재 committed 텍스트를 미리 채우고, 저장/취소 버튼을 노출한다.
	 * 편집 중에는 시작/중지/분석 버튼이 비활성화된다(`ButtonStatePolicy`).
	 */
	enterEditMode(): void {
		if (this.isEditing) return;
		this.isEditing = true;
		this.renderEditMode();
		this.refreshButtons();
	}

	/**
	 * 편집 모드를 종료한다(Requirement 5.4, 5.6).
	 *
	 * - `save=true`: textarea 값으로 `plugin.handleSaveEditClick`을 호출한다.
	 *   저장 핸들러가 예외를 던지면(예: 본문이 공백 전용 — Requirement 5.8) 편집
	 *   모드를 유지하고 전이하지 않는다.
	 * - `save=false`: `plugin.handleCancelEditClick`만 호출하고 상태 변경 없이 전이.
	 */
	async exitEditMode(save: boolean): Promise<void> {
		if (!this.isEditing) return;

		if (save) {
			const value = this.editorTextareaEl?.value ?? "";
			try {
				await this.plugin.handleSaveEditClick(value);
			} catch (err) {
				// 플러그인 측이 Notice를 띄울 책임. 뷰는 편집 모드 유지.
				console.error("[SidebarView] save handler rejected:", err);
				return;
			}
		} else {
			this.plugin.handleCancelEditClick();
		}

		this.isEditing = false;
		this.renderReadMode();
		this.refreshButtons();
	}

	/**
	 * 분석 진행 중 스피너의 가시성을 토글한다(Requirement 6.6, 6.16).
	 *
	 * `visible=true`일 때 분석 불변식(스트리밍/편집 중 동시 수행 금지)을 반영하기
	 * 위해 버튼 상태도 함께 갱신한다.
	 */
	showAnalyzeSpinner(visible: boolean): void {
		this.isAnalyzing = visible;
		if (this.spinnerEl) {
			this.spinnerEl.toggleClass("is-hidden", !visible);
		}
		this.refreshButtons();
	}

	/**
	 * 플러그인이 최근 전사 파일 목록을 주입할 때 호출한다.
	 *
	 * 전달받은 배열(mtime 내림차순, 최대 5개)을 그대로 저장하고 DOM 을 다시 그린다.
	 * 리스트가 비어 있으면 "이전 전사 내역이 없습니다" 안내 문구를 노출한다.
	 */
	setRecentTranscripts(files: TFile[]): void {
		this.recentTranscripts = files;
		this.renderRecentListBody();
	}

	/**
	 * 3개 버튼의 활성 상태/레이블을 재계산한다(Requirement 7.3, 7.4).
	 *
	 * 뷰 내부 플래그와 `plugin.getEnvironmentInputs()`의 값을 합쳐
	 * `computeButtonStates`에 전달한다. 순수 함수 결과만으로 DOM을 갱신하므로
	 * 호출 순서/빈도에 대해 멱등성(idempotent)을 가진다.
	 */
	refreshButtons(): void {
		if (!this.startStopBtn || !this.editBtn || !this.analyzeBtn) {
			// render() 이전에 호출된 경우 조용히 무시.
			return;
		}
		const env = this.plugin.getEnvironmentInputs();
		const states: ButtonStates = computeButtonStates({
			streamingState: this.currentState,
			isAnalyzing: this.isAnalyzing,
			isEditing: this.isEditing,
			hasTranscriptNote: env.hasTranscriptNote,
			transcriptLength: env.transcriptLength,
			hasCredentials: env.hasCredentials,
			hasBedrockModel: env.hasBedrockModel,
		});

		this.startStopBtn.disabled = !states.startStop.enabled;
		this.startStopBtn.setText(this.plugin.t.buttons[states.startStop.labelKey]);
		// CSS 에서 start / stop 시각 분기를 위한 data 속성(빨간 정지 버튼 스타일 등).
		this.startStopBtn.setAttr("data-mode", states.startStop.labelKey);

		this.editBtn.disabled = !states.edit.enabled;
		this.editBtn.setText(this.plugin.t.buttons.edit);

		this.analyzeBtn.disabled = !states.analyze.enabled;
		this.analyzeBtn.setText(this.plugin.t.buttons.analyze);

		// 복사 아이콘: 전사 보드 내부에 플로팅. 본문이 있고 편집/분석 중이 아닐 때만 활성.
		// 편집 모드에서는 텍스트 보드 자체가 textarea 로 대체되므로 이 아이콘은 DOM 에서 사라져 있다.
		if (this.copyBtn) {
			const hasText = this.currentDisplayedText().length > 0;
			this.copyBtn.disabled = !hasText || this.isAnalyzing;
		}
	}

	// ──────────────────────────────────────────────────────────
	// 내부 렌더 헬퍼
	// ──────────────────────────────────────────────────────────

	/**
	 * 상태 영역(`transcribe-status`)을 그린다.
	 *
	 * 구성:
	 * - 녹음 중 빨간 펄스 인디케이터(`.recording-indicator`). 스트리밍 중이 아니면 숨김.
	 * - 주요 상태 레이블(`.state-label`).
	 * - 재연결 보조 라벨(`.reconnect-label`). 재연결 중이 아니면 숨김.
	 *
	 * 세 요소를 별도 span 으로 유지하여 재연결 중일 때 주요 레이블은 "streaming"을
	 * 그대로 두고 보조 라벨만 노출한다.
	 */
	private renderStatus(root: HTMLElement): void {
		const status = root.createDiv({ cls: "transcribe-status" });
		status.setAttr("data-state", this.currentState);
		this.statusEl = status;

		// 녹음 중 빨간 펄스 인디케이터 — 스트리밍 상태일 때만 노출.
		this.recordingIndicatorEl = status.createSpan({
			cls: "recording-indicator",
			attr: { "aria-label": "Recording" },
		});
		if (this.currentState !== "streaming") {
			this.recordingIndicatorEl.addClass("is-hidden");
		}

		this.stateLabelEl = status.createSpan({
			cls: "state-label",
			text: this.plugin.t.states[this.currentState],
		});

		this.reconnectLabelEl = status.createSpan({
			cls: "reconnect-label",
			text: this.plugin.t.states.reconnecting,
		});
		if (!this.reconnecting) {
			this.reconnectLabelEl.addClass("is-hidden");
		}
	}

	/**
	 * 컨트롤 영역(3 버튼)을 그리고 클릭 이벤트를 등록한다.
	 *
	 * 이벤트는 `plugin.registerDomEvent`로 등록하여 플러그인 unload 시 자동
	 * 해제되도록 한다(Requirement 8.1).
	 */
	private renderControls(root: HTMLElement): void {
		const controls = root.createDiv({ cls: "transcribe-controls" });

		this.startStopBtn = controls.createEl("button", {
			cls: "start-stop-btn",
			text: this.plugin.t.buttons.start,
		});
		this.editBtn = controls.createEl("button", {
			cls: "edit-btn",
			text: this.plugin.t.buttons.edit,
		});
		this.analyzeBtn = controls.createEl("button", {
			cls: "analyze-btn",
			text: this.plugin.t.buttons.analyze,
		});

		// 초기 상태에서 편집/분석은 비활성. refreshButtons()가 정확한 상태를 덮어쓴다.
		this.editBtn.disabled = true;
		this.analyzeBtn.disabled = true;

		this.plugin.registerDomEvent(this.startStopBtn, "click", () => {
			void this.plugin.handleStartStopClick();
		});
		this.plugin.registerDomEvent(this.editBtn, "click", () => {
			this.plugin.handleEditClick();
		});
		this.plugin.registerDomEvent(this.analyzeBtn, "click", () => {
			void this.plugin.handleAnalyzeClick();
		});
	}

	/**
	 * 분석 진행 중 스피너 영역을 그린다. 기본적으로 `is-hidden`.
	 */
	private renderSpinner(root: HTMLElement): void {
		this.spinnerEl = root.createDiv({
			cls: "transcribe-spinner",
			text: this.plugin.t.ui.analyzing,
		});
		if (!this.isAnalyzing) {
			this.spinnerEl.addClass("is-hidden");
		}
	}

	/**
	 * 읽기 모드 콘텐츠(`transcript-text` div + 빈 상태/committed/partial span)를 그린다.
	 *
	 * 빈 상태 안내(Requirement 1.10)는 전용 span을 두고 `is-hidden`으로 토글한다.
	 * 보드 우상단에는 플로팅 복사 아이콘을 얹어, 편집 모드로 진입하지 않아도 한 번의
	 * 클릭으로 전사 본문을 클립보드에 복사할 수 있게 한다.
	 */
	private renderReadMode(): void {
		const container = this.transcribeContentEl;
		if (!container) return;
		container.empty();
		this.editorTextareaEl = null;

		// 포지셔닝 래퍼 — 복사 아이콘을 absolute 배치하려면 position: relative 맥락이 필요.
		const wrapper = container.createDiv({ cls: "transcript-wrapper" });

		this.transcriptTextEl = wrapper.createDiv({ cls: "transcript-text" });

		this.emptyHintEl = this.transcriptTextEl.createSpan({
			cls: "empty-hint",
			text: this.plugin.t.ui.empty,
		});
		this.committedSpan = this.transcriptTextEl.createSpan({
			cls: "committed",
		});
		this.partialSpan = this.transcriptTextEl.createSpan({ cls: "partial" });

		// 복사 아이콘 버튼 — 전사 보드 우상단 플로팅. 스트리밍 중에도 현재까지 본문 복사 가능.
		this.copyBtn = wrapper.createEl("button", {
			cls: "transcript-copy-icon",
			attr: {
				"aria-label": this.plugin.t.buttons.copy,
				title: this.plugin.t.buttons.copy,
				type: "button",
			},
		});
		// Lucide `clipboard` 아이콘 — Obsidian 기본 제공.
		setIcon(this.copyBtn, "clipboard");
		this.plugin.registerDomEvent(this.copyBtn, "click", () => {
			void this.plugin.handleCopyClick?.(this.currentDisplayedText());
		});

		this.updateCommittedDom();
		this.updatePartialDom();
		this.applyEmptyState();
	}

	/**
	 * 편집 모드 콘텐츠(textarea + 저장/취소 버튼)를 그린다(Requirement 5.3).
	 */
	private renderEditMode(): void {
		const container = this.transcribeContentEl;
		if (!container) return;
		container.empty();
		this.transcriptTextEl = null;
		this.emptyHintEl = null;
		this.committedSpan = null;
		this.partialSpan = null;

		this.editorTextareaEl = container.createEl("textarea", {
			cls: "transcribe-editor",
		});
		this.editorTextareaEl.value = this.committedText;

		const editControls = container.createDiv({
			cls: "transcribe-editor-controls",
		});
		const saveBtn = editControls.createEl("button", {
			cls: "save-btn",
			text: this.plugin.t.buttons.save,
		});
		const cancelBtn = editControls.createEl("button", {
			cls: "cancel-btn",
			text: this.plugin.t.buttons.cancel,
		});

		this.plugin.registerDomEvent(saveBtn, "click", () => {
			void this.exitEditMode(true);
		});
		this.plugin.registerDomEvent(cancelBtn, "click", () => {
			void this.exitEditMode(false);
		});
	}

	/**
	 * committed 텍스트 span을 최신 값으로 갱신한다. 읽기 모드에서만 유효.
	 */
	private updateCommittedDom(): void {
		if (this.committedSpan) {
			this.committedSpan.setText(this.committedText);
		}
	}

	/**
	 * partial 텍스트 span을 최신 값으로 갱신한다.
	 *
	 * committed 뒤에 partial이 붙는 자연스러운 표시를 위해 committed/ partial 모두
	 * 비어있지 않을 때만 구분 공백을 prefix로 붙인다.
	 */
	private updatePartialDom(): void {
		if (!this.partialSpan) return;
		if (this.partialText.length === 0) {
			this.partialSpan.setText("");
			return;
		}
		const sep = this.committedText.length > 0 ? " " : "";
		this.partialSpan.setText(`${sep}${this.partialText}`);
	}

	/**
	 * committed/partial이 모두 비어있으면 빈 상태 안내만 노출한다(Requirement 1.10).
	 */
	private applyEmptyState(): void {
		if (!this.transcriptTextEl) return;
		const isEmpty =
			this.committedText.length === 0 && this.partialText.length === 0;

		this.transcriptTextEl.toggleClass("is-empty", isEmpty);
		this.emptyHintEl?.toggleClass("is-hidden", !isEmpty);
		this.committedSpan?.toggleClass("is-hidden", isEmpty);
		this.partialSpan?.toggleClass("is-hidden", isEmpty);
	}

	/**
	 * 트랜스크립트 본문 영역을 최하단으로 스크롤한다(Requirement 3.8).
	 */
	private scrollToBottom(): void {
		if (this.transcriptTextEl) {
			this.transcriptTextEl.scrollTop = this.transcriptTextEl.scrollHeight;
		}
	}

	/**
	 * 최근 전사 섹션의 컨테이너를 그린다. 실제 항목은 `renderRecentListBody`가 다시 채운다.
	 */
	private renderRecentList(root: HTMLElement): void {
		const section = root.createDiv({ cls: "transcribe-recent" });
		section.createEl("h4", {
			cls: "transcribe-recent__heading",
			text: this.plugin.t.ui.recentTranscripts,
		});
		this.recentListEl = section.createDiv({ cls: "transcribe-recent__list" });
		this.renderRecentListBody();
	}

	/**
	 * 최근 전사 리스트 본문을 최신 `recentTranscripts` 값으로 재구성한다.
	 *
	 * 각 항목은 클릭 가능한 버튼으로 렌더되며, 클릭 시 플러그인의 핸들러로 파일을 전달한다.
	 */
	private renderRecentListBody(): void {
		const container = this.recentListEl;
		if (!container) return;
		container.empty();

		if (this.recentTranscripts.length === 0) {
			container.createSpan({
				cls: "transcribe-recent__empty",
				text: this.plugin.t.ui.noRecentTranscripts,
			});
			return;
		}

		for (const file of this.recentTranscripts) {
			const item = container.createEl("button", {
				cls: "transcribe-recent__item",
			});
			item.createSpan({
				cls: "transcribe-recent__title",
				text: formatTranscriptDisplayName(file.basename),
			});
			item.createSpan({
				cls: "transcribe-recent__meta",
				text: formatRelativeMtime(file.stat.mtime),
			});
			this.plugin.registerDomEvent(item, "click", () => {
				void this.plugin.handleRecentTranscriptClick?.(file);
			});
		}
	}

	/**
	 * 현재 뷰에 "사용자에게 보이는" 본문 텍스트를 반환한다.
	 *
	 * - 편집 모드: textarea 의 현재 값.
	 * - 읽기 모드: `committedText`(partial 은 제외 — 확정된 내용만 복사).
	 */
	private currentDisplayedText(): string {
		if (this.isEditing && this.editorTextareaEl) {
			return this.editorTextareaEl.value;
		}
		return this.committedText;
	}

	/**
	 * DOM 참조 필드를 모두 null로 리셋한다. `render()` 시작과 `onClose`에서 호출.
	 */
	private clearDomRefs(): void {
		this.statusEl = null;
		this.recordingIndicatorEl = null;
		this.stateLabelEl = null;
		this.reconnectLabelEl = null;
		this.startStopBtn = null;
		this.editBtn = null;
		this.analyzeBtn = null;
		this.copyBtn = null;
		this.spinnerEl = null;
		this.transcribeContentEl = null;
		this.transcriptTextEl = null;
		this.emptyHintEl = null;
		this.committedSpan = null;
		this.partialSpan = null;
		this.editorTextareaEl = null;
		this.recentListEl = null;
	}
}

/**
 * 파일 수정 시각 타임스탬프(ms)를 사용자 친화적 상대 시각 문자열로 변환한다.
 *
 * `Intl.RelativeTimeFormat` 을 사용해 "방금 전", "3분 전", "2시간 전" 같은 표현을
 * 로케일에 맞게 생성한다. Obsidian 이 내부적으로 `navigator.language` 를 이미 반영하므로
 * 별도의 로케일 인자는 받지 않는다.
 */
function formatRelativeMtime(mtime: number): string {
	const diffSec = Math.round((mtime - Date.now()) / 1000);
	const rtf = new Intl.RelativeTimeFormat(navigator.language, {
		numeric: "auto",
	});
	if (Math.abs(diffSec) < 60) {
		return rtf.format(diffSec, "second");
	}
	const diffMin = Math.round(diffSec / 60);
	if (Math.abs(diffMin) < 60) {
		return rtf.format(diffMin, "minute");
	}
	const diffHour = Math.round(diffMin / 60);
	if (Math.abs(diffHour) < 24) {
		return rtf.format(diffHour, "hour");
	}
	const diffDay = Math.round(diffHour / 24);
	return rtf.format(diffDay, "day");
}

/**
 * 전사 노트의 `basename` 을 사용자 친화적인 표시용 문자열로 변환한다.
 *
 * 파일 시스템 호환성을 위해 저장 시에는 콜론 대신 하이픈을 사용한다(`HH-mm`).
 * UI 에서는 일반적인 시각 표기(`HH:mm`)로 되돌려 가독성을 높인다.
 *
 * 매칭 규칙:
 * - `YYYY-MM-DD HH-mm[-N]` → `YYYY-MM-DD HH:mm` (충돌 회피 suffix 는 제거)
 * - 구 포맷 `Transcribe-YYYYMMDD-HHmmss[-N]` 도 동일하게 변환해 이전 노트도 예쁘게 표시.
 * - 매칭되지 않는 파일명은 원본 그대로 반환한다(사용자 정의 이름 존중).
 */
function formatTranscriptDisplayName(basename: string): string {
	// 새 포맷: 2025-11-10 14-23 또는 2025-11-10 14-23-1
	const newFmt = /^(\d{4}-\d{2}-\d{2}) (\d{2})-(\d{2})(?:-\d+)?$/.exec(basename);
	if (newFmt) {
		const [, date, hh, mm] = newFmt;
		return `${date} ${hh}:${mm}`;
	}
	// 구 포맷: Transcribe-20251110-142345 또는 Transcribe-20251110-142345-1
	const oldFmt = /^Transcribe-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})\d{2}(?:-\d+)?$/.exec(
		basename,
	);
	if (oldFmt) {
		const [, y, mo, d, hh, mm] = oldFmt;
		return `${y}-${mo}-${d} ${hh}:${mm}`;
	}
	return basename;
}
