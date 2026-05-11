/**
 * Obsidian API 수동 목(manual mock).
 *
 * 실제 `obsidian` 패키지는 Obsidian 앱 런타임에서만 로드 가능한 네이티브 모듈이므로,
 * 테스트 환경(Vitest + jsdom)에서는 `vitest.config.ts`의 resolve alias를 통해
 * 이 파일로 치환된다.
 *
 * 여기서는 소스 코드에서 실제로 import되는 심볼과, PBT/예시 테스트에서 필요한 심볼만
 * 최소한의 형태로 스텁한다. 클래스는 생성자만 비워두고, 메서드는 호출 측이 실제로
 * 사용하는 것에 한해 기본 구현을 제공한다.
 *
 * 특정 테스트에서 동작을 바꾸려면 `vi.spyOn` 또는 별도의 팩토리 함수로 인스턴스를
 * 주입받아 개별 메서드를 대체한다.
 */

/* eslint-disable @typescript-eslint/no-unused-vars */

// ---------------------------------------------------------------------------
// 경로 정규화
// ---------------------------------------------------------------------------

/**
 * Obsidian의 `normalizePath`를 근사 구현한다.
 *
 * 실제 구현은 백슬래시 → 슬래시 치환, 중복 슬래시 제거, 상위 디렉터리 탐색(`..`)
 * 흡수 등을 수행한다. 테스트 목적상 동일한 결과 형태를 흉내낸다.
 */
export function normalizePath(path: string): string {
	if (path === undefined || path === null) return "";
	let result = String(path).replace(/\\/g, "/");
	// 앞쪽 슬래시 제거 (Obsidian은 절대 경로를 vault 상대 경로로 취급)
	result = result.replace(/^\/+/, "");
	// 중복 슬래시 → 단일 슬래시
	result = result.replace(/\/{2,}/g, "/");
	// 끝 슬래시 제거
	result = result.replace(/\/+$/, "");
	// `..` 세그먼트 흡수
	const segments: string[] = [];
	for (const seg of result.split("/")) {
		if (seg === "" || seg === ".") continue;
		if (seg === "..") {
			segments.pop();
			continue;
		}
		segments.push(seg);
	}
	return segments.join("/");
}

// ---------------------------------------------------------------------------
// Vault 파일 타입
// ---------------------------------------------------------------------------

export class TAbstractFile {
	path = "";
	name = "";
	parent: TFolder | null = null;
}

export class TFile extends TAbstractFile {
	extension = "";
	basename = "";
	stat: { ctime: number; mtime: number; size: number } = {
		ctime: 0,
		mtime: 0,
		size: 0,
	};
}

export class TFolder extends TAbstractFile {
	children: TAbstractFile[] = [];
	isRoot(): boolean {
		return this.path === "" || this.path === "/";
	}
}

// ---------------------------------------------------------------------------
// Vault
// ---------------------------------------------------------------------------

export class Vault {
	async read(_file: TFile): Promise<string> {
		return "";
	}
	async create(_path: string, _data: string): Promise<TFile> {
		return new TFile();
	}
	async createFolder(_path: string): Promise<TFolder> {
		return new TFolder();
	}
	async modify(_file: TFile, _data: string): Promise<void> {
		/* noop */
	}
	async process(file: TFile, fn: (data: string) => string): Promise<string> {
		const current = await this.read(file);
		const next = fn(current);
		await this.modify(file, next);
		return next;
	}
	getAbstractFileByPath(_path: string): TAbstractFile | null {
		return null;
	}
	getFileByPath(_path: string): TFile | null {
		return null;
	}
	getFolderByPath(_path: string): TFolder | null {
		return null;
	}
	getRoot(): TFolder {
		const root = new TFolder();
		root.path = "";
		root.name = "";
		return root;
	}
	getAllLoadedFiles(): TAbstractFile[] {
		return [];
	}
	getFiles(): TFile[] {
		return [];
	}
	getMarkdownFiles(): TFile[] {
		return [];
	}
}

// ---------------------------------------------------------------------------
// Workspace / Plugin / View
// ---------------------------------------------------------------------------

export class WorkspaceLeaf {
	view: unknown = null;
	async setViewState(_state: unknown): Promise<void> {
		/* noop */
	}
	getViewState(): unknown {
		return {};
	}
	detach(): void {
		/* noop */
	}
}

export class View {
	leaf: WorkspaceLeaf;
	containerEl: HTMLElement;
	constructor(leaf: WorkspaceLeaf) {
		this.leaf = leaf;
		this.containerEl = document.createElement("div");
	}
	getViewType(): string {
		return "";
	}
	getDisplayText(): string {
		return "";
	}
	async onOpen(): Promise<void> {
		/* noop */
	}
	async onClose(): Promise<void> {
		/* noop */
	}
}

