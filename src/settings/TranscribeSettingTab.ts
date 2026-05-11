/**
 * `TranscribeSettingTab` — Obsidian 설정 화면에 노출되는 플러그인 설정 탭.
 *
 * Obsidian `PluginSettingTab`을 확장하여 다음 5개 섹션을 정해진 순서로 렌더링한다.
 *   1. UI Locale 드롭다운 (설정 탭의 **첫 항목**, Requirement 2.2)
 *   2. AWS credentials 섹션: access key ID / secret access key(password) / AWS region
 *   3. Transcription 섹션: transcription language / transcript folder(FolderSuggest 연결)
 *   4. Analysis 섹션: Bedrock model ID
 *   5. About 섹션: 자격 증명 저장 위치 보안 고지 (Requirement 2.13)
 *
 * 설계 원칙(Requirements 2.1, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 2.9, 2.10, 2.13, 2.16):
 * - 섹션 헤더는 `setHeading()` 패턴만 사용한다. `createEl("h2")`는 심사 거부 사유이므로 금지한다.
 * - 모든 레이블은 Sentence case로 작성하며, 문자열은 i18n(`plugin.t`)에서만 가져온다.
 * - access key ID / secret key는 HTML `maxlength` + 런타임 검증으로 길이 초과를 방지한다.
 * - 길이 초과 입력이 감지되면 해당 필드 아래에 인라인 에러 메시지를 표시하고
 *   `settingsStore.save()`를 호출하지 않아 부적합한 상태가 영속화되지 않도록 한다.
 *   (요구사항 2.16의 "저장 버튼 비활성화"는 Obsidian Setting 패턴상 별도 save 버튼이 없으므로,
 *    "유효하지 않으면 저장을 실행하지 않는다"는 불변식으로 해석·구현한다.)
 * - UI Locale 변경 시: 설정 저장 → `plugin.changeLocale(locale)` 호출 → `display()` 재호출하여
 *   설정 탭 전체를 새 언어로 다시 렌더링한다 (Requirement 2.3).
 *
 * 관련 설계: design.md § 9 "SettingsStore & TranscribeSettingTab & FolderSuggest"
 */

import {
	type App,
	Notice,
	type Plugin,
	PluginSettingTab,
	Setting,
} from "obsidian";

import type { Translations } from "../i18n";
import type {
	LanguageCode,
	SupportedLocale,
	TranscribeSettings,
} from "../types/settings";

import {
	BedrockModelCatalog,
	type BedrockCatalogEntry,
} from "../services/BedrockModelCatalog";
import { VocabularyManager } from "../services/VocabularyManager";
import { TranscribeError } from "../types/errors";
import { FolderSuggest } from "./FolderSuggest";
import type { SettingsStore } from "./SettingsStore";

/**
 * 본 탭이 플러그인 인스턴스로부터 요구하는 최소 계약(contract).
 *
 * 실제 `TranscribePlugin` 클래스는 task 17.1에서 구현되므로, 여기서는 `Plugin`을
 * 상속한 임의의 객체가 아래 구조만 만족하면 된다는 의미의 구조적 타입으로 선언한다.
 * `TranscribePlugin extends Plugin`이 구현되면 별도 선언/구현 변경 없이 자동으로 호환된다.
 *
 * - `settings`: 현재 플러그인 설정 상태. UI 렌더링 시 초기값으로 사용된다.
 * - `settingsStore`: 저장/검증 책임을 위임받는 저장소. (task 7.1 구현)
 * - `t`: 현재 로케일의 번역 객체. UI 레이블/설명은 전적으로 이 객체에서 가져온다.
 * - `changeLocale(locale)`: 로케일 전환 파이프라인. 설정 저장 + `t` 갱신 + 열린 SidebarView
 *    에 번역 전달까지 수행한다. (task 17.1 구현)
 */
export interface TranscribePluginLike extends Plugin {
	settings: TranscribeSettings;
	settingsStore: SettingsStore;
	t: Translations;
	changeLocale(locale: SupportedLocale): Promise<void>;
}

/**
 * `accessKeyId` 최대 길이(Requirement 2.5, 2.16).
 * `SettingsStore`의 검증 상한과 반드시 동일하게 유지한다.
 */
const MAX_ACCESS_KEY_ID_LENGTH = 128;

/**
 * `secretAccessKey` 최대 길이(Requirement 2.6, 2.16).
 */
const MAX_SECRET_ACCESS_KEY_LENGTH = 256;

