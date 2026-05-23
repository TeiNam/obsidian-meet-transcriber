/**
 * `DownloadConfirmModal` — 사용자가 로컬 모델 다운로드 버튼을 눌렀을 때 표시되는
 * 명시적 동의 모달. Requirement 2.1 ~ 2.3, 2.5, 2.9 와 design §5.6 매핑.
 *
 * ## 책임
 * - 사용자가 다운로드 버튼을 클릭하면 (a) 모델 ID, (b) 출처 도메인, (c) 예상 크기(MB),
 *   (d) 저장 경로를 표시하여 무엇이 어디로 받아질지 사용자가 확인할 수 있게 한다
 *   (Requirement 2.2).
 * - 사용자가 "동의 후 다운로드"(영어 "Agree and download") 버튼을 클릭한 시점에만
 *   `Model_Download_Manager.download(...)` 가 호출되도록 한다 — 모달이 열렸다는 사실만으로는
 *   네트워크 요청이 발생하지 않는다 (Requirement 2.3).
 * - 다운로드가 시작되면 `onProgress` 콜백을 받아 진행 영역의 텍스트(`bytesDownloaded`,
 *   `percent`)를 1초 이내 간격으로 갱신한다 (Requirement 2.5).
 * - 사용자가 "취소"를 클릭하면 진행 중인 다운로드를 `controller.abort()` 로 중단하고
 *   모달을 닫는다 (Requirement 2.9).
 * - 다운로드가 성공/실패/취소로 종결되면 모달을 자동으로 닫는다.
 *
 * ## 의존성 주입
 * 본 모달은 `Model_Download_Manager` 를 생성자 인자로 받는다. 모달 내부에서 매니저나
 * 그 의존성(HttpStreamClient, NodeFsLike) 을 직접 만들지 않는다 — 테스트에서 spy
 * 매니저를 주입할 수 있도록 하기 위함 (Requirement 12.5).
 *
 * ## DOM / Obsidian 검수 규약
 * - `innerHTML` / `outerHTML` 등은 사용하지 않으며 `createEl`/`createDiv` 와 `setText`
 *   만 사용한다.
 * - 버튼은 `<button>` 엘리먼트에 `addEventListener("click", ...)` 으로 핸들러 등록.
 *   본 모달은 Plugin 컨텍스트가 없으므로 `registerDomEvent` 대신 모달 close 시점에
 *   listener 가 자동 폐기되는 단발성 등록 방식을 쓴다.
 * - i18n 키 (task 28 에서 정식 도입 완료): `notices.downloadConfirmTitle`,
 *   `notices.downloadConfirmDescription(sizeMb, host)`, `notices.downloadConfirmAgree`,
 *   `notices.downloadCancelled`, `buttons.cancel`. 모달 옵션의 `t` 가 주입되면
 *   해당 키들을 사용하고, 누락된 경우(테스트 픽스처 등) 영어 fallback 으로 동작한다.
 */

import { Modal, type App } from "obsidian";

import type { Translations } from "../i18n";
import type {
	DownloadProgress,
	LocalModelCatalogEntry,
	Local_Model_Installation_Record,
	ModelDownloadCallbacks,
	ModelDownloadError,
	Model_Download_Manager,
} from "../services/Model_Download_Manager";

/**
 * 다운로드 종결 시 호출되는 콜백 묶음.
 *
 * 모달은 종결 시 항상 자기 자신을 close 한 후 본 콜백 중 하나를 호출한다 — 호출 측은
 * Plugin 의 `onCompleted` 핸들러(예: `localModelInstalled` data.json 갱신)와
 * 실패/취소 시 `Notice` 표시 로직을 여기에 연결한다.
 */
export interface DownloadConfirmCallbacks {
	onCompleted(record: Local_Model_Installation_Record): void;
	onError(reason: ModelDownloadError): void;
	onCancelled(): void;
}