export class ItemView extends View {
	contentEl: HTMLElement;
	icon = "";
	constructor(leaf: WorkspaceLeaf) {
		super(leaf);
		this.contentEl = document.createElement("div");
		this.containerEl.appendChild(this.contentEl);
	}
	getIcon(): string {
		return this.icon;
	}
}

export class MarkdownView extends ItemView {
	file: TFile | null = null;
	editor: unknown = {};
	getMode(): "source" | "preview" {
		return "source";
	}
}

// ---------------------------------------------------------------------------
// App / Workspace / FileManager / MetadataCache
// ---------------------------------------------------------------------------

export class Workspace {
	getActiveViewOfType<T>(_ctor: new (...args: unknown[]) => T): T | null {
		return null;
	}
	getLeavesOfType(_type: string): WorkspaceLeaf[] {
		return [];
	}
	getRightLeaf(_split: boolean): WorkspaceLeaf {
		return new WorkspaceLeaf();
	}
	getLeaf(_newLeaf?: boolean): WorkspaceLeaf {
		return new WorkspaceLeaf();
	}
	revealLeaf(_leaf: WorkspaceLeaf): void {
		/* noop */
	}
	on(_event: string, _cb: (...args: unknown[]) => void): unknown {
		return {};
	}
	off(_event: string, _cb: (...args: unknown[]) => void): void {
		/* noop */
	}
}

export class FileManager {
	async processFrontMatter(
		_file: TFile,
		_fn: (fm: Record<string, unknown>) => void,
	): Promise<void> {
		/* noop */
	}
	getNewFileParent(_path: string): TFolder {
		return new TFolder();
	}
}

export class MetadataCache {
	on(_event: string, _cb: (...args: unknown[]) => void): unknown {
		return {};
	}
	off(_event: string, _cb: (...args: unknown[]) => void): void {
		/* noop */
	}
}

export class App {
	vault: Vault = new Vault();
	workspace: Workspace = new Workspace();
	fileManager: FileManager = new FileManager();
	metadataCache: MetadataCache = new MetadataCache();
}

// ---------------------------------------------------------------------------
// Plugin / Settings
// ---------------------------------------------------------------------------

export interface PluginManifest {
	id: string;
	name: string;
	version: string;
	minAppVersion: string;
}

export class Plugin {
	app: App;
	manifest: PluginManifest;
	constructor(app: App, manifest?: Partial<PluginManifest>) {
		this.app = app;
		this.manifest = {
			id: manifest?.id ?? "test-plugin",
			name: manifest?.name ?? "Test Plugin",
			version: manifest?.version ?? "0.0.1",
			minAppVersion: manifest?.minAppVersion ?? "1.4.0",
		};
	}
	async loadData(): Promise<unknown> {
		return null;
	}
	async saveData(_data: unknown): Promise<void> {
		/* noop */
	}
	async onload(): Promise<void> {
		/* noop */
	}
	onunload(): void {
		/* noop */
	}
	addCommand(_command: unknown): unknown {
		return {};
	}
	addRibbonIcon(
		_icon: string,
		_title: string,
		_cb: (...args: unknown[]) => void,
	): HTMLElement {
		return document.createElement("div");
	}
	addSettingTab(_tab: unknown): void {
		/* noop */
	}
	registerView(
		_type: string,
		_viewCreator: (leaf: WorkspaceLeaf) => unknown,
	): void {
		/* noop */
	}
	registerEvent(_eventRef: unknown): void {
		/* noop */
	}
	registerDomEvent(
		_el: HTMLElement | Document | Window,
		_event: string,
		_cb: (...args: unknown[]) => void,
	): void {
		/* noop */
	}
	registerInterval(_id: number): void {
		/* noop */
	}
}

export class PluginSettingTab {
	app: App;
	plugin: Plugin;
	containerEl: HTMLElement;
	constructor(app: App, plugin: Plugin) {
		this.app = app;
		this.plugin = plugin;
		this.containerEl = document.createElement("div");
	}
	display(): void {
		/* noop */
	}
	hide(): void {
		/* noop */
	}
}

// ---------------------------------------------------------------------------
// Setting UI builder
// ---------------------------------------------------------------------------

abstract class BaseValueComponent<V> {
	protected value!: V;
	protected changeHandlers: ((v: V) => void)[] = [];
	protected disabled = false;
	setValue(value: V): this {
		this.value = value;
		return this;
	}
	getValue(): V {
		return this.value;
	}
	onChange(cb: (value: V) => void): this {
		this.changeHandlers.push(cb);
		return this;
	}
	setDisabled(disabled: boolean): this {
		this.disabled = disabled;
		return this;
	}
}

