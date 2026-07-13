import http from "node:http";
import fs from "node:fs";
import { URL } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import { app } from "electron";
import { loadConfig } from "./config";
import { store } from "./store";

/**
 * 로컬 전용 API 서버 — 127.0.0.1에만 listen. Buggle 웹앱이 캡처 목록/파일을 가져간다.
 * 보안: origin allowlist + pairing token(Authorization: Bearer 또는 ?token=). 외부 네트워크 불가.
 * /health, /pair는 detection/pairing용으로 토큰 없이 접근(대신 origin allowlist).
 */

const NAME = "buggle 캡처 도우미";

function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return true; // 브라우저 아님(직접 호출) — 토큰으로 별도 보호
  return loadConfig().allowedOrigins.includes(origin);
}

function setCors(res: http.ServerResponse, origin: string | undefined) {
  if (origin && isAllowedOrigin(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    // Private Network Access: https(공개 origin) 페이지가 127.0.0.1(로컬)로 붙을 때
    // Chrome이 preflight로 요구하는 헤더. 없으면 운영(https://www.buggle.co.kr)에서 연결이 막힌다.
    res.setHeader("Access-Control-Allow-Private-Network", "true");
    res.setHeader("Access-Control-Max-Age", "600");
  }
}

function tokenFrom(req: http.IncomingMessage, url: URL): string | null {
  const auth = req.headers["authorization"];
  if (typeof auth === "string" && auth.startsWith("Bearer ")) return auth.slice(7);
  return url.searchParams.get("token");
}
function authed(req: http.IncomingMessage, url: URL): boolean {
  return tokenFrom(req, url) === loadConfig().token;
}

function json(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

const EXT_CT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  mp4: "video/mp4",
  webm: "video/webm",
};

let server: http.Server | null = null;
let wss: WebSocketServer | null = null;
const clients = new Set<WebSocket>();

function broadcast(msg: unknown) {
  const data = JSON.stringify(msg);
  for (const ws of clients) {
    try {
      ws.send(data);
    } catch {
      /* 끊긴 소켓 무시 */
    }
  }
}

export function startServer(): void {
  const cfg = loadConfig();
  if (server) return;

  server = http.createServer((req, res) => {
    const origin = req.headers.origin;
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${cfg.port}`);
    setCors(res, origin);

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
    // 브라우저(origin 있음)면 allowlist 필수.
    if (origin && !isAllowedOrigin(origin)) {
      json(res, 403, { error: "origin not allowed" });
      return;
    }

    const p = url.pathname;

    // 공개(detection/pairing)
    if (p === "/health" && req.method === "GET") {
      json(res, 200, { ok: true, name: NAME, version: app.getVersion(), needsPairing: false });
      return;
    }
    if (p === "/pair" && req.method === "POST") {
      // MVP: origin allowlist 통과 시 토큰 발급(자동 페어링). 이후 이 토큰으로 API 호출.
      json(res, 200, { token: loadConfig().token });
      return;
    }

    // 이하 토큰 필요
    if (!authed(req, url)) {
      json(res, 401, { error: "unauthorized" });
      return;
    }

    if (p === "/captures" && req.method === "GET") {
      json(res, 200, { items: store.list() });
      return;
    }

    const fileMatch = /^\/captures\/([^/]+)\/(file|thumb)$/.exec(p);
    if (fileMatch && req.method === "GET") {
      const [, id, which] = fileMatch;
      const it = store.get(id);
      const filePath = which === "thumb" ? store.thumbPath(id) : store.filePath(id);
      if (!it || !filePath || !fs.existsSync(filePath)) {
        json(res, 404, { error: "not found" });
        return;
      }
      const ct = which === "thumb" ? "image/png" : EXT_CT[it.ext] ?? "application/octet-stream";
      res.writeHead(200, { "Content-Type": ct, "Cache-Control": "no-store" });
      fs.createReadStream(filePath).pipe(res);
      return;
    }

    const markMatch = /^\/captures\/([^/]+)\/mark-used$/.exec(p);
    if (markMatch && req.method === "POST") {
      const ok = store.markUsed(markMatch[1]);
      json(res, ok ? 200 : 404, { ok });
      return;
    }

    const delMatch = /^\/captures\/([^/]+)$/.exec(p);
    if (delMatch && req.method === "DELETE") {
      const ok = store.remove(delMatch[1]);
      json(res, ok ? 200 : 404, { ok });
      return;
    }

    json(res, 404, { error: "not found" });
  });

  // WebSocket /events — 변경 브로드캐스트. 토큰 + origin 검사.
  wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${cfg.port}`);
    const origin = req.headers.origin;
    if (url.pathname !== "/events" || (origin && !isAllowedOrigin(origin)) || tokenFrom(req, url) !== loadConfig().token) {
      socket.destroy();
      return;
    }
    wss!.handleUpgrade(req, socket, head, (ws) => {
      clients.add(ws);
      ws.send(JSON.stringify({ type: "hello", name: NAME }));
      ws.on("close", () => clients.delete(ws));
      ws.on("error", () => clients.delete(ws));
    });
  });

  store.on("change", () => broadcast({ type: "change" }));

  server.listen(cfg.port, "127.0.0.1", () => {
    console.log(`[server] ${NAME} listening on http://127.0.0.1:${cfg.port}`);
  });
  server.on("error", (e) => console.error("[server] error:", e));
}

export function stopServer(): void {
  for (const ws of clients) {
    try {
      ws.close();
    } catch {
      /* 무시 */
    }
  }
  clients.clear();
  wss?.close();
  server?.close();
  server = null;
  wss = null;
}
