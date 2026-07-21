// 빠른 붙여넣기 렌더러 — 커서 옆에 캡처를 쭉 늘어놓고 골라 붙여넣는다. 전역 스크립트(import/export 없음).
interface QpItem {
  id: string;
  kind?: string;
  thumbnailUrl: string;
  fileUrl?: string;
  createdAt: string;
  usedAt?: string | null;
}
interface Qp {
  list: () => Promise<QpItem[]>;
  conn: () => Promise<{ port: number; token: string }>;
  paste: (ids: string[]) => Promise<boolean>;
  cancel: () => void;
  showZoom: (id: string, anchor: { x: number; y: number; w: number; h: number }) => void;
  hideZoom: () => void;
  onShow: (cb: (items: QpItem[]) => void) => () => void;
}
declare const qp: Qp;

(function () {
  const stripEl = document.getElementById("strip") as HTMLElement;
  const titleEl = document.getElementById("title") as HTMLElement;

  // Mac은 안내 표기를 ⌘로(kbd의 "Ctrl" → "⌘").
  if (navigator.platform.toUpperCase().includes("MAC")) {
    document.querySelectorAll("kbd").forEach((k) => {
      if (k.textContent) k.textContent = k.textContent.replace("Ctrl", "⌘");
    });
  }
  let base = "";
  let token = "";
  let items: QpItem[] = [];
  const selected: string[] = []; // 고른 순서 = 붙여넣을 순서
  let cursor = 0; // 방향키 위치

  function timeAgo(iso: string): string {
    const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
    if (m < 1) return "방금";
    if (m < 60) return `${m}분 전`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}시간 전`;
    return `${Math.floor(h / 24)}일 전`;
  }

  function paintTitle() {
    titleEl.textContent = selected.length > 0 ? `${selected.length}장 선택됨` : "붙여넣을 사진을 선택해주세요";
  }

  /** 선택 표시만 갱신(재렌더 없이) — 순번 배지도 함께. */
  function paintSelection() {
    for (const el of Array.from(stripEl.querySelectorAll(".cap"))) {
      const id = el.getAttribute("data-id") || "";
      const i = selected.indexOf(id);
      el.classList.toggle("sel", i !== -1);
      const n = el.querySelector(".n") as HTMLElement | null;
      if (n) n.textContent = String(i + 1);
    }
    paintTitle();
  }

  function paintCursor() {
    const els = Array.from(stripEl.querySelectorAll(".cap"));
    els.forEach((el, i) => el.classList.toggle("cursor", i === cursor));
    els[cursor]?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  function render(next: QpItem[]) {
    hideZoom(); // 목록 재생성 시 앵커(썸네일 DOM)가 사라지므로 미리보기 닫기
    items = next;
    selected.length = 0;
    cursor = 0;
    if (items.length === 0) {
      stripEl.innerHTML = `<div id="empty">캡처한 항목이 없습니다.</div>`;
      paintTitle();
      return;
    }
    stripEl.innerHTML = "";
    for (const it of items) {
      // GIF는 실제 파일을 보여줘 스트립에서도 움직이게. 그 외는 정지 썸네일(PNG).
      const src = it.kind === "gif" && it.fileUrl ? it.fileUrl : it.thumbnailUrl;
      const url = base ? `${base}${src}?token=${encodeURIComponent(token)}` : "";
      const el = document.createElement("div");
      el.className = "cap";
      el.setAttribute("data-id", it.id);
      el.innerHTML = `
        <img src="${url}" alt="" />
        ${it.kind === "gif" ? `<span class="gif">GIF</span>` : ""}
        <span class="n"></span>
        <span class="t">${timeAgo(it.createdAt)}</span>`;
      stripEl.appendChild(el);
    }
    // 기본 선택 없음 — 사용자가 직접 고르게 한다.
    paintSelection();
    paintCursor();
  }

  async function paste() {
    if (selected.length === 0) return;
    await qp.paste(selected.slice()); // main이 클립보드에 담고 직전 창으로 돌아가 Ctrl+V
  }

  /* ===== 확대 미리보기(패널과 동일) =====
     0.8초 hover 또는 "이미 선택된 항목 재클릭" → 원본을 별도 창으로 크게 띄운다(main이 표시). */
  const HOVER_DELAY = 800;
  let zoomId: string | null = null;
  let hoverId: string | null = null;
  let hoverTimer: ReturnType<typeof setTimeout> | null = null;

  function clearHoverTimer() {
    if (hoverTimer) clearTimeout(hoverTimer);
    hoverTimer = null;
  }
  function hideZoom() {
    clearHoverTimer();
    hoverId = null;
    if (!zoomId) return;
    zoomId = null;
    qp.hideZoom();
  }
  function showZoom(id: string) {
    const el = stripEl.querySelector(`.cap[data-id="${id}"]`) as HTMLElement | null;
    if (!el) return;
    clearHoverTimer();
    zoomId = id;
    const r = el.getBoundingClientRect();
    qp.showZoom(id, { x: r.left, y: r.top, w: r.width, h: r.height }); // main이 창 위치를 더해 화면 좌표로
  }

  // 클릭: 이미 선택된 항목 재클릭 → 미리보기 토글. 미선택 항목 → 선택+바로 붙여넣기.
  //       Ctrl/⌘+클릭 → 여러 장 모으기(Enter로 확정).
  stripEl.addEventListener("click", (e) => {
    const el = (e.target as HTMLElement).closest(".cap") as HTMLElement | null;
    if (!el) return;
    const id = el.getAttribute("data-id")!;
    cursor = items.findIndex((it) => it.id === id);
    if (e.ctrlKey || e.metaKey) {
      const i = selected.indexOf(id);
      if (i === -1) selected.push(id);
      else selected.splice(i, 1);
      paintSelection();
      paintCursor();
      return;
    }
    // 이미 선택된 항목을 (수식키 없이) 다시 클릭 → 붙여넣기 대신 미리보기 토글(패널과 동일).
    if (selected.includes(id)) {
      if (zoomId === id) hideZoom();
      else showZoom(id);
      return;
    }
    hideZoom();
    selected.length = 0;
    selected.push(id);
    paintSelection();
    void paste();
  });

  // 0.8초 hover → 미리보기. 다른 썸네일로 이동하면 이전 타이머 취소.
  stripEl.addEventListener("mouseover", (e) => {
    const el = (e.target as HTMLElement).closest(".cap") as HTMLElement | null;
    const id = el?.getAttribute("data-id") ?? null;
    if (!id || id === hoverId) return;
    clearHoverTimer();
    hoverId = id;
    if (zoomId && zoomId !== id) hideZoom();
    hoverTimer = setTimeout(() => showZoom(id), HOVER_DELAY);
  });
  // 스트립 밖(썸네일 아님)으로 이동 → 닫기. 확대 창은 마우스를 무시하므로 안전.
  document.addEventListener("mouseover", (e) => {
    const el = (e.target as HTMLElement).closest(".cap") as HTMLElement | null;
    const overId = el?.getAttribute("data-id") ?? null;
    if (!overId) {
      clearHoverTimer();
      hoverId = null;
    }
    if (zoomId && overId !== zoomId) hideZoom();
  });

  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      if (zoomId) hideZoom(); // 미리보기가 떠 있으면 Esc는 그것부터 닫는다
      else qp.cancel();
    } else if (e.key === "Enter") {
      e.preventDefault();
      void paste();
    } else if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      cursor = Math.max(0, Math.min(items.length - 1, cursor + (e.key === "ArrowRight" ? 1 : -1)));
      paintCursor();
    } else if (e.key === " ") {
      e.preventDefault(); // Space = 커서 항목 선택 토글(여러 장 모으기)
      const id = items[cursor]?.id;
      if (!id) return;
      const i = selected.indexOf(id);
      if (i === -1) selected.push(id);
      else selected.splice(i, 1);
      paintSelection();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
      e.preventDefault();
      selected.length = 0;
      for (const it of items) selected.push(it.id);
      paintSelection();
    }
  });

  (async () => {
    const c = await qp.conn();
    base = `http://127.0.0.1:${c.port}`;
    token = c.token;
    render(await qp.list());
  })();

  // 열릴 때마다 최신 목록으로 다시 그린다(그동안 캡처가 늘었을 수 있음).
  qp.onShow((next) => render(next));
})();
