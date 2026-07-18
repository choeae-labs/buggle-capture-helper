import { app, Tray, Menu, BrowserWindow, globalShortcut, ipcMain, nativeImage, clipboard, Notification, screen } from "electron";
import path from "node:path";
import fs from "node:fs";
import { execFile } from "node:child_process";
import electronUpdater from "electron-updater";
import { dataDir, loadConfig, saveConfig, type Hotkeys } from "./config";
import { store } from "./store";
import { startServer, stopServer } from "./server";
import { captureFullScreen, captureRegion, captureFixed, setFixedRegion } from "./capture";
import { initRecorder, isRecording, registerRecorderIpc, startRecording, stopRecording } from "./recorder";
import { focusAndPaste, focusApp, getForegroundWindow, getLastPasteDebug, hasMacAccessibility, pressPasteKey } from "./win-paste";

// 숨은/화면 밖 인코더 창의 비디오 프레임이 멈추지 않도록 백그라운드 throttling·occlusion 비활성화.
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");

let tray: Tray | null = null;
let preview: BrowserWindow | null = null;
let editor: BrowserWindow | null = null;
let editorTargetId: string | null = null;

const PREVIEW_HEADER_H = 42; // 접었을 때 남길 헤더 높이
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
  hideZoomWin(); // 확대 창도 캡처에 안 찍히게 숨긴다
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

/* ===== 전역 붙여넣기(어느 앱에서든 Ctrl+Shift+V) =====
   메인 패널이 아니라, 커서 옆에 캡처 썸네일만 쭉 늘어놓는 가벼운 창을 띄운다
   (윈도우 Win+V 클립보드 기록과 같은 결). 고르면 그 자리에 바로 붙는다. */
let quickWin: BrowserWindow | null = null;
// 창을 열기 직전에 쓰던 창. 붙여넣기 후 여기로 포커스를 되돌린다.
let quickPasteTarget: string | null = null;

const QUICK_W = 620;
const QUICK_H = 168;

