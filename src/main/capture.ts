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

/** 선택 영역 캡처 — 오버레이로 드래그 → 그 디스플레이 캡처 후 crop. */
export async function captureRegion(): Promise<CaptureItem | null> {
  const display = displayUnderCursor();
  const region = await pickRegion(display);
  if (!region) return null;
  const { img, scale } = await captureDisplayImage(display);
  const cropped = cropRegion(img, region, scale);
  return saveImage(cropped, String(display.id));
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

/** 고정 영역 재지정 — 오버레이로 드래그해 좌표 저장. */
export async function setFixedRegion(): Promise<FixedRegion | null> {
  const display = displayUnderCursor();
  const region = await pickRegion(display);
  if (!region) return null;
  const fr: FixedRegion = { displayId: String(display.id), ...region };
  saveConfig({ fixedRegion: fr });
  return fr;
}

/* ===== 오버레이(선택 영역 드래그) ===== */

let overlayWin: BrowserWindow | null = null;

export function pickRegion(display: Electron.Display): Promise<Rect | null> {
  return new Promise((resolve) => {
    if (overlayWin) {
      overlayWin.close();
      overlayWin = null;
    }
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
    overlayWin = win;
    win.setAlwaysOnTop(true, "screen-saver");
    win.loadFile(path.join(__dirname, "../renderer/overlay.html"));
    win.once("ready-to-show", () => win.show());

    let done = false;
    const finish = (rect: Rect | null) => {
      if (done) return;
      done = true;
      ipcMain.removeListener("overlay:select", onSelect);
      ipcMain.removeListener("overlay:cancel", onCancel);
      if (!win.isDestroyed()) win.close();
      overlayWin = null;
      resolve(rect && rect.width >= 3 && rect.height >= 3 ? rect : null);
    };
    const onSelect = (_e: unknown, rect: Rect) => finish(rect);
    const onCancel = () => finish(null);
    ipcMain.on("overlay:select", onSelect);
    ipcMain.on("overlay:cancel", onCancel);
    win.on("closed", () => finish(null));
  });
}
