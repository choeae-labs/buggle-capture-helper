// 렌더러 HTML을 dist로 복사(TS는 tsc가 컴파일). 간단 복사만.
const fs = require("node:fs");
const path = require("node:path");

const pairs = [
  ["src/renderer/preview.html", "dist/renderer/preview.html"],
  ["src/renderer/overlay.html", "dist/renderer/overlay.html"],
  ["src/renderer/recorder.html", "dist/renderer/recorder.html"],
  ["src/renderer/indicator.html", "dist/renderer/indicator.html"],
  ["src/renderer/editor.html", "dist/renderer/editor.html"],
];

for (const [from, to] of pairs) {
  const dst = path.resolve(to);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(path.resolve(from), dst);
  console.log("copied", from, "->", to);
}
