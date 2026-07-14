import { BrowserWindow, ipcMain, Notification, screen } from "electron";
import path from "node:path";
import { loadConfig } from "./config";
import { store } from "./store";
import { displayUnderCursor, getDisplaySourceId, pickRegionMulti, type Rect } from "./capture";

/**
 * 화면 녹화 컨트롤러(main). 숨은 recorder 창이 desktop 스트림을 canvas로 그려
 * gifenc로 점진 인코딩하고, content-protected 인디케이터로 정지 UI를 제공한다.
 */

type RecordKind = "full" | "region";

interface RecorderHooks {
  /** 녹화 상태 변화 — main이 트레이 갱신 + preview 숨김/표시 처리. */
  setRecordingUi: (recording: boolean) => void;
}

let hooks: RecorderHooks = { setRecordingUi: () => {} };
export function initRecorder(h: RecorderHooks) {
  hooks = h;
}

let encoder: BrowserWindow | null = null;
let indicator: BrowserWindow | null = null;
let regionFrame: BrowserWindow | null = null;
let recording = false;
let autoStopTimer: ReturnType<typeof setTimeout> | null = null;
let tickTimer: ReturnType<typeof setInterval> | null = null;
let startedAt = 0;
let finalizing = false;

export function isRecording(): boolean {
  return recording;
}

function notify(title: string, body: string) {
  try {
    if (Notification.isSupported()) new Notification({ title, body, silent: true }).show();
  } catch {
    /* 무시 */
  }
}

/** content-protected 인디케이터(캡처에 안 찍힘). 상단 중앙 작은 바. */
function createIndicator() {
  const wa = screen.getPrimaryDisplay().workArea;
  const w = 190;
  const h = 46;
  indicator = new BrowserWindow({
    x: Math.round(wa.x + (wa.width - w) / 2),
    y: wa.y + 12,
    width: w,
    height: h,
    frame: false,
    transparent: true,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: false,
    show: false,
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: true, // 로컬 신뢰 콘텐츠(원격 로드 없음)
      sandbox: false, // require() 사용
    },
  });
  indicator.setContentProtection(true); // 화면 캡처/녹화에서 제외
  indicator.setAlwaysOnTop(true, "screen-saver");
  indicator.loadFile(path.join(__dirname, "../renderer/indicator.html"));
  indicator.once("ready-to-show", () => indicator?.showInactive());
  indicator.on("closed", () => (indicator = null));
}

/** 녹화 중인 영역을 테두리로 표시(content-protected → GIF엔 안 찍힘, 클릭 통과). */
function createRegionFrame(display: Electron.Display, region: Rect) {
  const sx = Math.round(display.bounds.x + region.x);
  const sy = Math.round(display.bounds.y + region.y);
  const w = Math.max(1, Math.round(region.width));
  const h = Math.max(1, Math.round(region.height));
  regionFrame = new BrowserWindow({
    x: sx,
    y: sy,
    width: w,
    height: h,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    focusable: false,
    hasShadow: false,
    enableLargerThanScreen: true,
    alwaysOnTop: true,
    show: false,
    webPreferences: { contextIsolation: true },
  });
  regionFrame.setContentProtection(true); // 캡처에서 제외 → 녹화 결과엔 테두리가 안 들어감
  regionFrame.setIgnoreMouseEvents(true); // 클릭 통과(아래 화면 조작 가능)
  regionFrame.setAlwaysOnTop(true, "screen-saver");
  const html =
    "<style>html,body{margin:0;height:100%;background:transparent;overflow:hidden}" +
    ".b{position:fixed;inset:0;box-sizing:border-box;border:2px solid #ef4444;" +
    "box-shadow:0 0 0 1px rgba(0,0,0,.55) inset,0 0 0 1px rgba(0,0,0,.55)}</style><div class='b'></div>";
  regionFrame.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
  regionFrame.once("ready-to-show", () => regionFrame?.showInactive());
  regionFrame.on("closed", () => (regionFrame = null));
}

function createEncoder() {
  // 인코더 창은 desktopCapturer 프레임을 계속 받아야 해서 렌더링이 살아 있어야 한다.
  // 과거엔 화면 밖(-20000)에 뒀는데 (1) macOS가 그 좌표를 안 지켜 좌상단에 빈 흰 창으로 보이고
  // (2) 그 창이 전체화면 녹화에 그대로 찍혔다(setContentProtection 누락). 또 완전 화면밖/숨김은
  // occlusion 판정으로 렌더러가 throttle돼 프레임이 멈출 수 있다.
  // → '온스크린 1x1 투명 + opacity 0 + setContentProtection' 조합:
  //   compositor엔 '보이는 창'이라 프레임 유지, 사용자 눈엔 투명·초소형이라 안 보이고,
  //   setContentProtection(true)가 화면 캡처/녹화에서 자기 자신을 제외한다(indicator/regionFrame과 동일).
  const wa = screen.getPrimaryDisplay().workArea;
  encoder = new BrowserWindow({
    x: wa.x,
    y: wa.y,
    width: 16,
    height: 16,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false,
    show: false,
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: true, // require('gifenc'), ipcRenderer 사용
      sandbox: false,
      backgroundThrottling: false, // 온스크린이어도 타이머/미디어 유지(추가 안전판)
    },
  });
  encoder.setContentProtection(true); // 화면 캡처/녹화에서 제외 → GIF에 인코더 창이 안 찍힘
  encoder.setIgnoreMouseEvents(true); // 온스크린이어도 클릭은 아래로 통과
  encoder.setOpacity(0); // 사용자 눈엔 완전 투명(프레임은 계속 흐름)
  encoder.loadFile(path.join(__dirname, "../renderer/recorder.html"));
  encoder.once("ready-to-show", () => encoder?.showInactive()); // opacity 0 + 1x1 투명 → 안 보임, 포커스 안 뺏김
  encoder.on("closed", () => (encoder = null));
}