export interface DownloadConfirmModalOptions {
	readonly app: App;
	readonly entry: LocalModelCatalogEntry;
	readonly modelFolder: string;
	readonly downloadManager: Model_Download_Manager;
	readonly callbacks: DownloadConfirmCallbacks;
	/**
	 * 현재 로케일에 해당하는 번역 객체 (선택).
	 *
	 * 주입되지 않은 경우 영어 fallback 으로 동작한다 — 테스트 픽스처가 i18n 주입 없이도
	 * 모달을 띄울 수 있도록 하기 위함이다. 프로덕션 호출 경로(`LocalModelSettingsSection`)
	 * 는 항상 `host.t` 를 그대로 전달한다.
	 */
	readonly t?: Translations;
}

/**
 * 모달 내부 상태 — 사용자 행동에 따라 한 방향으로만 전이된다.
 *
 *     idle → downloading → completed
 *               │
 *               ├─→ failed
 *               └─→ cancelled
 *
 * `idle` 에서는 사용자가 [Agree and download] 또는 [Cancel] 을 누를 수 있다. 후자는
 * 모달만 닫고 다운로드는 시작되지 않는다 (Requirement 2.3 의 보호 — 모달 표시만으로
 * 네트워크 요청이 발생해서는 안 된다).
 */
type ModalState = "idle" | "downloading" | "completed" | "failed" | "cancelled";

/**
 * 진행률 영역을 갱신하기 위한 핸들 묶음. render 직후 채워지며 progress 핸들러에서 참조.
 */
interface ProgressEls {
	statusEl: HTMLElement;
	percentEl: HTMLElement;
	bytesEl: HTMLElement;
}

export class DownloadConfirmModal extends Modal {
	private readonly entry: LocalModelCatalogEntry;
	private readonly modelFolder: string;
	private readonly downloadManager: Model_Download_Manager;
	private readonly callbacks: DownloadConfirmCallbacks;
	private readonly t: Translations | undefined;

	private state: ModalState = "idle";
	private controller: AbortController | null = null;
	private progressEls: ProgressEls | null = null;
	private agreeBtn: HTMLButtonElement | null = null;
	private cancelBtn: HTMLButtonElement | null = null;

	constructor(options: DownloadConfirmModalOptions) {
		super(options.app);
		this.entry = options.entry;
		this.modelFolder = options.modelFolder;
		this.downloadManager = options.downloadManager;
		this.callbacks = options.callbacks;
		this.t = options.t;
	}

	override onOpen(): void {
		this.renderConfirmation();
	}

	override onClose(): void {
		// onClose 는 close() 가 호출된 시점에 항상 호출된다. 사용자가 OS 단축키 등으로
		// 모달을 닫은 경우에도 in-flight 다운로드가 남지 않도록 controller 를 abort.
		// 이미 종결된(completed/failed/cancelled) 경우에는 abort 가 no-op 이므로 안전.
		if (this.state === "downloading" && this.controller !== null) {
			try {
				this.controller.abort();
			} catch {
				/* AbortController.abort() 는 본래 throw 하지 않음 — 방어적 catch */
			}
		}
		// DOM 정리는 Modal 베이스가 처리하지만, 진행 핸들 참조는 명시적으로 비워둔다.
		this.progressEls = null;
		this.agreeBtn = null;
		this.cancelBtn = null;
	}

	// -------------------------------------------------------------------------
	// 렌더링
	// -------------------------------------------------------------------------

