import { buildSegments, THRESH } from "./geo.js";
import { drawSeat } from "./seatmap.js";

const $ = id => document.getElementById(id);
const pad = n => String(n).padStart(2, "0");
// 승차 시각(H:MI) + 경과분을 순수 산술로 계산한다 — Date 객체의 로컬 타임존에 기대면
// 브라우저가 KST가 아닐 때(혹은 KST일 때도 이 트릭 자체가) 시각이 밀린다.
function fmt(startH, startMI, minOff) {
  const total = ((startH * 60 + startMI + Math.round(minOff)) % 1440 + 1440) % 1440;
  return pad(Math.floor(total / 60)) + ":" + pad(total % 60);
}
const DIRW = ["북", "북동", "동", "남동", "남", "남서", "서", "북서"];
const compass = b => DIRW[Math.round(b / 45) % 8];
const SUN = "#FFB223", HOT = "#EF6C1A";

function nowKST() {
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul", year: "numeric", month: "2-digit",
    day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false
  }).formatToParts(new Date());
  const o = {}; p.forEach(x => o[x.type] = x.value);
  return { y: +o.year, mo: +o.month, d: +o.day, h: +(o.hour === "24" ? 0 : o.hour), mi: +o.minute };
}
// 승차 시각 기본값은 사용자가 직접 손대기 전까지 "지금"을 계속 따라간다.
let followNow = true;
$("date").addEventListener("input", () => followNow = false);
$("time").addEventListener("input", () => followNow = false);

function followClock() {
  const n = nowKST();
  if (followNow) {
    $("date").value = `${n.y}-${pad(n.mo)}-${pad(n.d)}`;
    $("time").value = `${pad(n.h)}:${pad(n.mi)}`;
  }
}
followClock();
setInterval(followClock, 30000);

// 앱인토스 미니앱은 이 프론트를 토스 자체 도메인에서 띄우므로 상대경로 fetch가 안 통한다.
// 백엔드 프록시(Cloudtype 배포)를 절대주소로 호출한다 — CORS는 이미 열려 있다.
const API_BASE = "https://port-0-genuel-msidnon2a00aaf43.sel3.cloudtype.app";

async function api(pathAndQuery) {
  const res = await fetch(API_BASE + pathAndQuery);
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error || `요청 실패 (${res.status})`);
  return data;
}

function setStatus(msg, isError = false) {
  const el = $("status");
  el.textContent = msg || "";
  el.classList.toggle("err", isError);
}

let CITIES = [], ROUTES = [], STOPS = [];

// 마지막으로 조회한 노선을 기억한다 — 미니앱을 껐다 켜도 그대로 이어서 보게 한다.
const SAVE_KEY = "geuneuljari:last";
let RESTORE = null;
try { RESTORE = JSON.parse(localStorage.getItem(SAVE_KEY) || "null"); } catch { RESTORE = null; }

function saveLast() {
  const r = ROUTES[+$("route").value];
  if (!r) return;
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify({
      cityCode: $("city").value, routeNo: $("routeNo").value.trim(),
      routeId: r.routeId, from: +$("from").value, to: +$("to").value
    }));
  } catch { /* 저장 실패는 무시한다 — 추천 기능 자체엔 영향 없다 */ }
}

async function loadCities() {
  setStatus("도시 목록 불러오는 중…");
  try {
    CITIES = await api("/api/cities");
    $("city").innerHTML = "";
    // 전국 노선을 다루므로 특정 도시를 기본값으로 밀어넣지 않는다.
    // 이전에 조회한 도시가 있으면 그것만 복원한다.
    const ph = document.createElement("option");
    ph.value = ""; ph.textContent = "도시를 선택하세요";
    $("city").appendChild(ph);
    CITIES.forEach(c => {
      const o = document.createElement("option");
      o.value = c.code; o.textContent = c.name;
      $("city").appendChild(o);
    });
    const saved = RESTORE && CITIES.some(c => String(c.code) === String(RESTORE.cityCode));
    $("city").value = saved ? RESTORE.cityCode : "";
    setStatus("");
    if (saved && RESTORE.routeNo) {
      $("routeNo").value = RESTORE.routeNo;
      await searchRoutes();
    }
  } catch (e) {
    setStatus(`도시 목록을 불러오지 못했습니다: ${e.message}`, true);
  }
}

