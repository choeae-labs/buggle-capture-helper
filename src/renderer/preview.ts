// 플로팅 미리보기 렌더러 — 최근 캡처 표시, 복사/삭제, 캡처 트리거. 전역 스크립트(import/export 없음).
interface CaptureItem {
  id: string;
  kind?: string;
  thumbnailUrl: string;
  fileUrl?: string;
  createdAt: string;
  usedAt?: string | null;
  width?: number;
  height?: number;
}
type HotkeyMap = { fullScreen: string; region: string; fixed: string; setFixed: string; record: string };
interface Bc {
  list: () => Promise<CaptureItem[]>;
  conn: () => Promise<{ port: number; token: string }>;
  remove: (id: string) => Promise<boolean>;
  copy: (id: string) => Promise<boolean>;
  copyFiles: (ids: string[]) => Promise<boolean>;
  capture: (kind: "full" | "region" | "fixed") => Promise<void>;
  record: (kind: "full" | "region") => Promise<void>;
  getHotkeys: () => Promise<HotkeyMap>;
  setHotkeys: (hk: Partial<HotkeyMap>) => Promise<HotkeyMap>;
  hide: () => void;
  collapse: (v: boolean) => void;
  setTrayIcon: (d: { p16: string; p32: string }) => void;
  onCaptures: (cb: (items: CaptureItem[]) => void) => () => void;
}
declare const bc: Bc;