export async function startRecording(kind: RecordKind): Promise<boolean> {
  if (recording) return false;
  const cfg = loadConfig();
  let display = displayUnderCursor();

  // 녹화 UI(preview 숨김) 먼저 — 영역 오버레이/프레임에 안 잡히게.
  hooks.setRecordingUi(true);

  let crop: Rect | null = null;
  if (kind === "region") {
    const picked = await pickRegionMulti();
    if (!picked) {
      hooks.setRecordingUi(false);
      return false; // 취소
    }
    display = picked.display; // 고른 모니터로 녹화 대상 전환
    crop = picked.region;
  }

  let sourceId: string;
  try {
    sourceId = await getDisplaySourceId(display);
  } catch (e) {
    hooks.setRecordingUi(false);
    notify("녹화 시작 실패", (e as Error).message ?? "화면 소스를 찾지 못했습니다.");
    return false;
  }

  recording = true;
  finalizing = false;
  startedAt = Date.now();

  createEncoder();
  createIndicator();
  if (kind === "region" && crop) createRegionFrame(display, crop); // 녹화 영역 테두리 표시

  const beginPayload = {
    sourceId,
    crop, // DIP, 디스플레이 로컬(없으면 전체)
    displayWidthDip: display.size.width,
    displayHeightDip: display.size.height,
    fps: cfg.recording.fps,
    maxWidth: cfg.recording.maxWidth,
  };

  // 인코더 렌더러 준비되면 시작 신호.
  const send = () => encoder?.webContents.send("recorder:start", beginPayload);
  if (encoder && encoder.webContents.isLoading()) {
    encoder.webContents.once("did-finish-load", send);
  } else {
    send();
  }

  // 경과 tick + 자동 정지.
  tickTimer = setInterval(() => {
    const sec = Math.floor((Date.now() - startedAt) / 1000);
    indicator?.webContents.send("recorder:tick", { seconds: sec });
  }, 500);
  autoStopTimer = setTimeout(() => stopRecording(), cfg.recording.maxSeconds * 1000);

  return true;
}

/** 정지 요청 — 인코더에 finalize를 지시. 실제 저장은 recorder:done 수신에서. */
export function stopRecording(): void {
  if (!recording || finalizing) return;
  finalizing = true;
  if (autoStopTimer) {
    clearTimeout(autoStopTimer);
    autoStopTimer = null;
  }
  encoder?.webContents.send("recorder:finalize");
}

function cleanup() {
  recording = false;
  finalizing = false;
  if (tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
  if (autoStopTimer) {
    clearTimeout(autoStopTimer);
    autoStopTimer = null;
  }
  if (indicator && !indicator.isDestroyed()) indicator.close();
  indicator = null;
  if (regionFrame && !regionFrame.isDestroyed()) regionFrame.close();
  regionFrame = null;
  if (encoder && !encoder.isDestroyed()) encoder.close();
  encoder = null;
  hooks.setRecordingUi(false);
}

/** ipc 등록(1회). main 부팅에서 호출. */
export function registerRecorderIpc(): void {
  // 인디케이터 정지 버튼.
  ipcMain.on("recorder:stop-request", () => stopRecording());

  // 인코더 완료 — GIF 저장.
  ipcMain.on(
    "recorder:done",
    (_e, data: { gif: Uint8Array; thumb: Uint8Array; width: number; height: number; frames: number }) => {
      try {
        const buffer = Buffer.from(data.gif);
        const thumb = Buffer.from(data.thumb);
        if (buffer.byteLength > 0 && data.frames > 0) {
          store.add({
            buffer,
            thumbnail: thumb,
            mimeType: "image/gif",
            kind: "gif",
            ext: "gif",
            width: data.width,
            height: data.height,
          });
          const mb = (buffer.byteLength / (1024 * 1024)).toFixed(2);
          notify("녹화 저장됨", `GIF ${data.frames}프레임 · ${mb} MB`);
        } else {
          notify("녹화 실패", "프레임이 캡처되지 않았습니다.");
        }
      } catch (e) {
        console.error("[recorder] 저장 실패:", e);
        notify("녹화 저장 실패", (e as Error).message ?? "알 수 없는 오류");
      } finally {
        cleanup();
      }
    },
  );

  ipcMain.on("recorder:error", (_e, msg: string) => {
    console.error("[recorder] 인코더 오류:", msg);
    notify("녹화 실패", msg || "녹화 중 오류가 발생했습니다.");
    cleanup();
  });
}
