/**
 * `LocalModelSettingsSection` — 설정 탭의 "Local model" 섹션 렌더러.
 *
 * task 23 — `TranscribeSettingTab` 의 본체가 800 줄을 넘어 비대해지는 것을 막기 위해
 * 백엔드 선택 / 로컬 모델 / 모델 폴더 / 다운로드 버튼 영역을 별도 모듈로 분리한다.
 * 본 모듈은 외부 효과(파일 시스템, 네트워크) 를 직접 수행하지 않으며, 모든 입출력은
 * 호출 측이 주입한 호스트 객체(`LocalModelSectionHost`) 를 통해 일어난다.
 *
 * ## 매핑되는 acceptance criteria
 * - Requirement 1.1 (모델 카탈로그 노출): 드롭다운 옵션이 `LOCAL_MODEL_CATALOG` + 빈 값.
 * - Requirement 1.2 (백엔드 선택 모드): 3 옵션 드롭다운, 기본 `cloud-only`.
 * - Requirement 1.3 (로컬 모델 ID): 카탈로그 항목 + 빈 값(미선택).
 * - Requirement 1.4 (모델 폴더 절대 경로): `isAbsoluteOSPath` 로 인라인 검증, 실패 시 메시지.
 * - Requirement 1.5 (OS 별 기본 경로 prefill): macOS/Windows/Linux 분기. 빈 값일 때만 prefill.
 * - Requirement 1.6 (local-only/auto 시 누락 검증): 누락 항목명을 포함한 인라인 메시지.
 * - Requirement 2.1 (다운로드 버튼 + 예상 크기 표시): `DownloadConfirmModal` 진입.
 *
 * ## i18n 정책
 * 본 모듈의 모든 라벨/설명/옵션 텍스트는 `host.t.settings.*` 경로의 i18n 키만 사용한다
 * (task 28 에서 정식 키 도입 완료). 영어/한국어 fallback 하드코딩은 더 이상 사용하지 않는다.
 * 단, 인라인 검증 메시지(폴더 형식 오류, 누락 필드 안내 등) 처럼 짧고 컨텍스트가 강한
 * 메시지는 `localText(host, en, ko)` 헬퍼로 로케일 분기를 둔다.
 */

import { Notice, type App, Setting } from "obsidian";

import type { Translations } from "../i18n";
import {
	LOCAL_MODEL_CATALOG,
	type LocalModelCatalogEntry,
} from "../services/Local_Model_Catalog";
import type {
	Model_Download_Manager,
	ModelDownloadError,
} from "../services/Model_Download_Manager";
import type { Backend_Selection_Mode, TranscribeSettings } from "../types/settings";
import type { Local_Model_Installation_Record } from "../types/localModel";
import { isAbsoluteOSPath } from "../domain/pathValidation";
import { DownloadConfirmModal } from "../views/DownloadConfirmModal";

/**
 * 본 섹션 렌더러가 호스트(`TranscribeSettingTab` 또는 테스트 stub) 에게 요구하는 최소 계약.
 *
 * 구조적 타입(structural type) 으로 정의되어 있어 `TranscribeSettingTab` 의 어떤 멤버를
 * 정확히 호출하는지 외부에서도 명확히 추적할 수 있다. 또한 테스트에서 fake host 를
 * 손쉽게 구성할 수 있어 단위 검증이 가능하다.
 */
export interface LocalModelSectionHost {
	/** Obsidian `App` — DownloadConfirmModal 생성에 사용. */
	readonly app: App;
	/** 현재 설정 — 본 섹션이 직접 mutate 하지만 저장은 host 에게 위임한다. */
	readonly settings: TranscribeSettings;
	/** 현재 로케일에 해당하는 번역 객체 — 영어/한국어 분기에 사용. */
	readonly t: Translations;
	/** 모델 다운로드 매니저 (선택). 미주입 시 다운로드 버튼은 비활성. */
	readonly modelDownloadManager: Model_Download_Manager | undefined;
	/** 다운로드 완료 시 plugin 측 책임으로 영속화하기 위한 콜백 (선택). */
	readonly onLocalModelDownloaded: ((record: Local_Model_Installation_Record) => void) | undefined;
	/** 현재 설정이 valid 하면 저장 — invalid 한 다른 필드가 있으면 no-op. */
	saveIfValid(): Promise<void>;
	/**
	 * 모델 폴더 prefill 에 사용할 기본 경로 (task 33).
	 *
	 * Obsidian 데스크톱 환경에서는 vault 루트의 `Attached Files` 절대 경로를 우선
	 * 반환하고, 그 외(테스트 stub / vault 접근 불가) 환경에서는 OS 별 기본 경로
	 * (`computeDefaultModelFolder()`) 로 fallback 한다. 미구현 host 는 undefined 를
	 * 반환할 수 있으며 이 경우 본 섹션은 OS 기본 경로만 사용한다.
	 */
	readonly getDefaultModelFolder?: () => string;
}