	/**
	 * 동의 화면 — 모델 정보 + Agree/Cancel 두 버튼.
	 *
	 * 표시 항목 (Requirement 2.2):
	 * - 모델 ID (`entry.id`)
	 * - 출처 도메인: `entry.downloadUrl` 의 host. URL 파싱 실패 시 `huggingface.co` 로
	 *   fallback (Requirement 9.1.c — 모든 카탈로그 항목은 Hugging Face 도메인).
	 * - 예상 크기 MB (`entry.sizeMb`)
	 * - 저장 경로 (`modelFolder`)
	 */
	private renderConfirmation(): void {
		const t = this.t;
		const titleText = t?.notices.downloadConfirmTitle ?? "Download local model";
		this.titleEl.setText(titleText);

		this.contentEl.empty();

		const sourceHost = extractHost(this.entry.downloadUrl);

		// 안내 문장. Requirement 2.2 의 "사전 확인" 핵심 요소를 한 단락에 모은다.
		const description = this.contentEl.createEl("p", {
			cls: "transcribe-download-confirm__description",
		});
		const descriptionText = t
			? t.notices.downloadConfirmDescription(this.entry.sizeMb, sourceHost)
			: `This will download approximately ${this.entry.sizeMb}MB from ${sourceHost}. Continue?`;
		description.setText(descriptionText);

		// 상세 항목 4 개를 라벨/값 라인으로 표시.
		const detailsList = this.contentEl.createDiv({
			cls: "transcribe-download-confirm__details",
		});
		appendDetailRow(detailsList, "Model", this.entry.displayName);
		appendDetailRow(detailsList, "Model ID", this.entry.id);
		appendDetailRow(detailsList, "Source", sourceHost);
		appendDetailRow(detailsList, "Size", `${this.entry.sizeMb} MB`);
		appendDetailRow(detailsList, "Save to", this.modelFolder);

		// 진행률 영역 — 다운로드 시작 전에는 안내만 표시되고, 시작 후 percent/bytes 가 채워진다.
		const progressContainer = this.contentEl.createDiv({
			cls: "transcribe-download-confirm__progress",
		});
		const statusEl = progressContainer.createDiv({
			cls: "transcribe-download-confirm__progress-status",
		});
		statusEl.setText("Waiting for confirmation");
		const percentEl = progressContainer.createDiv({
			cls: "transcribe-download-confirm__progress-percent",
		});
		percentEl.setText("0%");
		const bytesEl = progressContainer.createDiv({
			cls: "transcribe-download-confirm__progress-bytes",
		});
		bytesEl.setText("0 / ?");
		this.progressEls = { statusEl, percentEl, bytesEl };

		// 버튼 행.
		const buttonRow = this.contentEl.createDiv({
			cls: "transcribe-download-confirm__buttons",
		});
		const cancelBtn = buttonRow.createEl("button", {
			cls: "transcribe-download-confirm__cancel",
		});
		cancelBtn.setText(t?.buttons.cancel ?? "Cancel");
		cancelBtn.addEventListener("click", () => this.handleCancelClick());
		this.cancelBtn = cancelBtn;

		const agreeBtn = buttonRow.createEl("button", {
			cls: "transcribe-download-confirm__agree mod-cta",
		});
		agreeBtn.setText(t?.notices.downloadConfirmAgree ?? "Agree and download");
		agreeBtn.addEventListener("click", () => this.handleAgreeClick());
		this.agreeBtn = agreeBtn;
	}

	// -------------------------------------------------------------------------
	// 버튼 핸들러
	// -------------------------------------------------------------------------

	/**
	 * Agree 클릭 — 정확히 이 시점에만 `Model_Download_Manager.download(...)` 를 호출한다
	 * (Requirement 2.3). 중복 클릭 방어를 위해 idle 상태가 아니면 무시한다.
	 */
	private handleAgreeClick(): void {
		if (this.state !== "idle") return;
		this.state = "downloading";

		// UI 전환 — Agree 버튼은 비활성화하고 Cancel 은 그대로 둔다 (Requirement 2.9).
		if (this.agreeBtn !== null) {
			this.agreeBtn.disabled = true;
		}
		if (this.progressEls !== null) {
			this.progressEls.statusEl.setText("Downloading…");
		}

		const callbacks: ModelDownloadCallbacks = {
			onProgress: (progress) => this.handleProgress(progress),
			onCompleted: (record) => this.handleCompleted(record),
			onError: (reason) => this.handleError(reason),
		};

		// Model_Download_Manager.download 는 즉시 AbortController 를 반환한다 — 사용자가
		// Cancel 을 누르면 이 controller 의 abort() 만 호출하면 된다.
		this.controller = this.downloadManager.download(
			this.entry,
			this.modelFolder,
			callbacks,
		);
	}