(function () {
  const listEl = document.getElementById("list") as HTMLDivElement;
  const tipEl = document.getElementById("tip") as HTMLElement;
  let base = "";
  let token = "";
  let items: CaptureItem[] = []; // 현재 표시 중(최근 6개)
  const selected = new Set<string>(); // 다중 선택
  let anchorId: string | null = null; // Shift 범위 선택 기준점
  let prevIds = new Set<string>(); // 직전 목록 id(신규 캡처 감지용)

  function timeAgo(iso: string): string {
    const diff = Date.now() - new Date(iso).getTime();
    const m = Math.floor(diff / 60000);
    if (m < 1) return "방금";
    if (m < 60) return `${m}분 전`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}시간 전`;
    return `${Math.floor(h / 24)}일 전`;
  }

  /** 하단 안내에 짧은 상태 메시지를 잠깐 표시. */
  let tipTimer: ReturnType<typeof setTimeout> | null = null;
  const tipDefault = tipEl.innerHTML;
  function restoreTip() {
    if (selected.size > 1) tipEl.textContent = `${selected.size}장 선택됨 · Ctrl+C 복사 · Del 삭제`;
    else tipEl.innerHTML = tipDefault;
  }
  function flashTip(msg: string) {
    tipEl.textContent = msg;
    if (tipTimer) clearTimeout(tipTimer);
    tipTimer = setTimeout(restoreTip, 1200);
  }

  /** 선택 표시만 갱신(재렌더 없이). */
  function paintSelection() {
    for (const el of Array.from(listEl.querySelectorAll(".item"))) {
      el.classList.toggle("selected", selected.has(el.getAttribute("data-id") || ""));
    }
    restoreTip();
  }

  function render(next: CaptureItem[]) {
    items = next; // 전체 표시(스크롤). 이전 캡처도 아래로 스크롤해 볼 수 있음.
    // 사라진 항목은 선택에서 제거.
    for (const id of Array.from(selected)) {
      if (!items.some((it) => it.id === id)) selected.delete(id);
    }
    // 새로 들어온 캡처(직전 목록에 없던 id) 중 가장 최신을 기본 선택.
    const firstNew = items.find((it) => !prevIds.has(it.id));
    if (prevIds.size > 0 && firstNew) {
      selected.clear();
      selected.add(firstNew.id);
      anchorId = firstNew.id;
    } else if (selected.size === 0 && items[0]) {
      // 초기/선택 비었을 때 최신 1장 기본 선택(클릭→Ctrl+C 바로 가능).
      selected.add(items[0].id);
      anchorId = items[0].id;
    }
    prevIds = new Set(items.map((it) => it.id));
    if (items.length === 0) {
      listEl.innerHTML = `<div id="empty">아직 캡처가 없어요.<br/>단축키로 캡처해보세요.</div>`;
      restoreTip();
      return;
    }
    listEl.innerHTML = "";
    for (const it of items) {
      const wrap = document.createElement("div");
      wrap.className = "item" + (selected.has(it.id) ? " selected" : "");
      wrap.setAttribute("data-id", it.id);
      // GIF는 실제 파일을 보여줘 목록에서도 움직이게. 그 외는 정지 썸네일(PNG).
      const srcUrl = it.kind === "gif" && it.fileUrl ? it.fileUrl : it.thumbnailUrl;
      const thumb = base ? `${base}${srcUrl}?token=${encodeURIComponent(token)}` : "";
      wrap.innerHTML = `
        <span class="check">✓</span>
        ${it.kind === "gif" ? `<span class="gifbadge">GIF</span>` : ""}
        <img src="${thumb}" alt="" />
        <div class="meta">
          <span class="time">${timeAgo(it.createdAt)}${it.width ? ` · ${it.width}×${it.height}` : ""}</span>
          ${it.usedAt ? `<span class="used">첨부됨</span>` : ""}
        </div>
        <div class="acts">
          <button data-copy="${it.id}">복사</button>
          <button data-del="${it.id}">삭제</button>
        </div>`;
      listEl.appendChild(wrap);
    }
    restoreTip();
  }

  /** 클릭 방식에 따라 선택 갱신. plain=단일, ctrl=토글, shift=범위. */
  function selectClick(id: string, e: MouseEvent) {
    if (e.shiftKey && anchorId) {
      const ids = items.map((it) => it.id);
      const a = ids.indexOf(anchorId);
      const b = ids.indexOf(id);
      if (a !== -1 && b !== -1) {
        selected.clear();
        for (let i = Math.min(a, b); i <= Math.max(a, b); i++) selected.add(ids[i]);
      }
    } else if (e.ctrlKey || e.metaKey) {
      if (selected.has(id)) selected.delete(id);
      else selected.add(id);
      anchorId = id;
    } else {
      selected.clear();
      selected.add(id);
      anchorId = id;
    }
    paintSelection();
  }

  async function copySelected() {
    const ids = items.map((it) => it.id).filter((id) => selected.has(id));
    if (ids.length === 0) return;
    if (ids.length > 1) {
      // 여러 장 → 파일 목록으로 복사(브라우저에 Ctrl+V 시 여러 장 붙여넣기, GIF 애니메이션 유지).
      const ok = await bc.copyFiles(ids);
      flashTip(ok ? `${ids.length}장 복사됨 · Ctrl+V로 붙여넣기` : "복사 실패");
    } else {
      const ok = await bc.copy(ids[0]); // 1장 → 비트맵(어디에나 이미지로 붙게).
      flashTip(ok ? "복사됨" : "복사 실패");
    }
  }
  async function deleteSelected() {
    const ids = items.map((it) => it.id).filter((id) => selected.has(id));
    if (ids.length === 0) return;
    for (const id of ids) await bc.remove(id); // store 변경 → onCaptures로 재렌더
    flashTip(`${ids.length}장 삭제됨`);
  }

  listEl.addEventListener("click", async (e) => {
    const t = e.target as HTMLElement;
    const copyId = t.getAttribute("data-copy");
    const delId = t.getAttribute("data-del");
    if (copyId) {
      const ok = await bc.copy(copyId);
      t.textContent = ok ? "복사됨" : "실패";
      setTimeout(() => (t.textContent = "복사"), 1200);
      return;
    }
    if (delId) {
      await bc.remove(delId);
      return;
    }
    // 그 외 영역 클릭 → 선택(수식키 반영).
    const item = t.closest(".item") as HTMLElement | null;
    if (item) selectClick(item.getAttribute("data-id")!, e);
  });

  // 키보드: Ctrl/⌘+C 복사, Delete/Backspace 삭제(창이 포커스됐을 때 = 클릭 후).
  window.addEventListener("keydown", (e) => {
    // 설정 패널이 열려 있으면 목록 단축키 무시.
    if (!document.getElementById("settings")!.classList.contains("hidden")) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c") {
      e.preventDefault();
      void copySelected();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
      e.preventDefault(); // 전체 선택
      selected.clear();
      for (const it of items) selected.add(it.id);
      paintSelection();
    } else if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      void deleteSelected();
    }
  });

  const recMenu = document.getElementById("recMenu") as HTMLDivElement;
  const closeRecMenu = () => recMenu.classList.add("hidden");

  document.getElementById("caps")!.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    // 녹화 버튼 → 전체/영역 선택 메뉴 토글.
    if (t.closest("#recBtn")) {
      recMenu.classList.toggle("hidden");
      return;
    }
    // 메뉴에서 전체/영역 선택.
    const recItem = t.closest("[data-rec]") as HTMLElement | null;
    if (recItem) {
      closeRecMenu();
      bc.record(recItem.getAttribute("data-rec") as "full" | "region");
      return;
    }
    const btn = t.closest("[data-cap]") as HTMLElement | null;
    const kind = btn?.getAttribute("data-cap") as "full" | "region" | "fixed" | null;
    if (kind) bc.capture(kind);
  });
  // 바깥 클릭 시 녹화 메뉴 닫기.
  document.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    if (!t.closest("#recBtn") && !t.closest("#recMenu")) closeRecMenu();
  });
  document.getElementById("close")!.addEventListener("click", () => bc.hide());
  let collapsed = false;
  const collapseBtn = document.getElementById("collapse") as HTMLButtonElement;
  collapseBtn.addEventListener("click", () => {
    collapsed = !collapsed;
    listEl.classList.toggle("hidden", collapsed);
    document.querySelector(".caps-wrap")!.classList.toggle("hidden", collapsed);
    tipEl.classList.toggle("hidden", collapsed);
    collapseBtn.textContent = collapsed ? "▸" : "▾";
    bc.collapse(collapsed); // 창 자체를 헤더만 남기고 최소화/복원
  });

  /* ===== 맨 위로 플로팅 버튼 ===== */
  const toTop = document.getElementById("toTop") as HTMLButtonElement;
  listEl.addEventListener("scroll", () => {
    toTop.classList.toggle("show", listEl.scrollTop > 120);
  });
  toTop.addEventListener("click", () => listEl.scrollTo({ top: 0, behavior: "smooth" }));

  /* ===== 단축키 설정 (체크박스 + 키 드롭다운) ===== */
  const settingsEl = document.getElementById("settings") as HTMLDivElement;
  const HK_ROWS: { key: keyof HotkeyMap; label: string }[] = [
    { key: "fullScreen", label: "전체 화면 캡처하기" },
    { key: "region", label: "영역을 지정하여 캡처하기" },
    { key: "fixed", label: "고정된 사각 영역 캡처하기" },
    { key: "setFixed", label: "고정 영역 다시 지정하기" },
    { key: "record", label: "화면 녹화하기 (GIF)" },
  ];

  // 키 드롭다운 옵션(값=Electron accelerator 키, "" = 없음).
  function keyOptionValues(): string[] {
    const letters: string[] = [];
    for (let i = 65; i <= 90; i++) letters.push(String.fromCharCode(i)); // A~Z
    const fkeys: string[] = [];
    for (let i = 1; i <= 12; i++) fkeys.push("F" + i); // F1~F12
    return [
      "", "PrintScreen",
      "1", "2", "3", "4", "5", "6", "7", "8", "9", "0",
      ...letters, ...fkeys,
      "Insert", "Home", "End", "PageUp", "PageDown",
      "Up", "Down", "Left", "Right", "Space",
    ];
  }
  const KEY_OPTIONS_HTML = keyOptionValues()
    .map((v) => `<option value="${v}">${v === "" ? "없음" : v}</option>`)
    .join("");

  // accelerator 문자열 ↔ {shift,ctrl,alt,key}
  function parseAccel(accel: string) {
    let shift = false, ctrl = false, alt = false, key = "";
    for (const p of accel ? accel.split("+") : []) {
      if (p === "Shift") shift = true;
      else if (["CommandOrControl", "Control", "Command", "Cmd", "Ctrl"].includes(p)) ctrl = true;
      else if (["Alt", "Option"].includes(p)) alt = true;
      else key = p;
    }
    return { shift, ctrl, alt, key };
  }
  function buildAccel(shift: boolean, ctrl: boolean, alt: boolean, key: string): string {
    if (!key) return ""; // 없음 → 비활성
    const parts: string[] = [];
    if (ctrl) parts.push("CommandOrControl");
    if (alt) parts.push("Alt");
    if (shift) parts.push("Shift");
    parts.push(key);
    return parts.join("+");
  }

  // 설정 행을 그린다(최초 1회).
  const groupEl = document.getElementById("hk-group") as HTMLDivElement;
  for (const row of HK_ROWS) {
    const el = document.createElement("div");
    el.className = "hkrow";
    el.setAttribute("data-hk", row.key);
    el.innerHTML = `
      <span class="lab">${row.label}</span>
      <div class="hkctrl">
        <label class="mod"><input type="checkbox" data-mod="shift" /> Shift</label>
        <label class="mod"><input type="checkbox" data-mod="ctrl" /> Ctrl</label>
        <label class="mod"><input type="checkbox" data-mod="alt" /> Alt</label>
        <select data-key>${KEY_OPTIONS_HTML}</select>
      </div>`;
    groupEl.appendChild(el);
  }
  const hkRowEls = Array.from(groupEl.querySelectorAll<HTMLDivElement>(".hkrow"));

  function fillRow(el: HTMLDivElement, accel: string) {
    const p = parseAccel(accel);
    (el.querySelector('[data-mod="shift"]') as HTMLInputElement).checked = p.shift;
    (el.querySelector('[data-mod="ctrl"]') as HTMLInputElement).checked = p.ctrl;
    (el.querySelector('[data-mod="alt"]') as HTMLInputElement).checked = p.alt;
    (el.querySelector("[data-key]") as HTMLSelectElement).value = p.key;
  }
  function readRow(el: HTMLDivElement): string {
    const shift = (el.querySelector('[data-mod="shift"]') as HTMLInputElement).checked;
    const ctrl = (el.querySelector('[data-mod="ctrl"]') as HTMLInputElement).checked;
    const alt = (el.querySelector('[data-mod="alt"]') as HTMLInputElement).checked;
    const key = (el.querySelector("[data-key]") as HTMLSelectElement).value;
    return buildAccel(shift, ctrl, alt, key);
  }

  function openSettings() {
    bc.getHotkeys().then((hk) => {
      for (const el of hkRowEls) {
        const key = el.getAttribute("data-hk") as keyof HotkeyMap;
        fillRow(el, hk[key] ?? "");
      }
      settingsEl.classList.remove("hidden");
    });
  }
  function closeSettings() {
    settingsEl.classList.add("hidden");
  }

  document.getElementById("settings-open")!.addEventListener("click", openSettings);
  document.getElementById("settings-close")!.addEventListener("click", closeSettings);
  document.getElementById("set-cancel")!.addEventListener("click", closeSettings);
  document.getElementById("set-save")!.addEventListener("click", async () => {
    const next: Partial<HotkeyMap> = {};
    for (const el of hkRowEls) {
      const key = el.getAttribute("data-hk") as keyof HotkeyMap;
      next[key] = readRow(el);
    }
    await bc.setHotkeys(next);
    closeSettings();
    flashTip("단축키 저장됨");
  });

  // 트레이 아이콘 = Buggle 로고. SVG를 PNG로 래스터화해 main에 전달(트레이는 래스터만 지원).
  (function setTrayIcon() {
    const SVG =
      '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240" viewBox="0 0 240 240" fill="none">' +
      '<path d="M98 52 L112 86" stroke="#10376A" stroke-width="11" stroke-linecap="round"/>' +
      '<path d="M142 52 L128 86" stroke="#10376A" stroke-width="11" stroke-linecap="round"/>' +
      '<ellipse cx="120" cy="150" rx="86" ry="78" fill="#FF8500"/>' +
      '<circle cx="120" cy="86" r="28" fill="#10376A"/>' +
      '<path d="M120 86 V226" stroke="#10376A" stroke-width="10" stroke-linecap="round"/>' +
      '<circle cx="80" cy="138" r="14" fill="#10376A"/><circle cx="160" cy="138" r="14" fill="#10376A"/>' +
      '<circle cx="90" cy="186" r="12" fill="#10376A"/><circle cx="150" cy="186" r="12" fill="#10376A"/></svg>';
    const img = new Image();
    img.onload = () => {
      const make = (size: number) => {
        const c = document.createElement("canvas");
        c.width = size;
        c.height = size;
        c.getContext("2d")!.drawImage(img, 0, 0, size, size);
        return c.toDataURL("image/png");
      };
      try {
        bc.setTrayIcon({ p16: make(16), p32: make(32) });
      } catch {
        /* 무시 */
      }
    };
    img.src = "data:image/svg+xml;base64," + btoa(SVG);
  })();

  bc.onCaptures(render);
  bc.conn().then((c) => {
    base = `http://127.0.0.1:${c.port}`;
    token = c.token;
    return bc.list();
  }).then(render);
})();
