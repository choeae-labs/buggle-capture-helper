# Buggle Capture Helper

Buggle 전용 스크린샷 보조 도구(Windows 트레이 앱). 화면을 빠르게 캡처해 로컬에 보관하고, Buggle 웹앱에 **localhost API**로 제공한다. (Phase 1 MVP)

## 실행 (개발)

```bash
npm install
npm start        # 빌드 후 Electron 실행 (트레이 상주)
```

트레이 아이콘(우클릭 메뉴) 또는 전역 단축키로 캡처. 캡처하면 우하단 플로팅 미리보기에 즉시 표시된다.

## 단축키 (기본, 설정으로 변경 예정)

| 단축키 | 동작 |
|---|---|
| `Ctrl+Shift+1` | 전체 화면 캡처(커서가 있는 모니터) |
| `Ctrl+Shift+2` | 선택 영역 캡처(드래그, `Esc` 취소) |
| `Ctrl+Shift+3` | 고정 영역 캡처(미지정 시 먼저 지정) |
| `Ctrl+Shift+0` | 고정 영역 재지정 |
| `Ctrl+Shift+4` | 화면 녹화 시작/중지(GIF) |

단축키는 미리보기 창의 ⚙ 설정에서 변경할 수 있다.

## 녹화(GIF)

- 전체 화면 녹화: 단축키(`Ctrl+Shift+4`) / 미리보기의 **● 녹화** 버튼 / 트레이 메뉴. 영역 녹화는 트레이 **"영역 녹화"**.
- 녹화 중에는 화면 상단에 **정지 바**가 뜨고(캡처에 안 찍힘), 미리보기 창은 자동으로 숨겨진다. 같은 단축키/정지 버튼으로 중지.
- 저장 형식은 **GIF**. 기본 프리셋(균형): **10fps · 최대 폭 960px · 최대 20초**(초과 시 자동 정지). `config.json`의 `recording`에서 변경 가능.
- **용량 주의:** GIF는 프레임마다 팔레트+무손실이라 영상보다 크다. 해상도 축소·낮은 fps·길이 제한으로 관리하며, 저장 후 알림에 파일 크기를 표시한다.
- ffmpeg 없이 순수 JS 인코더(`gifenc`)로 프레임을 캡처하며 점진 인코딩한다(메모리 절약).

## 저장/정책

- 저장 위치: `%APPDATA%/BuggleCapture/captures` (파일) + `captures.json` (메타)
- 보관: 기본 **7일 / 최대 100개**, 초과분 오래된 것부터 자동 삭제
- 설정: `%APPDATA%/BuggleCapture/config.json` (포트·토큰·단축키·고정영역·origin allowlist)
- **로컬 파일은 사용자가 Buggle에서 명시적으로 첨부하기 전까지 서버로 업로드하지 않는다.**

## 로컬 API (Buggle 웹 연동용)

`http://127.0.0.1:38473` — **127.0.0.1에만 listen**. Buggle origin allowlist + pairing token.

| 메서드/경로 | 인증 | 설명 |
|---|---|---|
| `GET /health` | 공개 | 연결 감지. `{ ok, name, version, needsPairing:false }` |
| `POST /pair` | origin | 토큰 발급(allowlist origin이면 자동). `{ token }` |
| `GET /captures` | 토큰 | 캡처 목록 `{ items: CaptureItem[] }`(newest first) |
| `GET /captures/:id/file` | 토큰 | 원본 파일(stream). `?token=` 쿼리 허용 |
| `GET /captures/:id/thumb` | 토큰 | 썸네일 PNG |
| `POST /captures/:id/mark-used` | 토큰 | Buggle 첨부 완료 표시(`usedAt`) |
| `DELETE /captures/:id` | 토큰 | 캡처 삭제 |
| `WS /events` | 토큰 | 변경 브로드캐스트 `{ type:"change" }` |

인증: `Authorization: Bearer <token>` 또는 `?token=<token>`(이미지 `src`용). CORS는 allowlist origin만 허용.

### CaptureItem

```ts
type CaptureItem = {
  id: string;
  kind: "image" | "gif" | "video";
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  width?: number; height?: number;
  createdAt: string;              // ISO
  source?: { displayId?: string; appName?: string; windowTitle?: string };
  thumbnailUrl: string;          // 상대경로 /captures/:id/thumb
  fileUrl: string;               // 상대경로 /captures/:id/file
  usedAt?: string | null;
};
```

## Buggle 웹 연동(Phase 2, 별도 작업)

qloop 레포에 추가 예정:
- `src/lib/capture/{types,client}.ts` — health/pair/list/file→File/mark-used/WS
- `src/components/capture/CapturePicker.tsx` — 캡처 선택 모달(썸네일 그리드·다중선택·실시간)
- `CreateIssueDialog`·`IssueDetailPanel` 붙여넣기 흐름에 연결(기존 `uploadIssueAttachment` 재사용)
- 헬퍼 꺼져 있으면 조용히 비활성(기존 기능 무영향)

## 패키징(Windows exe)

```bash
npm run dist     # electron-builder — build/icon.ico 넣고 실행 권장
```

## MVP 범위 / 후속

- MVP: 전체/선택/고정 캡처, 트레이, 전역 단축키, 로컬 저장, 플로팅 미리보기, 로컬 API
- 후속: GIF/영상 녹화, 주석 편집, 단축키 설정 UI, 페어링 승인 UX, macOS
