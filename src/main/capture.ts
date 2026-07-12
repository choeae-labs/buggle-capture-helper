import { screen, desktopCapturer, nativeImage, BrowserWindow, ipcMain, type NativeImage } from "electron";
import path from "node:path";
import { store, type CaptureItem } from "./store";
import { loadConfig, saveConfig, type FixedRegion } from "./config";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 커서가 있는 디스플레이. */
export function displayUnderCursor() {
  return screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
}
function displayById(id: string) {
  return screen.getAllDisplays().find((d) => String(d.id) === String(id)) ?? null;
}

/** 대상 디스플레이의 desktopCapturer screen source id(getUserMedia chromeMediaSourceId용). */
export async function getDisplaySourceId(display: Electron.Display): Promise<string> {
  const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 1, height: 1 } });
  const source = sources.find((s) => String(s.display_id) === String(display.id)) ?? sources[0];
  if (!source) throw new Error("녹화할 화면 소스를 찾지 못했습니다.");
  return source.id;
}

/** 한 디스플레이를 실제 픽셀 해상도로 캡처(NativeImage). display_id로 소스 매칭. */
async function captureDisplayImage(display: Electron.Display): Promise<{ img: NativeImage; scale: number }> {
  const scale = display.scaleFactor || 1;
  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize: { width: Math.round(display.size.width * scale), height: Math.round(display.size.height * scale) },
  });
  const source =
    sources.find((s) => String(s.display_id) === String(display.id)) ??
    sources[0]; // 폴백: 첫 화면
  if (!source) throw new Error("캡처할 화면 소스를 찾지 못했습니다.");
  return { img: source.thumbnail, scale };
}

/** 이미지 → 저장(썸네일 생성 포함). */
function saveImage(img: NativeImage, displayId: string): CaptureItem {
  const size = img.getSize();
  const buffer = img.toPNG();
  const thumb = img.resize({ width: Math.min(360, size.width) }).toPNG();
  return store.add({
    buffer,
    thumbnail: thumb,
    mimeType: "image/png",
    kind: "image",
    width: size.width,
    height: size.height,
    source: { displayId },
  });
}

/** 전체 화면 캡처(커서 모니터). */
export async function captureFullScreen(): Promise<CaptureItem> {
  const display = displayUnderCursor();
  const { img } = await captureDisplayImage(display);
  return saveImage(img, String(display.id));
}

/** DIP(디스플레이 로컬) 영역 → 픽셀 crop. */
function cropRegion(img: NativeImage, region: Rect, scale: number): NativeImage {
  const rect = {
    x: Math.max(0, Math.round(region.x * scale)),
    y: Math.max(0, Math.round(region.y * scale)),
    width: Math.max(1, Math.round(region.width * scale)),
    height: Math.max(1, Math.round(region.height * scale)),
  };
  return img.crop(rect);
}

/** 선택 영역 캡처 — 모든 모니터 오버레이로 드래그 → 고른 모니터 캡처 후 crop. */
export async function captureRegion(): Promise<CaptureItem | null> {
  const picked = await pickRegionMulti();
  if (!picked) return null;
  const { img, scale } = await captureDisplayImage(picked.display);
  const cropped = cropRegion(img, picked.region, scale);
  return saveImage(cropped, String(picked.display.id));
}

/** 고정 영역 캡처 — 저장된 좌표로 즉시 crop. 없으면 먼저 지정 유도(null 반환). */
export async function captureFixed(): Promise<CaptureItem | null> {
  const cfg = loadConfig();
  const fr = cfg.fixedRegion;
  if (!fr) return null;
  const display = displayById(fr.displayId) ?? displayUnderCursor();
  const { img, scale } = await captureDisplayImage(display);
  const cropped = cropRegion(img, { x: fr.x, y: fr.y, width: fr.width, height: fr.height }, scale);
  return saveImage(cropped, String(display.id));
}

/** 고정 영역 재지정 — 모든 모니터 오버레이로 드래그해 좌표 저장. */
export async function setFixedRegion(): Promise<FixedRegion | null> {
  const picked = await pickRegionMulti();
  if (!picked) return null;
  const fr: FixedRegion = { displayId: String(picked.display.id), ...picked.region };
  saveConfig({ fixedRegion: fr });
  return fr;
}

/* ===== 오버레이(선택 영역 드래그) — 모든 모니터에 표시 ===== */

let overlayWins: BrowserWindow[] = [];

function createOverlay(display: Electron.Display): BrowserWindow {
  const b = display.bounds; // 스크린 좌표(DIP)
  const win = new BrowserWindow({
    x: b.x,
    y: b.y,
    width: b.width,
    height: b.height,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    fullscreenable: false,
    hasShadow: false,
    enableLargerThanScreen: true,
    webPreferences: {
      preload: path.join(__dirname, "../preload/overlay-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setAlwaysOnTop(true, "screen-saver");
  win.setBounds({ x: b.x, y: b.y, width: b.width, height: b.height });
  win.loadFile(path.join(__dirname, "../renderer/overlay.html"));
  return win;
}

/**
 * 모든 모니터에 오버레이를 띄우고, 드래그로 영역을 고른다.
 * 어느 모니터에서 골랐는지 판별해 그 디스플레이와 디스플레이-로컬 영역(DIP)을 반환.
 */
export function pickRegionMulti(): Promise<{ display: Electron.Display; region: Rect } | null> {
  return new Promise((resolve) => {
    for (const w of overlayWins) if (!w.isDestroyed()) w.close();
    overlayWins = [];

    const cursorDisplay = displayUnderCursor();
    const entries = screen.getAllDisplays().map((display) => ({ win: createOverlay(display), display }));
    overlayWins = entries.map((e) => e.win);

    let done = false;
    const finish = (result: { display: Electron.Display; region: Rect } | null) => {
      if (done) return;
      done = true;
      ipcMain.removeListener("overlay:select", onSelect);
      ipcMain.removeListener("overlay:cancel", onCancel);
      for (const { win } of entries) if (!win.isDestroyed()) win.close();
      overlayWins = [];
      resolve(result);
    };
    const onSelect = (e: Electron.IpcMainEvent, rect: Rect) => {
      const hit = entries.find((x) => !x.win.isDestroyed() && x.win.webContents.id === e.sender.id);
      if (!hit) return;
      finish(rect.width >= 3 && rect.height >= 3 ? { display: hit.display, region: rect } : null);
    };
    const onCancel = () => finish(null);
    ipcMain.on("overlay:select", onSelect);
    ipcMain.on("overlay:cancel", onCancel);

    for (const { win, display } of entries) {
      // 커서가 있는 모니터의 오버레이에 포커스(Esc 키 수신용). 나머지는 비활성 표시.
      const focusThis = display.id === cursorDisplay.id;
      win.once("ready-to-show", () => (focusThis ? win.show() : win.showInactive()));
    }
  });
}
