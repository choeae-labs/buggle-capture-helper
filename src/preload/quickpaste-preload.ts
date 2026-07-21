import { contextBridge, ipcRenderer } from "electron";

/** quickpaste 렌더러 ↔ main 안전 브리지(contextIsolation). */
contextBridge.exposeInMainWorld("qp", {
  list: () => ipcRenderer.invoke("quick:list"),
  conn: () => ipcRenderer.invoke("preview:conn") as Promise<{ port: number; token: string }>,
  paste: (ids: string[]) => ipcRenderer.invoke("quick:paste", ids),
  cancel: () => ipcRenderer.send("quick:cancel"),
  showZoom: (id: string, anchor: { x: number; y: number; w: number; h: number }) => ipcRenderer.send("quick-zoom:show", id, anchor),
  hideZoom: () => ipcRenderer.send("quick-zoom:hide"),
  onShow: (cb: (items: unknown[]) => void) => {
    const h = (_e: unknown, items: unknown[]) => cb(items);
    ipcRenderer.on("quick:show", h);
    return () => ipcRenderer.removeListener("quick:show", h);
  },
});
