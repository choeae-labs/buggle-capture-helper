// electron-builder afterPack 훅 — macOS 앱을 ad-hoc 재서명.
// identity:null이면 electron-builder의 서명이 부실해("code has no resources ...") 최신 macOS(26+)에서
// 코드서명 감시가 실행 즉시 SIGTRAP으로 죽인다. --force --deep --sign - 로 리소스 포함 재서명하면 실행된다.
// (Developer ID 서명을 붙이면 이 훅은 불필요.)
const { execSync } = require("node:child_process");

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;
  const app = `${context.appOutDir}/${context.packager.appInfo.productFilename}.app`;
  console.log("[afterPack] ad-hoc 재서명:", app);
  execSync(`codesign --force --deep --sign - "${app}"`, { stdio: "inherit" });
};
