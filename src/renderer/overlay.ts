// 선택 영역 오버레이 — 드래그로 사각형 선택, mouseup에 rect(DIP, 디스플레이 로컬) 전송. Esc 취소.
// 모듈이 아닌 전역 스크립트(import/export 없음)로 컴파일돼 <script src>로 로드된다.
interface OverlayApi {
  select: (r: { x: number; y: number; width: number; height: number }) => void;
  cancel: () => void;
}
declare const overlay: OverlayApi;

(function () {
  const box = document.getElementById("box") as HTMLDivElement;
  const label = document.getElementById("label") as HTMLDivElement;
  const hint = document.getElementById("hint") as HTMLDivElement;
  let sx = 0;
  let sy = 0;
  let dragging = false;

  function rect(e: PointerEvent) {
    return {
      x: Math.min(sx, e.clientX),
      y: Math.min(sy, e.clientY),
      width: Math.abs(e.clientX - sx),
      height: Math.abs(e.clientY - sy),
    };
  }
  function update(e: PointerEvent) {
    const r = rect(e);
    box.style.display = "block";
    box.style.left = r.x + "px";
    box.style.top = r.y + "px";
    box.style.width = r.width + "px";
    box.style.height = r.height + "px";
    label.style.display = "block";
    label.textContent = `${r.width} × ${r.height}`;
    label.style.left = r.x + "px";
    label.style.top = Math.max(0, r.y - 22) + "px";
  }

  window.addEventListener("pointerdown", (e) => {
    dragging = true;
    sx = e.clientX;
    sy = e.clientY;
    hint.style.display = "none";
    update(e);
  });
  window.addEventListener("pointermove", (e) => {
    if (dragging) update(e);
  });
  window.addEventListener("pointerup", (e) => {
    if (!dragging) return;
    dragging = false;
    const r = rect(e);
    if (r.width >= 3 && r.height >= 3) overlay.select(r);
    else overlay.cancel();
  });
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") overlay.cancel();
  });
})();
