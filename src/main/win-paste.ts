// 전역 붙여넣기 보조 — "직전에 쓰던 창/앱"으로 포커스를 되돌리고 붙여넣기(Ctrl+V / ⌘V)를 대신 눌러준다.
//
// Electron엔 다른 앱의 창을 다루거나 키 입력을 보내는 API가 없어 OS 도구로 처리한다.
//   - Windows: Win32 API를 PowerShell로 호출.
//   - macOS: osascript(AppleScript)로 직전 앱을 activate + ⌘V. '손쉬운 사용(접근성)' 권한 필요.
// (네이티브 모듈을 추가하면 빌드·서명이 복잡해져서 피했다.)
import { execFile } from "node:child_process";
import { systemPreferences } from "electron";

/** PowerShell 실행(짧은 스크립트 전용). 실패해도 던지지 않고 stdout만 돌려준다. */
function ps(script: string, timeout = 4000): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-STA", "-Command", script],
      { timeout, windowsHide: true },
      (err, stdout) => {
        if (err) console.warn("[win-paste] PowerShell 실패:", err.message);
        resolve((stdout || "").trim());
      },
    );
  });
}

/** osascript 실행(짧은 스크립트 전용). 실패해도 던지지 않고 stdout/stderr를 그대로 돌려준다(디버그용). */
function osa(script: string, timeout = 5000): Promise<{ out: string; err: string }> {
  return new Promise((resolve) => {
    execFile("osascript", ["-e", script], { timeout }, (err, stdout, stderr) => {
      const errText = [(stderr || "").trim(), err ? err.message : ""].filter(Boolean).join(" | ");
      if (errText) console.warn("[mac-paste] osascript:", errText);
      resolve({ out: (stdout || "").trim(), err: errText });
    });
  });
}

/** 마지막 자동 붙여넣기 시도의 진단 문자열(실패 원인 실측용). */
let lastPasteDebug = "";
export function getLastPasteDebug(): string {
  return lastPasteDebug;
}

const WIN32_SIG = `
Add-Type -Namespace BgL -Name W -MemberDefinition @'
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
'@ -ErrorAction SilentlyContinue
`;

/**
 * 지금 맨 앞에 있는 창/앱을 식별하는 토큰. 우리 팝업이 포커스를 뺏기 "전에" 불러야 한다.
 * 반환값은 문자열 토큰(Win: 창 핸들 정수 / Mac: 앱 bundle id) — 나중에 그대로 되돌려줄 때만 쓴다.
 */
export async function getForegroundWindow(): Promise<string | null> {
  if (process.platform === "win32") {
    const out = await ps(`${WIN32_SIG}[BgL.W]::GetForegroundWindow().ToInt64()`);
    return /^-?\d+$/.test(out) && out !== "0" ? out : null;
  }
  if (process.platform === "darwin") {
    // 우리 팝업이 뜨기 '전'에 호출됨 → 지금 맨 앞 앱의 bundle id를 저장(복귀용).
    const r = await osa(
      'tell application "System Events" to get bundle identifier of first application process whose frontmost is true',
    );
    if (!/^[A-Za-z0-9.\-]+$/.test(r.out)) {
      lastPasteDebug = `[대상식별 실패] out=${r.out || "(없음)"} err=${r.err || "(없음)"}`;
      return null;
    }
    return r.out;
  }
  return null;
}

/** macOS '손쉬운 사용(접근성)' 권한 여부. keystroke 전송에 필수. prompt=true면 시스템 권한창을 띄운다. */
export function hasMacAccessibility(prompt = false): boolean {
  if (process.platform !== "darwin") return true;
  try {
    return systemPreferences.isTrustedAccessibilityClient(prompt);
  } catch {
    return false;
  }
}

/** (mac) 대상 앱만 앞으로(포커스 복귀). 순차 다건 붙여넣기의 준비 단계. */
export async function focusApp(target: string | null): Promise<boolean> {
  if (process.platform !== "darwin" || !target || !/^[A-Za-z0-9.\-]+$/.test(target)) return false;
  const r = await osa(`tell application id "${target}" to activate`);
  if (r.err) lastPasteDebug = `[activate 실패] ${r.err}`;
  return !r.err;
}

/** (mac) 지금 포커스된 앱에 ⌘V 한 번 전송. */
export async function pressPasteKey(): Promise<boolean> {
  if (process.platform !== "darwin") return false;
  const r = await osa('tell application "System Events" to keystroke "v" using command down\nreturn "ok"');
  if (!r.out.endsWith("ok")) lastPasteDebug = `[keystroke 실패] ${r.err || "무응답"}`;
  return r.out.endsWith("ok");
}

/**
 * 저장해둔 창/앱으로 포커스를 되돌린 뒤 붙여넣기(Ctrl+V / ⌘V)를 보낸다.
 *
 * 실패해도 클립보드에는 이미 복사돼 있으므로 사용자가 직접 붙여넣으면 된다 →
 * 성공 여부만 돌려주고 예외는 삼킨다.
 */
export async function focusAndPaste(target: string | null): Promise<boolean> {
  if (!target) return false;
  if (process.platform === "win32") {
    const out = await ps(`
${WIN32_SIG}
$h = [IntPtr]::new([int64]${target})
if (-not [BgL.W]::IsWindow($h)) { 'nowindow'; exit }
if ([BgL.W]::IsIconic($h)) { [BgL.W]::ShowWindow($h, 9) | Out-Null }  # SW_RESTORE
[BgL.W]::SetForegroundWindow($h) | Out-Null
Start-Sleep -Milliseconds 120   # 포커스 전환이 끝난 뒤에 키를 보내야 엉뚱한 창에 들어가지 않는다
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait('^v')
'ok'
`);
    return out.endsWith("ok");
  }
  if (process.platform === "darwin") {
    if (!/^[A-Za-z0-9.\-]+$/.test(target)) {
      lastPasteDebug = `[형식오류] target=${target}`;
      return false; // bundle id 형식 방어(osascript 삽입 차단)
    }
    // 진단을 위해 권한이 없어 보여도 일단 시도 — 실제 실패 지점·에러문을 기록한다.
    // (isTrustedAccessibilityClient가 실상과 다르게 보고되는 케이스가 있고,
    //  keystroke는 접근성 외에 자동화(AppleEvents, "System Events 제어") 권한도 별도로 필요하다.)
    const ax = hasMacAccessibility(false);
    const act = await osa(`tell application id "${target}" to activate`);
    const key = await osa('tell application "System Events" to keystroke "v" using command down\nreturn "ok"');
    lastPasteDebug =
      `target=${target} 접근성=${ax ? "있음" : "없음"}` +
      ` | activate: ${act.err ? "실패(" + act.err + ")" : "OK"}` +
      ` | keystroke: ${key.out.endsWith("ok") ? "OK" : "실패(" + (key.err || "무응답") + ")"}`;
    return key.out.endsWith("ok");
  }
  return false;
}
