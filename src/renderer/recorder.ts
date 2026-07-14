// 숨은 GIF 인코더 렌더러 — desktop 스트림을 canvas로 그려 gifenc로 점진 인코딩.
// nodeIntegration 창에서 로드되므로 require 사용 가능. 전역 오염 방지를 위해 IIFE.
(function () {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { ipcRenderer } = require("electron");
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { GIFEncoder, quantize, applyPalette } = require("gifenc");

  interface StartOpts {
    sourceId: string;
    crop: { x: number; y: number; width: number; height: number } | null;
    displayWidthDip: number;
    displayHeightDip: number;
    fps: number;
    maxWidth: number;
  }

  let stream: MediaStream | null = null;
  let video: HTMLVideoElement | null = null;
  let canvas: HTMLCanvasElement | null = null;
  let ctx: CanvasRenderingContext2D | null = null;
  let gif: any = null;
  let thumbCanvas: HTMLCanvasElement | null = null;
  let frameCount = 0;
  let running = false;
  let loopTimer: any = null;

  function stopStream() {
    try {
      stream?.getTracks().forEach((t) => t.stop());
    } catch {
      /* 무시 */
    }
    stream = null;
  }

  function canvasToPng(c: HTMLCanvasElement): Promise<Uint8Array> {
    return new Promise((resolve) => {
      c.toBlob(async (blob) => {
        if (!blob) return resolve(new Uint8Array());
        resolve(new Uint8Array(await blob.arrayBuffer()));
      }, "image/png");
    });
  }

  async function begin(opts: StartOpts) {
    // 캡처 해상도를 4K raw가 아니라 '출력에 필요한 만큼'으로 제약 — 녹화 중 시스템 전체 저하의 최대 원인 제거.
    // 전체화면: cropW=displayW → captureW=maxWidth. 영역: 크롭이 maxWidth로 나오도록 전체 폭을 역산(작은 영역도 선명).
    const cropWDip = opts.crop ? Math.max(1, opts.crop.width) : opts.displayWidthDip;
    const captureW = Math.min(4096, Math.max(opts.maxWidth, Math.round((opts.maxWidth * opts.displayWidthDip) / cropWDip)));
    const captureH = Math.min(4096, Math.max(1, Math.round((captureW * opts.displayHeightDip) / opts.displayWidthDip)));
    const constraints: any = {
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: "desktop",
          chromeMediaSourceId: opts.sourceId,
          maxWidth: captureW, // was 4096 — target 기반(핵심 성능 개선)
          maxHeight: captureH,
          maxFrameRate: opts.fps,
        },
      },
    };
    stream = await navigator.mediaDevices.getUserMedia(constraints);

    video = document.createElement("video");
    video.srcObject = stream;
    video.muted = true;
    await video.play();
    if (!video.videoWidth) {
      await new Promise<void>((r) => video!.addEventListener("loadedmetadata", () => r(), { once: true }));
    }

    // DIP → 비디오 픽셀 배율(영역 크롭 정확도).
    const scale = video.videoWidth / opts.displayWidthDip || 1;
    const sx = opts.crop ? Math.max(0, Math.round(opts.crop.x * scale)) : 0;
    const sy = opts.crop ? Math.max(0, Math.round(opts.crop.y * scale)) : 0;
    const sw = opts.crop ? Math.max(1, Math.round(opts.crop.width * scale)) : video.videoWidth;
    const sh = opts.crop ? Math.max(1, Math.round(opts.crop.height * scale)) : video.videoHeight;

    // 목표 폭으로 다운스케일(용량/인코딩 비용 절감).
    const targetW = Math.max(1, Math.min(opts.maxWidth, sw));
    const targetH = Math.max(1, Math.round((sh * targetW) / sw));

    canvas = document.createElement("canvas");
    canvas.width = targetW;
    canvas.height = targetH;
    ctx = canvas.getContext("2d", { willReadFrequently: true }) as CanvasRenderingContext2D;

    gif = GIFEncoder();
    frameCount = 0;
    running = true;

    // 전역 팔레트: quantize(256색 median-cut)를 매 프레임 하던 걸 1회 + 주기 갱신만으로(비용 대폭↓).
    // applyPalette만 매 프레임. quantize/applyPalette는 format을 반드시 일치시킨다.
    const FORMAT = "rgb565";
    const COLORS = 256;
    const REFRESH_EVERY = 40; // ≈10fps에서 4초마다 팔레트 재계산(배경/테마 변화 대응)
    let palette: any = null;

    const delayMs = Math.max(20, Math.round(1000 / opts.fps));
    const maxFrames = opts.fps * 60; // 안전 상한(정상 정지는 main의 finalize)
    let nextAt = performance.now();
    let lastAt = nextAt;
    let first = true;

    const tick = () => {
      if (!running || !ctx || !canvas || !video) return;
      const now = performance.now();
      ctx.drawImage(video, sx, sy, sw, sh, 0, 0, targetW, targetH);
      const { data } = ctx.getImageData(0, 0, targetW, targetH);

      if (!palette || frameCount % REFRESH_EVERY === 0) palette = quantize(data, COLORS, { format: FORMAT });
      const index = applyPalette(data, palette, FORMAT);

      // GIF 타임라인을 실제 경과시간으로(고정 delay 금지 → 밀림 누적/재생길이 왜곡 방지).
      const frameDelay = first ? delayMs : Math.max(20, Math.round(now - lastAt));
      lastAt = now;
      first = false;

      gif.writeFrame(index, targetW, targetH, { palette, delay: frameDelay });
      frameCount++;
      if (frameCount === 1) grabThumb(targetW, targetH);
      if (frameCount >= maxFrames) {
        void finalize();
        return;
      }

      // 드리프트 보정 + 밀리면 프레임 드랍(연속발사 스파이럴 방지).
      nextAt += delayMs;
      if (now > nextAt + delayMs) nextAt = now + delayMs;
      loopTimer = setTimeout(tick, Math.max(0, nextAt - performance.now()));
    };
    loopTimer = setTimeout(tick, delayMs);
  }

  function grabThumb(w: number, h: number) {
    if (!canvas) return;
    const tw = Math.min(360, w);
    const th = Math.max(1, Math.round((h * tw) / w));
    thumbCanvas = document.createElement("canvas");
    thumbCanvas.width = tw;
    thumbCanvas.height = th;
    thumbCanvas.getContext("2d")!.drawImage(canvas, 0, 0, tw, th);
  }

  async function finalize() {
    if (!running) return;
    running = false;
    if (loopTimer) clearTimeout(loopTimer);
    loopTimer = null;
    try {
      if (frameCount === 0 || !canvas) {
        stopStream();
        ipcRenderer.send("recorder:done", { gif: new Uint8Array(), thumb: new Uint8Array(), width: 0, height: 0, frames: 0 });
        return;
      }
      gif.finish();
      const bytes: Uint8Array = gif.bytes();
      const thumb = await canvasToPng(thumbCanvas ?? canvas);
      const width = canvas.width;
      const height = canvas.height;
      stopStream();
      ipcRenderer.send("recorder:done", { gif: bytes, thumb, width, height, frames: frameCount });
    } catch (e: any) {
      stopStream();
      ipcRenderer.send("recorder:error", String(e?.message ?? e));
    }
  }

  ipcRenderer.on("recorder:start", async (_e: unknown, opts: StartOpts) => {
    try {
      await begin(opts);
    } catch (e: any) {
      stopStream();
      ipcRenderer.send("recorder:error", String(e?.message ?? e));
    }
  });
  ipcRenderer.on("recorder:finalize", () => void finalize());
})();