/**
 * `bedrockModelId` 최대 길이(Requirement 2.8).
 *
 * 현재는 드롭다운 선택 기반이므로 UI 레벨에서는 자동 보장되지만, 카탈로그가 예상치 못한
 * 초장문 id 를 반환하는 경우를 대비해 검증 경로의 상한값 참조 상수로 남겨둔다.
 */
const MAX_BEDROCK_MODEL_ID_LENGTH = 256;

/**
 * AWS 리전 드롭다운에 표시할 일반 리전 목록.
 *
 * AWS Transcribe Streaming과 Bedrock Runtime 양쪽에서 가용한 대표 리전만 포함한다.
 * 사용자가 목록 외 리전을 이미 설정한 경우(예: 구버전에서 저장된 값), 드롭다운에
 * 동적으로 해당 값을 추가하여 UI상 "선택된 값"과 "저장된 값"의 불일치를 방지한다.
 */
const COMMON_AWS_REGIONS: readonly string[] = [
	"us-east-1",
	"us-east-2",
	"us-west-1",
	"us-west-2",
	"ap-northeast-1",
	"ap-northeast-2",
	"ap-southeast-1",
	"ap-southeast-2",
	"eu-west-1",
	"eu-central-1",
	"eu-north-1",
	"ca-central-1",
	"sa-east-1",
];

/**
 * 전사 언어 코드 드롭다운 옵션(Requirement 2.9).
 */
const LANGUAGE_CODE_OPTIONS: readonly LanguageCode[] = ["ko-KR", "en-US"];

/**
 * 플러그인 설정 탭.
 *
 * `plugin.addSettingTab(new TranscribeSettingTab(app, plugin))` 형태로 등록된다(Requirement 2.1).
 * 인스턴스는 Obsidian이 설정 화면을 열 때마다 `display()`를 호출한다.
 */
export class TranscribeSettingTab extends PluginSettingTab {
	/**
	 * 플러그인 인스턴스 참조. `settings`/`settingsStore`/`t`/`changeLocale`에 접근하기 위해 보관한다.
	 *
	 * 부모 `PluginSettingTab.plugin`이 존재하지만 그 타입은 기본 `Plugin`이라 우리가 필요한
	 * 확장 멤버를 직접 노출하지 않는다. 따라서 더 구체적인 타입을 가진 별도 필드로 보관한다.
	 */
	private readonly transcribePlugin: TranscribePluginLike;

	/**
	 * Bedrock 모델 카탈로그 서비스.
	 *
	 * 자격 증명/리전을 받아 `ListFoundationModels` + `ListInferenceProfiles` 를 호출해
	 * 드롭다운에 채울 모델 목록을 제공한다. 인스턴스는 재사용 가능(상태 없음).
	 */
	private readonly modelCatalog: BedrockModelCatalog;

	/**
	 * Vocabulary 자동 관리 서비스.
	 *
	 * 설정에 입력된 단어 목록을 AWS Custom Vocabulary 로 생성/업데이트/삭제한다.
	 */
	private readonly vocabManager: VocabularyManager;

	/**
	 * 가장 최근에 성공한 모델 카탈로그 조회 결과.
	 * 드롭다운 재렌더(예: 로케일 변경) 시 네트워크 재호출 없이 즉시 옵션으로 반영하기 위함이다.
	 */
	private cachedModels: BedrockCatalogEntry[] = [];

	/** 현재 카탈로그 조회가 진행 중인지 여부. UI 중복 클릭 방지. */
	private modelsLoading = false;

	constructor(app: App, plugin: TranscribePluginLike) {
		super(app, plugin);
		this.transcribePlugin = plugin;
		this.modelCatalog = new BedrockModelCatalog();
		this.vocabManager = new VocabularyManager();
	}