/**
 * Local model 섹션을 컨테이너에 렌더링한다.
 *
 * 호출 측은 `setHeading()` 을 호출한 직후에 본 함수를 호출하도록 약속한다.
 * 본 함수는 헤딩 자체는 만들지 않고 그 아래 4 개 필드(backend mode / model id /
 * model folder / download control) 만 렌더링한다.
 */
export function renderLocalModelSection(
	containerEl: HTMLElement,
	host: LocalModelSectionHost,
): void {
	renderBackendSelectionModeDropdown(containerEl, host);
	renderLocalModelIdDropdown(containerEl, host);
	renderModelFolderField(containerEl, host);
	renderDownloadModelControl(containerEl, host);
}

// -----------------------------------------------------------------------------
// 개별 필드 렌더러
// -----------------------------------------------------------------------------

/**
 * 백엔드 선택 모드 드롭다운 (Requirement 1.2).
 *
 * 옵션은 정확히 3 개(`cloud-only`, `local-only`, `auto`) 이며 기본값은 `cloud-only`.
 * 변경 직후 `local-only` / `auto` 로 전환되면 누락 검증을 트리거한다 (Requirement 1.6).
 */
function renderBackendSelectionModeDropdown(
	containerEl: HTMLElement,
	host: LocalModelSectionHost,
): void {
	const setting = new Setting(containerEl);
	const labels = host.t.settings.backendSelectionMode;
	setting.setName(labels.name);
	setting.setDesc(labels.desc);

	const errorEl = createErrorEl(setting.settingEl);

	setting.addDropdown((dd) => {
		dd.addOption("cloud-only", labels.options["cloud-only"]);
		dd.addOption("local-only", labels.options["local-only"]);
		dd.addOption("auto", labels.options.auto);
		dd.setValue(host.settings.backendSelectionMode);
		dd.onChange(async (value) => {
			const mode = value as Backend_Selection_Mode;
			host.settings.backendSelectionMode = mode;
			await host.saveIfValid();
			// 누락 검증을 갱신하여 저장 직후 인라인 안내가 즉시 보이도록 한다.
			updateLocalRequirementsHint(errorEl, host);
		});
	});

	updateLocalRequirementsHint(errorEl, host);
}

/**
 * 로컬 모델 ID 드롭다운 (Requirement 1.3).
 *
 * 옵션은 카탈로그 전체 + 빈 값(미선택). 빈 값은 항상 첫 번째.
 */
function renderLocalModelIdDropdown(
	containerEl: HTMLElement,
	host: LocalModelSectionHost,
): void {
	const setting = new Setting(containerEl);
	const labels = host.t.settings.localModelId;
	setting.setName(labels.name);
	setting.setDesc(labels.desc);

	setting.addDropdown((dd) => {
		// 빈 값(미선택) 옵션 — 사용자가 모델을 선택하지 않은 상태를 명시적으로 표현.
		dd.addOption("", `(${labels.empty})`);
		for (const entry of LOCAL_MODEL_CATALOG) {
			// 표시명에 예상 크기를 함께 노출 — `sizeFormat` 으로 일관된 포맷 적용.
			dd.addOption(
				entry.id,
				`${entry.displayName} (${labels.sizeFormat(entry.sizeMb)})`,
			);
		}
		dd.setValue(host.settings.localModelId);
		dd.onChange(async (value) => {
			host.settings.localModelId = value;
			await host.saveIfValid();
		});
	});
}

/**
 * 모델 폴더 텍스트 필드 (Requirement 1.4, 1.5).
 *
 * - 빈 값일 때 OS 별 기본값으로 prefill (사용자가 입력한 값은 보존).
 * - onChange 마다 `isAbsoluteOSPath` 검증, 실패 시 인라인 빨간 텍스트로 사유 표시.
 * - placeholder 도 OS 기본값으로 노출하여 사용자가 형식을 즉시 인지할 수 있게 한다.
 */