async function searchRoutes() {
  const cityCode = $("city").value;
  const routeNo = $("routeNo").value.trim();
  if (!cityCode) { setStatus("도시를 먼저 선택하세요.", true); return; }
  if (!routeNo) { setStatus("노선번호를 입력하세요.", true); return; }
  setStatus("노선 검색 중…");
  $("route").innerHTML = ""; $("from").innerHTML = ""; $("to").innerHTML = "";
  STOPS = []; $("result").classList.add("hidden");
  try {
    ROUTES = await api(`/api/routes?cityCode=${encodeURIComponent(cityCode)}&routeNo=${encodeURIComponent(routeNo)}`);
    if (ROUTES.length === 0) { setStatus("검색 결과가 없습니다.", true); return; }
    ROUTES.forEach((r, i) => {
      const o = document.createElement("option");
      o.value = i; o.textContent = `${r.routeNo}번 · ${r.start} → ${r.end}`;
      $("route").appendChild(o);
    });
    if (RESTORE?.routeId) {
      const i = ROUTES.findIndex(r => r.routeId === RESTORE.routeId);
      if (i >= 0) $("route").value = i;
    }
    setStatus(`${ROUTES.length}개 노선을 찾았습니다.`);
    await loadStops();
  } catch (e) {
    setStatus(`노선 검색 실패: ${e.message}`, true);
  }
}

async function loadStops() {
  const cityCode = $("city").value;
  const r = ROUTES[+$("route").value];
  if (!r) return;
  setStatus("정류소 불러오는 중…");
  $("from").innerHTML = ""; $("to").innerHTML = ""; $("result").classList.add("hidden");
  try {
    STOPS = await api(`/api/stops?cityCode=${encodeURIComponent(cityCode)}&routeId=${encodeURIComponent(r.routeId)}`);
    if (STOPS.length < 2) {
      setStatus("이 노선은 좌표가 있는 정류소가 2개 미만이라 계산할 수 없습니다.", true);
      return;
    }
    STOPS.forEach((s, i) => {
      const a = document.createElement("option"); a.value = i; a.textContent = s.name; $("from").appendChild(a);
    });
    $("from").value = RESTORE && RESTORE.from < STOPS.length ? RESTORE.from : 0;
    updateToOptions();
    if (RESTORE && [...$("to").options].some(o => +o.value === RESTORE.to)) $("to").value = RESTORE.to;
    RESTORE = null;   // 복원은 첫 로드 때 한 번만. 이후 선택은 사용자 것이다.
    setStatus(`정류소 ${STOPS.length}개를 불러왔습니다.`);
    saveLast();
    refreshBuses();
  } catch (e) {
    setStatus(`정류소를 불러오지 못했습니다: ${e.message}`, true);
  }
}

// 내리는 곳은 타는 곳 이후 정류소만 선택 가능하게 한다.
function updateToOptions() {
  const from = +$("from").value;
  $("to").innerHTML = "";
  STOPS.forEach((s, i) => {
    if (i <= from) return;
    const o = document.createElement("option"); o.value = i; o.textContent = s.name; $("to").appendChild(o);
  });
  $("to").value = STOPS.length - 1;
}
$("from").addEventListener("change", updateToOptions);

// 실시간 버스 위치 — 타임라인 가운데 선 위의 점으로 표시한다. 부가 정보라
// 못 가져와도 조용히 안 보일 뿐, 핵심 기능(좌석 추천)엔 관여하지 않는다.
let BUSES = [];
async function refreshBuses() {
  const r = ROUTES[+$("route").value];
  if (!r || $("city").value === "seoul") { BUSES = []; positionBusMarker(); return; }
  try {
    BUSES = await api(`/api/buslocation?cityCode=${encodeURIComponent($("city").value)}&routeId=${encodeURIComponent(r.routeId)}`);
  } catch { BUSES = []; }
  positionBusMarker();
}
setInterval(refreshBuses, 20000);