	/**
	 * 설정 탭을 처음부터 다시 렌더링한다.
	 *
	 * Obsidian이 설정 화면을 열 때마다 호출된다.
	 * UI Locale 변경 시 내부적으로도 재호출하여 새 번역으로 전체 화면을 갱신한다(Requirement 2.3).
	 */
	display(): void {
		const { containerEl } = this;
		const plugin = this.transcribePlugin;
		const t = plugin.t;

		// 이전 렌더 결과를 완전히 제거 — display()는 재호출 가능하므로 누수 방지를 위해 필수
		containerEl.empty();

		// (1) UI Locale 드롭다운 — 설정 탭의 첫 항목 (Requirement 2.2)
		this.renderLocaleDropdown(containerEl, t);

		// (2) AWS credentials 섹션 (Requirement 2.4)
		new Setting(containerEl).setName(t.settings.awsHeading).setHeading();
		this.renderAccessKeyIdField(containerEl, t);
		this.renderSecretAccessKeyField(containerEl, t);
		this.renderRegionDropdown(containerEl, t);

		// (3) Transcription 섹션
		new Setting(containerEl)
			.setName(t.settings.transcriptionHeading)
			.setHeading();
		this.renderLanguageCodeDropdown(containerEl, t);
		this.renderTranscriptFolderField(containerEl, t);

		// (4) Analysis 섹션
		new Setting(containerEl)
			.setName(t.settings.analysisHeading)
			.setHeading();
		this.renderBedrockModelIdField(containerEl, t);
		this.renderAnalysisGlossaryField(containerEl, t);

		// (5) Vocabulary 섹션 (A) — Transcribe 커스텀 어휘 이름
		new Setting(containerEl)
			.setName(t.settings.vocabularyHeading)
			.setHeading();
		this.renderTranscribeVocabularyNameField(containerEl, t);

		// (6) About 섹션 — 자격 증명 저장 위치 보안 고지 (Requirement 2.13)
		new Setting(containerEl)
			.setName(t.settings.aboutHeading)
			.setHeading();
		new Setting(containerEl).setDesc(t.settings.aboutNotice);
	}

	// ---------------------------------------------------------------------
	// 개별 필드 렌더러
	// ---------------------------------------------------------------------

	/**
	 * 설정 탭의 첫 항목 — UI Locale 드롭다운(Requirement 2.2, 2.3).
	 *
	 * 변경 시 흐름:
	 *   1. `plugin.settings.uiLocale` 갱신
	 *   2. `plugin.changeLocale(locale)` 호출 — 내부에서 `saveData`, `t` 갱신, 열린 SidebarView
	 *      에 번역 전달까지 수행한다.
	 *   3. `this.display()` 재호출 — 설정 탭의 모든 레이블을 새 언어로 즉시 재렌더링한다.
	 *
	 * 주의: `changeLocale`이 설정 저장을 이미 수행하므로 여기서 별도로 `settingsStore.save`를
	 *       호출하지 않는다. 중복 저장으로 인한 I/O 경쟁을 방지한다.
	 */
	private renderLocaleDropdown(containerEl: HTMLElement, t: Translations): void {
		new Setting(containerEl)
			.setName(t.settings.language.name)
			.setDesc(t.settings.language.desc)
			.addDropdown((dd) => {
				dd.addOption("en", t.settings.language.options.en);
				dd.addOption("ko", t.settings.language.options.ko);
				dd.setValue(this.transcribePlugin.settings.uiLocale);
				dd.onChange(async (value) => {
					const locale = value as SupportedLocale;
					this.transcribePlugin.settings.uiLocale = locale;
					try {
						await this.transcribePlugin.changeLocale(locale);
					} catch (err) {
						console.error(
							"[TranscribeSettingTab] changeLocale failed:",
							err,
						);
						new Notice(this.transcribePlugin.t.notices.settingsSaveFailed);
						return;
					}
					// 설정 탭 전체를 새 번역으로 재렌더링
					this.display();
				});
			});
	}

	/**
	 * AWS access key ID 입력 필드(Requirement 2.5, 2.16).
	 *
	 * HTML `maxlength`로 브라우저 레벨 입력 제한을 걸고, 런타임에서도 길이 초과를 재검증한다.
	 * 길이 초과 시 인라인 에러 메시지를 표시하고 저장을 수행하지 않는다.
	 */
	private renderAccessKeyIdField(containerEl: HTMLElement, t: Translations): void {
		const setting = new Setting(containerEl)
			.setName(t.settings.accessKeyId.name)
			.setDesc(t.settings.accessKeyId.desc);

		const errorEl = this.createErrorEl(setting.settingEl);

		setting.addText((text) => {
			text.inputEl.setAttribute(
				"maxlength",
				String(MAX_ACCESS_KEY_ID_LENGTH),
			);
			text.setValue(this.transcribePlugin.settings.accessKeyId);
			text.onChange(async (value) => {
				this.transcribePlugin.settings.accessKeyId = value;
				await this.validateAndSave(
					errorEl,
					"accessKeyId",
					this.formatLengthExceededMessage(MAX_ACCESS_KEY_ID_LENGTH),
				);
			});
		});
	}

