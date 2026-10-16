"""Select a diverse 20-row benchmark ground truth from the full design-partner student list.

READ-ONLY against the source xlsx (never edits it). Writes a NEW CSV + XLSX with cleaned
values. Picks rows that (a) have a Clay LinkedIn profile + strong Clay enrichment fields
(accurate benchmark targets), and (b) maximise diversity across email TYPE (quota'd),
email provider / academic TLD, country, world region, institution, country-mismatch and
employment signals.

Usage: PYTHONIOENCODING=utf-8 python scripts/select_ground_truth.py
"""
import sys, csv, os, re
from collections import Counter
from openpyxl import load_workbook, Workbook
sys.stdout.reconfigure(encoding="utf-8")

SRC = r"C:/Users/User/Downloads/Student Database - graduation check against linkedin (1).xlsx"
OUT_DIR = r"C:/Users/User/lycert/benchmark"
# FREE-tier providers (big free quotas → larger, statistically meaningful sample):
QUOTA_FREE = {"corporate": 18, "academic": 27, "personal": 30}  # = 75
# PAID providers (conserve credits → tight, maximally-diverse subset of the free set):
QUOTA_PAID = {"corporate": 5, "academic": 7, "personal": 8}  # = 20


# ── mojibake repair (UTF-8 misdecoded as mac-roman/cp1252) ──
# Self-validating: try to re-encode to the wrong codec and decode as UTF-8; a clean accented
# string (already correct UTF-8) fails that round-trip and is returned untouched, while a
# mojibaked one ("Gda≈Ñska") round-trips back to the real text ("Gdańska").
def fixmoji(s):
    if not isinstance(s, str) or s.isascii():
        return s
    for codec in ("mac_roman", "cp1252", "latin-1"):
        try:
            t = s.encode(codec).decode("utf-8")
            if t != s and "�" not in t:
                return t
        except UnicodeError:
            continue
    return s


def lossy(s):
    return isinstance(s, str) and any(m in s for m in ("??", "�", "?ß", "?£", "?¬"))


wb = load_workbook(SRC, read_only=True, data_only=True)
ws = wb.active
it = ws.iter_rows(values_only=True)
H = [str(c).strip() if c is not None else "" for c in next(it)]
idx = {h: i for i, h in enumerate(H)}


def g(r, h):
    v = r[idx[h]] if idx[h] < len(r) else None
    return "" if v is None else str(v).strip()


PERSONAL = {"gmail": "gmail", "hotmail": "hotmail", "yahoo": "yahoo", "ymail": "yahoo",
            "outlook": "outlook", "live.": "outlook", "msn": "outlook", "icloud": "icloud",
            "me.com": "icloud", "aol": "aol", "proton": "proton", "gmx": "gmx",
            "yandex": "yandex", "mail.ru": "mail.ru", "qq.com": "qq", "163.com": "163",
            "126.com": "163", "naver": "naver"}


def provider(email):
    d = email.lower().split("@")[-1]
    for k, v in PERSONAL.items():
        if k in d:
            return v
    return None


def etype(email):
    d = email.lower().split("@")[-1]
    if provider(email):
        return "personal"
    if ".edu" in d or ".ac." in d or d.endswith(".ac") or "univ" in d or "student" in d:
        return "academic"
    return "corporate"


def atld(email):
    parts = email.lower().split("@")[-1].split(".")
    for anchor in ("edu", "ac"):
        if anchor in parts:
            return ".".join(parts[parts.index(anchor):])
    return ".".join(parts[1:]) if len(parts) > 1 else parts[-1]


def norm_country(c):
    c = re.sub(r"\s*\(.*?\)", "", c).strip()  # "Venezuela (Bolivarian Republic of)" -> "Venezuela"
    cl = c.strip().lower()
    if "united states" in cl or cl == "usa" or "america" in cl:
        return "USA"
    if "united kingdom" in cl or "great britain" in cl or cl in ("uk", "england", "scotland", "wales"):
        return "UK"
    if "korea" in cl:
        return "South Korea"
    if "rkiye" in cl or "turkey" in cl:
        return "Turkey"
    if "russia" in cl:
        return "Russia"
    return c.strip()


