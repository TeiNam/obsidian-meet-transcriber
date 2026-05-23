/**
 * Vitest 전역 셋업.
 *
 * jsdom 환경이 기본으로 제공하지 않는 브라우저 API를 보완하거나,
 * 테스트 간 공통 초기화를 수행하는 자리.
 *
 * 현재 제공하는 폴리필:
 * - Obsidian이 `HTMLElement.prototype`에 확장해 두는 DOM 헬퍼(createEl, createDiv,
 *   createSpan, empty, setText, setAttr, addClass, removeClass, toggleClass).
 *   실제 `obsidian` 모듈은 런타임에서만 로드 가능하므로 UI 테스트가 이 메서드를 호출할
 *   수 있도록 jsdom의 HTMLElement 프로토타입에 최소 구현을 심어둔다.
 *
 * 추후 `navigator.mediaDevices`, `AudioContext`, `crypto.randomUUID` 등 별도 API
 * 폴리필이 필요해지면 이 파일에 추가한다.
 */

type CreateElOptions = {
	cls?: string | string[];
	text?: string;
	attr?: Record<string, string | number | boolean>;
	// Obsidian 실제 API 는 `<option>` / `<input>` 등에서 자주 쓰이도록 `value` 를
	// top-level 옵션으로 받아 DOM 속성에 직접 매핑한다. 폴리필도 동일하게 지원한다.
	value?: string;
};

/**
 * Obsidian DOM 확장 폴리필을 한 번만 설치한다.
 *
 * 동일 프로세스 내에서 이 파일이 여러 번 로드되더라도 중복 설치/재정의 되지 않도록
 * 마커 플래그(`__obsidianDomPolyfilled`)로 가드한다.
 */
function installObsidianDomExtensions(): void {
	const proto = HTMLElement.prototype as unknown as Record<string, unknown> & {
		__obsidianDomPolyfilled?: boolean;
	};
	if (proto.__obsidianDomPolyfilled) return;
	proto.__obsidianDomPolyfilled = true;

	// createEl: 자식 요소를 생성/부착하고 클래스·텍스트·속성을 일괄 설정한다.
	proto.createEl = function createEl<K extends keyof HTMLElementTagNameMap>(
		this: HTMLElement,
		tag: K,
		options?: CreateElOptions,
	): HTMLElementTagNameMap[K] {
		const el = document.createElement(tag);
		if (options?.cls) {
			const classes = Array.isArray(options.cls)
				? options.cls
				: options.cls.split(/\s+/).filter(Boolean);
			for (const c of classes) el.classList.add(c);
		}
		if (options?.text !== undefined) {
			el.textContent = options.text;
		}
		if (options?.attr) {
			for (const [name, value] of Object.entries(options.attr)) {
				el.setAttribute(name, String(value));
			}
		}
		// Obsidian 실 API 호환: `<option value="...">` 처럼 `value` 가 DOM 속성과
		// 프로퍼티 양쪽에 반영되어야 select.options[i].value 가 우리가 설정한 값을
		// 돌려준다 (jsdom 에서는 setAttribute 만으로도 동작하지만, 명시적으로 둘 다 세팅).
		if (options?.value !== undefined) {
			el.setAttribute("value", options.value);
			(el as unknown as { value: string }).value = options.value;
		}
		this.appendChild(el);
		return el;
	} as unknown as HTMLElement["createEl"];

	proto.createDiv = function createDiv(
		this: HTMLElement,
		options?: CreateElOptions,
	): HTMLDivElement {
		return (
			this as unknown as { createEl: HTMLElement["createEl"] }
		).createEl("div", options);
	} as unknown as HTMLElement["createDiv"];

	proto.createSpan = function createSpan(
		this: HTMLElement,
		options?: CreateElOptions,
	): HTMLSpanElement {
		return (
			this as unknown as { createEl: HTMLElement["createEl"] }
		).createEl("span", options);
	} as unknown as HTMLElement["createSpan"];

	proto.empty = function empty(this: HTMLElement): void {
		while (this.firstChild) {
			this.removeChild(this.firstChild);
		}
	};

	proto.setText = function setText(
		this: HTMLElement,
		text: string | DocumentFragment,
	): void {
		if (typeof text === "string") {
			this.textContent = text;
		} else {
			this.textContent = "";
			this.appendChild(text);
		}
	};

	proto.setAttr = function setAttr(
		this: HTMLElement,
		name: string,
		value: string | number | boolean,
	): void {
		this.setAttribute(name, String(value));
	};

	proto.addClass = function addClass(this: HTMLElement, cls: string): void {
		for (const c of cls.split(/\s+/).filter(Boolean)) this.classList.add(c);
	};

	proto.removeClass = function removeClass(
		this: HTMLElement,
		cls: string,
	): void {
		for (const c of cls.split(/\s+/).filter(Boolean))
			this.classList.remove(c);
	};

	// Obsidian의 toggleClass는 두 번째 인자 `force`가 필수 bool이며 반환값이 없다.
	// DOM 표준 `classList.toggle(cls, force)`에 위임하되 반환값을 숨긴다.
	proto.toggleClass = function toggleClass(
		this: HTMLElement,
		cls: string,
		force: boolean,
	): void {
		for (const c of cls.split(/\s+/).filter(Boolean)) {
			this.classList.toggle(c, force);
		}
	};
}

installObsidianDomExtensions();

export {};