export class TextComponent extends BaseValueComponent<string> {
	inputEl: HTMLInputElement;
	constructor(containerEl: HTMLElement) {
		super();
		this.inputEl = document.createElement("input");
		this.inputEl.type = "text";
		this.value = "";
		containerEl.appendChild(this.inputEl);
		this.inputEl.addEventListener("input", () => {
			this.value = this.inputEl.value;
			for (const h of this.changeHandlers) h(this.value);
		});
	}
	setPlaceholder(placeholder: string): this {
		this.inputEl.placeholder = placeholder;
		return this;
	}
	override setValue(value: string): this {
		this.value = value;
		this.inputEl.value = value;
		return this;
	}
}

export class TextAreaComponent extends BaseValueComponent<string> {
	inputEl: HTMLTextAreaElement;
	constructor(containerEl: HTMLElement) {
		super();
		this.inputEl = document.createElement("textarea");
		this.value = "";
		containerEl.appendChild(this.inputEl);
		this.inputEl.addEventListener("input", () => {
			this.value = this.inputEl.value;
			for (const h of this.changeHandlers) h(this.value);
		});
	}
	setPlaceholder(placeholder: string): this {
		this.inputEl.placeholder = placeholder;
		return this;
	}
	override setValue(value: string): this {
		this.value = value;
		this.inputEl.value = value;
		return this;
	}
}

export class DropdownComponent extends BaseValueComponent<string> {
	selectEl: HTMLSelectElement;
	constructor(containerEl: HTMLElement) {
		super();
		this.selectEl = document.createElement("select");
		this.value = "";
		containerEl.appendChild(this.selectEl);
		this.selectEl.addEventListener("change", () => {
			this.value = this.selectEl.value;
			for (const h of this.changeHandlers) h(this.value);
		});
	}
	addOption(value: string, label: string): this {
		const opt = document.createElement("option");
		opt.value = value;
		opt.textContent = label;
		this.selectEl.appendChild(opt);
		return this;
	}
	addOptions(options: Record<string, string>): this {
		for (const [value, label] of Object.entries(options)) {
			this.addOption(value, label);
		}
		return this;
	}
	override setValue(value: string): this {
		this.value = value;
		this.selectEl.value = value;
		return this;
	}
}

export class ToggleComponent extends BaseValueComponent<boolean> {
	toggleEl: HTMLInputElement;
	constructor(containerEl: HTMLElement) {
		super();
		this.toggleEl = document.createElement("input");
		this.toggleEl.type = "checkbox";
		this.value = false;
		containerEl.appendChild(this.toggleEl);
		this.toggleEl.addEventListener("change", () => {
			this.value = this.toggleEl.checked;
			for (const h of this.changeHandlers) h(this.value);
		});
	}
	override setValue(value: boolean): this {
		this.value = value;
		this.toggleEl.checked = value;
		return this;
	}
}

export class ButtonComponent {
	buttonEl: HTMLButtonElement;
	private clickHandler: (() => void) | null = null;
	constructor(containerEl: HTMLElement) {
		this.buttonEl = document.createElement("button");
		containerEl.appendChild(this.buttonEl);
		this.buttonEl.addEventListener("click", () => this.clickHandler?.());
	}
	setButtonText(text: string): this {
		this.buttonEl.textContent = text;
		return this;
	}
	setCta(): this {
		this.buttonEl.classList.add("mod-cta");
		return this;
	}
	setDisabled(disabled: boolean): this {
		this.buttonEl.disabled = disabled;
		return this;
	}
	onClick(cb: () => void): this {
		this.clickHandler = cb;
		return this;
	}
}

/**
 * Obsidian `ExtraButtonComponent` 의 테스트용 스텁.
 * 실제 구현은 `Setting.addExtraButton` 에서 반환되며 아이콘/툴팁/클릭 콜백을 제공한다.
 */
export class ExtraButtonComponent {
	extraSettingsEl: HTMLElement;
	private clickHandler: (() => void) | null = null;
	private disabled = false;
	constructor(containerEl: HTMLElement) {
		this.extraSettingsEl = document.createElement("div");
		this.extraSettingsEl.className = "clickable-icon extra-setting-button";
		containerEl.appendChild(this.extraSettingsEl);
		this.extraSettingsEl.addEventListener("click", () => {
			if (!this.disabled) this.clickHandler?.();
		});
	}
	setIcon(iconId: string): this {
		setIcon(this.extraSettingsEl, iconId);
		return this;
	}
	setTooltip(tooltip: string): this {
		this.extraSettingsEl.setAttribute("aria-label", tooltip);
		this.extraSettingsEl.setAttribute("title", tooltip);
		return this;
	}
	setDisabled(disabled: boolean): this {
		this.disabled = disabled;
		if (disabled) {
			this.extraSettingsEl.classList.add("is-disabled");
		} else {
			this.extraSettingsEl.classList.remove("is-disabled");
		}
		return this;
	}
	onClick(cb: () => void): this {
		this.clickHandler = cb;
		return this;
	}
}

