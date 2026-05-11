// npm version 훅으로 실행되는 버전 동기화 스크립트.
//
// 동작:
// 1. package.json 의 version 을 읽는다(npm version 이 이미 업데이트한 직후 상태).
// 2. manifest.json 의 version 을 동일 값으로 갱신한다.
// 3. versions.json 에 새 항목 `{ "<version>": "<minAppVersion>" }` 을 추가한다.
//    이미 존재하면 덮어쓰지 않는다(의도치 않은 이력 변경 방지).
// 4. 두 파일을 git add 해서 npm version 이 만들어 줄 release 커밋에 포함시킨다.
//
// 사용 예:
//   npm version 1.0.1   → 1.0.1 태그와 커밋이 세 파일을 동시에 반영한 상태로 생성된다.

import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const versions = JSON.parse(readFileSync("versions.json", "utf8"));

const targetVersion = pkg.version;
if (!targetVersion) {
  console.error("package.json version is missing");
  process.exit(1);
}

// manifest.json 갱신
manifest.version = targetVersion;
writeFileSync("manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);

// versions.json 갱신 — 최소 Obsidian 버전은 manifest 에서 가져온다.
if (!versions[targetVersion]) {
  versions[targetVersion] = manifest.minAppVersion;
}
writeFileSync("versions.json", `${JSON.stringify(versions, null, 2)}\n`);

// npm version 이 생성하는 release 커밋에 포함되도록 스테이지.
execSync("git add manifest.json versions.json");

console.log(
  `Synchronized manifest.json and versions.json to ${targetVersion} (minAppVersion ${manifest.minAppVersion})`,
);