function renderModelFolderField(
	containerEl: HTMLElement,
	host: LocalModelSectionHost,
): void {
	const setting = new Setting(containerEl);
	const labels = host.t.settings.modelFolder;
	setting.setName(labels.name);
	setting.setDesc(labels.desc);

	const errorEl = createErrorEl(setting.settingEl);

	// 빈 값이면 기본 경로로 prefill (Requirement 1.5, task 33).
	// 사용자가 이전에 입력한 값이 있으면 그대로 보존한다.
	// task 33: host 가 vault 기반 기본 경로(`<vault>/Attached Files`) 를 제공하면
	// 그 값을 우선 사용하고, 없거나 빈 문자열이면 OS 별 기본 경로로 fallback 한다.
	const vaultDefault = host.getDefaultModelFolder?.() ?? "";
	const osDefault = computeDefaultModelFolder();
	const prefillDefault =
		vaultDefault.length > 0 ? vaultDefault : osDefault;
	if (host.settings.modelFolder.length === 0) {
		host.settings.modelFolder = prefillDefault;
		// 사이드 이펙트 저장은 onChange 와 동일 흐름으로 한 번만.
		void host.saveIfValid();
	}

	setting.addText((text) => {
		text.inputEl.classList.add("transcribe-model-folder-input");
		// placeholder 는 i18n 의 일반 안내 문구를 우선 사용하되, 기본 경로가 산출되어
		// 있으면 그쪽이 사용자에게 더 구체적이므로 그 값으로 덮어쓴다.
		text.setPlaceholder(
			prefillDefault.length > 0 ? prefillDefault : labels.placeholder,
		);
		text.setValue(host.settings.modelFolder);
		text.onChange(async (value) => {
			host.settings.modelFolder = value;
			validateModelFolderInline(errorEl, value, host);
			// isAbsoluteOSPath 가 false 라도 settings.region 등 다른 필드가 invalid
			// 일 수 있으므로 saveIfValid 만 호출 — invalid 면 no-op.
			await host.saveIfValid();
		});
	});

	// 초기 렌더 시점에도 한 번 검증해 즉시 사용자에게 피드백을 준다.
	validateModelFolderInline(errorEl, host.settings.modelFolder, host);
}

/**
 * "Download model" 버튼 + 예상 크기 표시 + 누락 안내 (Requirement 2.1).
 *
 * 버튼 활성 조건: (a) localModelId 가 카탈로그 항목, (b) modelFolder 가 절대 경로,
 * (c) modelDownloadManager 가 주입되어 있음. 셋 중 하나라도 미충족이면 disabled.
 *
 * 클릭 시 `DownloadConfirmModal` 을 열어 사용자 동의 후에만 실제 다운로드를 시작한다.
 */
function renderDownloadModelControl(
	containerEl: HTMLElement,
	host: LocalModelSectionHost,
): void {
	const setting = new Setting(containerEl);
	const labels = host.t.settings.localModelId;
	setting.setName(labels.download);

	// 예상 크기 표시 — 선택된 모델이 있으면 desc 영역에 표시한다.
	const entry = findCatalogEntry(host.settings.localModelId);
	if (entry !== undefined) {
		setting.setDesc(
			localText(
				host,
				`Approximately ${labels.sizeFormat(entry.sizeMb)} will be downloaded from ${extractHost(entry.downloadUrl)}.`,
				`${extractHost(entry.downloadUrl)} 에서 약 ${labels.sizeFormat(entry.sizeMb)} 가 다운로드됩니다.`,
			),
		);
	} else {
		setting.setDesc(
			localText(
				host,
				"Select a local model first to enable download.",
				"먼저 로컬 모델을 선택해야 다운로드할 수 있습니다.",
			),
		);
	}

	setting.addButton((btn) => {
		btn.setButtonText(labels.download);
		const enabled = canStartDownload(host);
		btn.setDisabled(!enabled);
		if (enabled) {
			btn.setCta();
		}
		btn.onClick(() => {
			handleDownloadClick(host);
		});
	});
}

// -----------------------------------------------------------------------------
// 클릭 핸들러
// -----------------------------------------------------------------------------

/**
 * "Download model" 버튼 클릭 진입점.
 *
 * 본 함수는 폴백/예외에 강건하도록 모든 사전 조건을 한 번 더 검증한다 — UI 가
 * disabled 상태를 잘못 보여주는 일이 있어도 네트워크 요청은 절대 발사되지 않게 한다.
 */
