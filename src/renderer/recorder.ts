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
    const constraints: any = {
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: "desktop",
          chromeMediaSourceId: opts.sourceId,
          maxWidth: 4096,
          maxHeight: 4096,
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
    const delay = Math.max(20, Math.round(1000 / opts.fps));
    const maxFrames = opts.fps * 60; // 안전 상한(정상 정지는 main의 finalize)

    const tick = () => {
      if (!running || !ctx || !canvas || !video) return;
      ctx.drawImage(video, sx, sy, sw, sh, 0, 0, targetW, targetH);
      const { data } = ctx.getImageData(0, 0, targetW, targetH);
      const palette = quantize(data, 256);
      const index = applyPalette(data, palette);
      gif.writeFrame(index, targetW, targetH, { palette, delay });
      frameCount++;
      if (frameCount === 1) grabThumb(targetW, targetH);
      if (frameCount >= maxFrames) {
        void finalize();
        return;
      }
      loopTimer = setTimeout(tick, delay);
    };
    loopTimer = setTimeout(tick, delay);
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
