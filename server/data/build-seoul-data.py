# 서울 열린데이터광장 "서울시버스노선별정류소정보" xlsx를 서버가 바로 읽는 JSON으로 변환한다.
# 서울은 TAGO가 다루지 않아 정적 덤프를 쓴다 (CLAUDE.md 참고). 데이터는 거의 안 바뀌므로
# 새 xlsx를 받으면 이 스크립트를 다시 돌려 seoul-stops.json을 갱신하면 된다.
#
# 사용: python build-seoul-data.py <xlsx경로>

import sys
import json
import openpyxl

if len(sys.argv) != 2:
    print("사용: python build-seoul-data.py <xlsx경로>")
    sys.exit(1)

wb = openpyxl.load_workbook(sys.argv[1], read_only=True, data_only=True)
ws = wb["Data"]

rows = []
for routeId, routeNo, ord_, nodeId, arsId, name, x, y in ws.iter_rows(min_row=2, values_only=True):
    if routeId is None or x is None or y is None:
        continue
    rows.append({
        "routeId": str(routeId),
        "routeNo": str(routeNo),
        "ord": int(ord_),
        "name": name,
        "lat": float(y),
        "lon": float(x),
    })

out_path = __file__.replace("build-seoul-data.py", "seoul-stops.json")
with open(out_path, "w", encoding="utf-8") as f:
    json.dump(rows, f, ensure_ascii=False, separators=(",", ":"))

print(f"{len(rows)}개 행 -> {out_path}")
