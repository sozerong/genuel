import { buildSegments, projectOntoStops, THRESH } from "./geo.js";
import { drawSeat } from "./seatmap.js";

const $ = id => document.getElementById(id);

const NOTICE_KEY = "noticeSeen_v1";
if (!localStorage.getItem(NOTICE_KEY)) $("noticeModal").classList.remove("hidden");
$("noticeOk").addEventListener("click", () => {
  localStorage.setItem(NOTICE_KEY, "1");
  $("noticeModal").classList.add("hidden");
});

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
{ const n = nowKST(); $("expDate").value = `${n.y}-${pad(n.mo)}-${pad(n.d)}`; } // 고속·시외버스 배차조회 날짜 기본값. 계속 따라가지 않는다 — 조회는 한 번 하고 마는 동작이라서.

// 로컬에서 server/proxy.mjs를 직접 띄우면 그 프록시가 이 정적 파일도 같이 서빙하므로,
// 상대경로로 자기 자신을 부르면 된다 — 프록시 코드를 고칠 때마다 cloudtype에 올릴 필요가 없다.
// 앱인토스 미니앱은 이 프론트를 토스 자체 도메인에서 띄우므로 상대경로 fetch가 안 통해서,
// (그리고 cloudtype 배포본도 마찬가지로) 절대주소를 쓴다 — CORS는 이미 열려 있다.
const isLocalDev = location.hostname === "localhost" || location.hostname === "127.0.0.1";
const API_BASE = isLocalDev ? "" : "https://port-0-genuel-msidnon2a00aaf43.sel3.cloudtype.app";

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

// 시내·광역버스는 정류소 목록으로, 고속·시외버스는 터미널+배차시간표로 계산한다 —
// 계산·렌더 코드(renderResult)는 공유하고 "정류소를 어떻게 구하는지"만 다르다.
// MODE 값이 그대로 /api/express* 의 type 파라미터(exp|suburbs)라 city만 예외로 취급한다.
const MODE_TABS = { city: "modeCity", exp: "modeExp", suburbs: "modeSuburbs" };
let MODE = "city";
function setMode(mode) {
  MODE = mode;
  for (const [m, id] of Object.entries(MODE_TABS)) {
    $(id).classList.toggle("on", mode === m);
    $(id).setAttribute("aria-selected", mode === m);
  }
  $("cityFields").classList.toggle("hidden", mode !== "city");
  $("expressFields").classList.toggle("hidden", mode === "city");
  $("result").classList.add("hidden");
  setStatus("");
  document.querySelectorAll(".busmarker").forEach(el => el.remove()); // 실시간 위치는 시내버스 전용
  // 고속<->시외 전환 시 이전 탭에서 검색한 터미널이 남아있으면 안 된다 —
  // ID 체계가 서로 다를 수 있어서, 화면엔 안 지워지고 값만 남으면 엉뚱한 노선으로 계산된다.
  EXP_DEP = []; EXP_ARR = []; EXP_SCHEDULE = [];
  $("expDepTerminal").innerHTML = ""; $("expArrTerminal").innerHTML = ""; $("expSchedule").innerHTML = "";
}
for (const [m, id] of Object.entries(MODE_TABS)) $(id).onclick = () => setMode(m);

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
  if (MODE !== "city") return;   // 고속·시외버스는 TAGO에 실시간 위치 API가 없다
  const r = ROUTES[+$("route").value];
  if (document.hidden) return;   // 백그라운드에서까지 일일 호출 한도를 태우지 않는다
  if (!r || $("city").value === "seoul") { BUSES = []; positionBusMarker(); return; }
  try {
    BUSES = await api(`/api/buslocation?cityCode=${encodeURIComponent($("city").value)}&routeId=${encodeURIComponent(r.routeId)}`);
  } catch { BUSES = []; }
  positionBusMarker();
}
setInterval(refreshBuses, 20000);
// 앱을 다시 열었을 때 최대 20초간 옛 위치가 남아있지 않도록 즉시 한 번 당겨온다.
document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshBuses(); });