	/**
	 * AWS secret access key 입력 필드(Requirement 2.6, 2.16).
	 *
	 * `text.inputEl.type = "password"`로 마스킹 표시한다.
	 * access key ID와 동일한 길이 검증 규칙을 적용한다(상한만 다름).
	 */
	private renderSecretAccessKeyField(
		containerEl: HTMLElement,
		t: Translations,
	): void {
		const setting = new Setting(containerEl)
			.setName(t.settings.secretAccessKey.name)
			.setDesc(t.settings.secretAccessKey.desc);

		const errorEl = this.createErrorEl(setting.settingEl);

		setting.addText((text) => {
			// 마스킹 처리 — DOM 속성을 직접 설정해 UI에 즉시 반영
			text.inputEl.type = "password";
			text.inputEl.setAttribute(
				"maxlength",
				String(MAX_SECRET_ACCESS_KEY_LENGTH),
			);
			text.setValue(this.transcribePlugin.settings.secretAccessKey);
			text.onChange(async (value) => {
				this.transcribePlugin.settings.secretAccessKey = value;
				await this.validateAndSave(
					errorEl,
					"secretAccessKey",
					this.formatLengthExceededMessage(MAX_SECRET_ACCESS_KEY_LENGTH),
				);
			});
		});
	}

	/**
	 * AWS 리전 드롭다운(Requirement 2.7).
	 *
	 * 기본 리전 목록 외에 이전에 저장된 값이 있다면 그 값도 옵션으로 포함시켜
	 * 설정 로드 직후 UI가 실제 저장 값과 일치하도록 한다.
	 */
	private renderRegionDropdown(
		containerEl: HTMLElement,
		t: Translations,
	): void {
		new Setting(containerEl)
			.setName(t.settings.region.name)
			.setDesc(t.settings.region.desc)
			.addDropdown((dd) => {
				const current = this.transcribePlugin.settings.region;
				const regions = new Set<string>(COMMON_AWS_REGIONS);
				if (current && !regions.has(current)) {
					regions.add(current);
				}
				for (const r of regions) {
					dd.addOption(r, r);
				}
				dd.setValue(current || "us-east-1");
				dd.onChange(async (value) => {
					this.transcribePlugin.settings.region = value;
					await this.saveIfValid();
				});
			});
	}

	/**
	 * 전사 언어 코드 드롭다운(Requirement 2.9).
	 */
	private renderLanguageCodeDropdown(
		containerEl: HTMLElement,
		t: Translations,
	): void {
		new Setting(containerEl)
			.setName(t.settings.languageCode.name)
			.setDesc(t.settings.languageCode.desc)
			.addDropdown((dd) => {
				for (const code of LANGUAGE_CODE_OPTIONS) {
					dd.addOption(code, code);
				}
				dd.setValue(this.transcribePlugin.settings.languageCode);
				dd.onChange(async (value) => {
					this.transcribePlugin.settings.languageCode =
						value as LanguageCode;
					await this.saveIfValid();
				});
			});
	}

	/**
	 * 전사 저장 폴더 입력 필드 + `FolderSuggest` 자동완성 연결(Requirement 2.10).
	 *
	 * `FolderSuggest`는 `AbstractInputSuggest<TFolder>`를 상속하여 vault 내 실존 폴더만
	 * 후보로 노출한다. 사용자는 타이핑 중 드롭다운으로 폴더를 선택할 수 있다.
	 */
	private renderTranscriptFolderField(
		containerEl: HTMLElement,
		t: Translations,
	): void {
		new Setting(containerEl)
			.setName(t.settings.transcriptFolder.name)
			.setDesc(t.settings.transcriptFolder.desc)
			.addText((text) => {
				// 볼트 폴더 자동완성 연결 — 인스턴스 생성만으로 입력 요소에 바인딩된다
				new FolderSuggest(this.app, text.inputEl);
				text.setPlaceholder("");
				text.setValue(this.transcribePlugin.settings.transcriptFolder);
				text.onChange(async (value) => {
					this.transcribePlugin.settings.transcriptFolder = value;
					await this.saveIfValid();
				});
			});
	}