	/**
	 * Cancel 클릭 — idle 상태면 모달만 닫고 (다운로드 미시작), downloading 이면
	 * `controller.abort()` 호출 후 종료. abort 결과는 `Model_Download_Manager` 가
	 * `onError({code:"cancelled"})` 으로 통지하며, 본 핸들러에서 `handleError` 가
	 * 모달 close 까지 처리한다.
	 */
	private handleCancelClick(): void {
		if (this.state === "idle") {
			// 다운로드 미시작 — 사용자가 동의 전에 모달을 닫음. 콜백 호출 없이 close 만.
			this.state = "cancelled";
			this.callbacks.onCancelled();
			this.close();
			return;
		}
		if (this.state !== "downloading") return; // 이미 완료/실패/취소 — 중복 무시.

		// in-flight 다운로드 abort. 결과 통지는 onError 경로(code:"cancelled")로 들어옴.
		if (this.controller !== null) {
			try {
				this.controller.abort();
			} catch {
				/* AbortController.abort() 는 본래 throw 하지 않음 */
			}
		}
	}

	// -------------------------------------------------------------------------
	// Model_Download_Manager 콜백
	// -------------------------------------------------------------------------

	private handleProgress(progress: DownloadProgress): void {
		if (this.state !== "downloading" || this.progressEls === null) return;
		const totalLabel =
			progress.bytesTotal !== null
				? formatBytes(progress.bytesTotal)
				: "?";
		this.progressEls.percentEl.setText(`${progress.percent}%`);
		this.progressEls.bytesEl.setText(
			`${formatBytes(progress.bytesDownloaded)} / ${totalLabel}`,
		);
	}

	private handleCompleted(record: Local_Model_Installation_Record): void {
		if (this.state !== "downloading") return;
		this.state = "completed";
		this.callbacks.onCompleted(record);
		this.close();
	}

	private handleError(reason: ModelDownloadError): void {
		if (this.state !== "downloading") return;
		if (reason.code === "cancelled") {
			this.state = "cancelled";
			this.callbacks.onCancelled();
		} else {
			this.state = "failed";
			this.callbacks.onError(reason);
		}
		this.close();
	}
}

// -----------------------------------------------------------------------------
// 내부 헬퍼 (순수 함수)
// -----------------------------------------------------------------------------

/**
 * 라벨/값 한 줄을 details 컨테이너에 추가한다. createEl 만 사용해 XSS 안전하다.
 */
function appendDetailRow(
	parent: HTMLElement,
	label: string,
	value: string,
): void {
	const row = parent.createDiv({ cls: "transcribe-download-confirm__row" });
	const labelEl = row.createEl("span", {
		cls: "transcribe-download-confirm__row-label",
	});
	labelEl.setText(`${label}:`);
	const valueEl = row.createEl("span", {
		cls: "transcribe-download-confirm__row-value",
	});
	valueEl.setText(value);
}

/**
 * URL 의 host 부분만 추출. 파싱 실패 시 `huggingface.co` 로 fallback —
 * `Local_Model_Catalog` 의 모든 항목은 Hugging Face 도메인이므로 안전한 기본값이다.
 */
function extractHost(url: string): string {
	try {
		return new URL(url).host;
	} catch {
		return "huggingface.co";
	}
}

/**
 * 바이트 수를 사람이 읽기 좋은 단위로 변환. 1024 진법, 소수 1자리 유지.
 */
function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	const kb = bytes / 1024;
	if (kb < 1024) return `${kb.toFixed(1)} KB`;
	const mb = kb / 1024;
	if (mb < 1024) return `${mb.toFixed(1)} MB`;
	const gb = mb / 1024;
	return `${gb.toFixed(2)} GB`;
}
