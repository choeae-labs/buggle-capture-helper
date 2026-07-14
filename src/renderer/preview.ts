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
  edit: (id: string) => Promise<void>;
  capture: (kind: "full" | "region" | "fixed") => Promise<void>;
  record: (kind: "full" | "region") => Promise<void>;
  getHotkeys: () => Promise<HotkeyMap>;
  setHotkeys: (hk: Partial<HotkeyMap>) => Promise<HotkeyMap>;
  suspendHotkeys: () => Promise<void>;
  resumeHotkeys: () => Promise<void>;
  getRecording: () => Promise<{ fps: number; maxSeconds: number; maxWidth: number }>;
  getSettings: () => Promise<{ maxItems: number; retentionDays: number }>;
  setSettings: (s: { maxItems?: number; retentionDays?: number }) => Promise<{ maxItems: number; retentionDays: number }>;
  clearAll: () => Promise<number>;
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

  /** 플랫폼: Mac이면 단축키 표기를 ⌘/⇧ 심볼로. */
  const IS_MAC = navigator.platform.toUpperCase().includes("MAC");
  const PRIME = IS_MAC ? "⌘" : "Ctrl+"; // 주 수식키 표기(복사/붙여넣기 안내용)

  /** 하단 안내에 짧은 상태 메시지를 잠깐 표시. */
  let tipTimer: ReturnType<typeof setTimeout> | null = null;
  if (IS_MAC) tipEl.innerHTML = "<b>⌘클릭</b> 다중선택 · <b>⌘C</b> 복사 · <b>Del</b> 삭제";
  const tipDefault = tipEl.innerHTML;
  function restoreTip() {
    if (selected.size > 1) tipEl.textContent = `${selected.size}장 선택됨 · ${PRIME}C 복사 · Del 삭제`;
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
          ${it.kind !== "gif" ? `<button data-edit="${it.id}">편집</button>` : ""}
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
      flashTip(ok ? `${ids.length}장 복사됨 · ${PRIME}V로 붙여넣기` : "복사 실패");
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
    const editId = t.getAttribute("data-edit");
    const copyId = t.getAttribute("data-copy");
    const delId = t.getAttribute("data-del");
    if (editId) {
      void bc.edit(editId);
      return;
    }
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

  /* ===== 단축키 설정 (키 레코딩 — 입력칸 클릭 후 원하는 조합을 그대로 누른다) ===== */
  const settingsEl = document.getElementById("settings") as HTMLDivElement;
  const HK_ROWS: { key: keyof HotkeyMap; label: string }[] = [
    { key: "fullScreen", label: "전체 화면 캡처하기" },
    { key: "region", label: "영역을 지정하여 캡처하기" },
    { key: "fixed", label: "고정된 사각 영역 캡처하기" },
    { key: "setFixed", label: "고정 영역 다시 지정하기" },
    { key: "record", label: "화면 녹화하기 (GIF)" },
  ];

  // KeyboardEvent.code → Electron accelerator 키 이름("" = 등록 불가 키).
  function codeToAccelKey(code: string): string {
    if (/^Key[A-Z]$/.test(code)) return code.slice(3); // KeyA → A
    if (/^Digit[0-9]$/.test(code)) return code.slice(5); // Digit1 → 1
    if (/^Numpad[0-9]$/.test(code)) return "num" + code.slice(6); // Numpad1 → num1
    if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code; // F1~F24
    const map: Record<string, string> = {
      Space: "Space", ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right",
      Home: "Home", End: "End", PageUp: "PageUp", PageDown: "PageDown", Insert: "Insert",
      PrintScreen: "PrintScreen", Backquote: "`", Minus: "-", Equal: "=",
      BracketLeft: "[", BracketRight: "]", Backslash: "\\", Semicolon: ";", Quote: "'",
      Comma: ",", Period: ".", Slash: "/",
    };
    return map[code] ?? "";
  }

  // accelerator 문자열 ↔ 조합 구조체. Cmd(⌘)와 Ctrl(⌃)을 구분해 다룬다.
  // CommandOrControl은 "플랫폼 주 수식키"(Mac=⌘, Win=Ctrl)로 해석.
  type Combo = { meta: boolean; ctrl: boolean; alt: boolean; shift: boolean; key: string };
  function parseAccel(accel: string): Combo {
    const c: Combo = { meta: false, ctrl: false, alt: false, shift: false, key: "" };
    for (const p of accel ? accel.split("+") : []) {
      if (p === "Shift") c.shift = true;
      else if (p === "CommandOrControl" || p === "CmdOrCtrl") (IS_MAC ? (c.meta = true) : (c.ctrl = true));
      else if (p === "Command" || p === "Cmd" || p === "Super" || p === "Meta") c.meta = true;
      else if (p === "Control" || p === "Ctrl") c.ctrl = true;
      else if (p === "Alt" || p === "Option") c.alt = true;
      else c.key = p;
    }
    return c;
  }
  function buildAccel(c: Combo): string {
    if (!c.key) return ""; // 없음 → 비활성
    const parts: string[] = [];
    // 주 수식키(Mac ⌘ / Win Ctrl)는 CommandOrControl로 저장 — 기본값과 호환·이식성 유지.
    if (IS_MAC ? c.meta : c.ctrl) parts.push("CommandOrControl");
    if (IS_MAC && c.ctrl) parts.push("Control"); // Mac의 ⌃는 별도 유지
    if (!IS_MAC && c.meta) parts.push("Super"); // Windows 키(드묾)
    if (c.alt) parts.push("Alt");
    if (c.shift) parts.push("Shift");
    parts.push(c.key);
    return parts.join("+");
  }
  /** 표시용: Mac은 ⌃⌥⇧⌘ 심볼(애플 표준 순서), Windows는 Ctrl+Alt+Shift+키. */
  function fmtCombo(accel: string): string {
    if (!accel) return "없음";
    const c = parseAccel(accel);
    if (IS_MAC) {
      return (c.ctrl ? "⌃" : "") + (c.alt ? "⌥" : "") + (c.shift ? "⇧" : "") + (c.meta ? "⌘" : "") + c.key;
    }
    const parts: string[] = [];
    if (c.ctrl) parts.push("Ctrl");
    if (c.meta) parts.push("Win");
    if (c.alt) parts.push("Alt");
    if (c.shift) parts.push("Shift");
    parts.push(c.key);
    return parts.join("+");
  }

  // 설정 행을 그린다(최초 1회). 레코더 버튼(data-accel에 현재 값 보관) + 지우기.
  const groupEl = document.getElementById("hk-group") as HTMLDivElement;
  for (const row of HK_ROWS) {
    const el = document.createElement("div");
    el.className = "hkrow";
    el.setAttribute("data-hk", row.key);
    el.innerHTML = `
      <span class="lab">${row.label}</span>
      <div class="hkctrl">
        <button type="button" class="hk-rec" data-accel="">없음</button>
        <button type="button" class="hk-clear" title="단축키 지우기(비활성)">✕</button>
      </div>`;
    groupEl.appendChild(el);
  }
  const hkRowEls = Array.from(groupEl.querySelectorAll<HTMLDivElement>(".hkrow"));

  // ---- 레코딩 상태 ----
  // 입력칸 클릭 → 녹화 시작. 키를 누를 때마다 실시간 표시(확정 X).
  // Enter(또는 다른 영역 클릭) → 후보 확정. Esc → 취소(원래 값 복원). 단독 키도 허용.
  let recHkBtn: HTMLButtonElement | null = null; // 현재 녹화 중인 버튼
  let candidate = ""; // 현재 후보 accelerator(실시간)

  function setRowAccel(btn: HTMLButtonElement, accel: string) {
    btn.setAttribute("data-accel", accel);
    btn.textContent = fmtCombo(accel);
    btn.classList.toggle("empty", !accel);
  }
  /** 후보를 확정(적용)하고 녹화 종료. */
  function commitHkRecording() {
    if (!recHkBtn) return;
    const btn = recHkBtn;
    recHkBtn = null;
    btn.classList.remove("rec");
    setRowAccel(btn, candidate); // 아무 것도 안 눌렀으면 candidate=기존값 → 변화 없음
  }
  /** 적용 없이 취소 — 원래 값 복원. */
  function cancelHkRecording() {
    if (!recHkBtn) return;
    const btn = recHkBtn;
    recHkBtn = null;
    btn.classList.remove("rec");
    setRowAccel(btn, btn.getAttribute("data-accel") ?? "");
  }
  function startHkRecording(btn: HTMLButtonElement) {
    commitHkRecording(); // 진행 중이던 다른 녹화는 확정하고 시작
    recHkBtn = btn;
    candidate = btn.getAttribute("data-accel") ?? "";
    btn.classList.add("rec");
    btn.textContent = "키를 누르세요…";
  }

  for (const el of hkRowEls) {
    const btn = el.querySelector(".hk-rec") as HTMLButtonElement;
    btn.addEventListener("click", (e) => {
      e.stopPropagation(); // 패널 클릭(확정)과 구분
      if (recHkBtn !== btn) startHkRecording(btn);
    });
    (el.querySelector(".hk-clear") as HTMLButtonElement).addEventListener("click", (e) => {
      e.stopPropagation();
      if (recHkBtn === btn) {
        recHkBtn = null;
        btn.classList.remove("rec");
      }
      setRowAccel(btn, "");
    });
  }
  // 녹화 중 설정 패널의 다른 곳을 클릭 → 후보 확정("다른 영역 클릭 시 지정").
  settingsEl.addEventListener("click", () => {
    if (recHkBtn) commitHkRecording();
  });

  // 녹화 중 키 입력 — 누를 때마다 실시간 표시, Enter 확정 / Esc 취소.
  window.addEventListener(
    "keydown",
    (e) => {
      if (!recHkBtn) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.key === "Escape") return cancelHkRecording();
      if (e.key === "Enter") return commitHkRecording();
      // 수식키만 누른 상태 → 실시간으로 수식키만 표시(본 키 대기).
      if (["Shift", "Control", "Alt", "Meta"].includes(e.key)) {
        const mods: string[] = [];
        if (IS_MAC ? e.metaKey : e.ctrlKey) mods.push(IS_MAC ? "⌘" : "Ctrl");
        if (IS_MAC && e.ctrlKey) mods.push("⌃");
        if (e.altKey) mods.push(IS_MAC ? "⌥" : "Alt");
        if (e.shiftKey) mods.push(IS_MAC ? "⇧" : "Shift");
        recHkBtn.textContent = mods.length ? mods.join(IS_MAC ? "" : "+") + " …" : "키를 누르세요…";
        return;
      }
      const key = codeToAccelKey(e.code);
      if (!key) return; // 등록 불가 키(한/영, CapsLock 등)
      // 단독 키도 허용(사용자 요청) — 수식키 없이도 후보로 저장.
      const combo: Combo = { meta: e.metaKey, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, key };
      candidate = buildAccel(combo);
      recHkBtn.textContent = fmtCombo(candidate); // 실시간 표시(확정은 Enter/클릭)
    },
    true
  );
  // PrintScreen은 브라우저에서 keydown이 안 오고 keyup만 온다 → keyup으로 별도 인식.
  window.addEventListener(
    "keyup",
    (e) => {
      if (!recHkBtn || e.code !== "PrintScreen") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      const combo: Combo = { meta: e.metaKey, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, key: "PrintScreen" };
      candidate = buildAccel(combo);
      recHkBtn.textContent = fmtCombo(candidate);
    },
    true
  );

  function fillRow(el: HTMLDivElement, accel: string) {
    setRowAccel(el.querySelector(".hk-rec") as HTMLButtonElement, accel);
  }
  function readRow(el: HTMLDivElement): string {
    return (el.querySelector(".hk-rec") as HTMLButtonElement).getAttribute("data-accel") ?? "";
  }

  function openSettings() {
    void bc.suspendHotkeys(); // 설정 중엔 전역 단축키 해제 → 조합 눌러도 캡처 안 발동
    bc.getHotkeys().then((hk) => {
      for (const el of hkRowEls) {
        const key = el.getAttribute("data-hk") as keyof HotkeyMap;
        fillRow(el, hk[key] ?? "");
      }
      settingsEl.classList.remove("hidden");
    });
    void bc.getSettings().then((s) => {
      (document.getElementById("set-maxitems") as HTMLInputElement).value = String(s.maxItems);
      (document.getElementById("set-retention") as HTMLInputElement).value = String(s.retentionDays);
    });
  }
  function closeSettings() {
    cancelHkRecording();
    settingsEl.classList.add("hidden");
    void bc.resumeHotkeys(); // 설정 닫으면 전역 단축키 재등록
  }

  document.getElementById("settings-open")!.addEventListener("click", openSettings);
  document.getElementById("settings-close")!.addEventListener("click", closeSettings);
  document.getElementById("set-cancel")!.addEventListener("click", closeSettings);
  document.getElementById("set-clearall")!.addEventListener("click", async () => {
    if (!confirm("저장된 캡처를 모두 삭제할까요? 되돌릴 수 없습니다.")) return;
    const n = await bc.clearAll();
    flashTip(`${n}개 전체 삭제됨`);
  });
  document.getElementById("set-save")!.addEventListener("click", async () => {
    commitHkRecording(); // 녹화 중이면 후보를 먼저 확정
    const next: Partial<HotkeyMap> = {};
    for (const el of hkRowEls) {
      const key = el.getAttribute("data-hk") as keyof HotkeyMap;
      next[key] = readRow(el);
    }
    await bc.setHotkeys(next);
    // 보관 설정도 함께 저장.
    const mi = parseInt((document.getElementById("set-maxitems") as HTMLInputElement).value, 10);
    const rd = parseInt((document.getElementById("set-retention") as HTMLInputElement).value, 10);
    await bc.setSettings({
      maxItems: Number.isFinite(mi) ? mi : undefined,
      retentionDays: Number.isFinite(rd) ? rd : undefined,
    });
    refreshTooltips(); // 바뀐 단축키를 툴팁에 반영
    closeSettings();
    flashTip("설정 저장됨");
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

  // 캡처/녹화 버튼 툴팁에 단축키 + 녹화 최대시간 반영(설정 변경 시 갱신).
  function fmtAccel(a: string): string {
    return fmtCombo(a); // Mac: ⌘⇧1 심볼 / Windows: Ctrl+Shift+1
  }
  function applyTooltips(hk: HotkeyMap, maxSeconds: number) {
    const set = (sel: string, base: string, accel: string) => {
      const el = document.querySelector(sel);
      if (el) el.setAttribute("title", accel ? `${base} (${fmtAccel(accel)})` : `${base} (단축키 없음)`);
    };
    set('[data-cap="full"]', "전체 화면 캡처", hk.fullScreen);
    set('[data-cap="region"]', "선택 영역 캡처 · 드래그", hk.region);
    set('[data-cap="fixed"]', "고정 영역 캡처", hk.fixed);
    const rec = document.getElementById("recBtn");
    if (rec) {
      const base = `화면 녹화 · GIF, 최대 ${maxSeconds}초`;
      rec.setAttribute("title", hk.record ? `${base} (${fmtAccel(hk.record)})` : base);
    }
  }
  function refreshTooltips() {
    Promise.all([bc.getHotkeys(), bc.getRecording()]).then(([hk, rec]) => applyTooltips(hk, rec.maxSeconds));
  }
  refreshTooltips();

  bc.onCaptures(render);
  bc.conn().then((c) => {
    base = `http://127.0.0.1:${c.port}`;
    token = c.token;
    return bc.list();
  }).then(render);
})();