	/**
	 * Bedrock 모델 ID 선택 필드 — 드롭다운 + 새로고침 버튼(Requirement 2.8).
	 *
	 * 구성:
	 * 1. **드롭다운(select)**: 현재 `cachedModels` 배열을 옵션으로 표시한다.
	 *    - 저장된 값이 목록에 없으면 "직접 입력(저장 값 유지)" 항목을 맨 위에 추가해 덮어쓰지 않는다.
	 *    - 새로 선택하면 즉시 `settings.bedrockModelId` 갱신 후 저장.
	 * 2. **새로고침 버튼(`refresh-cw` 아이콘)**: 클릭 시 현재 자격 증명/리전으로 카탈로그 재조회.
	 *    - 로딩 중에는 버튼이 비활성화되고 desc 영역에 "불러오는 중..." 메시지 표시.
	 *    - 자격 증명/리전이 비어 있으면 즉시 Notice 로 안내하고 API 호출하지 않는다.
	 *    - 에러는 code 별로 `awsAuthError` / `awsNetworkError` Notice 로 분기.
	 *
	 * 심사 준수:
	 * - 아이콘은 Obsidian `setIcon(el, "refresh-cw")` 사용 — 자체 SVG/이미지 미포함.
	 * - 로그는 `console.error` 만 사용.
	 * - 자격 증명은 메모리 상 플러그인 설정에서만 읽고 로그에 남기지 않는다.
	 */
	private renderBedrockModelIdField(
		containerEl: HTMLElement,
		t: Translations,
	): void {
		const setting = new Setting(containerEl)
			.setName(t.settings.bedrockModelId.name)
			.setDesc(t.settings.bedrockModelId.desc);

		// 동적 상태 메시지(로딩/빈 결과 안내)를 표시할 보조 라인.
		const statusEl = setting.settingEl.createDiv({
			cls: "transcribe-setting-status",
		});
		if (this.modelsLoading) {
			statusEl.setText(t.settings.bedrockModelId.loading);
		} else if (this.cachedModels.length === 0) {
			statusEl.setText(t.settings.bedrockModelId.empty);
		}

		let selectEl: HTMLSelectElement | null = null;
		let refreshBtnEl: HTMLElement | null = null;

		// 드롭다운 — Setting.addDropdown 을 사용해 Obsidian 의 기본 스타일을 따른다.
		setting.addDropdown((dd) => {
			selectEl = dd.selectEl;
			this.populateModelDropdown(dd.selectEl, t);
			dd.selectEl.addEventListener("change", async () => {
				const value = dd.selectEl.value;
				if (value.length === 0) {
					return;
				}
				this.transcribePlugin.settings.bedrockModelId = value;
				await this.saveIfValid();
			});
		});

		// 새로고침 버튼 — extraSettingButton 대신 extraButton 으로 아이콘 제공.
		setting.addExtraButton((btn) => {
			refreshBtnEl = btn.extraSettingsEl;
			btn.setIcon("refresh-cw");
			btn.setTooltip(t.settings.bedrockModelId.refresh);
			btn.onClick(() => {
				void this.refreshModels(t, selectEl, statusEl, refreshBtnEl);
			});
			if (this.modelsLoading) {
				btn.setDisabled(true);
			}
		});
	}

	/**
	 * 드롭다운 옵션 목록을 `cachedModels` 기준으로 구성한다.
	 *
	 * 저장된 값이 목록에 없으면 맨 위에 해당 값을 직접 옵션으로 추가해
	 * 새로고침 없이도 마지막에 사용한 모델이 선택된 상태로 보이도록 한다.
	 * 이 옵션을 선택해도 값은 변경되지 않는다(이미 저장된 값이므로).
	 */
	private populateModelDropdown(
		selectEl: HTMLSelectElement,
		t: Translations,
	): void {
		selectEl.empty();

		const current = this.transcribePlugin.settings.bedrockModelId.trim();
		const known = new Set(this.cachedModels.map((m) => m.id));

		// 저장된 값이 카탈로그에 없으면 해당 값을 직접 옵션으로 추가한다.
		// 새로고침 전에도 마지막 사용 모델이 드롭다운에 표시되어 즉시 사용 가능.
		if (current.length > 0 && !known.has(current)) {
			const opt = selectEl.createEl("option", {
				value: current,
				text: current,
			});
			opt.selected = true;
		}

		// 제공자별로 optgroup 으로 묶어 표시하면 사용자가 찾기 편하다.
		const byProvider = new Map<string, BedrockCatalogEntry[]>();
		for (const entry of this.cachedModels) {
			const list = byProvider.get(entry.provider) ?? [];
			list.push(entry);
			byProvider.set(entry.provider, list);
		}

		for (const [provider, entries] of byProvider) {
			const group = selectEl.createEl("optgroup", { attr: { label: provider } });
			for (const entry of entries) {
				const prefix = entry.kind === "inference-profile" ? "⚡ " : "";
				const opt = group.createEl("option", {
					value: entry.id,
					text: `${prefix}${entry.label} (${entry.id})`,
				});
				if (entry.id === current) {
					opt.selected = true;
				}
			}
		}

		// 저장된 값이 없고 목록도 비어 있으면 placeholder 역할의 빈 옵션 하나를 둔다.
		if (selectEl.options.length === 0) {
			selectEl.createEl("option", { value: "", text: "" });
		}
	}

