#!/usr/bin/env python3
"""
Build data/cities/city-search.csv from the Commune column in:
  - communes_idf.xlsx       (sheet Communes)
  - communes_occitanie.xlsx (sheet Communes)

Usage:
  python3 scripts/build-city-search-from-depts.py
"""

from __future__ import annotations

import csv
import re
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "data" / "cities" / "city-search.csv"

FILES = [
    (ROOT / "communes_idf.xlsx", "ILE-DE-FRANCE"),
    (ROOT / "communes_occitanie.xlsx", "OCCITANIE"),
]

NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}


def shared_strings(z: zipfile.ZipFile) -> list[str]:
    try:
        root = ET.fromstring(z.read("xl/sharedStrings.xml"))
    except KeyError:
        return []
    out = []
    for si in root.findall("m:si", NS):
        texts = [t.text or "" for t in si.findall(".//m:t", NS)]
        out.append("".join(texts))
    return out


def col_row(cell_ref: str) -> tuple[int, int]:
    m = re.match(r"([A-Z]+)(\d+)", cell_ref)
    col, row = m.group(1), int(m.group(2))
    n = 0
    for c in col:
        n = n * 26 + (ord(c) - 64)
    return n - 1, row - 1


def workbook_sheets(z: zipfile.ZipFile) -> list[tuple[str, str]]:
    wb = ET.fromstring(z.read("xl/workbook.xml"))
    rels = ET.fromstring(z.read("xl/_rels/workbook.xml.rels"))
    id_to_target = {r.get("Id"): r.get("Target") for r in rels}
    sheets = []
    for sh in wb.findall("m:sheets/m:sheet", NS):
        name = sh.get("name")
        rid = sh.get(
            "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id"
        )
        target = id_to_target.get(rid, "")
        if target and not target.startswith("xl/"):
            target = "xl/" + target.lstrip("/")
        sheets.append((name, target))
    return sheets


def read_full_sheet(z: zipfile.ZipFile, path: str) -> list[list[str]]:
    ss = shared_strings(z)
    root = ET.fromstring(z.read(path))
    rows: dict[int, dict[int, str]] = {}
    for c in root.findall(".//m:c", NS):
        ref = c.get("r")
        if not ref:
            continue
        ci, ri = col_row(ref)
        t = c.get("t")
        v = c.find("m:v", NS)
        if v is None or v.text is None:
            val = ""
        elif t == "s":
            val = ss[int(v.text)] if int(v.text) < len(ss) else ""
        else:
            val = v.text
        rows.setdefault(ri, {})[ci] = val
    if not rows:
        return []
    max_r = max(rows)
    max_c = max(max(r) for r in rows.values())
    return [
        [rows.get(ri, {}).get(ci, "") for ci in range(max_c + 1)]
        for ri in range(max_r + 1)
    ]


def communes_from_xlsx(path: Path) -> list[str]:
    z = zipfile.ZipFile(path)
    sheets = workbook_sheets(z)
    target = None
    for name, t in sheets:
        if name.lower().startswith("communes"):
            target = t
            break
    if not target:
        target = sheets[-1][1]

    table = read_full_sheet(z, target)
    header = [str(h).strip() for h in table[0]]
    idx = next((i for i, h in enumerate(header) if h.lower() == "commune"), None)
    if idx is None:
        raise SystemExit(f"No Commune column in {path}: {header}")

    cities: list[str] = []
    seen: set[str] = set()
    for row in table[1:]:
        if idx >= len(row):
            continue
        name = str(row[idx]).strip()
        if not name:
            continue
        key = name.casefold()
        if key in seen:
            continue
        seen.add(key)
        cities.append(name)
    return cities


def main() -> None:
    rows = [("region", "city")]
    for path, region in FILES:
        if not path.exists():
            raise SystemExit(f"Missing Excel file: {path}")
        cities = communes_from_xlsx(path)
        print(f"{region}: {len(cities)} communes from Commune column")
        for city in cities:
            rows.append((region, city))

    OUT.parent.mkdir(parents=True, exist_ok=True)
    with OUT.open("w", newline="", encoding="utf-8") as f:
        csv.writer(f).writerows(rows)
    print(f"Wrote {OUT} — total {len(rows) - 1}")


if __name__ == "__main__":
    main()
