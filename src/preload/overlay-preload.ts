import { contextBridge, ipcRenderer } from "electron";

/** 선택 영역 오버레이 렌더러 → main. */
contextBridge.exposeInMainWorld("overlay", {
  select: (rect: { x: number; y: number; width: number; height: number }) => ipcRenderer.send("overlay:select", rect),
  cancel: () => ipcRenderer.send("overlay:cancel"),
});
