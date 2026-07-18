import { app } from "electron";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

/** 앱 데이터 루트 — %APPDATA%/BuggleCapture (요구사항 5.2 저장 위치). */
export function dataDir(): string {
  const dir = path.join(app.getPath("appData"), "BuggleCapture");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
export function capturesDir(): string {
  const dir = path.join(dataDir(), "captures");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export interface FixedRegion {
  displayId: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Hotkeys {
  fullScreen: string;
  region: string;
  fixed: string;
  setFixed: string;
  record: string;
  /** 어느 앱에서든 캡처를 골라 그 자리에 붙여넣기(전역). */
  pastePicker: string;
}

/** GIF 녹화 프리셋(용량/화질 균형). 설정에서 변경 가능. */
export interface RecordingConfig {
  fps: number;
  maxSeconds: number;
  maxWidth: number;
}

export interface AppConfig {
  port: number;
  /** Buggle 웹앱이 API 호출 시 제시할 페어링 토큰(최초 실행 시 생성). */
  token: string;
  /** CORS/연결 허용 origin allowlist(Buggle). */
  allowedOrigins: string[];
  hotkeys: Hotkeys;
  recording: RecordingConfig;
  fixedRegion: FixedRegion | null;
  retentionDays: number;
  maxItems: number;
  /** Windows 로그인 시 자동 시작(트레이 상주). */
  autoStart: boolean;
  preview: { x: number | null; y: number | null; w: number | null; h: number | null; collapsed: boolean; alwaysOnTop: boolean };
}

const DEFAULTS: AppConfig = {
  port: 38473,
  token: "",
  allowedOrigins: [
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "https://buggle.co.kr",
    "https://www.buggle.co.kr",
  ],
  hotkeys: {
    fullScreen: "CommandOrControl+Shift+1",
    region: "CommandOrControl+Shift+2",
    fixed: "CommandOrControl+Shift+3",
    setFixed: "CommandOrControl+Shift+0",
    record: "CommandOrControl+Shift+4",
    pastePicker: "CommandOrControl+Shift+V",
  },
  recording: { fps: 10, maxSeconds: 20, maxWidth: 960 },
  fixedRegion: null,
  retentionDays: 7,
  maxItems: 100,
  autoStart: true,
  preview: { x: null, y: null, w: null, h: null, collapsed: false, alwaysOnTop: true },
};

let cache: AppConfig | null = null;

function configPath(): string {
  return path.join(dataDir(), "config.json");
}

export function loadConfig(): AppConfig {
  if (cache) return cache;
  let cfg = { ...DEFAULTS };
  try {
    const raw = fs.readFileSync(configPath(), "utf8");
    const parsed = JSON.parse(raw);
    cfg = {
      ...DEFAULTS,
      ...parsed,
      hotkeys: { ...DEFAULTS.hotkeys, ...(parsed.hotkeys ?? {}) },
      recording: { ...DEFAULTS.recording, ...(parsed.recording ?? {}) },
      preview: { ...DEFAULTS.preview, ...(parsed.preview ?? {}) },
      // allowedOrigins는 병합(사용자 추가분 + 기본) — 중복 제거.
      allowedOrigins: Array.from(new Set([...(parsed.allowedOrigins ?? []), ...DEFAULTS.allowedOrigins])),
    };
  } catch {
    // 최초 실행/파손 — 기본값.
  }
  if (!cfg.token) cfg.token = crypto.randomBytes(24).toString("base64url");
  cache = cfg;
  saveConfig(cfg);
  return cfg;
}

export function saveConfig(next: Partial<AppConfig>): AppConfig {
  const merged = { ...(cache ?? DEFAULTS), ...next } as AppConfig;
  cache = merged;
  try {
    fs.writeFileSync(configPath(), JSON.stringify(merged, null, 2), "utf8");
  } catch (e) {
    console.error("[config] save 실패:", e);
  }
  return merged;
}
