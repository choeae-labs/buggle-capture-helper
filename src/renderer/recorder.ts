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
  let capW = 0,
    capH = 0,
    fpsActual = 0; // 실측: 실제 캡처 해상도·fps(스로틀 적용됐는지 검증용)

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

    // ★ 마우스 끊김 최대 레버: mandatory로는 desktop 소스에서 자주 무시되는 프레임레이트/해상도를
    //   트랙 자체에 applyConstraints로 실효 적용. ProMotion 60~120fps 풀레이트 캡처를 opts.fps로 낮춰
    //   WindowServer/GPU 부하(=커서 소프트웨어 합성 stutter의 원인)를 직접 차단한다.
    const track = stream.getVideoTracks()[0];
    try {
      await track.applyConstraints({ frameRate: { max: opts.fps }, width: { max: captureW }, height: { max: captureH } });
    } catch {
      /* 일부 소스 미지원 → mandatory 값으로 진행 */
    }

    video = document.createElement("video");
    video.srcObject = stream;
    video.muted = true;
    await video.play();
    if (!video.videoWidth) {
      await new Promise<void>((r) => video!.addEventListener("loadedmetadata", () => r(), { once: true }));
    }

    // 실측: 캡처가 실제로 줄었는지(finalize에서 notify로 노출). capW가 target 근처+fpsActual≈opts.fps면 스로틀 성공.
    capW = video.videoWidth;
    capH = video.videoHeight;
    fpsActual = Math.round((track.getSettings().frameRate ?? 0) * 10) / 10;

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
    const frameInterval = 1000 / opts.fps;
    const maxFrames = opts.fps * 60; // 안전 상한(정상 정지는 main의 finalize)
    let lastAt = -Infinity; // 마지막 '처리한' 프레임 시각 — fps 게이트 겸 delay 기준

    // 한 프레임 처리(캡처→인덱싱→인코딩). GIF delay는 실제 경과시간(재생 길이 정확).
    const processFrame = (nowTs: number) => {
      if (!ctx || !canvas || !video) return;
      ctx.drawImage(video, sx, sy, sw, sh, 0, 0, targetW, targetH);
      const { data } = ctx.getImageData(0, 0, targetW, targetH);
      if (!palette || frameCount % REFRESH_EVERY === 0) palette = quantize(data, COLORS, { format: FORMAT });
      const index = applyPalette(data, palette, FORMAT);
      const frameDelay = lastAt === -Infinity ? delayMs : Math.max(20, Math.round(nowTs - lastAt));
      lastAt = nowTs;
      gif.writeFrame(index, targetW, targetH, { palette, delay: frameDelay });
      frameCount++;
      if (frameCount === 1) grabThumb(targetW, targetH);
    };

    // ★ setTimeout tick → requestVideoFrameCallback: 실제 프레임 도착에만 반응 + fps 게이트로 opts.fps만 처리.
    //   합성기와 동기돼 중복 tick/readback이 사라지고 jank가 준다(rVFC 미지원 시 setTimeout 폴백).
    const anyVideo = video as any;
    if (typeof anyVideo.requestVideoFrameCallback === "function") {
      const onFrame = (nowTs: number) => {
        if (!running || !video) return;
        if (nowTs - lastAt >= frameInterval - 2) processFrame(nowTs);
        if (frameCount >= maxFrames) {
          void finalize();
          return;
        }
        (video as any).requestVideoFrameCallback(onFrame);
      };
      anyVideo.requestVideoFrameCallback(onFrame);
    } else {
      const loop = () => {
        if (!running) return;
        processFrame(performance.now());
        if (frameCount >= maxFrames) {
          void finalize();
          return;
        }
        loopTimer = setTimeout(loop, delayMs);
      };
      loopTimer = setTimeout(loop, delayMs);
    }
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
      ipcRenderer.send("recorder:done", { gif: bytes, thumb, width, height, frames: frameCount, capW, capH, fpsActual });
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