const BUS_ICON_SVG = '<svg viewBox="0 0 24 24"><path d="M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v9a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6Z"/><circle cx="8" cy="17.3" r="1.6"/><circle cx="16" cy="17.3" r="1.6"/></svg>';

// 현재 이 노선에서 운행 중인 차량 전부를 타임라인 가운데 선 위에 표시한다.
// 차량번호로 마커를 재사용해서, 폴링마다 새로 안 만들고 다음 위치로 미끄러지게 한다.
function positionBusMarker() {
  const tl = $("timeline");
  const dots = [...tl.querySelectorAll(".strow .dot")];
  const existing = new Map([...tl.querySelectorAll(".busmarker")].map(el => [el.dataset.vehicle, el]));

  if (!BUSES.length || CUR_STOPS.length < 2 || dots.length !== CUR_STOPS.length || $("result").classList.contains("hidden")) {
    existing.forEach(el => el.remove());
    return;
  }

  const lo = CUR_STOPS[0].ord, hi = CUR_STOPS[CUR_STOPS.length - 1].ord;
  const tlRect = tl.getBoundingClientRect();
  // 마커는 타임라인 콘텐츠 기준으로 절대 배치되는데 getBoundingClientRect는 화면 기준이다.
  // 타임라인이 내부 스크롤되므로 scrollTop을 더해 콘텐츠 좌표로 되돌린다.
  const centerOf = d => { const r = d.getBoundingClientRect(); return r.top + r.height / 2 - tlRect.top + tl.scrollTop; };

  const seen = new Set();
  BUSES.forEach((bus, i) => {
    // 표시 중인 구간 밖의 버스는 그리지 않는다. 끝에 붙여두면 "정류장에 서 있다"는
    // 거짓 정보가 된다 — 안 보이는 편이 정직하다.
    if (bus.nodeOrd < lo || bus.nodeOrd > hi) return;
    const fidx = projectOntoStops(bus, CUR_STOPS);
    if (fidx === null) return;

    const key = bus.vehicleNo || `#${i}`;
    seen.add(key);

    // 소수 인덱스를 두 정류소 dot 사이의 화면 좌표로 옮긴다.
    const i0 = Math.max(0, Math.min(dots.length - 1, Math.floor(fidx)));
    const i1 = Math.min(dots.length - 1, i0 + 1);
    const y = centerOf(dots[i0]) + (centerOf(dots[i1]) - centerOf(dots[i0])) * (fidx - i0);

    let marker = existing.get(key);
    if (!marker) {
      marker = document.createElement("div");
      marker.className = "busmarker"; marker.dataset.vehicle = key;
      marker.innerHTML = BUS_ICON_SVG;
      tl.appendChild(marker);
    }
    marker.title = bus.vehicleNo ? `버스 위치 · ${bus.vehicleNo}` : "버스 위치";
    marker.style.top = `${y}px`;
  });

  existing.forEach((el, key) => { if (!seen.has(key)) el.remove(); });
}

$("city").addEventListener("change", () => {
  $("route").innerHTML = ""; $("from").innerHTML = ""; $("to").innerHTML = "";
  ROUTES = []; STOPS = []; RESTORE = null; $("result").classList.add("hidden");
  BUSES = []; document.querySelectorAll(".busmarker").forEach(el => el.remove());
});
$("btnSearch").addEventListener("click", searchRoutes);
$("route").addEventListener("change", loadStops);

$("btnNow").onclick = () => { const n = nowKST(); $("date").value = `${n.y}-${pad(n.mo)}-${pad(n.d)}`; $("time").value = `${pad(n.h)}:${pad(n.mi)}`; run(); };
$("btn16").onclick = () => { $("time").value = "16:00"; run(); };
$("btn8").onclick = () => { $("time").value = "08:00"; run(); };
$("btnGo").onclick = () => { if (MODE !== "city") runExpress(); else run(); };

let SEGS = [], SEL = 0, CUR_STOPS = [];

