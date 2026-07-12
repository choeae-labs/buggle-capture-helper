// 녹화 인디케이터 렌더러 — 경과시간 표시 + 정지 버튼. nodeIntegration 창(require 사용).
(function () {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { ipcRenderer } = require("electron");
  const timeEl = document.getElementById("time") as HTMLSpanElement;

  function fmt(sec: number): string {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }

  ipcRenderer.on("recorder:tick", (_e: unknown, data: { seconds: number }) => {
    timeEl.textContent = fmt(data.seconds);
  });

  document.getElementById("stop")!.addEventListener("click", () => {
    ipcRenderer.send("recorder:stop-request");
  });
})();
