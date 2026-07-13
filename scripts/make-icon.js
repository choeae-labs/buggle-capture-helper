// Buggle 로고(SVG)를 래스터화해 build/icon.ico 생성(설치 파일/앱 아이콘용).
// 실행: npm run make-icon  (electron 필요). 외부 변환 도구 없이 Chromium 캔버스로 처리.
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240" viewBox="0 0 240 240" fill="none">' +
  '<rect width="240" height="240" rx="48" fill="#FFFFFF"/>' +
  '<path d="M98 52 L112 86" stroke="#10376A" stroke-width="11" stroke-linecap="round"/>' +
  '<path d="M142 52 L128 86" stroke="#10376A" stroke-width="11" stroke-linecap="round"/>' +
  '<ellipse cx="120" cy="150" rx="86" ry="78" fill="#FF8500"/>' +
  '<circle cx="120" cy="86" r="28" fill="#10376A"/>' +
  '<path d="M120 86 V226" stroke="#10376A" stroke-width="10" stroke-linecap="round"/>' +
  '<circle cx="80" cy="138" r="14" fill="#10376A"/><circle cx="160" cy="138" r="14" fill="#10376A"/>' +
  '<circle cx="90" cy="186" r="12" fill="#10376A"/><circle cx="150" cy="186" r="12" fill="#10376A"/></svg>';

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