REGION = {"USA": "N.America", "Canada": "N.America", "Puerto Rico": "N.America", "Mexico": "LatAm", "Brazil": "LatAm",
          "Argentina": "LatAm", "Chile": "LatAm", "Colombia": "LatAm", "Peru": "LatAm",
          "Ecuador": "LatAm", "Uruguay": "LatAm", "Venezuela": "LatAm", "Bolivia": "LatAm",
          "Panama": "LatAm", "Honduras": "LatAm", "El Salvador": "LatAm", "Nicaragua": "LatAm",
          "Paraguay": "LatAm", "Costa Rica": "LatAm", "Guatemala": "LatAm", "Dominican Republic": "LatAm",
          "France": "W.Europe", "Germany": "W.Europe", "Spain": "W.Europe", "Italy": "W.Europe",
          "Portugal": "W.Europe", "Netherlands": "W.Europe", "Belgium": "W.Europe",
          "Switzerland": "W.Europe", "Austria": "W.Europe", "Ireland": "W.Europe",
          "Luxembourg": "W.Europe", "Malta": "W.Europe", "Greece": "W.Europe", "Cyprus": "W.Europe",
          "UK": "UK", "Sweden": "Nordics", "Norway": "Nordics", "Denmark": "Nordics",
          "Finland": "Nordics", "Iceland": "Nordics",
          "Poland": "E.Europe", "Czechia": "E.Europe", "Czech Republic": "E.Europe",
          "Romania": "E.Europe", "Hungary": "E.Europe", "Ukraine": "E.Europe", "Russia": "E.Europe",
          "Bulgaria": "E.Europe", "Serbia": "E.Europe", "Croatia": "E.Europe", "Slovakia": "E.Europe",
          "Slovenia": "E.Europe", "Lithuania": "E.Europe", "Latvia": "E.Europe", "Estonia": "E.Europe",
          "United Arab Emirates": "MiddleEast", "Saudi Arabia": "MiddleEast", "Israel": "MiddleEast",
          "Turkey": "MiddleEast", "Qatar": "MiddleEast", "Kuwait": "MiddleEast", "Lebanon": "MiddleEast",
          "Jordan": "MiddleEast", "Iran": "MiddleEast", "Iraq": "MiddleEast", "Bahrain": "MiddleEast",
          "Oman": "MiddleEast",
          "Nigeria": "Africa", "Egypt": "Africa", "South Africa": "Africa", "Kenya": "Africa",
          "Morocco": "Africa", "Ghana": "Africa", "Tunisia": "Africa", "Algeria": "Africa",
          "Ethiopia": "Africa", "Mozambique": "Africa", "Angola": "Africa", "Zimbabwe": "Africa",
          "Tanzania": "Africa", "Uganda": "Africa", "Senegal": "Africa", "Cameroon": "Africa",
          "India": "S.Asia", "Pakistan": "S.Asia", "Bangladesh": "S.Asia", "Sri Lanka": "S.Asia",
          "Nepal": "S.Asia",
          "China": "E.Asia", "Japan": "E.Asia", "South Korea": "E.Asia", "Taiwan": "E.Asia",
          "Hong Kong": "E.Asia",
          "Indonesia": "SE.Asia", "Philippines": "SE.Asia", "Vietnam": "SE.Asia", "Viet Nam": "SE.Asia",
          "Thailand": "SE.Asia", "Malaysia": "SE.Asia", "Singapore": "SE.Asia",
          "Australia": "Oceania", "New Zealand": "Oceania"}

CLAY = ["LI Title", "LI Job Company Name", "Company Domain Name", "LI Education Name",
        "LI Education Date Range", "LI Job Start Date", "LI Job End Date"]
KEYFIELDS = ["Contact Name", "LI Title", "LI Job Company Name", "LI Education Name"]

