import { contextBridge, ipcRenderer } from "electron";

/** preview 렌더러 ↔ main 안전 브리지(contextIsolation). */
contextBridge.exposeInMainWorld("bc", {
  list: () => ipcRenderer.invoke("preview:list"),
  conn: () => ipcRenderer.invoke("preview:conn") as Promise<{ port: number; token: string }>,
  status: () => ipcRenderer.invoke("preview:status"),
  remove: (id: string) => ipcRenderer.invoke("preview:delete", id),
  copy: (id: string) => ipcRenderer.invoke("preview:copy", id),
  capture: (kind: "full" | "region" | "fixed") => ipcRenderer.invoke("preview:capture", kind),
  record: (kind: "full" | "region") => ipcRenderer.invoke("preview:record", kind),
  getHotkeys: () => ipcRenderer.invoke("preview:getHotkeys"),
  setHotkeys: (hk: Record<string, string>) => ipcRenderer.invoke("preview:setHotkeys", hk),
  hide: () => ipcRenderer.send("preview:hide"),
  collapse: (v: boolean) => ipcRenderer.send("preview:collapse", v),
  setTrayIcon: (d: { p16: string; p32: string }) => ipcRenderer.send("tray:icon", d),
  onCaptures: (cb: (items: unknown[]) => void) => {
    const h = (_e: unknown, items: unknown[]) => cb(items);
    ipcRenderer.on("captures", h);
    return () => ipcRenderer.removeListener("captures", h);
  },
});