// 현재 보고 있는 구간(CUR_STOPS)에 가장 가까운 차량 한 대를 골라 타임라인의
// 정류소 점(dot) 위치를 기준으로 세로 좌표를 계산한다. 구간 밖이면 위/아래 끝에 붙인다.
function positionBusMarker() {
  const tl = $("timeline");
  let marker = document.getElementById("busmarker");
  const dots = [...tl.querySelectorAll(".strow .dot")];
  if (!BUSES.length || CUR_STOPS.length < 2 || dots.length !== CUR_STOPS.length || $("result").classList.contains("hidden")) {
    if (marker) marker.remove();
    return;
  }
  const lo = CUR_STOPS[0].ord, hi = CUR_STOPS[CUR_STOPS.length - 1].ord;
  const distTo = b => b.nodeOrd < lo ? lo - b.nodeOrd : b.nodeOrd > hi ? b.nodeOrd - hi : 0;
  const bus = BUSES.reduce((best, b) => !best || distTo(b) < distTo(best) ? b : best, null);
  if (!bus) { if (marker) marker.remove(); return; }

  // 정류소 사이일 땐 두 dot 사이를 순번 비율로 보간한다 — 세그먼트 라벨과 겹칠 수
  // 있지만 그게 실제로 버스가 지나는 중이라는 뜻이라 자연스럽다.
  const ord = Math.max(lo, Math.min(hi, bus.nodeOrd));
  let idx1 = CUR_STOPS.findIndex(s => s.ord >= ord);
  if (idx1 < 0) idx1 = CUR_STOPS.length - 1;
  let idx0 = idx1, frac = 0;
  if (CUR_STOPS[idx1].ord > ord && idx1 > 0) {
    idx0 = idx1 - 1;
    const span = CUR_STOPS[idx1].ord - CUR_STOPS[idx0].ord || 1;
    frac = (ord - CUR_STOPS[idx0].ord) / span;
  }
  const tlRect = tl.getBoundingClientRect();
  const centerOf = d => { const r = d.getBoundingClientRect(); return r.top + r.height / 2 - tlRect.top; };
  const y0 = centerOf(dots[idx0]), y1 = centerOf(dots[idx1]);
  const y = y0 + (y1 - y0) * frac;

  if (!marker) {
    marker = document.createElement("div");
    marker.id = "busmarker"; marker.className = "busmarker";
    tl.appendChild(marker);
  }
  marker.title = bus.vehicleNo ? `버스 위치 · ${bus.vehicleNo}` : "버스 위치";
  marker.style.top = `${y}px`;
}

$("city").addEventListener("change", () => {
  $("route").innerHTML = ""; $("from").innerHTML = ""; $("to").innerHTML = "";
  ROUTES = []; STOPS = []; RESTORE = null; $("result").classList.add("hidden");
  BUSES = []; document.getElementById("busmarker")?.remove();
});
$("btnSearch").addEventListener("click", searchRoutes);
$("route").addEventListener("change", loadStops);

$("btnNow").onclick = () => { const n = nowKST(); $("date").value = `${n.y}-${pad(n.mo)}-${pad(n.d)}`; $("time").value = `${pad(n.h)}:${pad(n.mi)}`; run(); };
$("btn16").onclick = () => { $("time").value = "16:00"; run(); };
$("btn8").onclick = () => { $("time").value = "08:00"; run(); };
$("btnGo").onclick = run;

let SEGS = [], SEL = 0, CUR_STOPS = [];

