// electron-builder afterPack 훅 (영문 productName 버전 — 최소).
//
// 배경: electron-builder 25.1.8은 유효 Developer ID가 없으면 mac 앱 코드서명을 건너뛴다
// ("skipped macOS application code signing"). 그 상태로는 Apple Silicon에서 서명 부실로
// 실행되지 않으므로 여기서 @electron/osx-sign으로 ad-hoc 재서명한다.
//
// (과거 한글 productName일 때는 electron-builder가 Helper 번들명을 유니코드 NFD로 기록해
//  macOS 26 코드서명 감시가 V8 JIT 시동 시 메인 프로세스를 SIGTRAP으로 즉사시켰다. productName을
//  영문 ASCII로 바꿔 그 정규화 문제를 원천 제거했으므로, 프레임워크/Helper 복원·NFC 수술은 불필요.)
//  Developer ID 정식 서명+공증으로 전환하면 이 훅 자체를 제거 가능.
const path = require("node:path");

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;
  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`
  );
  const { signAsync } = require("@electron/osx-sign");
  await signAsync({
    app: appPath,
    identity: "-",
    identityValidation: false,
    optionsForFile: () => ({ hardenedRuntime: false }),
  });
  console.log("[afterPack] ad-hoc 재서명 완료");
};
