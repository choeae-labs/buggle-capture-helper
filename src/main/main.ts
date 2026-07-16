import { app, Tray, Menu, BrowserWindow, globalShortcut, ipcMain, nativeImage, clipboard, Notification, screen } from "electron";
import path from "node:path";
import fs from "node:fs";
import { execFile } from "node:child_process";
import electronUpdater from "electron-updater";
import { loadConfig, saveConfig, type Hotkeys } from "./config";
import { store } from "./store";
import { startServer, stopServer } from "./server";
import { captureFullScreen, captureRegion, captureFixed, setFixedRegion } from "./capture";
import { initRecorder, isRecording, registerRecorderIpc, startRecording, stopRecording } from "./recorder";

// 숨은/화면 밖 인코더 창의 비디오 프레임이 멈추지 않도록 백그라운드 throttling·occlusion 비활성화.
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");

let tray: Tray | null = null;
let preview: BrowserWindow | null = null;
let editor: BrowserWindow | null = null;
let editorTargetId: string | null = null;

const PREVIEW_HEADER_H = 46; // 접었을 때 남길 헤더 높이
let previewCollapsed = false;
let previewExpandedHeight = 560; // 펼친 상태 높이(복원용)

/* ===== 알림 ===== */
function notify(title: string, body: string) {
  try {
    if (Notification.isSupported()) new Notification({ title, body, silent: true }).show();
  } catch {
    /* 무시 */
  }
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 캡처 직전 preview 창을 숨겨 화면에 찍히지 않게 한다. 이전에 보였는지 반환. */
async function hidePreviewForCapture(): Promise<boolean> {
  const wasVisible = !!(preview && !preview.isDestroyed() && preview.isVisible());
  if (wasVisible) {
    preview!.hide();
    await delay(200); // 창이 실제로 화면에서 사라질 시간 확보(컴포지터 반영).
  }
  return wasVisible;
}

/** 캡처가 없었을 때(취소·실패) 이전 표시 상태로 복원. */
function restorePreview(wasVisible: boolean) {
  if (wasVisible && preview && !preview.isDestroyed()) preview.showInactive();
}

/* ===== 캡처 실행(공통 에러 처리 + preview 갱신) ===== */
async function runCapture(kind: "full" | "region" | "fixed" | "setFixed") {
  const wasVisible = await hidePreviewForCapture();
  try {
    if (kind === "full") {
      await captureFullScreen();
      flashPreview();
    } else if (kind === "region") {
      const r = await captureRegion();
      if (r) flashPreview();
      else restorePreview(wasVisible);
    } else if (kind === "fixed") {
      const cfg = loadConfig();
      if (!cfg.fixedRegion) {
        // 고정 영역 미지정 → 먼저 지정하도록 유도.
        const fr = await setFixedRegion();
        if (fr) notify("고정 영역 지정됨", "이제 단축키로 같은 영역을 반복 캡처할 수 있어요.");
        restorePreview(wasVisible);
        return;
      }
      const r = await captureFixed();
      if (r) flashPreview();
      else restorePreview(wasVisible);
    } else if (kind === "setFixed") {
      const fr = await setFixedRegion();
      if (fr) notify("고정 영역 재지정됨", `${fr.width}×${fr.height} 영역을 저장했어요.`);
      restorePreview(wasVisible);
    }
  } catch (e) {
    console.error("[capture] 실패:", e);
    notify("캡처 실패", (e as Error).message ?? "알 수 없는 오류");
    restorePreview(wasVisible);
  }
}

function flashPreview() {
  ensurePreview();
  // 캡처 직후엔 창을 활성화(포커스)해, 클릭 없이 바로 Ctrl+C로 방금 캡처를 복사할 수 있게 한다.
  // (새 캡처는 렌더러에서 자동 선택됨.) show()는 showInactive와 달리 포커스를 준다.
  preview?.show();
  preview?.focus();
  preview?.webContents.send("captures", store.list());
}

/* ===== 녹화(GIF) ===== */
/** recorder 상태 변화 훅 — 녹화 중엔 preview를 숨겨 GIF에 안 찍히게, 끝나면 다시 표시. */
function setRecordingUi(recording: boolean) {
  if (recording) {
    if (preview && !preview.isDestroyed() && preview.isVisible()) preview.hide();
  } else {
    flashPreview();
  }
  updateTrayMenu();
}

async function runRecord(kind: "full" | "region") {
  if (isRecording()) {
    stopRecording();
    return;
  }
  await startRecording(kind);
}

/* ===== Floating Preview 창 ===== */
function ensurePreview() {
  if (preview && !preview.isDestroyed()) return;
  const cfg = loadConfig();
  const primary = screen.getPrimaryDisplay().workArea;
  const width = cfg.preview.w ?? 300;
  const height = cfg.preview.h ?? 560;
  previewExpandedHeight = height;
  const x = cfg.preview.x ?? primary.x + primary.width - width - 24;
  const y = cfg.preview.y ?? primary.y + primary.height - height - 24;

  preview = new BrowserWindow({
    x,
    y,
    width,
    height,
    minWidth: 240,
    minHeight: 220,
    frame: false,
    transparent: true,
    resizable: true,
    skipTaskbar: true,
    alwaysOnTop: cfg.preview.alwaysOnTop,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "../preload/preview-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  preview.setAlwaysOnTop(cfg.preview.alwaysOnTop, "floating");
  preview.loadFile(path.join(__dirname, "../renderer/preview.html"));
  // 시작 시엔 창을 띄우지 않는다(트레이 상주만). 데이터만 준비.
  preview.once("ready-to-show", () => {
    preview?.webContents.send("captures", store.list());
  });
  const savePos = () => {
    if (!preview || preview.isDestroyed()) return;
    const [px, py] = preview.getPosition();
    saveConfig({ preview: { ...loadConfig().preview, x: px, y: py } });
  };
  const saveSize = () => {
    if (!preview || preview.isDestroyed()) return;
    if (previewCollapsed) return; // 접힌 상태 높이는 저장하지 않음(복원 높이 보존)
    const [pw, ph] = preview.getSize();
    previewExpandedHeight = ph;
    saveConfig({ preview: { ...loadConfig().preview, w: pw, h: ph } });
  };
  preview.on("moved", savePos);
  preview.on("resized", saveSize);
  // 안전장치: 설정 중 창이 숨겨져도 전역 단축키가 죽은 채 남지 않게 재등록(멱등).
  preview.on("hide", () => registerHotkeys());
  preview.on("closed", () => {
    preview = null;
    registerHotkeys();
  });
}

function togglePreview() {
  ensurePreview();
  if (!preview) return;
  if (preview.isVisible()) preview.hide();
  else preview.showInactive();
}

/** 창을 표시/포커스(캡처·프로토콜 트리거 시). 시작 시엔 호출하지 않는다. */
function showPreview() {
  ensurePreview();
  if (!preview || preview.isDestroyed()) return;
  preview.showInactive();
  preview.webContents.send("captures", store.list());
}

/* ===== 이미지 편집 창 ===== */
function openEditor(id: string) {
  const it = store.get(id);
  if (!it || it.kind !== "image") return; // 이미지 캡처만 편집
  if (editor && !editor.isDestroyed()) editor.close();
  editorTargetId = id;
  editor = new BrowserWindow({
    width: 1100,
    height: 780,
    minWidth: 700,
    minHeight: 500,
    backgroundColor: "#0f131b",
    title: "buggle 캡처 편집",
    show: false,
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: true, // require('fabric'), ipcRenderer
      sandbox: false,
    },
  });
  editor.setMenuBarVisibility(false);
  editor.loadFile(path.join(__dirname, "../renderer/editor.html"));
  editor.once("ready-to-show", () => editor?.show());
  editor.on("closed", () => {
    editor = null;
    editorTargetId = null;
  });
}

/* ===== 단축키 ===== */
function registerHotkeys() {
  globalShortcut.unregisterAll();
  const { hotkeys } = loadConfig();
  const map: [string, () => void][] = [
    [hotkeys.fullScreen, () => runCapture("full")],
    [hotkeys.region, () => runCapture("region")],
    [hotkeys.fixed, () => runCapture("fixed")],
    [hotkeys.setFixed, () => runCapture("setFixed")],
    [hotkeys.record, () => runRecord("full")],
  ];
  for (const [accel, fn] of map) {
    if (!accel) continue; // "없음"(빈 문자열) → 등록 안 함
    try {
      const ok = globalShortcut.register(accel, fn);
      if (!ok) console.warn(`[hotkey] 등록 실패(충돌?): ${accel}`);
    } catch (e) {
      console.warn(`[hotkey] 예외 ${accel}:`, e);
    }
  }
}

/* ===== 트레이 ===== */
function updateTrayMenu() {
  if (!tray) return;
  const cfg = loadConfig();
  const menu = Menu.buildFromTemplate([
    { label: `전체 화면 캡처 (${cfg.hotkeys.fullScreen})`, click: () => runCapture("full") },
    { label: `선택 영역 캡처 (${cfg.hotkeys.region})`, click: () => runCapture("region") },
    { label: `고정 영역 캡처 (${cfg.hotkeys.fixed})`, click: () => runCapture("fixed") },
    { label: `고정 영역 재지정 (${cfg.hotkeys.setFixed})`, click: () => runCapture("setFixed") },
    { type: "separator" },
    ...(isRecording()
      ? [{ label: "■ 녹화 중지", click: () => stopRecording() }]
      : [
          { label: `전체 화면 녹화 (${cfg.hotkeys.record})`, click: () => runRecord("full") },
          { label: "영역 녹화", click: () => runRecord("region") },
        ]),
    { type: "separator" },
    { label: "미리보기 표시/숨김", click: () => togglePreview() },
    {
      label: "로그인 시 자동 시작",
      type: "checkbox",
      checked: cfg.autoStart,
      click: (item) => {
        saveConfig({ autoStart: item.checked });
        applyAutoStart();
        updateTrayMenu();
      },
    },
    { type: "separator" },
    // 업데이트 — 다운로드 완료 시 즉시 적용 메뉴 노출(상주 앱이라 '종료 시 설치'만으론 적용 기회가 없음).
    ...(updateReadyVersion
      ? [{ label: `⬆ 업데이트 적용하고 재시작 (v${updateReadyVersion})`, click: () => applyUpdateNow() }]
      : [{ label: "업데이트 확인", click: () => void manualCheckForUpdates() }]),
    { type: "separator" },
    { label: `API 포트: ${cfg.port} · v${app.getVersion()}`, enabled: false },
    { label: "종료", click: () => app.quit() },
  ]);
  tray.setContextMenu(menu);
}

function buildTray() {
  // 간단한 1x1 투명 아이콘 폴백(빌드시 build/icon 교체 권장).
  const icon = nativeImage.createEmpty();
  tray = new Tray(icon);
  tray.setToolTip("buggle 캡처");
  updateTrayMenu();
  tray.on("click", () => togglePreview());
}

/* ===== IPC (preview 렌더러 ↔ main) ===== */
function registerIpc() {
  ipcMain.handle("preview:list", () => store.list());
  ipcMain.handle("preview:delete", (_e, id: string) => store.remove(id));
  ipcMain.handle("preview:copy", (_e, id: string) => {
    const fp = store.filePath(id);
    if (!fp) return false;
    let img = nativeImage.createFromPath(fp);
    // GIF 등은 createFromPath가 빈 이미지를 줄 수 있음 → 썸네일(PNG)로 폴백.
    if (img.isEmpty()) {
      const tp = store.thumbPath(id);
      if (tp) img = nativeImage.createFromPath(tp);
    }
    if (img.isEmpty()) return false;
    clipboard.writeImage(img);
    return true;
  });
  // 여러 장 → 파일 목록(CF_HDROP)으로 클립보드에 복사. 브라우저에 Ctrl+V 시 여러 File로 전달됨(GIF 애니메이션 유지).
  ipcMain.handle("preview:copyFiles", async (_e, ids: string[]) => {
    const paths = ids.map((id) => store.filePath(id)).filter((p): p is string => !!p && fs.existsSync(p));
    if (paths.length === 0) return false;
    if (process.platform === "win32") {
      // Windows: CF_HDROP(파일 목록)로 클립보드에 담아 브라우저 Ctrl+V 시 여러 File로 붙는다.
      // PowerShell Set-Clipboard -LiteralPath (경로의 홑따옴표는 '' 로 escape).
      const quoted = paths.map((p) => `'${p.replace(/'/g, "''")}'`).join(",");
      return await new Promise<boolean>((resolve) => {
        execFile(
          "powershell",
          ["-NoProfile", "-NonInteractive", "-Command", `Set-Clipboard -LiteralPath ${quoted}`],
          (err) => {
            if (err) console.warn("[copyFiles] Set-Clipboard 실패:", err.message);
            resolve(!err);
          },
        );
      });
    }
    // macOS 등: NSPasteboard는 여러 파일을 브라우저 붙여넣기(DataTransfer.files)로 넘겨주지 못한다.
    // 첫 이미지만 비트맵으로 클립보드에 담는 폴백(단일 붙여넣기). 여러 장은 웹 캡처 피커로 유도한다.
    const first = nativeImage.createFromPath(paths[0]);
    if (!first.isEmpty()) {
      clipboard.writeImage(first);
      return true;
    }
    return false;
  });
  ipcMain.handle("preview:capture", (_e, kind: "full" | "region" | "fixed") => runCapture(kind));
  ipcMain.handle("preview:record", (_e, kind: "full" | "region") => runRecord(kind === "region" ? "region" : "full"));
  ipcMain.handle("preview:getHotkeys", () => loadConfig().hotkeys);
  // 단축키 설정 중엔 전역 단축키 해제(설정 중 조합을 눌러도 캡처가 발동하지 않게). 닫으면 재등록.
  ipcMain.handle("preview:suspendHotkeys", () => globalShortcut.unregisterAll());
  ipcMain.handle("preview:resumeHotkeys", () => registerHotkeys());
  ipcMain.handle("preview:getRecording", () => loadConfig().recording);
  ipcMain.handle("preview:setHotkeys", (_e, hk: Partial<Hotkeys>) => {
    const cfg = saveConfig({ hotkeys: { ...loadConfig().hotkeys, ...hk } });
    registerHotkeys(); // 새 단축키 즉시 반영
    updateTrayMenu(); // 트레이 라벨 갱신
    return cfg.hotkeys;
  });
  ipcMain.on("preview:hide", () => preview?.hide());
  // 이미지 편집 창.
  ipcMain.handle("preview:edit", (_e, id: string) => openEditor(id));
  ipcMain.handle("editor:load", () => {
    if (!editorTargetId) return { dataUrl: "", fileName: "image.png" };
    const it = store.get(editorTargetId);
    const fp = store.filePath(editorTargetId);
    if (!it || !fp || !fs.existsSync(fp)) return { dataUrl: "", fileName: "image.png" };
    const b64 = fs.readFileSync(fp).toString("base64");
    // 로컬 파일을 data URL로 전달 → canvas taint 회피.
    return { dataUrl: `data:${it.mimeType};base64,${b64}`, fileName: it.fileName };
  });
  ipcMain.handle("editor:save", (_e, png: Uint8Array) => {
    if (!editorTargetId) return false;
    const ok = store.replaceImage(editorTargetId, Buffer.from(png));
    if (editor && !editor.isDestroyed()) editor.close();
    flashPreview();
    return ok;
  });
  ipcMain.handle("editor:cancel", () => {
    if (editor && !editor.isDestroyed()) editor.close();
  });
  // 접기/펼치기 → 창 높이를 헤더만 남기거나 원래 높이로 복원.
  ipcMain.on("preview:collapse", (_e, collapsed: boolean) => {
    if (!preview || preview.isDestroyed()) return;
    const [w] = preview.getSize();
    previewCollapsed = collapsed;
    if (collapsed) {
      preview.setResizable(false);
      preview.setMinimumSize(240, PREVIEW_HEADER_H);
      preview.setSize(w, PREVIEW_HEADER_H);
    } else {
      preview.setMinimumSize(240, 220);
      preview.setSize(w, previewExpandedHeight || 560);
      preview.setResizable(true);
    }
  });
  // 렌더러가 래스터화한 Buggle 로고를 트레이 아이콘으로 설정.
  ipcMain.on("tray:icon", (_e, d: { p16: string; p32: string }) => {
    try {
      const icon = nativeImage.createFromDataURL(d.p16);
      if (d.p32) icon.addRepresentation({ scaleFactor: 2, dataURL: d.p32 });
      tray?.setImage(icon);
    } catch (e) {
      console.warn("[tray] 아이콘 설정 실패:", e);
    }
  });
  ipcMain.handle("preview:status", () => ({ port: loadConfig().port, running: true }));
  // preview 렌더러가 로컬 서버(썸네일 로드)에 접근할 포트·토큰. (헬퍼 자기 창이므로 노출 안전)
  ipcMain.handle("preview:conn", () => {
    const c = loadConfig();
    return { port: c.port, token: c.token };
  });
  // store 변경 시 preview 갱신
  store.on("change", () => {
    if (preview && !preview.isDestroyed()) preview.webContents.send("captures", store.list());
  });
}

/* ===== 프로토콜 (buggle-capture://) ===== */
const PROTOCOL = "buggle-capture";

/** argv에서 buggle-capture:// URL을 찾는다(웹/OS가 실행 시 전달). */
function protocolUrlFromArgv(argv: string[]): string | null {
  return argv.find((a) => a.startsWith(`${PROTOCOL}://`)) ?? null;
}

/** 자동 업데이트 — 설치 빌드에서만. 새 버전을 조용히 받아 다음 종료/재시작 시 적용. */
/** 상주 앱이라 시작 시 1회 확인만으론 새 버전을 영영 못 본다 → 주기적으로 재확인. */
const UPDATE_CHECK_INTERVAL_MS = 2 * 60 * 60 * 1000; // 2시간
let updateReadyVersion: string | null = null; // 다운로드 완료된 새 버전(트레이 '적용' 메뉴용)

/** 자동 업데이트 지원 여부(설치 빌드 + Windows). */
function canAutoUpdate(): boolean {
  // macOS는 Developer ID 코드서명 없이는 electron-updater(Squirrel.Mac)가 서명 검증에서 실패한다.
  // 서명 붙이기 전까지 mac은 자동업데이트를 끄고 Homebrew(brew upgrade)로 갱신한다.
  return app.isPackaged && process.platform !== "darwin";
}

function checkForUpdates() {
  if (!canAutoUpdate()) return;
  try {
    const { autoUpdater } = electronUpdater;
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true; // 종료 시에도 적용(트레이에서 즉시 적용도 가능)
    autoUpdater.on("update-downloaded", (info) => {
      updateReadyVersion = info.version;
      updateTrayMenu(); // 트레이에 "업데이트 적용하고 재시작" 노출
      notify("업데이트 준비됨", `새 버전 ${info.version} — 트레이 메뉴의 '업데이트 적용하고 재시작'으로 바로 적용할 수 있어요.`);
    });
    autoUpdater.on("error", (e) => console.warn("[updater] 오류:", e?.message ?? e));
    const run = () => void autoUpdater.checkForUpdates().catch((e) => console.warn("[updater] 확인 실패:", e?.message ?? e));
    run(); // 시작 시 1회
    setInterval(run, UPDATE_CHECK_INTERVAL_MS); // 이후 주기적으로
  } catch (e) {
    console.warn("[updater] 초기화 실패:", e);
  }
}

/** 다운로드된 업데이트를 즉시 적용(앱 종료 후 설치·재시작). */
function applyUpdateNow() {
  try {
    electronUpdater.autoUpdater.quitAndInstall();
  } catch (e) {
    console.warn("[updater] 적용 실패:", e);
    notify("업데이트 적용 실패", (e as Error)?.message ?? "알 수 없는 오류");
  }
}

/** 트레이 '업데이트 확인' — 사용자가 직접 확인하고 결과를 알림으로 받는다. */
async function manualCheckForUpdates() {
  if (!app.isPackaged) return notify("업데이트 확인", "개발 모드에선 지원하지 않아요.");
  if (process.platform === "darwin") return notify("업데이트 확인", "macOS는 brew upgrade로 갱신해주세요.");
  if (updateReadyVersion) {
    return notify("업데이트 준비됨", `새 버전 ${updateReadyVersion} — 트레이의 '업데이트 적용하고 재시작'을 눌러주세요.`);
  }
  try {
    const r = await electronUpdater.autoUpdater.checkForUpdates();
    const v = r?.updateInfo?.version;
    if (v && v !== app.getVersion()) notify("업데이트 발견", `새 버전 ${v} — 내려받는 중이에요.`);
    else notify("업데이트 확인", `최신 버전입니다 (v${app.getVersion()}).`);
  } catch (e) {
    notify("업데이트 확인 실패", (e as Error)?.message ?? "네트워크 오류");
  }
}

/** 로그인 시 자동 시작 반영. dev(비패키지)에서는 건너뜀. */
function applyAutoStart() {
  if (!app.isPackaged) return; // dev(npm start)에서는 등록 안 함
  try {
    app.setLoginItemSettings({ openAtLogin: loadConfig().autoStart, args: [] });
  } catch (e) {
    console.warn("[autostart] 설정 실패:", e);
  }
}

/* ===== 부트 ===== */
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  // 프로토콜 클라이언트 등록(dev는 execPath+argv로).
  if (process.defaultApp && process.argv.length >= 2) {
    app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(process.argv[1])]);
  } else {
    app.setAsDefaultProtocolClient(PROTOCOL);
  }

  app.on("second-instance", (_e, argv) => {
    // Buggle "캡처"/프로토콜로 실행 → 창 표시. 그 외 재실행 → 토글.
    if (protocolUrlFromArgv(argv)) showPreview();
    else togglePreview();
  });

  // macOS: 독 아이콘 클릭 또는 앱 아이콘으로 직접 실행 시 미리보기 창을 띄운다.
  // (트레이 상주 앱이라 창이 없어 "눌러도 반응 없다"는 혼선 방지. 로그인 자동 시작으로
  //  백그라운드에서 열릴 땐 activate가 발생하지 않아 조용히 트레이만 상주한다.)
  app.on("activate", () => showPreview());

  app.whenReady().then(() => {
    if (process.platform === "win32") app.setAppUserModelId("com.buggle.capturehelper");
    loadConfig();
    applyAutoStart();
    checkForUpdates();
    startServer();
    initRecorder({ setRecordingUi });
    registerRecorderIpc();
    registerIpc();
    registerHotkeys();
    buildTray();
    ensurePreview(); // 숨긴 채 생성만(트레이 상주). 시작 시 노출 안 함.
    // 프로토콜로 실행된 경우에만 창 표시.
    if (protocolUrlFromArgv(process.argv)) showPreview();
  });
}

app.on("window-all-closed", () => {
  // 트레이 앱 — 창이 모두 닫혀도 종료하지 않는다(리스너가 있으면 기본 quit이 일어나지 않음).
});
app.on("will-quit", () => {
  if (isRecording()) stopRecording();
  globalShortcut.unregisterAll();
  stopServer();
});
