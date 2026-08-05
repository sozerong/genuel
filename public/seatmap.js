// 좌석도 SVG 렌더. prototype.html에서 그대로 이식.
import { D2R } from "./solar.js";
import { THRESH } from "./geo.js";

const NS = "http://www.w3.org/2000/svg";
const mk = (n, a) => { const e = document.createElementNS(NS, n); for (const k in a) e.setAttribute(k, a[k]); return e; };
const hx = h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const mix = (a, b, t) => { const A = hx(a), B = hx(b); return `rgb(${A.map((v, i) => Math.round(v + (B[i] - v) * t)).join(",")})`; };
const SUN = "#FFB223", HOT = "#EF6C1A", SHADE = "#2F6C86";
const ROWS = [-56, -34, -12, 10, 32, 54];
const COLS = [{ x: -34, side: -1, win: 1 }, { x: -16, side: -1, win: 0 }, { x: 16, side: 1, win: 0 }, { x: 34, side: 1, win: 1 }];

function seatE(c, ri, sinD, cosD, alt) {
  if (alt <= 0) return 0;
  const lat = Math.abs(sinD) * Math.cos(alt * D2R);
  const lit = Math.sign(sinD) === c.side;
  let e = lit ? (c.win ? lat : lat * 0.5) : (c.win ? lat * 0.05 : lat * 0.14);
  if (cosD > 0.6 && ri < 2) e = Math.max(e, cosD * Math.cos(alt * D2R) * (ri === 0 ? 0.85 : 0.55));
  return Math.min(1, e);
}

export function drawSeat(svg, s) {
  while (svg.firstChild) svg.removeChild(svg.firstChild);
  const g = mk("g", { transform: "translate(200,196) scale(0.92)" });
  const { sinD = 0, cosD = 0, alt = 0, az = null, brg = 0 } = s || {};
  const body = "#FFFFFF", stroke = "#C9D3DB", seatBase = "#DFE6EC", glass = "#EDF1F4";

  if (alt > 0 && az !== null) {
    const defs = mk("defs");
    const rg = mk("radialGradient", { id: "gl", cx: "50%", cy: "50%", r: "50%" });
    rg.appendChild(mk("stop", { offset: "0%", "stop-color": SUN, "stop-opacity": ".5" }));
    rg.appendChild(mk("stop", { offset: "100%", "stop-color": SUN, "stop-opacity": "0" }));
    defs.appendChild(rg); g.appendChild(defs);
    const R = 150, d = (az - brg) * D2R;
    const sx = Math.sin(d) * R, sy = -Math.cos(d) * R;
    const pp = [Math.cos(d), Math.sin(d)];
    for (let k = -3; k <= 3; k++) {
      const o = k * 22;
      g.appendChild(mk("line", {
        x1: sx + pp[0] * o, y1: sy + pp[1] * o, x2: sx * .13 + pp[0] * o, y2: sy * .13 + pp[1] * o,
        stroke: SUN, "stroke-width": 1.4, "stroke-opacity": .28, "stroke-linecap": "round"
      }));
    }
    g.appendChild(mk("circle", { cx: 0, cy: 0, r: R, fill: "none", stroke: "#D6DEE5", "stroke-width": 1, "stroke-dasharray": "2 6" }));
    g.appendChild(mk("circle", { cx: sx, cy: sy, r: 44, fill: "url(#gl)" }));
    g.appendChild(mk("circle", { cx: sx, cy: sy, r: 12, fill: SUN }));
    g.appendChild(mk("text", {
      x: sx, y: sy + 30, "text-anchor": "middle", fill: "#8A6410",
      "font-family": "IBM Plex Mono, monospace", "font-size": "10"
    })).textContent = `고도 ${Math.round(alt)}°`;
  }

  g.appendChild(mk("rect", { x: -45, y: -98, width: 90, height: 196, rx: 15, fill: body, stroke: stroke, "stroke-width": 1.5 }));
  [[-48.5, -1], [43.5, 1]].forEach(([x, side]) => {
    const lit = Math.sign(sinD) === side && alt > 0;
    g.appendChild(mk("rect", {
      x, y: -64, width: 5, height: 148, rx: 2.5,
      fill: lit ? mix(glass, SUN, Math.min(.9, Math.abs(sinD) * Math.cos(alt * D2R) + .25)) : glass
    }));
  });
  g.appendChild(mk("rect", {
    x: -36, y: -95, width: 72, height: 8, rx: 4,
    fill: (cosD > 0.6 && alt > 0) ? mix(glass, SUN, .75) : glass
  }));
  g.appendChild(mk("path", { d: "M0,-120 L7,-107 L0,-111 L-7,-107 Z", fill: "#8494A2" }));
  g.appendChild(mk("text", {
    x: 0, y: -128, "text-anchor": "middle", fill: "#8494A2",
    "font-family": "IBM Plex Mono, monospace", "font-size": "9.5", "letter-spacing": "1.4"
  })).textContent = "진행";
  g.appendChild(mk("rect", { x: -40, y: -82, width: 16, height: 15, rx: 4, fill: seatBase, opacity: .55 }));
  g.appendChild(mk("rect", { x: 43, y: -80, width: 3, height: 12, rx: 1.5, fill: "#A8B6C2" }));
  g.appendChild(mk("rect", { x: 43, y: 18, width: 3, height: 14, rx: 1.5, fill: "#A8B6C2" }));

  let best = null; const cells = [];
  ROWS.forEach((y, ri) => COLS.forEach(c => {
    const e = seatE(c, ri, sinD, cosD, alt);
    cells.push({ x: c.x, y, e });
    if (c.win && (!best || e < best.e)) best = { x: c.x, y, e, side: c.side };
  }));
  [-34, -17, 0, 17, 34].forEach(x => {
    const c = { x, side: x < 0 ? -1 : (x > 0 ? 1 : 0), win: Math.abs(x) > 30 };
    cells.push({ x, y: 78, e: seatE(c, 5, sinD, cosD, alt) });
  });
  cells.forEach(s2 => {
    const f = s2.e < 0.03 ? seatBase : (s2.e < 0.5 ? mix(seatBase, SUN, s2.e * 2) : mix(SUN, HOT, (s2.e - .5) * 2));
    g.appendChild(mk("rect", { x: s2.x - 8, y: s2.y - 8, width: 16, height: 16, rx: 4.5, fill: f, stroke: "#F4F7F9", "stroke-width": 1 }));
  });
  if (best && alt > 0 && Math.abs(sinD) * Math.cos(alt * D2R) >= THRESH) {
    ROWS.slice(1, 4).forEach(y => g.appendChild(mk("rect", {
      x: best.x - 11, y: y - 11, width: 22, height: 22, rx: 7,
      fill: "none", stroke: SHADE, "stroke-width": 2
    })));
    g.appendChild(mk("text", {
      x: best.side < 0 ? -72 : 72, y: -4, "text-anchor": "middle", fill: SHADE,
      "font-family": "IBM Plex Sans KR, sans-serif", "font-size": "12", "font-weight": "700"
    })).textContent = "여기";
  }
  svg.appendChild(g);
}