function ensureQuickWin() {
  if (quickWin && !quickWin.isDestroyed()) return;
  quickWin = new BrowserWindow({
    width: QUICK_W,
    height: QUICK_H,
    frame: false,
    transparent: true,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "../preload/quickpaste-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  quickWin.setAlwaysOnTop(true, "pop-up-menu"); // 다른 앱 위에 확실히 뜨도록
  quickWin.setContentProtection(true); // 캡처에 이 창이 찍히지 않게
  quickWin.loadFile(path.join(__dirname, "../renderer/quickpaste.html"));
  // 다른 곳을 클릭하면(포커스 상실) 조용히 닫는다 — 고르기 창이므로 눌러붙어 있으면 방해된다.
  quickWin.on("blur", () => hideQuickWin());
  quickWin.on("closed", () => {
    quickWin = null;
  });
}

function hideQuickWin() {
  quickPasteTarget = null;
  if (quickWin && !quickWin.isDestroyed() && quickWin.isVisible()) quickWin.hide();
}

/** 커서가 있는 화면 안쪽, 커서 바로 아래에 놓는다(다중 모니터 대응). */
function placeQuickWin() {
  if (!quickWin || quickWin.isDestroyed()) return;
  const pt = screen.getCursorScreenPoint();
  const wa = screen.getDisplayNearestPoint(pt).workArea;
  const x = Math.max(wa.x + 8, Math.min(pt.x - QUICK_W / 2, wa.x + wa.width - QUICK_W - 8));
  // 아래에 자리가 없으면 커서 위로 띄운다.
  const below = pt.y + 18;
  const y = below + QUICK_H + 8 <= wa.y + wa.height ? below : Math.max(wa.y + 8, pt.y - QUICK_H - 18);
  quickWin.setPosition(Math.round(x), Math.round(y));
}

/**
 * 전역 단축키 → 캡처 선택 창.
 *
 * 포커스를 뺏기 "전에" 대상 창을 기록해야 나중에 그리로 돌아가 붙여넣을 수 있다.
 */
async function openQuickPaste() {
  if (isRecording()) return; // 녹화 중엔 띄우지 않는다(GIF에 찍힘)
  if (quickWin && !quickWin.isDestroyed() && quickWin.isVisible()) {
    hideQuickWin(); // 같은 단축키를 다시 누르면 닫기(토글)
    return;
  }
  const target = await getForegroundWindow();
  ensureQuickWin();
  quickPasteTarget = target;
  placeQuickWin();
  quickWin?.show();
  quickWin?.focus();
  quickWin?.webContents.send("quick:show", store.list());
}

/* ===== 확대 미리보기 창 =====
   패널 안 요소로 그리면 패널 창(360×520) 밖으로 못 나가 작게 보인다.
   → 별도 투명 창으로 띄워 화면의 최대 70%까지 크게 보여준다. 마우스는 무시(순수 오버레이). */
let zoomWin: BrowserWindow | null = null;

/** 로컬 API의 원본 이미지 URL(GIF는 애니메이션 유지). 토큰 포함. */
function zoomImageUrl(it: { fileUrl?: string; thumbnailUrl: string }): string {
  const c = loadConfig();
  const rel = it.fileUrl || it.thumbnailUrl;
  if (!rel) return "";
  return `http://127.0.0.1:${c.port}${rel}?token=${encodeURIComponent(c.token)}`;
}

function ensureZoomWin() {
  if (zoomWin && !zoomWin.isDestroyed()) return;
  zoomWin = new BrowserWindow({
    width: 400,
    height: 300,
    frame: false,
    transparent: true,
    resizable: false,
    skipTaskbar: true,
    focusable: false, // 포커스를 뺏지 않는다(패널 hover 유지)
    alwaysOnTop: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "../preload/zoom-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  zoomWin.setAlwaysOnTop(true, "pop-up-menu");
  zoomWin.setIgnoreMouseEvents(true); // 클릭 통과 — 순수 미리보기
  zoomWin.setContentProtection(true); // 캡처에 안 찍히게
  zoomWin.loadFile(path.join(__dirname, "../renderer/zoom.html"));
  zoomWin.on("closed", () => {
    zoomWin = null;
  });
}

function hideZoomWin() {
  if (zoomWin && !zoomWin.isDestroyed() && zoomWin.isVisible()) zoomWin.hide();
}

/** 확대 창을 이미지 비율대로 크게(화면 70% 상한) 잡고, 패널 옆에 배치한다. */
function showZoomWin(id: string, anchor: { x: number; y: number; w: number; h: number }) {
  if (!preview || preview.isDestroyed()) return;
  const it = store.list().find((x) => x.id === id);
  if (!it) return;
  const url = zoomImageUrl(it);
  if (!url) return;

  ensureZoomWin();
  const pb = preview.getBounds();
  const wa = screen.getDisplayNearestPoint({ x: pb.x, y: pb.y }).workArea;
  const iw = it.width && it.width > 0 ? it.width : 800;
  const ih = it.height && it.height > 0 ? it.height : 600;
  const PAD = 12; // 테두리·그림자 여백
  const maxW = wa.width * 0.52;
  const maxH = wa.height * 0.52;
  const scale = Math.min(maxW / iw, maxH / ih, 1.5); // 작은 캡처도 최대 1.5배까지 확대
  const winW = Math.round(iw * scale) + PAD * 2;
  const winH = Math.round(ih * scale) + PAD * 2;

  // 패널 왼쪽에 우선 배치(패널이 보통 우하단). 자리 없으면 오른쪽.
  let x = pb.x - winW - 10;
  if (x < wa.x + 6) x = pb.x + pb.width + 10;
  x = Math.max(wa.x + 6, Math.min(x, wa.x + wa.width - winW - 6));
  // 세로: 앵커(썸네일) 중앙에 맞춤 → 화면 안으로 클램프.
  const anchorMidY = pb.y + anchor.y + anchor.h / 2;
  let y = Math.round(anchorMidY - winH / 2);
  y = Math.max(wa.y + 6, Math.min(y, wa.y + wa.height - winH - 6));

  zoomWin!.setBounds({ x, y, width: winW, height: winH });
  zoomWin!.webContents.send("zoom:img", { url, isGif: it.kind === "gif" });
  zoomWin!.showInactive(); // 포커스 없이 표시
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
  const width = cfg.preview.w ?? 360;
  const height = cfg.preview.h ?? 520;
  previewExpandedHeight = height;
  const x = cfg.preview.x ?? primary.x + primary.width - width - 24;
  const y = cfg.preview.y ?? primary.y + primary.height - height - 24;

  preview = new BrowserWindow({
    x,
    y,
    width,
    height,
    minWidth: 320,
    minHeight: 200,
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
  preview.on("hide", () => {
    registerHotkeys();
    hideZoomWin(); // 패널이 숨으면 확대 창도 닫는다
  });
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
    [hotkeys.pastePicker, () => void openQuickPaste()],
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
/** 1장 → 비트맵으로 클립보드에(어떤 앱에나 이미지로 붙는다). */
function copyOne(id: string): boolean {
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
}

/** 여러 장 → 파일 목록(CF_HDROP)으로 클립보드에. 브라우저 Ctrl+V 시 여러 File로 전달됨(GIF 애니메이션 유지). */
async function copyMany(ids: string[]): Promise<boolean> {
  const paths = ids.map((id) => store.filePath(id)).filter((p): p is string => !!p && fs.existsSync(p));
  if (paths.length === 0) return false;
  if (process.platform === "win32") {
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
}

/** 선택분을 클립보드에 담는다. 1장이면 비트맵(어디에나), 여러 장이면 파일 목록. */
function copySelection(ids: string[]): Promise<boolean> {
  return ids.length > 1 ? copyMany(ids) : Promise.resolve(copyOne(ids[0]));
}

function registerIpc() {
  ipcMain.handle("preview:list", () => store.list());
  ipcMain.handle("preview:delete", (_e, id: string) => store.remove(id));
  ipcMain.handle("preview:copy", (_e, id: string) => copyOne(id));
  ipcMain.handle("preview:copyFiles", (_e, ids: string[]) => copyMany(ids));
  // 빠른 붙여넣기 창.
  ipcMain.handle("quick:list", () => store.list());
  ipcMain.on("quick:cancel", () => hideQuickWin());
  // 클립보드에 담고 → 창을 숨긴 뒤 → 직전 창으로 돌아가 Ctrl+V를 대신 눌러준다.
  ipcMain.handle("quick:paste", async (_e, ids: string[]) => {
    if (ids.length === 0) return false;
    const target = quickPasteTarget;
    quickPasteTarget = null;
    // 우리 창이 앞에 있으면 대상 창으로 포커스가 안 돌아간다 → 먼저 숨긴다.
    if (quickWin && !quickWin.isDestroyed()) quickWin.hide();

    let pasted = false;
    if (process.platform === "darwin" && ids.length > 1) {
      // macOS 클립보드는 다중 파일을 브라우저/입력창 붙여넣기로 전달하지 못한다(NSPasteboard 한계 —
      // copyMany는 첫 장만 담김) → 대상 앱에 포커스를 준 뒤 '한 장 복사 → ⌘V'를 장수만큼 반복(순차 붙여넣기).
      if (await focusApp(target)) {
        await delay(250); // 포커스 전환 완료 대기
        pasted = true;
        for (const id of ids) {
          if (!copyOne(id)) {
            pasted = false;
            continue; // 이 장은 건너뛰고 다음 장
          }
          if (!(await pressPasteKey())) {
            pasted = false;
            break; // 키 전송 자체가 막히면 중단(권한 문제)
          }
          await delay(350); // 대상 앱이 클립보드를 읽은 뒤 다음 장으로 교체
        }
      }
    } else {
      const copied = await copySelection(ids);
      if (!copied) return false;
      // 실패해도 클립보드엔 남아 있으므로 사용자가 직접 Ctrl+V(⌘V) 하면 된다.
      pasted = await focusAndPaste(target);
    }
    for (const id of ids) store.markUsed(id); // 붙여넣은 캡처는 "첨부됨"으로
    // macOS: 실패 시 원인 진단을 알림+로그로 남긴다(실측용). 복사는 이미 됐으니 ⌘V로는 붙는다.
    if (!pasted && process.platform === "darwin") {
      const dbg = getLastPasteDebug() || `target=${target ?? "(없음)"} — 진단 없음`;
      try {
        fs.appendFileSync(path.join(dataDir(), "paste-debug.log"), `${new Date().toISOString()} ${dbg}\n`);
      } catch {
        /* 무시 */
      }
      notify("자동 붙여넣기 실패(진단)", dbg.slice(0, 180));
      if (!hasMacAccessibility(false)) hasMacAccessibility(true); // '손쉬운 사용' 권한창 유도
    }
    return pasted;
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
  // 보관 설정(최대 개수·보관 기간) 조회/저장 + 전체 삭제.
  ipcMain.handle("preview:getSettings", () => {
    const c = loadConfig();
    return { maxItems: c.maxItems, retentionDays: c.retentionDays };
  });
  ipcMain.handle("preview:setSettings", (_e, s: { maxItems?: number; retentionDays?: number }) => {
    const next: Partial<{ maxItems: number; retentionDays: number }> = {};
    if (typeof s.maxItems === "number" && isFinite(s.maxItems)) next.maxItems = Math.max(1, Math.min(1000, Math.round(s.maxItems)));
    if (typeof s.retentionDays === "number" && isFinite(s.retentionDays)) next.retentionDays = Math.max(1, Math.min(365, Math.round(s.retentionDays)));
    const c = saveConfig(next);
    store.prune(); // 개수/기간 줄이면 즉시 반영
    return { maxItems: c.maxItems, retentionDays: c.retentionDays };
  });
  ipcMain.handle("preview:clearAll", () => store.clearAll());
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
  // 확대 미리보기 창(패널 밖 별도 창).
  ipcMain.on("zoom:show", (_e, id: string, anchor: { x: number; y: number; w: number; h: number }) => showZoomWin(id, anchor));
  ipcMain.on("zoom:hide", () => hideZoomWin());
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
