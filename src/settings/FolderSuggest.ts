/**
 * `FolderSuggest` — Vault 폴더 경로 자동완성 suggester.
 *
 * Obsidian `AbstractInputSuggest<TFolder>`를 확장하여,
 * 설정 탭의 `Transcript_Folder` 텍스트 입력 필드에 vault 폴더 자동완성을 제공한다.
 * 사용자는 폴더명을 타이핑하면서 드롭다운으로 실제 존재하는 vault 폴더 목록을 볼 수 있다.
 *
 * 설계 원칙:
 * - 대소문자 구분 없이 매칭(`toLowerCase()`).
 * - 결과는 `path` 사전식 순서로 정렬하여 UX 안정성 확보.
 * - 대규모 vault에서도 UI 응답성을 유지하기 위해 최대 20개 결과로 제한(Requirement 2.10).
 * - 루트 폴더(빈 `path`)는 `"/"`로 표시한다.
 * - 선택 시 `inputEl.trigger("input")`을 호출하여 Obsidian `Setting`의 `onChange` 핸들러를 트리거한다.
 *
 * 관련 요구사항: Requirement 2.10
 * 관련 설계: design.md § 9 "SettingsStore & TranscribeSettingTab & FolderSuggest"
 * 관련 steering: `obsidian-plugin-develop/typescript-chromium.md` — "FolderSuggest" 섹션
 */

import {
	AbstractInputSuggest,
	type App,
	type TAbstractFile,
	TFolder,
} from "obsidian";

/**
 * 자동완성 드롭다운에 표시할 최대 폴더 수.
 *
 * 대규모 vault에서 `getAllLoadedFiles()`가 수천 개의 항목을 반환할 수 있으므로,
 * 렌더링 성능과 UX 가독성을 위해 상한을 둔다(Requirement 2.10).
 */
const MAX_SUGGESTIONS = 20;

/**
 * Vault 폴더 경로 자동완성 suggester.
 *
 * 사용 예:
 * ```ts
 * new Setting(containerEl)
 *   .setName(t.settings.transcriptFolder.name)
 *   .addText((text) => {
 *     new FolderSuggest(this.app, text.inputEl);
 *     text.setValue(settings.transcriptFolder).onChange((v) => { ... });
 *   });
 * ```
 */
export class FolderSuggest extends AbstractInputSuggest<TFolder> {
	/**
	 * @param app - Obsidian `App` 인스턴스. `app.vault` 접근용.
	 * @param inputEl - 자동완성을 연결할 `<input>` 요소.
	 *   `AbstractInputSuggest`가 내부적으로 이 요소의 포커스/입력 이벤트를 구독한다.
	 *   선택 시 이 요소의 `value`를 갱신하고 `trigger("input")`으로 onChange를 전파한다.
	 */
	constructor(
		app: App,
		private readonly inputEl: HTMLInputElement,
	) {
		super(app, inputEl);
	}

	/**
	 * 현재 입력 문자열에 매칭되는 vault 폴더 목록을 반환한다.
	 *
	 * 동작:
	 * 1. `app.vault.getAllLoadedFiles()`로 vault의 모든 파일/폴더를 가져온다.
	 * 2. `TFolder` 인스턴스만 남긴다(`instanceof` 타입 가드).
	 * 3. 폴더의 `path`가 `query`를 (대소문자 무시) 포함하는 것만 남긴다.
	 * 4. `path` 오름차순으로 정렬하여 안정적인 순서를 보장한다.
	 * 5. 최대 `MAX_SUGGESTIONS`개만 반환한다(Requirement 2.10).
	 *
	 * 빈 `query`("") 입력 시 모든 폴더가 매칭되므로, 이 경우에도 동일한 상한이 적용된다.
	 *
	 * @param query - 사용자가 입력한 문자열.
	 * @returns 매칭된 `TFolder` 배열(최대 `MAX_SUGGESTIONS`개).
	 */
	getSuggestions(query: string): TFolder[] {
		const lowerQuery = query.toLowerCase();
		return this.app.vault
			.getAllLoadedFiles()
			.filter(
				(f: TAbstractFile): f is TFolder =>
					f instanceof TFolder &&
					f.path.toLowerCase().includes(lowerQuery),
			)
			.sort((a, b) => a.path.localeCompare(b.path))
			.slice(0, MAX_SUGGESTIONS);
	}

	/**
	 * 드롭다운의 개별 폴더 항목을 렌더링한다.
	 *
	 * 루트 폴더(`TFolder` 중 `path === ""`인 항목)는 `"/"`로 대체 표시하여
	 * 사용자가 루트를 선택 가능한 대상으로 인지할 수 있게 한다.
	 *
	 * `setText()`는 Obsidian이 `HTMLElement`에 추가한 보강 메서드이며,
	 * XSS 안전한 텍스트 노드 삽입을 보장한다(`innerHTML` 사용 금지, Requirement 9.5).
	 *
	 * @param folder - 렌더링할 폴더.
	 * @param el - 드롭다운 항목의 컨테이너 엘리먼트.
	 */
	renderSuggestion(folder: TFolder, el: HTMLElement): void {
		el.setText(folder.path || "/");
	}

	/**
	 * 사용자가 드롭다운에서 항목을 선택했을 때의 동작.
	 *
	 * 1. 입력 필드의 `value`를 선택된 폴더의 `path`로 갱신한다.
	 * 2. `inputEl.trigger("input")`으로 `input` 이벤트를 디스패치하여
	 *    Obsidian `Setting`의 `onChange` 핸들러가 호출되도록 한다.
	 *    (`trigger`는 Obsidian이 `HTMLElement`에 추가한 보강 메서드이다.)
	 * 3. `this.close()`로 suggestion 팝오버를 닫는다.
	 *
	 * 부모 시그니처는 `(value: T, evt: MouseEvent | KeyboardEvent): void`이지만,
	 * 본 구현에서는 이벤트 객체를 사용하지 않으므로 생략한다(TS 파라미터 축소 호환).
	 *
	 * @param folder - 사용자가 선택한 폴더.
	 */
	selectSuggestion(folder: TFolder): void {
		this.inputEl.value = folder.path;
		this.inputEl.trigger("input");
		this.close();
	}
}
