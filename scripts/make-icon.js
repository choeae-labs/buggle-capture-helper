// Buggle 로고(SVG)를 래스터화해 build/icon.ico 생성(설치 파일/앱 아이콘용).
// 실행: npm run make-icon  (electron 필요). 외부 변환 도구 없이 Chromium 캔버스로 처리.
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

// 새 브랜드 마크(buggle_capture.svg) — 오렌지 타일 + 화이트 b 벌레 + 네이비 캡처 브래킷
const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000">' +
  '<defs><clipPath id="tile"><rect width="1000" height="1000" rx="200"/></clipPath></defs>' +
  '<g clip-path="url(#tile)">' +
  '<rect width="1000" height="1000" fill="#e96b33"/>' +
  '<path fill="#fdfefd" d="M502.5,445.2c-29,0-56.4,7.1-80.5,19.8v-66.8c0-25.7-20.8-46.5-46.5-46.5c-25.7,0-46.5,20.8-46.5,46.5v220.5c0,4.6,0.2,9.2,0.5,13.7c0.5,6,1.2,11.9,2.3,17.8v0c0,0,0,0,0,0c14.8,80.8,85.6,142,170.6,142c95.8,0,173.5-77.7,173.5-173.5S598.3,445.2,502.5,445.2z M584.2,618.9c0,44.9-36.4,81.6-80.7,81.9c-39.1,0.3-70.1-28-78.6-62.4v0c-1.5-6.2-2.4-12.6-2.3-19.1c0-7.1,0.9-14.1,2.6-20.7c9-35.3,40.3-61.5,78.9-61.4C550.1,537.3,584.9,577.1,584.2,618.9z"/>' +
  '<circle fill="#091e7b" cx="376.1" cy="282.2" r="47.1"/>' +
  '<circle fill="#091e7b" cx="512.8" cy="282.2" r="47.1"/>' +
  '<g fill="none" stroke="#091e7b" stroke-width="52" stroke-linecap="round" stroke-linejoin="round">' +
  '<polyline points="155,258.5 155,151.1 258.8,151.1"/>' +
  '<polyline points="846,258.5 846,151.1 742.2,151.1"/>' +
  '<polyline points="155,741.9 155,849.3 258.8,849.3"/>' +
  '<polyline points="846,741.9 846,849.3 742.2,849.3"/>' +
  '</g></g></svg>';

const SIZES = [16, 24, 32, 48, 64, 128, 256];

/** PNG 버퍼들을 ICO(PNG 임베드) 컨테이너로 패킹. */
function buildIco(pngs) {
  const count = pngs.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type=icon
  header.writeUInt16LE(count, 4);
  const entries = Buffer.alloc(16 * count);
  let offset = 6 + 16 * count;
  const bodies = [];
  pngs.forEach((p, i) => {
    const b = i * 16;
    entries.writeUInt8(p.size >= 256 ? 0 : p.size, b + 0); // width (0=256)
    entries.writeUInt8(p.size >= 256 ? 0 : p.size, b + 1); // height
    entries.writeUInt8(0, b + 2); // color count
    entries.writeUInt8(0, b + 3); // reserved
    entries.writeUInt16LE(1, b + 4); // planes
    entries.writeUInt16LE(32, b + 6); // bit count
    entries.writeUInt32LE(p.buf.length, b + 8);
    entries.writeUInt32LE(offset, b + 12);
    offset += p.buf.length;
    bodies.push(p.buf);
  });
  return Buffer.concat([header, entries, ...bodies]);
}

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 300, height: 300 });
  const dataUri = "data:image/svg+xml;base64," + Buffer.from(SVG).toString("base64");
  const html =
    "<!doctype html><html><body><script>window.__render=(size,uri)=>new Promise((res,rej)=>{" +
    "var img=new Image();img.onload=function(){var c=document.createElement('canvas');c.width=size;c.height=size;" +
    "var x=c.getContext('2d');x.clearRect(0,0,size,size);x.drawImage(img,0,0,size,size);res(c.toDataURL('image/png'));};" +
    "img.onerror=rej;img.src=uri;});</script></body></html>";
  await win.loadURL("data:text/html;base64," + Buffer.from(html).toString("base64"));

  try {
    const pngs = [];
    for (const s of SIZES) {
      const durl = await win.webContents.executeJavaScript(`window.__render(${s}, ${JSON.stringify(dataUri)})`);
      pngs.push({ size: s, buf: Buffer.from(durl.split(",")[1], "base64") });
    }
    const ico = buildIco(pngs);
    fs.mkdirSync(path.join(__dirname, "..", "build"), { recursive: true });
    fs.writeFileSync(path.join(__dirname, "..", "build", "icon.ico"), ico);
    console.log(`build/icon.ico 생성 완료 (${ico.length} bytes, ${SIZES.length} sizes)`);

    // macOS/Linux용 큰 PNG(1024) — electron-builder가 mac 빌드 시 이 png를 icns로 자동 변환한다.
    const bigDurl = await win.webContents.executeJavaScript(
      `window.__render(1024, ${JSON.stringify(dataUri)})`
    );
    const bigBuf = Buffer.from(bigDurl.split(",")[1], "base64");
    fs.writeFileSync(path.join(__dirname, "..", "build", "icon.png"), bigBuf);
    console.log(`build/icon.png 생성 완료 (${bigBuf.length} bytes, 1024)`);
    app.exit(0);
  } catch (e) {
    console.error("icon 생성 실패:", e);
    app.exit(1);
  }
});
