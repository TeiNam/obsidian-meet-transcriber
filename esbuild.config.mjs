import esbuild from "esbuild";
import process from "process";
import builtins from "builtin-modules";

// 프로덕션 모드 여부 판별 (인자로 "production" 전달 시)
const prod = process.argv[2] === "production";

const context = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: [
    "obsidian",
    "electron",
    // CodeMirror/Lezer 계열은 Obsidian 호스트가 제공 → 번들 제외
    "@codemirror/*",
    "@lezer/*",
    // Node.js 내장 모듈 (http2, tls, crypto, stream 등) 런타임 해석
    ...builtins,
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
});

if (prod) {
  // 프로덕션: 단일 빌드 후 종료
  await context.rebuild();
  await context.dispose();
} else {
  // 개발: watch 모드로 파일 변경 감지
  await context.watch();
}