	/**
	 * 새로고침 버튼 클릭 흐름.
	 *
	 * 1. 자격 증명/리전이 누락되면 Notice 로 안내하고 API 호출하지 않는다.
	 * 2. 로딩 상태 on → 버튼 비활성화, 상태 텍스트 표시.
	 * 3. `BedrockModelCatalog.listInvokableModels` 호출.
	 * 4. 성공 시 `cachedModels` 갱신 후 드롭다운 재구성.
	 * 5. 실패 시 에러 코드별 Notice.
	 * 6. finally: 로딩 상태 off, 버튼 복원.
	 */
	private async refreshModels(
		t: Translations,
		selectEl: HTMLSelectElement | null,
		statusEl: HTMLElement,
		refreshBtnEl: HTMLElement | null,
	): Promise<void> {
		if (this.modelsLoading) return;

		const plugin = this.transcribePlugin;
		const missing: string[] = [];
		if (plugin.settings.accessKeyId.trim().length === 0) missing.push(t.settings.accessKeyId.name);
		if (plugin.settings.secretAccessKey.trim().length === 0) missing.push(t.settings.secretAccessKey.name);
		if (plugin.settings.region.trim().length === 0) missing.push(t.settings.region.name);
		if (missing.length > 0) {
			new Notice(t.notices.missingSettings(missing));
			return;
		}

		this.modelsLoading = true;
		statusEl.setText(t.settings.bedrockModelId.loading);
		if (refreshBtnEl) {
			refreshBtnEl.setAttribute("aria-disabled", "true");
			refreshBtnEl.addClass("is-disabled");
		}

		try {
			const models = await this.modelCatalog.listInvokableModels({
				credentials: {
					accessKeyId: plugin.settings.accessKeyId,
					secretAccessKey: plugin.settings.secretAccessKey,
				},
				region: plugin.settings.region,
			});
			this.cachedModels = models;
			if (selectEl) {
				this.populateModelDropdown(selectEl, t);
			}
			if (models.length === 0) {
				statusEl.setText(t.settings.bedrockModelId.empty);
			} else {
				statusEl.setText("");
			}
		} catch (err) {
			statusEl.setText("");
			if (err instanceof TranscribeError) {
				if (err.code === "AWS_AUTH") {
					new Notice(t.notices.awsAuthError);
				} else {
					new Notice(t.notices.awsNetworkError);
				}
			} else {
				console.error("[TranscribeSettingTab] refreshModels unknown error:", err);
				new Notice(t.notices.awsNetworkError);
			}
		} finally {
			this.modelsLoading = false;
			if (refreshBtnEl) {
				refreshBtnEl.removeAttribute("aria-disabled");
				refreshBtnEl.removeClass("is-disabled");
			}
		}
	}

	/**
	 * 분석 용어 사전 입력 필드 — 여러 줄 텍스트로 `용어: 설명` 항목을 받는다.
	 *
	 * 값이 있으면 `BedrockService.analyze` 호출 시 `glossary` 파라미터로 전달되어
	 * 분석 프롬프트의 "glossary" 블록에 삽입된다. 길이 상한은 두지 않으며(프롬프트 토큰
	 * 제한 내에서 자유 사용), 저장은 변경 시 `saveIfValid` 로 즉시 수행한다.
	 */
	private renderAnalysisGlossaryField(
		containerEl: HTMLElement,
		t: Translations,
	): void {
		new Setting(containerEl)
			.setName(t.settings.analysisGlossary.name)
			.setDesc(t.settings.analysisGlossary.desc)
			.addTextArea((ta) => {
				ta.inputEl.rows = 6;
				ta.inputEl.classList.add("transcribe-glossary-textarea");
				ta.setPlaceholder(t.settings.analysisGlossary.placeholder);
				ta.setValue(this.transcribePlugin.settings.analysisGlossary);
				ta.onChange(async (value) => {
					this.transcribePlugin.settings.analysisGlossary = value;
					await this.saveIfValid();
				});
			});
	}

