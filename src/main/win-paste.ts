// 전역 붙여넣기 보조 — "직전에 쓰던 창"으로 포커스를 되돌리고 Ctrl+V를 대신 눌러준다.
//
// Electron에는 다른 앱의 창을 다루거나 키 입력을 보내는 API가 없어 Win32 API를 PowerShell로 호출한다.
// (네이티브 모듈을 추가하면 빌드·서명이 복잡해져서 피했다.)
import { execFile } from "node:child_process";

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
 * 지금 맨 앞에 있는 창의 핸들. 우리 팝업이 포커스를 뺏기 "전에" 불러야 한다.
 * 반환값은 문자열(핸들 정수) — 나중에 그대로 되돌려줄 때만 쓴다.
 */
export async function getForegroundWindow(): Promise<string | null> {
  if (process.platform !== "win32") return null;
  const out = await ps(`${WIN32_SIG}[BgL.W]::GetForegroundWindow().ToInt64()`);
  return /^-?\d+$/.test(out) && out !== "0" ? out : null;
}

/**
 * 저장해둔 창으로 포커스를 되돌린 뒤 Ctrl+V를 보낸다.
 *
 * 실패해도 클립보드에는 이미 복사돼 있으므로 사용자가 직접 Ctrl+V 하면 된다 →
 * 성공 여부만 돌려주고 예외는 삼킨다.
 */
export async function focusAndPaste(hwnd: string | null): Promise<boolean> {
  if (process.platform !== "win32" || !hwnd) return false;
  const out = await ps(`
${WIN32_SIG}
$h = [IntPtr]::new([int64]${hwnd})
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
