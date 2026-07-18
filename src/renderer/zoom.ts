// 확대 미리보기 창 렌더러 — main이 보내는 이미지 URL을 그대로 표시. 전역 스크립트.
interface ZoomBridge {
  onImg: (cb: (d: { url: string; isGif: boolean }) => void) => void;
}
declare const zoomBridge: ZoomBridge;

(function () {
  const img = document.getElementById("img") as HTMLImageElement;
  zoomBridge.onImg((d) => {
    img.src = d.url;
  });
})();
