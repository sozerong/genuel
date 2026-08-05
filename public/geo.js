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
export function buildSegments(stops, y, mo, d, h, mi) {
  const segs = []; let t = 0;
  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i], b = stops[i + 1];
    const km = distKm(a, b);
    const dur = km / SPEED * 60 + DWELL;
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