function handleDownloadClick(host: LocalModelSectionHost): void {
	if (!canStartDownload(host)) {
		return;
	}
	const entry = findCatalogEntry(host.settings.localModelId);
	if (entry === undefined) return;
	const manager = host.modelDownloadManager;
	if (manager === undefined) return;

	const modal = new DownloadConfirmModal({
		app: host.app,
		entry,
		modelFolder: host.settings.modelFolder,
		downloadManager: manager,
		t: host.t,
		callbacks: {
			onCompleted: (record) => {
				// plugin 측 영속화 책임 (data.json `localModelInstalled` 갱신).
				try {
					host.onLocalModelDownloaded?.(record);
				} catch (err) {
					console.error(
						"[LocalModelSettingsSection] onLocalModelDownloaded failed:",
						err,
					);
				}
				new Notice(
					localText(host, "Model downloaded.", "모델이 다운로드되었습니다."),
					5_000,
				);
			},
			onError: (reason) => {
				// reason.code 별로 적합한 i18n 키를 매핑한다 (Requirement 2.6, 2.7, 10.3).
				new Notice(formatDownloadErrorNotice(host, reason), 5_000);
			},
			onCancelled: () => {
				/* no-op — 사용자가 명시적으로 취소했으므로 별도 알림 없음. */
			},
		},
	});
	modal.open();
}

// -----------------------------------------------------------------------------
// 사전 조건 / 검증 헬퍼 (순수 함수)
// -----------------------------------------------------------------------------

/**
 * 다운로드 시작 가능 조건을 한 곳에서 평가한다.
 *
 * 세 조건이 모두 만족되어야 한다:
 * 1. `localModelId` 가 카탈로그의 실재 항목.
 * 2. `modelFolder` 가 OS 절대 경로.
 * 3. `modelDownloadManager` 가 주입되어 있음.
 */
function canStartDownload(host: LocalModelSectionHost): boolean {
	const entry = findCatalogEntry(host.settings.localModelId);
	if (entry === undefined) return false;
	if (!isAbsoluteOSPath(host.settings.modelFolder)) return false;
	if (host.modelDownloadManager === undefined) return false;
	return true;
}

/**
 * 카탈로그에서 id 와 일치하는 항목을 찾는다. 없으면 undefined.
 */
function findCatalogEntry(id: string): LocalModelCatalogEntry | undefined {
	if (id.length === 0) return undefined;
	return LOCAL_MODEL_CATALOG.find((entry) => entry.id === id);
}

/**
 * 모델 폴더 입력의 인라인 검증을 갱신한다.
 *
 * - 빈 문자열: 메시지 비움 (사용자가 막 비웠을 수 있으므로 시끄럽게 굴지 않는다).
 *   단, backendSelectionMode 가 local-only/auto 인 경우는 누락 안내가 별도로 표시되므로
 *   여기서도 빈 메시지를 그대로 둔다 — 누락 검증은 backend mode 의 errorEl 이 담당.
 * - `isAbsoluteOSPath(value)` 가 false: 사유를 빨간 텍스트로 표시.
 * - true: 메시지 비움.
 */
function validateModelFolderInline(
	errorEl: HTMLElement,
	value: string,
	host: LocalModelSectionHost,
): void {
	if (value.length === 0) {
		errorEl.setText("");
		return;
	}
	if (!isAbsoluteOSPath(value)) {
		errorEl.setText(
			localText(
				host,
				"Model folder must be an absolute OS path (e.g. /Users/you/models or C:\\\\models).",
				"모델 폴더는 OS 절대 경로여야 합니다 (예: /Users/you/models 또는 C:\\\\models).",
			),
		);
		return;
	}
	errorEl.setText("");
}

/**
 * `local-only` / `auto` 모드에서 누락 항목(localModelId / modelFolder) 의 인라인 안내.
 *
 * Requirement 1.6 — 누락 항목명을 포함한 메시지를 표시한다.
 */
function updateLocalRequirementsHint(
	errorEl: HTMLElement,
	host: LocalModelSectionHost,
): void {
	const mode = host.settings.backendSelectionMode;
	if (mode !== "local-only" && mode !== "auto") {
		errorEl.setText("");
		return;
	}
	const missing: string[] = [];
	if (host.settings.localModelId.length === 0) {
		missing.push(localText(host, "Local model", "로컬 모델"));
	}
	if (host.settings.modelFolder.length === 0) {
		missing.push(localText(host, "Model folder", "모델 폴더"));
	}
	if (missing.length === 0) {
		errorEl.setText("");
		return;
	}
	errorEl.setText(
		localText(
			host,
			`Missing for ${mode}: ${missing.join(", ")}.`,
			`${mode} 모드에 누락됨: ${missing.join(", ")}.`,
		),
	);
}

// -----------------------------------------------------------------------------
// 공통 유틸 — DOM / 문자열 / 경로
// -----------------------------------------------------------------------------

