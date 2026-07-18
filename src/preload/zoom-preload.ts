import { contextBridge, ipcRenderer } from "electron";

/** zoom 렌더러 ↔ main 안전 브리지(contextIsolation). */
contextBridge.exposeInMainWorld("zoomBridge", {
  onImg: (cb: (d: { url: string; isGif: boolean }) => void) => {
    ipcRenderer.on("zoom:img", (_e, d) => cb(d));
  },
});
