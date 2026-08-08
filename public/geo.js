// 구간 방위각 · 거리 · 소요시간 · 좌우 판정. prototype.html에서 수치적으로 동일하게 이식.
import { sunPos, kstToUtc, D2R, R2D } from "./solar.js";

export function bearing(a, b) {
  const φ1 = a.lat * D2R, φ2 = b.lat * D2R, Δλ = (b.lon - a.lon) * D2R;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (Math.atan2(y, x) * R2D + 360) % 360;
}

export function distKm(a, b) {
  const R = 6371, dφ = (b.lat - a.lat) * D2R, dλ = (b.lon - a.lon) * D2R;
  const h = Math.sin(dφ / 2) ** 2 + Math.cos(a.lat * D2R) * Math.cos(b.lat * D2R) * Math.sin(dλ / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

const SPEED = 21, DWELL = 0.5; // km/h, 정차 분

// stops: [{ name, lat, lon }, ...] — TAGO 정류소 좌표를 ord 순으로 넘긴다.
// stops에 elapsedMin(출발 기준 경과분)이 있으면 그걸로 구간 소요시간을 낸다 — 고속버스처럼
// 정류소 사이 실제 이동시간을 이미 아는 경우다. 없으면(시내버스) 기존처럼 21km/h로 추정한다.
// 고속도로는 21km/h 가정이 전혀 안 맞아서, elapsedMin이 있는데도 무시하면 태양 위치 계산에
// 쓰는 경과시간이 실제와 몇 배씩 벌어진다.
export function buildSegments(stops, y, mo, d, h, mi) {
  const segs = []; let t = 0;
  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i], b = stops[i + 1];
    const km = distKm(a, b);
    const dur = (Number.isFinite(a.elapsedMin) && Number.isFinite(b.elapsedMin))
      ? b.elapsedMin - a.elapsedMin
      : km / SPEED * 60 + DWELL;
    const brg = bearing(a, b);
    const mid = { lat: (a.lat + b.lat) / 2, lon: (a.lon + b.lon) / 2 };
    const { alt, az } = sunPos(kstToUtc(y, mo, d, h, mi) + (t + dur / 2) * 60000, mid.lat, mid.lon);
    const dl = (az - brg) * D2R;
    const sinD = Math.sin(dl), cosD = Math.cos(dl);
    const lat = alt > 0 ? Math.abs(sinD) * Math.cos(alt * D2R) : 0; // 측면 유입 강도
    segs.push({
      from: a.name, to: b.name, brg, km, dur,
      start: t, end: t + dur, alt, az, sinD, cosD,
      inten: lat,
      EL: alt > 0 ? dur * Math.max(0, -sinD) * Math.cos(alt * D2R) : 0,
      ER: alt > 0 ? dur * Math.max(0, sinD) * Math.cos(alt * D2R) : 0
    });
    t += dur;
  }
  return segs;
}

// 버스 GPS를 정류소 경로에 투영해 "몇 번째 정류소에서 다음 정류소로 몇 %" 지점인지 낸다.
// TAGO의 nodeord는 정수라 그것만 쓰면 버스가 정류소에 딱 붙어 한 칸씩 튄다 —
// 정류소 사이의 실제 위치는 좌표로만 알 수 있다.
// 반환: 소수 인덱스(3.4 = stops[3]에서 stops[4]로 40% 지점). 정류소를 못 찾으면 null.
export function projectOntoStops(bus, stops) {
  const at = stops.findIndex(s => s.ord === bus.nodeOrd);
  if (at < 0) return null;
  if (!Number.isFinite(bus.lat) || !Number.isFinite(bus.lon)) return at; // 좌표가 없으면 정류소에 스냅
  // 순환 노선에서 엉뚱한 구간에 붙는 걸 막으려고 보고된 정류소 앞뒤 한 구간만 후보로 둔다.
  const kx = Math.cos(stops[at].lat * D2R); // 위도에 따른 경도 축소 — 이걸 빼면 투영이 동서로 늘어난다
  let best = null;
  for (let i = Math.max(0, at - 1); i <= Math.min(stops.length - 2, at); i++) {
    const a = stops[i], b = stops[i + 1];
    const vx = (b.lon - a.lon) * kx, vy = b.lat - a.lat;
    const px = (bus.lon - a.lon) * kx, py = bus.lat - a.lat;
    const len2 = vx * vx + vy * vy;
    const t = len2 ? Math.max(0, Math.min(1, (px * vx + py * vy) / len2)) : 0;
    const dx = px - vx * t, dy = py - vy * t;
    const d2 = dx * dx + dy * dy;
    if (!best || d2 < best.d2) best = { d2, idx: i + t };
  }
  return best ? best.idx : at;
}

export const THRESH = 0.13; // 이보다 약하면 "차이 없음"

export function label(s) {
  if (s.alt <= 0) return "none";
  if (s.inten < THRESH) return "none";
  return s.sinD > 0 ? "left" : "right"; // 빛이 드는 반대쪽에 앉기
}

export function groupBlocks(segs) {
  const out = [];
  segs.forEach(s => {
    const lb = label(s);
    const last = out[out.length - 1];
    if (last && last.lb === lb) last.segs.push(s);
    else out.push({ lb, segs: [s] });
  });
  return out;
}
