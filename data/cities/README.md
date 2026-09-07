# City search lists (IDF + Occitanie)

These two regions do **not** work via the region dropdown on cci.fr.
The scraper opens each city like:

`https://www.cci.fr/agent-immobilier?city=montpellier`

## Source: Commune column in your Excel

- [`communes_idf.xlsx`](../../communes_idf.xlsx) → sheet **Communes (1266)** → column **Commune**
- [`communes_occitanie.xlsx`](../../communes_occitanie.xlsx) → sheet **Communes (4446)** → column **Commune**

Rebuild:

```bat
python3 scripts/build-city-search-from-depts.py
```

Writes [`city-search.csv`](city-search.csv) with columns `region,city`.

The scraper processes **one commune after another** with the same pagination / detail flow. Resume remembers completed cities.