/**
 * 인라인 에러 메시지용 `<div>` 노드를 부착하고 반환한다.
 *
 * 클래스명은 기존 컨벤션(`transcribe-setting-error`) 을 그대로 사용해 CSS 가 일관되게 적용된다.
 */
function createErrorEl(parentEl: HTMLElement): HTMLElement {
	return parentEl.createDiv({ cls: "transcribe-setting-error" });
}

/**
 * 현재 로케일에 따라 영어/한국어 fallback 을 분기한다.
 *
 * 정식 i18n 키로 표현하기 어려운 짧은 인라인 검증/안내 문구(폴더 형식 오류 안내,
 * 누락 필드 안내, 다운로드 완료 토스트 등) 에 한정하여 사용한다.
 */
function localText(host: LocalModelSectionHost, en: string, ko: string): string {
	return host.settings.uiLocale === "ko" ? ko : en;
}

/**
 * `ModelDownloadError.code` 를 i18n 키와 매핑하여 사용자에게 표시할 Notice 문구를 만든다.
 *
 * - `network`: `notices.downloadFailedNetwork(httpStatus)` — HTTP 상태가 없으면 0 으로 fallback.
 * - `checksum`: `notices.downloadFailedChecksum`.
 * - `disk`: `notices.downloadFailedDisk`.
 * - `disk-low`: `notices.diskSpaceLowDuringDownload(freeMb)` — 다운로드 도중 공간 부족.
 * - `cancelled`: `notices.downloadCancelled` — 사용자가 명시적으로 취소.
 *
 * 어떤 분기에도 들어맞지 않는 경우에는 영어 fallback 으로 짧은 안내를 반환한다.
 */
function formatDownloadErrorNotice(
	host: LocalModelSectionHost,
	reason: ModelDownloadError,
): string {
	const t = host.t.notices;
	switch (reason.code) {
		case "network":
			return t.downloadFailedNetwork(reason.httpStatus ?? 0);
		case "checksum":
			return t.downloadFailedChecksum;
		case "disk":
			return t.downloadFailedDisk;
		case "disk-low":
			return t.diskSpaceLowDuringDownload(reason.freeMb);
		case "cancelled":
			return t.downloadCancelled;
		default:
			// reason 이 위 union 의 모든 case 를 망라하므로 이 분기는 도달 불가지만,
			// 향후 새로운 code 가 추가될 때 명시적인 fallback 을 두어 안전성을 확보한다.
			return localText(
				host,
				"Model download failed.",
				"모델 다운로드에 실패했습니다.",
			);
	}
}

/**
 * URL 의 host 부분을 추출한다. 파싱 실패 시 `huggingface.co` fallback.
 * 모든 카탈로그 항목은 Hugging Face 도메인이므로 안전한 기본값이다.
 */
function extractHost(url: string): string {
	try {
		return new URL(url).host;
	} catch {
		return "huggingface.co";
	}
}

/**
 * OS 별 모델 폴더 기본값을 계산한다 (Requirement 1.5).
 *
 * - macOS: `${HOME}/Library/Application Support/obsidian-transcribe-plugin/models`
 * - Windows: `${APPDATA}/obsidian-transcribe-plugin/models`
 * - Linux: `${HOME}/.local/share/obsidian-transcribe-plugin/models`
 *
 * 환경 변수가 비어 있으면 빈 문자열을 반환한다(prefill 하지 않음).
 *
 * 본 함수는 `process.platform` / `process.env` 만 참조하며 외부 효과를 발생시키지 않는다.
 */
export function computeDefaultModelFolder(): string {
	// `process` 가 정의되지 않은 환경(브라우저 only) 에서도 안전하게 동작.
	const env =
		typeof process !== "undefined" && process.env !== undefined
			? process.env
			: ({} as NodeJS.ProcessEnv);
	const platform =
		typeof process !== "undefined" && typeof process.platform === "string"
			? process.platform
			: "";
	const subdir = "obsidian-transcribe-plugin/models";

	if (platform === "darwin") {
		const home = env.HOME ?? "";
		if (home.length === 0) return "";
		return `${home}/Library/Application Support/${subdir}`;
	}
	if (platform === "win32") {
		const appdata = env.APPDATA ?? "";
		if (appdata.length === 0) return "";
		// Windows 도 forward slash 를 인식하므로 일관성을 위해 통일.
		return `${appdata.replace(/\\/g, "/")}/${subdir}`;
	}
	// Linux / 기타 — XDG 기본 경로.
	const home = env.HOME ?? "";
	if (home.length === 0) return "";
	return `${home}/.local/share/${subdir}`;
}