cands = []
for r in it:
    email = g(r, "email")
    if not email or "@" not in email:
        continue
    if not g(r, "LinkedIn Profile Final") or not g(r, "LI Education Name"):
        continue
    if not g(r, "Institution Name"):  # require a named institution (better ground truth)
        continue
    compl = sum(1 for f in CLAY if g(r, f))
    if compl < 5:
        continue
    if any(lossy(g(r, f)) for f in KEYFIELDS):  # unrecoverable mojibake → skip
        continue
    lic = norm_country(fixmoji(g(r, "LI Country")))
    inst_loc = g(r, "Institution Location")
    inst_ctry = norm_country(inst_loc.split(",")[-1]) if inst_loc else ""
    country = lic or inst_ctry or "?"
    if country == "?":  # require a resolvable country
        continue
    cands.append({
        "row": [fixmoji("" if c is None else (str(c) if not isinstance(c, str) else c)) for c in r],
        "email": email, "name": fixmoji(g(r, "Contact Name")), "etype": etype(email),
        "prov": provider(email) or (atld(email) if etype(email) == "academic" else "corp"),
        "country": country, "region": REGION.get(country, "Other"),
        "inst": fixmoji(g(r, "Institution Name")),
        "mism": bool(lic and inst_ctry and lic != inst_ctry),
        "employed": bool(g(r, "LI Job Company Name")), "compl": compl,
    })

print("clean candidates (LinkedIn + education + >=5/7 Clay, no lossy mojibake):", len(cands))
print("  by etype:", dict(Counter(c["etype"] for c in cands)))
W = {"country": 3, "region": 4, "prov": 3, "inst": 1, "mism": 2, "employed": 2}


def select(pool_all, quota):
    """Greedy diversity selection with per-email-type quotas (rarest type first for best spread)."""
    seen = {k: set() for k in ("country", "region", "prov", "inst", "mism", "employed")}

    def score(c):
        s = sum(w for dim, w in W.items() if c.get(dim) not in seen[dim])
        return s + 0.5 * c["compl"] / 7

    out = []
    for et in ("corporate", "academic", "personal"):
        pool = [c for c in pool_all if c["etype"] == et]
        for _ in range(quota[et]):
            if not pool:
                break
            best = max(pool, key=score)
            out.append(best)
            pool.remove(best)
            for dim in seen:
                seen[dim].add(best.get(dim))
    return out


def mask(e):
    u, d = e.split("@")
    return u[0] + "***@" + d


def report(name, sel):
    print(f"\n=== {name}: {len(sel)} rows ===")
    print(" etype:", dict(Counter(c["etype"] for c in sel)))
    print(" region:", dict(Counter(c["region"] for c in sel)))
    print(" personal providers:", dict(Counter(c["prov"] for c in sel if c["etype"] == "personal")))
    print(" academic TLDs:", dict(Counter(c["prov"] for c in sel if c["etype"] == "academic")))
    ctrs = sorted(set(c["country"] for c in sel))
    print(f" distinct countries: {len(ctrs)} {ctrs}")
    print(" mismatch y/n:", dict(Counter(c["mism"] for c in sel)))
    print(" employed y/n:", dict(Counter(c["employed"] for c in sel)))
    print(" compl hist:", dict(sorted(Counter(c["compl"] for c in sel).items())))


def write(path_base, sel):
    with open(path_base + ".csv", "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(H)
        for c in sel:
            w.writerow(c["row"])
    owb = Workbook()
    osh = owb.active
    osh.title = "ground_truth"
    osh.append(H)
    for c in sel:
        osh.append(c["row"])
    owb.save(path_base + ".xlsx")
    print("WROTE:", path_base + ".csv / .xlsx")


os.makedirs(OUT_DIR, exist_ok=True)
free = select(cands, QUOTA_FREE)                 # large set for free providers
paid = select(free, QUOTA_PAID)                  # tight subset for paid providers
report("FREE set (future free providers)", free)
report("PAID set (subset, for paid providers)", paid)
assert all(p in free for p in paid), "paid set must be a subset of free set"
print()
write(os.path.join(OUT_DIR, "ground_truth_free_75"), free)
write(os.path.join(OUT_DIR, "ground_truth_paid_20"), paid)
# remove the old single-file name if present
for old in ("ground_truth_benchmark_20.csv", "ground_truth_benchmark_20.xlsx"):
    p = os.path.join(OUT_DIR, old)
    if os.path.exists(p):
        os.remove(p)