function run() {
  if (STOPS.length < 2) { setStatus("노선과 정류소를 먼저 선택하세요.", true); return; }
  let i0 = +$("from").value, i1 = +$("to").value;
  if (i1 <= i0) { i1 = STOPS.length - 1; i0 = 0; $("from").value = 0; $("to").value = i1; }
  saveLast();
  const stops = CUR_STOPS = STOPS.slice(i0, i1 + 1);
  const [Y, MO, D] = $("date").value.split("-").map(Number);
  const [H, MI] = $("time").value.split(":").map(Number);

  SEGS = buildSegments(stops, Y, MO, D, H, MI);
  const total = SEGS.reduce((a, s) => a + s.dur, 0);
  const EL = SEGS.reduce((a, s) => a + s.EL, 0), ER = SEGS.reduce((a, s) => a + s.ER, 0);

  /* --- 판정 문구 --- */
  const maxE = Math.max(EL, ER), diff = maxE > 0 ? Math.abs(EL - ER) / maxE : 0;
  const night = SEGS.every(s => s.alt <= 0);
  const bigEl = $("vbig"), smEl = $("vsm");
  if (night) {
    $("vk").textContent = "해 없음";
    bigEl.innerHTML = "아무 데나";
    smEl.textContent = "해가 지평선 아래입니다. 좌석 상관 없습니다.";
  } else if (diff < 0.15) {
    $("vk").textContent = "판정";
    bigEl.innerHTML = "<em class='cool'>차이 없음</em>";
    smEl.innerHTML = `좌우 노출 차이 ${Math.round(diff * 100)}% — 추천할 만큼 다르지 않습니다.`;
  } else {
    const side = EL < ER ? "왼쪽" : "오른쪽";
    $("vk").textContent = "추천 좌석";
    bigEl.innerHTML = `<em class='cool'>${side}</em> 창가`;
    const less = Math.round((1 - Math.min(EL, ER) / maxE) * 100);
    smEl.innerHTML = `반대편보다 햇빛 <b>${less}% 적음</b> · 총 ${Math.round(total)}분`;
  }

  /* --- 타임라인 --- */
  const tl = $("timeline"); tl.innerHTML = "";
  stops.forEach((st, i) => {
    const row = document.createElement("div"); row.className = "strow";
    const tmin = i === 0 ? 0 : SEGS[i - 1].end;
    row.innerHTML = `<span class="l"></span>
      <span class="c"><span class="dot ${(i === 0 || i === stops.length - 1) ? 'term' : ''}"></span><span class="nm">${st.name}</span></span>
      <span class="r">${fmt(H, MI,tmin)}</span>`;
    tl.appendChild(row);
    if (i < SEGS.length) {
      const s = SEGS[i];
      const seg = document.createElement("div"); seg.className = "seg" + (i === SEL ? " on" : "");
      const wl = Math.round(Math.max(0, -s.sinD) * Math.cos(Math.max(0, s.alt) * (Math.PI / 180)) * 100);
      const wr = Math.round(Math.max(0, s.sinD) * Math.cos(Math.max(0, s.alt) * (Math.PI / 180)) * 100);
      const grad = c => `linear-gradient(${c},${SUN},${HOT})`;
      const lowAlt = s.alt > 0 && s.alt < 20 ? `<span class="badge-lowalt">신뢰도 낮음</span>` : "";
      seg.innerHTML = `<span class="bl"><i style="width:${Math.max(2, wl)}%;background:${wl > 8 ? grad("270deg") : "#DDE4EA"}"></i></span>
        <span class="sp"><span>${compass(s.brg)} · ${Math.round(s.dur)}분${lowAlt}</span></span>
        <span class="br"><i style="width:${Math.max(2, wr)}%;background:${wr > 8 ? grad("90deg") : "#DDE4EA"}"></i></span>`;
      seg.onclick = () => { SEL = i; run(); };
      tl.appendChild(seg);
    }
  });

  /* --- 좌석도 --- */
  if (SEL >= SEGS.length) SEL = 0;
  const s = SEGS[SEL];
  drawSeat($("seat"), s);
  $("seatCap").innerHTML = `<b>${s.from} → ${s.to}</b> · 진행 ${Math.round(s.brg)}°(${compass(s.brg)}) · `
    + `태양 방위 ${Math.round(s.az)}° 고도 ${Math.round(s.alt)}° · ${fmt(H, MI,s.start)}~${fmt(H, MI,s.end)}`;

  /* --- 각주 --- */
  const lowAltCount = SEGS.filter(s2 => s2.alt > 0 && s2.alt < 20).length;
  $("foot").innerHTML =
    `계산: 정류장 좌표로 구간 방위각을 구하고, 승차 시각 기준 각 구간 통과 시점의 태양 방위·고도를 천문 계산해 |sinΔ|·cos(고도)로 측면 유입량을 냅니다. 평균 21km/h로 주행 시간을 추정합니다(실측 아님).<br><br>`
    + (lowAltCount ? `<b>주의</b> — 태양 고도 20° 미만 구간이 ${lowAltCount}개 있습니다. 건물 그림자에 가려 실제로는 예측보다 덜 뜨거울 수 있습니다.<br><br>` : "")
    + `구름은 반영하지 않았습니다. 정류소 좌표는 ${$("city").value === "seoul" ? "서울 열린데이터광장" : "TAGO 버스노선정보 API"} 실측값입니다.`;

  $("result").classList.remove("hidden");
  positionBusMarker();
}

loadCities();

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js");