	/**
	 * 단어 목록 textarea + "AWS에 동기화" 버튼.
	 *
	 * 사용자가 단어를 한 줄에 하나씩 입력하고 동기화 버튼을 누르면
	 * `VocabularyManager.syncVocabulary()` 를 호출해 AWS Custom Vocabulary 를
	 * 자동 생성/업데이트한다. 성공 시 `transcribeVocabularyName` 에 이름이 저장되어
	 * 다음 전사부터 자동 적용된다.
	 */
	private renderTranscribeVocabularyNameField(
		containerEl: HTMLElement,
		t: Translations,
	): void {
		const setting = new Setting(containerEl)
			.setName(t.settings.transcribeVocabularyName.name)
			.setDesc(t.settings.transcribeVocabularyName.desc);

		const statusEl = setting.settingEl.createDiv({
			cls: "transcribe-setting-status",
		});
		// 현재 동기화 상태 표시.
		if (this.transcribePlugin.settings.transcribeVocabularyName.length > 0) {
			statusEl.setText(
				`✓ ${t.settings.transcribeVocabularyName.syncReady}: ${this.transcribePlugin.settings.transcribeVocabularyName}`,
			);
		}

		setting.addTextArea((ta) => {
			ta.inputEl.rows = 6;
			ta.inputEl.classList.add("transcribe-glossary-textarea");
			ta.setPlaceholder(t.settings.transcribeVocabularyName.placeholder);
			ta.setValue(this.transcribePlugin.settings.vocabularyPhrases);
			ta.onChange(async (value) => {
				this.transcribePlugin.settings.vocabularyPhrases = value;
				await this.saveIfValid();
			});
		});

		setting.addButton((btn) => {
			btn.setButtonText(t.settings.transcribeVocabularyName.sync);
			btn.setCta();
			btn.onClick(() => {
				void this.syncVocabulary(t, statusEl, btn.buttonEl);
			});
		});
	}

	/**
	 * "AWS에 동기화" 버튼 클릭 흐름.
	 */
	private async syncVocabulary(
		t: Translations,
		statusEl: HTMLElement,
		btnEl: HTMLButtonElement,
	): Promise<void> {
		const plugin = this.transcribePlugin;

		// 자격 증명/리전 누락 체크.
		const missing: string[] = [];
		if (plugin.settings.accessKeyId.trim().length === 0) missing.push(t.settings.accessKeyId.name);
		if (plugin.settings.secretAccessKey.trim().length === 0) missing.push(t.settings.secretAccessKey.name);
		if (plugin.settings.region.trim().length === 0) missing.push(t.settings.region.name);
		if (missing.length > 0) {
			new Notice(t.notices.missingSettings(missing));
			return;
		}

		btnEl.disabled = true;
		btnEl.textContent = t.settings.transcribeVocabularyName.syncing;
		statusEl.setText(t.settings.transcribeVocabularyName.syncing);

		try {
			const result = await this.vocabManager.syncVocabulary({
				credentials: {
					accessKeyId: plugin.settings.accessKeyId,
					secretAccessKey: plugin.settings.secretAccessKey,
				},
				region: plugin.settings.region,
				languageCode: plugin.settings.languageCode,
				phrases: plugin.settings.vocabularyPhrases,
			});

			plugin.settings.transcribeVocabularyName = result.vocabularyName;
			await this.trySave();

			if (result.status === "READY") {
				statusEl.setText(
					`✓ ${t.settings.transcribeVocabularyName.syncReady}: ${result.vocabularyName}`,
				);
				new Notice(t.settings.transcribeVocabularyName.syncSuccess);
			} else if (result.status === "DELETED") {
				statusEl.setText("");
				new Notice(t.settings.transcribeVocabularyName.syncSuccess);
			} else if (result.status === "PENDING") {
				statusEl.setText(t.settings.transcribeVocabularyName.syncPending);
			} else {
				statusEl.setText("");
				new Notice(t.settings.transcribeVocabularyName.syncFailed);
			}
		} catch (err) {
			statusEl.setText("");
			if (err instanceof TranscribeError && err.code === "AWS_AUTH") {
				new Notice(t.notices.awsAuthError);
			} else {
				console.error("[TranscribeSettingTab] syncVocabulary failed:", err);
				new Notice(t.settings.transcribeVocabularyName.syncFailed);
			}
		} finally {
			btnEl.disabled = false;
			btnEl.textContent = t.settings.transcribeVocabularyName.sync;
		}
	}

