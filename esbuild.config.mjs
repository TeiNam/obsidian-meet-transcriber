import esbuild from "esbuild";
import process from "process";
import fs from "node:fs/promises";
import path from "node:path";
import builtins from "builtin-modules";

// 프로덕션 모드 여부 판별 (인자로 "production" 전달 시)
const prod = process.argv[2] === "production";

/**
 * AudioWorklet 소스(`pcm-worklet.js`)를 번들에 문자열로 포함시키는 esbuild 플러그인.
 *
 * 이유:
 * - Obsidian 플러그인 배포 표준은 `main.js` / `manifest.json` / `styles.css` 3파일 구조이다.
 *   별도 리소스 파일(pcm-worklet.js)을 플러그인 폴더에 두고 `vault.adapter.getResourcePath()`로
 *   읽는 방법도 있으나, `app://` 리소스 URL 을 `AudioContext.audioWorklet.addModule()` 로
 *   넘기면 환경에 따라 `AbortError: Unable to load a worklet's module` 이 난다.
 * - 따라서 worklet 소스를 번들에 문자열로 인라인한 뒤, 런타임에 Blob URL 을 생성해
 *   `audioWorklet.addModule(blobUrl)` 로 로드한다. (`AudioCapture` 가 이미
 *   `workletSource` 옵션을 통해 이 경로를 지원한다.)
 *
 * 동작:
 * - `?worklet` 쿼리를 붙여 import 한 경로(예: `../audio/pcm-worklet.js?worklet`)를
 *   가로채 해당 파일 내용을 `export default <string>` 모듈로 변환한다.
 */
const workletTextPlugin = {
  name: "worklet-text",
  setup(build) {
    build.onResolve({ filter: /\?worklet$/ }, (args) => ({
      path: path.resolve(args.resolveDir, args.path.replace(/\?worklet$/, "")),
      namespace: "worklet-text",
    }));
    build.onLoad({ filter: /.*/, namespace: "worklet-text" }, async (args) => {
      const contents = await fs.readFile(args.path, "utf8");
      return {
        contents: `export default ${JSON.stringify(contents)};`,
        loader: "js",
        watchFiles: [args.path],
      };
    });
  },
};

/**
 * 빌드 산출물 경로 정책.
 *
 * Obsidian community plugin 배포 규칙상 `main.js`는 플러그인 루트에 위치해야 한다 (manifest.json
 * 의 `main` 필드와 일치). 본 빌드는 `main.js` 단일 산출물만 떨어뜨리며 GitHub Release 에 함께
 * 첨부되어야 한다 (community plugin 검수 정책).
 *
 * - `main.js` : 플러그인 메인 (manifest.json `main` 과 매칭)
 *
 * v1.2 정리: 로컬 Whisper 백엔드 제거에 따라 `whisper-worker.js` 엔트리와 transformers.js / WASM
 * 자산 처리 로직이 모두 삭제되었다. 온라인 전용(AWS Transcribe Streaming) 으로 단순화.
 */

/** main.js (플러그인 메인 엔트리) 빌드 옵션 */
const mainBuildOptions = {
  entryPoints: ["src/main.ts"],
  bundle: true,
  plugins: [workletTextPlugin],
  external: [
    "obsidian",
    "electron",
    // CodeMirror/Lezer 계열은 Obsidian 호스트가 제공 → 번들 제외
    "@codemirror/*",
    "@lezer/*",
    // Node.js 내장 모듈 (http2, tls, crypto, stream 등) 런타임 해석
    ...builtins,
    // `node:` prefix 형태 (`node:crypto`, `node:fs`, `node:fs/promises` 등) 도 external 로
    // 처리한다. `builtin-modules` 패키지는 prefix 없는 이름만 반환하므로 명시적으로 매핑.
    ...builtins.map((m) => `node:${m}`),
  ],
  format: "cjs",
  target: "chrome106",
  logLevel: "info",
  // 프로덕션: 소스맵 비활성화 (심사 기준 9.10), 개발: inline 소스맵
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  outfile: "main.js",
  // 프로덕션: 코드 축소 (심사 기준 9.10)
  minify: prod,
  // 프로덕션: AWS SDK 등 외부 의존성에 포함된 console.log/warn/debug/info 호출을
  // 순수 호출로 표시하여 minify 단계에서 제거한다. `console.error`는 유지되어
  // 런타임 에러 로깅이 가능하다 (Requirement 9.6).
  pure: prod
    ? ["console.log", "console.warn", "console.debug", "console.info"]
    : [],
  // DEV 플래그: 개발 빌드에서는 true, 프로덕션 빌드에서는 false → 데드 코드 제거
  define: {
    DEV: JSON.stringify(!prod),
  },
};

if (prod) {
  // 프로덕션: 단일 엔트리 빌드 후 종료
  await esbuild.build(mainBuildOptions);

  // 산출물 사이즈 측정
  const sizeWarningBytes = 3 * 1024 * 1024; // 3MB
  const artifacts = ["main.js"];
  let totalBytes = 0;
  for (const name of artifacts) {
    try {
      const stat = await fs.stat(name);
      totalBytes += stat.size;
      const kb = (stat.size / 1024).toFixed(1);
      console.log(`[esbuild] ${name}: ${kb} KB`);
    } catch {
      console.error(`[esbuild] missing artifact: ${name}`);
    }
  }
  const totalKb = (totalBytes / 1024).toFixed(1);
  console.log(`[esbuild] total bundle size: ${totalKb} KB`);
  if (totalBytes > sizeWarningBytes) {
    console.error(
      `[esbuild] WARNING: total bundle size ${totalKb} KB exceeds 3 MB threshold. ` +
        `Consider reviewing AWS SDK bundling, dynamic imports, or external CDN strategy.`,
    );
  }
} else {
  // 개발: 단일 엔트리 watch 모드
  const mainContext = await esbuild.context(mainBuildOptions);
  await mainContext.watch();
}
