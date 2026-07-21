// 이미지 편집(주석) 렌더러 — fabric.js v6 기반. nodeIntegration 창(require 사용).
// 웹 편집기(ImageMarkupModal)의 fabric 동작을 이식 + 가림(모자이크/블러) 도구 추가.
(function () {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fabric: any = require("fabric");
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { ipcRenderer } = require("electron");

  const COLORS = ["#ef4444", "#f59e0b", "#3b82f6", "#111827", "#ffffff"];
  const STROKE = 3;
  const MAX_UPSCALE = 4;
  const STAMP_RADIUS = 15;
  const MAX_HISTORY = 40;
  const MOSAIC_BLOCK = 8; // 모자이크 셀 크기(표시 px)

  type Tool = "select" | "rect" | "arrow" | "text" | "crop" | "stamp" | "redact";

  const canvasEl = document.getElementById("c") as HTMLCanvasElement;
  const fc: any = new fabric.Canvas(canvasEl, { preserveObjectStacking: true, selection: true });

  let tool: Tool = "select";
  let color = COLORS[0];
  let scale = 1;
  let redactMode: "mosaic" | "blur" = "mosaic";
  let nextNumber = 1;

  /* ===== 히스토리(되돌리기/다시실행) ===== */
  interface Snap { json: string; scale: number; width: number; height: number }
  let history: Snap[] = [];
  let histIdx = -1;
  let restoring = false;

  function updateUndoRedo() {
    (document.getElementById("undo") as HTMLButtonElement).disabled = histIdx <= 0;
    (document.getElementById("redo") as HTMLButtonElement).disabled = histIdx >= history.length - 1;
  }
  function snapshot() {
    if (restoring) return;
    // 크기는 항상 맞춤(100%) 기준으로 저장 — 확대 상태(fc.getWidth=맞춤×zoom)를 기록하지 않는다.
    const snap: Snap = { json: JSON.stringify(fc.toJSON()), scale, width: fitW, height: fitH };
    history = history.slice(0, histIdx + 1);
    history.push(snap);
    if (history.length > MAX_HISTORY) history.shift();
    histIdx = history.length - 1;
    updateUndoRedo();
  }
  async function loadState(snap: Snap) {
    restoring = true;
    scale = snap.scale;
    fitW = snap.width;
    fitH = snap.height;
    fc.setDimensions({ width: fitW, height: fitH });
    await fc.loadFromJSON(snap.json);
    // 현재 확대 배율을 유지한 채 복원(캔버스 크기 = 맞춤 × zoom).
    fc.setDimensions({ width: Math.round(fitW * viewZoom), height: Math.round(fitH * viewZoom) });
    fc.setZoom(viewZoom);
    fc.renderAll();
    restoring = false;
    updateUndoRedo();
  }
  async function undo() {
    if (histIdx > 0) {
      histIdx--;
      await loadState(history[histIdx]);
    }
  }
  async function redo() {
    if (histIdx < history.length - 1) {
      histIdx++;
      await loadState(history[histIdx]);
    }
  }

  /* ===== 캔버스/스케일 ===== */
  function maxDims() {
    const w = Math.min(window.innerWidth - 48, 1600);
    const h = window.innerHeight - 130;
    return { maxW: Math.max(w, 320), maxH: Math.max(h, 320) };
  }
  async function loadImage(url: string) {
    const img = await fabric.FabricImage.fromURL(url, { crossOrigin: "anonymous" });
    const natW = img.width as number;
    const natH = img.height as number;
    const { maxW, maxH } = maxDims();
    scale = Math.min(maxW / natW, maxH / natH, MAX_UPSCALE);
    fitW = Math.round(natW * scale);
    fitH = Math.round(natH * scale);
    fc.setDimensions({ width: fitW, height: fitH });
    img.set({ selectable: false, evented: false, scaleX: scale, scaleY: scale, left: 0, top: 0 });
    fc.backgroundImage = img;
    resetZoom(); // 새 이미지/자르기 후 100%로
    fc.renderAll();
  }

  /* ===== 화면 확대/축소 =====
     캔버스 요소 자체를 키운다(맞춤크기 × zoom). 확대하면 편집기(스테이지) 전체 영역을 쓰고,
     넘치면 스테이지가 스크롤된다. 도형은 scene 좌표라 저장엔 영향 없다(export 직전 100%로 되돌림). */
  const MIN_ZOOM = 0.25;
  const MAX_ZOOM = 8;
  let fitW = 0; // 100%(맞춤) 캔버스 크기 — 최초 이미지 로드 때 결정
  let fitH = 0;
  let viewZoom = 1;
  const stageEl = document.getElementById("stage") as HTMLElement;

  function updateZoomLabel() {
    const el = document.getElementById("zoomPct");
    if (el) el.textContent = `${Math.round(viewZoom * 100)}%`;
  }
  function clampZoom(z: number): number {
    return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
  }
  /** 캔버스 크기=맞춤×zoom, fabric zoom=zoom. 앵커(화면 좌표) 아래 지점을 고정한 채 확대. */
  function applyZoom(z: number, anchorClientX?: number, anchorClientY?: number) {
    if (!fitW || !fitH) return;
    const rect = stageEl.getBoundingClientRect();
    const ax = anchorClientX ?? rect.left + rect.width / 2;
    const ay = anchorClientY ?? rect.top + rect.height / 2;
    const beforeW = fitW * viewZoom;
    const beforeH = fitH * viewZoom;
    // 확대 전 앵커 아래 콘텐츠 지점(0~1 비율).
    const cx = beforeW > 0 ? (stageEl.scrollLeft + (ax - rect.left)) / beforeW : 0.5;
    const cy = beforeH > 0 ? (stageEl.scrollTop + (ay - rect.top)) / beforeH : 0.5;

    viewZoom = clampZoom(z);
    fc.setDimensions({ width: Math.round(fitW * viewZoom), height: Math.round(fitH * viewZoom) });
    fc.setZoom(viewZoom);
    fc.requestRenderAll();
    updateZoomLabel();

    // 확대 후 같은 콘텐츠 지점이 앵커 아래에 오도록 스크롤 보정.
    stageEl.scrollLeft = cx * fitW * viewZoom - (ax - rect.left);
    stageEl.scrollTop = cy * fitH * viewZoom - (ay - rect.top);
  }
  function resetZoom() {
    viewZoom = 1;
    fc.setDimensions({ width: fitW, height: fitH });
    fc.setZoom(1);
    updateZoomLabel();
  }
  /** export(toDataURL) 동안 100%(맞춤)로 되돌려 확대 상태가 저장에 섞이지 않게 한다. */
  function withExportView<T>(fn: () => T): T {
    const z = viewZoom;
    fc.setDimensions({ width: fitW, height: fitH });
    fc.setZoom(1);
    try {
      return fn();
    } finally {
      fc.setDimensions({ width: Math.round(fitW * z), height: Math.round(fitH * z) });
      fc.setZoom(z);
      fc.requestRenderAll();
    }
  }

  // Ctrl+휠 → 커서 지점 기준 확대/축소. Ctrl 없으면 기본 스크롤 유지.
  fc.on("mouse:wheel", (opt: any) => {
    if (!opt.e.ctrlKey) return;
    opt.e.preventDefault();
    opt.e.stopPropagation();
    applyZoom(viewZoom * 0.999 ** opt.e.deltaY, opt.e.clientX, opt.e.clientY);
  });

  document.getElementById("zoomIn")!.addEventListener("click", () => applyZoom(viewZoom * 1.2));
  document.getElementById("zoomOut")!.addEventListener("click", () => applyZoom(viewZoom / 1.2));
  document.getElementById("zoomPct")!.addEventListener("click", () => resetZoom()); // 클릭 → 100%

  /* ===== Space+드래그로 스테이지 스크롤(팬) ===== */
  let spaceDown = false;
  let panning = false;
  let panLast = { x: 0, y: 0 };
  function isEditingText(): boolean {
    const o = fc.getActiveObject();
    return !!(o && o.isEditing);
  }
  window.addEventListener("keydown", (e) => {
    if (e.code === "Space" && !isEditingText()) {
      e.preventDefault(); // 스테이지 스크롤 점프 방지
      spaceDown = true;
      fc.defaultCursor = "grab";
      fc.setCursor("grab");
    }
  });
  window.addEventListener("keyup", (e) => {
    if (e.code === "Space") {
      spaceDown = false;
      panning = false;
      fc.defaultCursor = "default";
      fc.setCursor("default");
    }
  });

  /* ===== 도형 팩토리 ===== */
  function makeArrow(x1: number, y1: number, x2: number, y2: number, col: string) {
    const line = new fabric.Line([x1, y1, x2, y2], { stroke: col, strokeWidth: STROKE, strokeUniform: true });
    const angle = (Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI;
    const head = new fabric.Triangle({
      left: x2, top: y2, originX: "center", originY: "center",
      width: 14, height: 16, fill: col, angle: angle + 90,
    });
    return new fabric.Group([line, head]);
  }
  function makeStamp(n: number, x: number, y: number, col: string) {
    const circle = new fabric.Circle({
      radius: STAMP_RADIUS, fill: col, stroke: "#ffffff", strokeWidth: 2, strokeUniform: true,
      originX: "center", originY: "center", left: 0, top: 0,
    });
    const text = new fabric.Text(String(n), {
      fontSize: Math.round(STAMP_RADIUS * 1.25), fill: "#ffffff", fontWeight: "bold",
      fontFamily: "system-ui, sans-serif", originX: "center", originY: "center", left: 0, top: 0,
    });
    return new fabric.Group([circle, text], { left: x, top: y, originX: "center", originY: "center" });
  }
  const kids = (o: any): any[] => (o.getObjects ? o.getObjects() : []);
  const isStampGroup = (o: any) => o.type === "group" && kids(o)[0]?.type === "circle";
  const isArrowGroup = (o: any) => o.type === "group" && kids(o)[0]?.type === "line";

  /* ===== 도구 전환 ===== */
  function setTool(t: Tool) {
    tool = t;
    fc.selection = t === "select";
    fc.defaultCursor = t === "select" ? "default" : "crosshair";
    fc.forEachObject((o: any) => {
      if (t === "select") {
        o.selectable = true;
        o.evented = true;
      } else if (t === "stamp") {
        const s = isStampGroup(o);
        o.selectable = s;
        o.evented = s;
      } else {
        o.selectable = false;
        o.evented = false;
      }
    });
    if (t !== "select") fc.discardActiveObject();
    fc.renderAll();
    paintToolbar();
    updateContext();
    updateHint();
  }

  /* ===== 그리기 상태 ===== */
  let drawing = false;
  let startX = 0;
  let startY = 0;
  let temp: any = null;
  let cropRect: any = null;
  let hasCrop = false;

  function clearCrop() {
    if (cropRect) {
      fc.remove(cropRect);
      cropRect = null;
    }
    setHasCrop(false);
  }
  function setHasCrop(v: boolean) {
    hasCrop = v;
    (document.getElementById("cropApply") as HTMLElement).style.display = tool === "crop" && v ? "" : "none";
  }

  fc.on("mouse:down", (opt: any) => {
    if (spaceDown) {
      // 팬 시작 — 도구 동작 대신 화면 이동.
      panning = true;
      panLast = { x: opt.e.clientX, y: opt.e.clientY };
      fc.setCursor("grabbing");
      return;
    }
    if (tool === "select") return;
    const p = fc.getScenePoint(opt.e);
    if (tool === "stamp") {
      if (!opt.target) {
        fc.add(makeStamp(nextNumber, p.x, p.y, color));
        nextNumber++;
        updateContext();
        snapshot();
      }
      return;
    }
    if (tool === "text") {
      const it = new fabric.IText("텍스트", {
        left: p.x, top: p.y, fill: color, fontSize: 24, fontFamily: "system-ui, sans-serif",
      });
      fc.add(it);
      fc.setActiveObject(it);
      it.enterEditing();
      it.selectAll();
      setTool("select");
      return;
    }
    drawing = true;
    startX = p.x;
    startY = p.y;
    if (tool === "rect") {
      temp = new fabric.Rect({ left: p.x, top: p.y, width: 0, height: 0, fill: "transparent", stroke: color, strokeWidth: STROKE, strokeUniform: true, selectable: false, evented: false });
      fc.add(temp);
    } else if (tool === "arrow") {
      temp = new fabric.Line([p.x, p.y, p.x, p.y], { stroke: color, strokeWidth: STROKE, strokeUniform: true, selectable: false, evented: false });
      fc.add(temp);
    } else {
      // crop / redact — 점선 선택 사각형
      if (tool === "crop") clearCrop();
      temp = new fabric.Rect({ left: p.x, top: p.y, width: 0, height: 0, fill: "rgba(0,0,0,0.15)", stroke: "#3b82f6", strokeWidth: 1, strokeDashArray: [6, 4], selectable: false, evented: false });
      fc.add(temp);
      if (tool === "crop") cropRect = temp;
    }
  });

  fc.on("mouse:move", (opt: any) => {
    if (panning) {
      // 스테이지 스크롤로 이동(캔버스가 스테이지보다 크면 스크롤됨).
      stageEl.scrollLeft -= opt.e.clientX - panLast.x;
      stageEl.scrollTop -= opt.e.clientY - panLast.y;
      panLast = { x: opt.e.clientX, y: opt.e.clientY };
      return;
    }
    if (!drawing || !temp) return;
    const p = fc.getScenePoint(opt.e);
    if (tool === "arrow") {
      temp.set({ x2: p.x, y2: p.y });
    } else {
      temp.set({ left: Math.min(startX, p.x), top: Math.min(startY, p.y), width: Math.abs(p.x - startX), height: Math.abs(p.y - startY) });
    }
    fc.renderAll();
  });

  fc.on("mouse:up", (opt: any) => {
    if (panning) {
      panning = false;
      fc.setCursor(spaceDown ? "grab" : "default");
      return;
    }
    if (!drawing || !temp) {
      drawing = false;
      return;
    }
    const p = fc.getScenePoint(opt.e);
    const obj = temp;
    temp = null;
    drawing = false;
    if (tool === "rect") {
      if (obj.width < 4 && obj.height < 4) fc.remove(obj);
      else {
        obj.set({ selectable: true, evented: true });
        fc.setActiveObject(obj);
        setTool("select");
        snapshot();
      }
    } else if (tool === "arrow") {
      const len = Math.hypot(p.x - startX, p.y - startY);
      fc.remove(obj);
      if (len >= 6) {
        const arr = makeArrow(startX, startY, p.x, p.y, color);
        fc.add(arr);
        fc.setActiveObject(arr);
        setTool("select");
        snapshot();
      }
    } else if (tool === "crop") {
      if (obj.width < 8 || obj.height < 8) clearCrop();
      else setHasCrop(true);
    } else if (tool === "redact") {
      const l = obj.left, t = obj.top, w = obj.width, h = obj.height;
      fc.remove(obj);
      if (w >= 8 && h >= 8) applyRedact(l, t, w, h);
      setTool("select");
    }
  });

  /* ===== 가림(모자이크/블러) ===== */
  function applyRedact(left: number, top: number, w: number, h: number) {
    const dataUrl = withExportView(() => fc.toDataURL({ format: "png", left, top, width: w, height: h, multiplier: 1 }));
    const src = new Image();
    src.onload = () => {
      const out = document.createElement("canvas");
      out.width = Math.max(1, Math.round(w));
      out.height = Math.max(1, Math.round(h));
      const ctx = out.getContext("2d")!;
      if (redactMode === "mosaic") {
        const sw = Math.max(1, Math.round(w / MOSAIC_BLOCK));
        const sh = Math.max(1, Math.round(h / MOSAIC_BLOCK));
        const tmp = document.createElement("canvas");
        tmp.width = sw;
        tmp.height = sh;
        const tctx = tmp.getContext("2d")!;
        tctx.imageSmoothingEnabled = false;
        tctx.drawImage(src, 0, 0, sw, sh);
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(tmp, 0, 0, sw, sh, 0, 0, out.width, out.height);
      } else {
        ctx.filter = "blur(6px)";
        ctx.drawImage(src, 0, 0, out.width, out.height);
        ctx.filter = "none";
      }
      const fimg = new fabric.FabricImage(out, { left, top, selectable: true, evented: true });
      fc.add(fimg);
      fc.setActiveObject(fimg);
      fc.renderAll();
      snapshot();
    };
    src.src = dataUrl;
  }

  /* ===== 자르기 ===== */
  async function applyCrop() {
    if (!cropRect) return;
    const left = cropRect.left;
    const top = cropRect.top;
    const w = cropRect.width;
    const h = cropRect.height;
    clearCrop();
    const dataUrl = withExportView(() => fc.toDataURL({ format: "png", multiplier: 1 / scale, left, top, width: w, height: h }));
    fc.remove(...fc.getObjects());
    await loadImage(dataUrl);
    setTool("select");
    snapshot();
  }

  /* ===== 색상 ===== */
  function applyColorToActive() {
    const o = fc.getActiveObject();
    if (!o) return;
    if (isStampGroup(o)) kids(o)[0].set("fill", color);
    else if (o.type === "i-text" || o.type === "text") o.set("fill", color);
    else if (isArrowGroup(o)) kids(o).forEach((k: any) => k.set(k.type === "triangle" ? "fill" : "stroke", color));
    else o.set("stroke", color);
    fc.renderAll();
    snapshot();
  }

  /* ===== 저장/취소 ===== */
  function dataUrlToBytes(dataUrl: string): Uint8Array {
    const bin = atob(dataUrl.split(",")[1]);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  async function save() {
    (document.getElementById("done") as HTMLButtonElement).disabled = true;
    fc.discardActiveObject();
    fc.renderAll();
    const dataUrl = withExportView(() => fc.toDataURL({ format: "png", multiplier: 1 / scale }));
    await ipcRenderer.invoke("editor:save", dataUrlToBytes(dataUrl));
  }
  // window.confirm 대체: 편집 창 안에 디자인된 확인 대화상자를 띄운다.
  function askConfirm(msg: string, sub: string, yesLabel: string): Promise<boolean> {
    const box = document.getElementById("confirm") as HTMLElement;
    document.getElementById("cf-msg")!.textContent = msg;
    document.getElementById("cf-sub")!.textContent = sub;
    const yes = document.getElementById("cf-yes") as HTMLButtonElement;
    const no = document.getElementById("cf-no") as HTMLButtonElement;
    yes.textContent = yesLabel;
    box.classList.remove("hidden");
    yes.focus();
    return new Promise<boolean>((resolve) => {
      const done = (v: boolean) => {
        box.classList.add("hidden");
        yes.removeEventListener("click", onYes);
        no.removeEventListener("click", onNo);
        box.removeEventListener("mousedown", onBack);
        window.removeEventListener("keydown", onKey, true);
        resolve(v);
      };
      const onYes = () => done(true);
      const onNo = () => done(false);
      const onBack = (e: MouseEvent) => {
        if (e.target === box) done(false);
      };
      const onKey = (e: KeyboardEvent) => {
        e.stopPropagation();
        if (e.key === "Escape") { e.preventDefault(); done(false); }
        else if (e.key === "Enter") { e.preventDefault(); done(true); }
      };
      yes.addEventListener("click", onYes);
      no.addEventListener("click", onNo);
      box.addEventListener("mousedown", onBack);
      window.addEventListener("keydown", onKey, true);
    });
  }
  let confirmOpen = false;
  async function cancel() {
    if (histIdx > 0) {
      if (confirmOpen) return; // Esc 연타로 중복 오픈 방지
      confirmOpen = true;
      const ok = await askConfirm("편집한 내용을 저장하지 않고 닫을까요?", "지금까지 편집한 내용이 사라집니다.", "저장 안 함");
      confirmOpen = false;
      if (!ok) return;
    }
    void ipcRenderer.invoke("editor:cancel");
  }

  /* ===== 툴바 UI ===== */
  function paintToolbar() {
    for (const b of Array.from(document.querySelectorAll<HTMLButtonElement>("[data-tool]"))) {
      b.classList.toggle("active", b.getAttribute("data-tool") === tool);
    }
  }
  function paintColors() {
    for (const s of Array.from(document.querySelectorAll<HTMLElement>(".sw"))) {
      s.classList.toggle("active", s.getAttribute("data-color") === color);
    }
  }
  function updateContext() {
    const o = fc.getActiveObject();
    const show = (id: string, v: boolean) => ((document.getElementById(id) as HTMLElement).style.display = v ? "" : "none");
    show("ctxStampNext", tool === "stamp");
    show("ctxStampCur", !!o && isStampGroup(o));
    show("ctxText", !!o && (o.type === "i-text" || o.type === "text"));
    show("ctxRedact", tool === "redact");
    (document.getElementById("nextNum") as HTMLInputElement).value = String(nextNumber);
    if (o && isStampGroup(o)) {
      const txt = kids(o).find((k: any) => k.type === "text");
      (document.getElementById("curNum") as HTMLInputElement).value = txt ? txt.text : "1";
    }
    if (o && (o.type === "i-text" || o.type === "text")) {
      (document.getElementById("textSize") as HTMLInputElement).value = String(Math.round((o.fontSize || 24) * (o.scaleY || 1)));
    }
  }
  function updateHint() {
    const map: Record<Tool, string> = {
      select: "도형을 선택하면 이동·크기조절, Delete로 삭제. 색을 바꾸려면 선택 후 색상 클릭.",
      rect: "드래그해서 사각형을 그리세요.",
      arrow: "드래그해서 화살표를 그리세요.",
      text: "클릭한 곳에 텍스트를 입력하세요.",
      crop: "자를 영역을 드래그한 뒤 '자르기 적용'.",
      stamp: "빈 곳을 클릭하면 번호가 찍힙니다. '다음' 번호로 시작값을 바꿀 수 있어요.",
      redact: "가릴 영역을 드래그하세요. 모자이크/블러 선택 가능.",
    };
    (document.getElementById("hint") as HTMLElement).textContent = map[tool] + "  ·  Ctrl+휠 확대/축소 · Space+드래그 이동";
  }

  // 색상 스와치 생성
  const colorsEl = document.getElementById("colors")!;
  for (const c of COLORS) {
    const s = document.createElement("button");
    s.className = "sw";
    s.style.background = c;
    s.setAttribute("data-color", c);
    s.addEventListener("click", () => {
      color = c;
      paintColors();
      applyColorToActive();
    });
    colorsEl.appendChild(s);
  }

  // 도구 버튼
  for (const b of Array.from(document.querySelectorAll<HTMLButtonElement>("[data-tool]"))) {
    b.addEventListener("click", () => setTool(b.getAttribute("data-tool") as Tool));
  }
  document.getElementById("undo")!.addEventListener("click", () => void undo());
  document.getElementById("redo")!.addEventListener("click", () => void redo());
  document.getElementById("cropApply")!.addEventListener("click", () => void applyCrop());
  document.getElementById("cancel")!.addEventListener("click", cancel);
  document.getElementById("done")!.addEventListener("click", () => void save());

  // 컨텍스트 입력
  document.getElementById("nextNum")!.addEventListener("input", (e) => {
    const n = Math.max(1, parseInt((e.target as HTMLInputElement).value || "1", 10) || 1);
    nextNumber = n;
  });
  document.getElementById("curNum")!.addEventListener("input", (e) => {
    const o = fc.getActiveObject();
    if (!o || !isStampGroup(o)) return;
    const n = Math.max(1, parseInt((e.target as HTMLInputElement).value || "1", 10) || 1);
    const txt = kids(o).find((k: any) => k.type === "text");
    if (txt) {
      txt.set("text", String(n));
      fc.renderAll();
      snapshot();
    }
  });
  document.getElementById("textSize")!.addEventListener("input", (e) => {
    const o = fc.getActiveObject();
    if (!o || (o.type !== "i-text" && o.type !== "text")) return;
    const n = Math.max(6, parseInt((e.target as HTMLInputElement).value || "24", 10) || 24);
    o.set({ fontSize: n, scaleX: 1, scaleY: 1 });
    fc.renderAll();
    snapshot();
  });

  // 선택 변화 → 컨텍스트 입력 갱신
  fc.on("selection:created", updateContext);
  fc.on("selection:updated", updateContext);
  fc.on("selection:cleared", updateContext);
  fc.on("object:modified", () => snapshot());
  fc.on("text:editing:exited", () => snapshot());

  // 키보드
  window.addEventListener(
    "keydown",
    (e) => {
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) return;
      const active = fc.getActiveObject();
      if (active && active.isEditing) return;
      if (e.key === "Escape") {
        e.preventDefault();
        cancel();
      } else if ((e.key === "Delete" || e.key === "Backspace") && active) {
        e.preventDefault();
        fc.remove(active);
        fc.discardActiveObject();
        fc.renderAll();
        snapshot();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) void redo();
        else void undo();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") {
        e.preventDefault();
        void redo();
      }
    },
    true,
  );

  // 가림 모드 라디오
  for (const r of Array.from(document.querySelectorAll<HTMLInputElement>('input[name="rm"]'))) {
    r.addEventListener("change", () => {
      if (r.checked) redactMode = r.value as "mosaic" | "blur";
    });
  }

  /* ===== 초기 로드 ===== */
  paintColors();
  updateUndoRedo();
  updateHint();
  ipcRenderer.invoke("editor:load").then(async (data: { dataUrl: string; fileName: string }) => {
    await loadImage(data.dataUrl);
    history = [];
    histIdx = -1;
    snapshot(); // 초기 상태를 히스토리 시작점으로
    setTool("select");
  });
})();