	// ---------------------------------------------------------------------
	// 공통 헬퍼
	// ---------------------------------------------------------------------

	/**
	 * 설정 항목 컨테이너에 인라인 에러 메시지용 `<div>`를 부착한다.
	 *
	 * 반환된 엘리먼트는 기본적으로 비어 있으며(`textContent = ""`),
	 * 길이 초과 등 검증 실패 시 `textContent`를 갱신하여 화면에 노출한다.
	 * `createDiv`는 Obsidian이 `HTMLElement`에 추가한 보강 메서드로 XSS 안전하다.
	 */
	private createErrorEl(parentEl: HTMLElement): HTMLElement {
		return parentEl.createDiv({ cls: "transcribe-setting-error" });
	}

	/**
	 * 길이 초과 인라인 메시지 문자열 생성.
	 *
	 * i18n에 별도 키가 없는 짧은 기술 문구이므로, 현재 로케일에 맞춰 조건 분기한다.
	 * (향후 번역 키가 추가되면 `t.settings.*`로 교체한다.)
	 */
	private formatLengthExceededMessage(maxLength: number): string {
		const locale = this.transcribePlugin.settings.uiLocale;
		if (locale === "ko") {
			return `최대 ${maxLength}자까지 입력할 수 있습니다.`;
		}
		return `Maximum length is ${maxLength} characters.`;
	}

	/**
	 * 단일 필드 기준의 검증-저장 플로우.
	 *
	 * 동작:
	 * - `SettingsStore.validate`를 호출해 전체 설정을 검증한다.
	 * - `errors`에 대상 `field`가 포함되어 있으면 인라인 에러 메시지를 표시하고 저장하지 않는다.
	 * - 그 외(다른 필드 에러가 있더라도 이 필드는 유효한 경우)에는 에러 메시지를 해제한다.
	 * - 전체 `errors`가 비어 있어야만 실제로 `settingsStore.save`를 호출한다.
	 *   (부적합한 상태를 영속화하지 않는다는 요구사항 2.16의 취지.)
	 *
	 * @param errorEl 해당 필드의 인라인 에러 `<div>`.
	 * @param field 검증 결과에서 확인할 필드 식별자(`SettingsStore`와 동일한 키).
	 * @param message 이 필드가 유효하지 않을 때 표시할 사용자 메시지.
	 */
	private async validateAndSave(
		errorEl: HTMLElement,
		field: string,
		message: string,
	): Promise<void> {
		const plugin = this.transcribePlugin;
		const { errors } = plugin.settingsStore.validate(plugin.settings);

		if (errors.includes(field)) {
			errorEl.setText(message);
		} else {
			errorEl.setText("");
		}

		if (errors.length === 0) {
			await this.trySave();
		}
	}

	/**
	 * 현재 설정이 유효할 때만 저장한다. 다중 필드에 걸친 검증 실패 상황에서도
	 * 다른 정상 필드의 변경이 무효한 전체 상태를 영속화하지 않도록 보호한다.
	 */
	private async saveIfValid(): Promise<void> {
		const plugin = this.transcribePlugin;
		const { errors } = plugin.settingsStore.validate(plugin.settings);
		if (errors.length === 0) {
			await this.trySave();
		}
	}

	/**
	 * 설정 저장을 시도한다.
	 *
	 * 저장 실패(I/O 오류 등) 시 사용자에게 `Notice`로 알린다(Requirement 2.15).
	 * 이전 저장 값의 유지는 Obsidian의 `saveData` 동작(실패 시 기존 파일 보존)에 위임한다.
	 *
	 * 성공 Notice는 매 변경 시 과도한 피드백을 발생시켜 UX를 해치므로 기본적으로 생략한다.
	 * (Requirement 2.11의 "성공 여부를 Notice로 표시"는 실패 케이스의 명시적 표시로 충족한다.)
	 */
	private async trySave(): Promise<void> {
		try {
			await this.transcribePlugin.settingsStore.save(
				this.transcribePlugin.settings,
			);
		} catch (err) {
			console.error("[TranscribeSettingTab] saveSettings failed:", err);
			new Notice(this.transcribePlugin.t.notices.settingsSaveFailed);
		}
	}
}