function run() {
  if (STOPS.length < 2) { setStatus("노선과 정류소를 먼저 선택하세요.", true); return; }
  let i0 = +$("from").value, i1 = +$("to").value;
  if (i1 <= i0) { i1 = STOPS.length - 1; i0 = 0; $("from").value = 0; $("to").value = i1; }
  saveLast();
  const stops = CUR_STOPS = STOPS.slice(i0, i1 + 1);
  const [Y, MO, D] = $("date").value.split("-").map(Number);
  const [H, MI] = $("time").value.split(":").map(Number);
  renderResult(stops, Y, MO, D, H, MI);
  positionBusMarker(); // 실시간 위치는 시내버스 전용
}

// --- 고속·시외버스: 정류소 대신 터미널 검색 + 배차시간표. 계산·렌더는 renderResult()를 그대로 쓴다 ---
let EXP_DEP = [], EXP_ARR = [], EXP_SCHEDULE = [];

async function searchExpTerminal(kind) {
  const kwEl = $(kind === "dep" ? "expDepKeyword" : "expArrKeyword");
  const kw = kwEl.value.trim();
  if (!kw) { setStatus("터미널 이름을 입력하세요.", true); return; }
  setStatus("터미널 검색 중…");
  try {
    const list = await api(`/api/expressTerminals?type=${MODE}&keyword=${encodeURIComponent(kw)}`);
    if (list.length === 0) { setStatus("검색 결과가 없습니다.", true); return; }
    if (kind === "dep") EXP_DEP = list; else EXP_ARR = list;
    const sel = $(kind === "dep" ? "expDepTerminal" : "expArrTerminal");
    sel.innerHTML = "";
    // 같은 이름(운수회사별로 ID만 다른 것)은 서버가 이미 하나로 묶어서 준다 — 이름 하나에
    // ID 여러 개가 딸려있고, 배차조회 땐 그 ID 전부를 물어본다.
    list.forEach((t, i) => {
      const o = document.createElement("option"); o.value = i; o.textContent = t.name; sel.appendChild(o);
    });
    setStatus(`터미널 ${list.length}개를 찾았습니다.`);
  } catch (e) {
    setStatus(`터미널 검색 실패: ${e.message}`, true);
  }
}
$("btnExpDepSearch").addEventListener("click", () => searchExpTerminal("dep"));
$("btnExpArrSearch").addEventListener("click", () => searchExpTerminal("arr"));

async function searchExpSchedule() {
  const date = $("expDate").value.replaceAll("-", "");
  // 검색된 후보 이름이 여러 개일 수 있다(예: "전주" -> 전주시외터미널/대한리무진(전주)/전주대) —
  // 실제 등록된 노선이 그중 어느 이름 밑에 잡혀있는지 사용자가 알 방법이 없으므로,
  // select에서 고른 하나가 아니라 검색된 전체 후보의 ID를 다 합쳐서 조회한다.
  if (!EXP_DEP.length || !EXP_ARR.length) { setStatus("출발·도착 터미널을 먼저 검색하세요.", true); return; }
  if (!date) { setStatus("날짜를 선택하세요.", true); return; }
  setStatus("배차 조회 중…");
  $("expSchedule").innerHTML = ""; $("result").classList.add("hidden");
  try {
    const depIds = EXP_DEP.flatMap(t => t.ids), arrIds = EXP_ARR.flatMap(t => t.ids);
    EXP_SCHEDULE = await api(`/api/expressSchedule?type=${MODE}&depTerminalId=${encodeURIComponent(depIds.join(","))}&arrTerminalId=${encodeURIComponent(arrIds.join(","))}&date=${date}`);
    if (EXP_SCHEDULE.length === 0) { setStatus("이 조합으로 예정된 배차가 없습니다.", true); return; }
    EXP_SCHEDULE.forEach((s, i) => {
      const o = document.createElement("option");
      o.value = i; o.textContent = `${s.depTime.slice(11, 16)} · ${s.grade} · ${s.depPlace}→${s.arrPlace}`;
      $("expSchedule").appendChild(o);
    });
    setStatus(`배차 ${EXP_SCHEDULE.length}개를 찾았습니다.`);
  } catch (e) {
    setStatus(`배차 조회 실패: ${e.message}`, true);
  }
}
$("btnExpSchedule").addEventListener("click", searchExpSchedule);