export class Setting {
	settingEl: HTMLElement;
	nameEl: HTMLElement;
	descEl: HTMLElement;
	controlEl: HTMLElement;
	constructor(containerEl: HTMLElement) {
		this.settingEl = document.createElement("div");
		this.nameEl = document.createElement("div");
		this.descEl = document.createElement("div");
		this.controlEl = document.createElement("div");
		this.settingEl.appendChild(this.nameEl);
		this.settingEl.appendChild(this.descEl);
		this.settingEl.appendChild(this.controlEl);
		containerEl.appendChild(this.settingEl);
	}
	setName(name: string): this {
		this.nameEl.textContent = name;
		return this;
	}
	setDesc(desc: string): this {
		this.descEl.textContent = desc;
		return this;
	}
	setHeading(): this {
		this.settingEl.dataset.heading = "true";
		return this;
	}
	setDisabled(_disabled: boolean): this {
		return this;
	}
	addText(cb: (text: TextComponent) => void): this {
		const text = new TextComponent(this.controlEl);
		cb(text);
		return this;
	}
	addTextArea(cb: (ta: TextAreaComponent) => void): this {
		const ta = new TextAreaComponent(this.controlEl);
		cb(ta);
		return this;
	}
	addDropdown(cb: (dd: DropdownComponent) => void): this {
		const dd = new DropdownComponent(this.controlEl);
		cb(dd);
		return this;
	}
	addToggle(cb: (tg: ToggleComponent) => void): this {
		const tg = new ToggleComponent(this.controlEl);
		cb(tg);
		return this;
	}
	addButton(cb: (btn: ButtonComponent) => void): this {
		const btn = new ButtonComponent(this.controlEl);
		cb(btn);
		return this;
	}
	addExtraButton(cb: (btn: ExtraButtonComponent) => void): this {
		const btn = new ExtraButtonComponent(this.controlEl);
		cb(btn);
		return this;
	}
}

// ---------------------------------------------------------------------------
// Suggesters
// ---------------------------------------------------------------------------

export abstract class AbstractInputSuggest<T> {
	protected app: App;
	protected inputEl: HTMLInputElement;
	constructor(app: App, inputEl: HTMLInputElement) {
		this.app = app;
		this.inputEl = inputEl;
	}
	abstract getSuggestions(query: string): T[] | Promise<T[]>;
	abstract renderSuggestion(item: T, el: HTMLElement): void;
	abstract selectSuggestion(item: T): void;
	close(): void {
		/* noop */
	}
	open(): void {
		/* noop */
	}
	setValue(_value: string): void {
		/* noop */
	}
}

// ---------------------------------------------------------------------------
// Notice
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Icon rendering
// ---------------------------------------------------------------------------

/**
 * Obsidian의 `setIcon`을 흉내내는 스텁.
 *
 * 실제 구현은 대상 엘리먼트에 Lucide 아이콘 SVG를 삽입한다. 테스트 환경에서는
 * DOM 구조의 존재만 관찰하는 수준이면 충분하므로, 자리 표시 SVG 하나를 삽입한다.
 */
export function setIcon(parent: HTMLElement, iconId: string): void {
	parent.empty?.();
	const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
	svg.setAttribute("data-icon", iconId);
	svg.classList.add("svg-icon");
	parent.appendChild(svg);
}

export class Notice {
	noticeEl: HTMLElement;
	constructor(public message: string | DocumentFragment, _timeout?: number) {
		this.noticeEl = document.createElement("div");
	}
	hide(): void {
		/* noop */
	}
	setMessage(message: string | DocumentFragment): this {
		this.message = message;
		return this;
	}
}

// ---------------------------------------------------------------------------
// Network — requestUrl (stub)
// ---------------------------------------------------------------------------

export async function requestUrl(_options: unknown): Promise<{
	status: number;
	text: string;
	json: unknown;
	headers: Record<string, string>;
	arrayBuffer: ArrayBuffer;
}> {
	return {
		status: 200,
		text: "",
		json: null,
		headers: {},
		arrayBuffer: new ArrayBuffer(0),
	};
}
