// Every phone composition goes through this wrapper: hardware is part of the story.
// Proportions follow a 6.3" Pro iPhone (402 × 874 pt screen, ~55 pt corners, 126 × 37 pt island).
export const deviceCss = `
.phone{--w:390px;position:relative;width:var(--w);padding:calc(var(--w)*.03);border-radius:calc(var(--w)*.159);background:#060607;box-shadow:inset 0 0 0 calc(var(--w)*.004) #2c2c2e,0 0 0 calc(var(--w)*.006) #3a3a3c,0 0 0 calc(var(--w)*.0105) #b9b7b1,0 0 0 calc(var(--w)*.0125) #6e6d69,0 calc(var(--w)*.07) calc(var(--w)*.13) calc(var(--w)*-.03) #0008,0 calc(var(--w)*.02) calc(var(--w)*.04) #0003;isolation:isolate}
.phone .key{position:absolute;width:calc(var(--w)*.012);background:linear-gradient(90deg,#8d8c88,#d8d6d0 55%,#7b7a76);border-radius:calc(var(--w)*.006)}
.phone .key.l{left:calc(var(--w)*-.021)}.phone .key.r{right:calc(var(--w)*-.021)}
.phone .glass{position:relative;overflow:hidden;border-radius:calc(var(--w)*.129);background:#050505;aspect-ratio:1206/2622}.phone .glass>img{display:block;width:100%;height:100%;object-fit:cover}
.phone .island{position:absolute;z-index:2;top:1.27%;left:50%;transform:translateX(-50%);width:31.3%;height:4.23%;border-radius:999px;background:#000}.phone .island:after{content:"";position:absolute;width:8.6%;aspect-ratio:1;background:radial-gradient(circle at 38% 38%,#24304a,#0a0d14 70%);border-radius:50%;right:10%;top:50%;transform:translateY(-50%)}
.monitor{position:relative}.monitor .panel{padding:2.3%;background:#0c0c0d;border-radius:calc(var(--mw,600px)*.022);box-shadow:0 0 0 2px #bdbcb7,0 0 0 3px #8a8985,0 30px 50px -18px #0007}.monitor .panel img{display:block;width:100%;border-radius:2px}
.monitor .neck{width:18%;height:calc(var(--mw,600px)*.13);margin:0 auto;background:linear-gradient(90deg,#9a9995,#e4e3df 45%,#b4b3ae 70%,#8f8e8a);clip-path:polygon(8% 0,92% 0,100% 100%,0 100%)}.monitor .foot{width:34%;height:calc(var(--mw,600px)*.014);margin:0 auto;background:linear-gradient(#e2e1dc,#a3a29d);border-radius:2px 2px 6px 6px;box-shadow:0 10px 18px -6px #0005}
.laptop{position:relative}.laptop .lid{padding:2.4% 2.4% 3.2%;background:#0c0c0d;border-radius:calc(var(--lw,400px)*.04) calc(var(--lw,400px)*.04) 0 0;box-shadow:0 0 0 2px #bdbcb7,0 0 0 3px #8a8985}.laptop .lid img{display:block;width:100%}
.laptop .base{position:relative;left:-7%;width:114%;height:calc(var(--lw,400px)*.034);background:linear-gradient(#ecebe7,#c9c8c3 45%,#8e8d89);border-radius:2px 2px calc(var(--lw,400px)*.05) calc(var(--lw,400px)*.05)/2px 2px calc(var(--lw,400px)*.03) calc(var(--lw,400px)*.03);box-shadow:0 14px 22px -8px #0006}.laptop .base:before{content:"";position:absolute;left:42%;width:16%;top:0;height:42%;background:#a9a8a3;border-radius:0 0 6px 6px}
.browser{overflow:hidden;border-radius:12px;background:#e8e7e3;box-shadow:0 0 0 1px #0000001f,0 30px 50px -16px #0006}.browser .toolbar{height:38px;display:flex;align-items:center;gap:7px;padding:0 14px;border-bottom:1px solid #d3d2cd}.browser .dot{width:11px;height:11px;border-radius:100%}.browser .address{display:flex;align-items:center;justify-content:center;gap:5px;font:500 12.5px system-ui;color:#3d3d3a;margin:0 auto;background:#f6f5f1;border-radius:7px;width:58%;padding:5px 0}.browser .address svg{width:10px;height:10px}.browser .shot{display:block;width:100%;background-repeat:no-repeat}
.loupe{position:absolute;overflow:hidden;background-repeat:no-repeat;box-shadow:0 0 0 1.5px #ffffff2e,0 26px 44px -12px #000a,0 6px 14px #0003}
`;

const frameSize = { width: 1206, height: 2622 };

export const phone = (src, { width = 390, islandInCapture = false } = {}) =>
  `<div class="phone" style="--w:${width}px"><i class="key l" style="top:17.6%;height:3.6%"></i><i class="key l" style="top:23.6%;height:6.6%"></i><i class="key l" style="top:31.4%;height:6.6%"></i><i class="key r" style="top:25.4%;height:10.2%"></i><i class="key r" style="top:52%;height:5.4%;opacity:.7"></i><div class="glass"><img src="${src}" alt="Shouldertap on iPhone">${islandInCapture ? "" : '<div class="island"></div>'}</div></div>`;

// A real region of a capture, enlarged in place. `box` is in capture pixels.
export const loupe = (
  src,
  { box: [x, y, w, h], width, radius, left, top, z = 5, source = frameSize }
) => {
  const scale = width / w;
  return `<div class="loupe" style="z-index:${z};left:${left}px;top:${top}px;width:${width}px;height:${Math.round(h * scale)}px;border-radius:${radius}px;background-image:url(${src});background-size:${source.width * scale}px ${source.height * scale}px;background-position:${-x * scale}px ${-y * scale}px"></div>`;
};

export const monitor = (src, width = 600) =>
  `<div class="monitor" style="--mw:${width}px;width:${width}px"><div class="panel"><img src="${src}" alt="Shouldertap covers the Mac display"></div><div class="neck"></div><div class="foot"></div></div>`;

export const laptop = (src, width = 400) =>
  `<div class="laptop" style="--lw:${width}px;width:${width}px"><div class="lid"><img src="${src}" alt="The same tap on the Mac's built-in display"></div><div class="base"></div></div>`;

// `crop` narrows the captured viewport to a smaller window around the centered page.
export const browserFrame = (
  src,
  { width, crop: [x, y, w, h], source, url = "shouldertap.app/tap" }
) => {
  const scale = width / w;
  return `<div class="browser" style="width:${width}px"><div class="toolbar"><i class="dot" style="background:#ff5f57"></i><i class="dot" style="background:#febc2e"></i><i class="dot" style="background:#28c840"></i><span class="address"><svg viewBox="0 0 10 12" fill="#6f6e69"><path d="M2 5V3.5a3 3 0 0 1 6 0V5h.5A1.5 1.5 0 0 1 10 6.5v4A1.5 1.5 0 0 1 8.5 12h-7A1.5 1.5 0 0 1 0 10.5v-4A1.5 1.5 0 0 1 1.5 5zm1.5 0h3V3.5a1.5 1.5 0 0 0-3 0z"/></svg>${url}</span><i style="width:43px"></i></div><div class="shot" role="img" aria-label="Shouldertap browser sender" style="height:${Math.round(h * scale)}px;background-image:url(${src});background-size:${source.width * scale}px ${source.height * scale}px;background-position:${-x * scale}px ${-y * scale}px"></div></div>`;
};