async function runExpress() {
  const sched = EXP_SCHEDULE[+$("expSchedule").value];
  if (!sched) { setStatus("배차를 먼저 조회하고 선택하세요.", true); return; }

  // 검색 키워드가 아니라 이 배차가 실제로 등록된 출발지/도착지명(depPlace/arrPlace)으로
  // 지오코딩한다 — 검색 후보가 여러 이름일 수 있어 사용자가 고른 이름이 이 배차의 실제
  // 터미널과 다를 수 있다.
  setStatus("터미널 위치 확인 중…");
  let origin, destination;
  try {
    [origin, destination] = await Promise.all([
      api(`/api/geocode?name=${encodeURIComponent(sched.depPlace)}`),
      api(`/api/geocode?name=${encodeURIComponent(sched.arrPlace)}`)
    ]);
  } catch (e) {
    setStatus(`터미널 위치를 찾지 못했습니다: ${e.message}`, true);
    return;
  }

  setStatus("경로 계산 중…");
  let stops;
  try {
    stops = await api(`/api/expressRoute?originLat=${origin.lat}&originLon=${origin.lon}&destLat=${destination.lat}&destLon=${destination.lon}`);
  } catch (e) {
    setStatus(`경로를 가져오지 못했습니다: ${e.message}`, true);
    return;
  }
  if (!stops || stops.length < 2) { setStatus("이 구간은 경로를 계산할 수 없습니다.", true); return; }

  const [Y, MO, D] = sched.depTime.slice(0, 10).split("-").map(Number);
  const [H, MI] = sched.depTime.slice(11, 16).split(":").map(Number);
  renderResult(stops, Y, MO, D, H, MI);
  setStatus(`${sched.depPlace} → ${sched.arrPlace} · ${sched.grade} ${pad(H)}:${pad(MI)} 출발`);
}

// 시내버스(run)와 고속·시외버스(runExpress)가 정류소를 구하는 방법만 다르고, 이후 계산·렌더는 공유한다.
function renderResult(stops, Y, MO, D, H, MI) {
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
      seg.innerHTML = `<span class="bl"><i style="width:${Math.max(2, wl)}%;background:${wl > 8 ? grad("270deg") : "#DDE4EA"}"></i></span>
        <span class="sp"><span>${compass(s.brg)} · ${Math.round(s.dur)}분</span></span>
        <span class="br"><i style="width:${Math.max(2, wr)}%;background:${wr > 8 ? grad("90deg") : "#DDE4EA"}"></i></span>`;
      seg.onclick = () => { SEL = i; renderResult(stops, Y, MO, D, H, MI); };
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
  $("foot").innerHTML = MODE !== "city"
    ? `계산: 카카오 길찾기로 받은 실제 도로 경로를 15분 간격으로 표본화해, 각 지점 통과 시점의 태양 방위·고도를 천문 계산해 |sinΔ|·cos(고도)로 측면 유입량을 냅니다. 구간 소요시간은 배차시간표 기준 실제 총 소요시간을 나눈 값입니다(21km/h 추정 아님).<br><br>`
      + `구름은 반영하지 않았습니다. 경로는 카카오 길찾기 기준이며 실제 운행 경로와 다를 수 있습니다.`
    : `계산: 정류장 좌표로 구간 방위각을 구하고, 승차 시각 기준 각 구간 통과 시점의 태양 방위·고도를 천문 계산해 |sinΔ|·cos(고도)로 측면 유입량을 냅니다. 평균 21km/h로 주행 시간을 추정합니다(실측 아님).<br><br>`
      + `구름은 반영하지 않았습니다. 정류소 좌표는 ${$("city").value === "seoul" ? "서울 열린데이터광장" : "TAGO 버스노선정보 API"} 실측값입니다.`;

  $("result").classList.remove("hidden");
}

loadCities();

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js");
