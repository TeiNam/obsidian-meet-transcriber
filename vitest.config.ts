/**
 * Vitest 설정.
 *
 * 설계 원칙:
 * - `jsdom` 환경 사용 — `document`/`window` 필요한 UI 로직(SidebarView, Setting 컴포넌트,
 *   TranscriptBuffer 등)까지 동일 설정으로 테스트한다.
 * - `obsidian` 모듈은 실제 앱 런타임에서만 로드 가능하므로, 수동 모의(`tests/mocks/obsidian.ts`)로
 *   alias 치환한다.
 * - PBT 테스트 파일은 `**\/*.property.test.ts` 패턴으로 인식한다.
 * - 커버리지는 `v8` 프로바이더 사용 (`npm run test:coverage` 시에만 활성화).
 * - 빌드 산출물(`main.js`)과 외부 디렉터리(`node_modules`, `dist`, `.kiro`)는 제외.
 */

import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
	resolve: {
		alias: {
			// Obsidian API는 테스트에서 직접 import 불가 → 수동 모의 모듈로 치환
			obsidian: resolve(__dirname, "tests/mocks/obsidian.ts"),
		},
	},
	test: {
		// 브라우저 환경 시뮬레이션 (DOM API, navigator 등 사용 가능)
		environment: "jsdom",

		// 전역 설정 파일 — 필요 시 폴리필/전역 모의를 추가
		setupFiles: ["tests/setup.ts"],

		// 테스트 파일 패턴 — 일반 단위 테스트 + PBT(`*.property.test.ts`) 모두 포함
		include: [
			"src/**/*.{test,spec}.ts",
			"src/**/*.property.test.ts",
			"tests/**/*.{test,spec}.ts",
			"tests/**/*.property.test.ts",
		],

		// 빌드 산출물 및 외부 디렉터리 제외
		exclude: [
			"node_modules/**",
			"dist/**",
			"main.js",
			".kiro/**",
			".obsidian/**",
		],

		// 기본은 globals 비활성 — `describe`, `test`, `expect`는 명시적으로 import하여 사용
		globals: false,

		// PBT는 기본값(5s)보다 오래 걸릴 수 있어 여유를 둔다
		testTimeout: 30_000,
		hookTimeout: 10_000,

		// 커버리지 설정 — `--coverage` 플래그로만 활성화된다
		coverage: {
			provider: "v8",
			reporter: ["text", "html", "lcov"],
			include: ["src/**/*.ts"],
			exclude: [
				"src/**/*.test.ts",
				"src/**/*.property.test.ts",
				"src/**/*.d.ts",
				"src/audio/pcm-worklet.js",
			],
			// 커버리지 임계값은 태스크 진행에 따라 상향 조정한다
			thresholds: {
				lines: 0,
				functions: 0,
				branches: 0,
				statements: 0,
			},
		},
	},
});
