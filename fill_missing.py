"""
Fill misses: for each entry in missing.json, try:
  1) JioSaavn (via public saavn.dev API — has lyrics field for many songs)
  2) LyricsTranslate (search + scrape)
  3) Google search + scrape a generic lyrics page (AZLyrics, LyricsMint, Hindilyrics4u, JioSaavn direct, etc.)
Successful → append to lyrics.json. Failed → keep in missing.json with updated reason.
Resumable: writes after each success, skips entries already in lyrics.json by 'raw'.
"""
import os, json, re, time, sys, html, urllib.parse
import requests
from bs4 import BeautifulSoup

ROOT = os.path.expanduser("~/mnt/raga") if os.path.isdir(os.path.expanduser("~/mnt/raga")) else "."
LYRICS_PATH = os.path.join(ROOT, "lyrics.json")
MISSING_PATH = os.path.join(ROOT, "missing.json")

UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36"
HEADERS = {"User-Agent": UA, "Accept-Language": "en-US,en;q=0.9"}

def load(p):
    with open(p, encoding="utf-8") as f:
        return json.load(f)

def save(p, data):
    tmp = p + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.replace(tmp, p)

def parse_query(q):
    """Return (title, artist) best-guess. Query like 'Song : Artist - Album' or 'Song - Artist - X'."""
    s = re.sub(r"[\[\(].*?[\]\)]", "", q).strip()
    s = re.sub(r"\s+", " ", s)
    # Try ' : ' first (used for 'Song : Artists - Movie')
    parts = None
    if " : " in s:
        left, right = s.split(" : ", 1)
        title = left.strip()
        rest = right
        artist = rest.split(" - ")[0].strip() if " - " in rest else rest.strip()
    else:
        segs = [p.strip() for p in s.split(" - ")]
        title = segs[0]
        artist = segs[1] if len(segs) > 1 else ""
    # Trim trailing tokens like 'Lyrics'
    title = re.sub(r"\b(lyrics|official|full song|song)\b\s*$", "", title, flags=re.I).strip()
    # Only first artist
    artist = re.split(r"[,&/]| ft\.?| feat\.?", artist, flags=re.I)[0].strip()
    return title, artist

# --------- Source 1: JioSaavn via saavn.dev ---------
def try_saavn(title, artist):
    q = f"{title} {artist}".strip()
    try:
        r = requests.get("https://saavn.dev/api/search/songs",
                         params={"query": q, "limit": 5}, headers=HEADERS, timeout=15)
        if r.status_code != 200: return None
        data = r.json()
        results = (data.get("data") or {}).get("results") or []
        for s in results:
            sid = s.get("id")
            if not sid: continue
            lr = requests.get(f"https://saavn.dev/api/songs/{sid}/lyrics", headers=HEADERS, timeout=15)
            if lr.status_code != 200: continue
            ld = lr.json()
            lyr = ((ld.get("data") or {}).get("lyrics") or "").strip()
            if lyr and len(lyr) > 100:
                lyr = re.sub(r"<br\s*/?>", "\n", lyr)
                lyr = BeautifulSoup(lyr, "lxml").get_text("\n").strip()
                name = s.get("name") or title
                primary = ", ".join(a.get("name","") for a in ((s.get("artists") or {}).get("primary") or [])) or artist
                url = s.get("url") or ""
                return {"source": "jiosaavn", "title": name, "artist": primary, "url": url, "lyrics": lyr}
    except Exception:
        return None
    return None

# --------- Source 2: LyricsTranslate ---------
def try_lyricstranslate(title, artist):
    q = f"{title} {artist}".strip()
    try:
        r = requests.get("https://lyricstranslate.com/en/translations",
                         params={"query": q}, headers=HEADERS, timeout=15)
        if r.status_code != 200: return None
        soup = BeautifulSoup(r.text, "lxml")
        # Find first song link
        a = soup.select_one("a[href*='/en/'][href*='-lyrics.html']")
        if not a:
            a = soup.select_one("td.ltsearch-results-lyric-line a")
        if not a: return None
        href = a.get("href")
        if href.startswith("/"): href = "https://lyricstranslate.com" + href
        pr = requests.get(href, headers=HEADERS, timeout=15)
        if pr.status_code != 200: return None
        psoup = BeautifulSoup(pr.text, "lxml")
        # Original lyrics container
        node = psoup.select_one("div.song-node-text") or psoup.select_one("div.ltf")
        if not node: return None
        lyr = node.get_text("\n").strip()
        if len(lyr) < 100: return None
        t = psoup.select_one("h2 a") or psoup.select_one("h1")
        name = (t.get_text(strip=True) if t else title)
        return {"source": "lyricstranslate", "title": name, "artist": artist, "url": href, "lyrics": lyr}
    except Exception:
        return None

# --------- Source 3: DuckDuckGo HTML search + scrape ---------
LYRIC_HOSTS_RE = re.compile(
    r"(lyricsmint\.com|hindilyrics4u|lyricsbogie|lyricstape|lyricsted|"
    r"gaana\.com|jiosaavn\.com|azlyrics\.com|smule\.com|lyrics\.com|"
    r"musixmatch\.com|lyricsindia|lyricshawa|filmilyrics|hinditracks|"
    r"hungama\.com|last\.fm|lyricsraag|allthelyrics|lyricstranslate)",
    re.I)

def ddg_search(q, n=8):
    try:
        r = requests.post("https://html.duckduckgo.com/html/",
                          data={"q": q}, headers=HEADERS, timeout=15)
        if r.status_code != 200: return []
        soup = BeautifulSoup(r.text, "lxml")
        out = []
        for a in soup.select("a.result__a"):
            href = a.get("href","")
            m = re.search(r"uddg=([^&]+)", href)
            url = urllib.parse.unquote(m.group(1)) if m else href
            out.append(url)
            if len(out) >= n: break
        return out
    except Exception:
        return []

def scrape_lyrics_page(url):
    try:
        r = requests.get(url, headers=HEADERS, timeout=20)
        if r.status_code != 200: return None
        soup = BeautifulSoup(r.text, "lxml")
        # Remove script/style/nav
        for t in soup(["script","style","noscript","nav","header","footer","aside","form"]):
            t.decompose()
        # Site-specific extractors
        candidates = []
        # LyricsMint / LyricsBogie / etc — commonly use div.entry-content or div#lyric or <pre>
        for sel in ["div.lyrics", "div#lyric", "div.entry-content", "div.post-content",
                    "div.lyric-content", "div.lyricbox", "pre", "div[itemprop=lyrics]",
                    "div.songLyricsV14", "article", "div.main-content"]:
            for node in soup.select(sel):
                txt = node.get_text("\n").strip()
                if 200 < len(txt) < 8000 and txt.count("\n") > 5:
                    candidates.append(txt)
        if not candidates:
            # Fallback: largest text block that looks like lyrics (many newlines)
            best = ""
            for node in soup.find_all(["div","p","pre"]):
                txt = node.get_text("\n").strip()
                if len(txt) > len(best) and txt.count("\n") > 8 and len(txt) < 8000:
                    best = txt
            if best: candidates.append(best)
        if not candidates: return None
        lyr = max(candidates, key=len)
        # Strip common junk lines
        lines = [ln.strip() for ln in lyr.splitlines()]
        lines = [ln for ln in lines if ln and not re.search(
            r"(cookie|subscribe|advertisement|share this|©|all rights|newsletter|"
            r"privacy policy|terms of|comments|related songs|follow us|read more|"
            r"click here|home\s*»|breadcrumb)", ln, re.I)]
        lyr = "\n".join(lines).strip()
        if len(lyr) < 150: return None
        return lyr
    except Exception:
        return None

def try_google_scrape(title, artist):
    for q in [f"{title} {artist} lyrics", f"{title} {artist} lyrics telugu hindi", f'"{title}" {artist} lyrics']:
        urls = ddg_search(q, n=8)
        for u in urls:
            if not LYRIC_HOSTS_RE.search(u): continue
            lyr = scrape_lyrics_page(u)
            if lyr:
                return {"source": "webscrape", "title": title, "artist": artist, "url": u, "lyrics": lyr}
        time.sleep(0.5)
    return None

# --------- Driver ---------
def main():
    lyrics = load(LYRICS_PATH)
    missing = load(MISSING_PATH)
    seen_raw = {e.get("raw") for e in lyrics}
    still_missing = []
    added = 0
    import time as _t
    START = _t.time()
    CAP = float(os.environ.get("CAP", 150))
    for i, e in enumerate(missing, 1):
        if _t.time() - START > CAP:
            print(f"time cap {CAP}s hit at [{i}]", flush=True); break
        raw = e.get("raw")
        q = e.get("query") or raw or ""
        if raw in seen_raw:
            continue
        title, artist = parse_query(q)
        print(f"[{i}/{len(missing)}] {title[:40]} | {artist[:25]}", flush=True)
        result = None
        for fn, tag in [(try_saavn,"saavn"), (try_lyricstranslate,"lt"), (try_google_scrape,"web")]:
            try:
                result = fn(title, artist)
            except Exception as ex:
                result = None
            if result:
                print(f"   ✓ {tag}: {result['url'][:80]}", flush=True)
                break
            time.sleep(0.3)
        if result:
            lyrics.append({
                "raw": raw, "query": q,
                "title": result["title"], "artist": result["artist"],
                "url": result["url"], "lyrics": result["lyrics"],
                "source": result["source"],
            })
            save(LYRICS_PATH, lyrics)
            added += 1
        else:
            still_missing.append({"raw": raw, "query": q, "reason": "not found via saavn/lyricstranslate/web"})
        save(MISSING_PATH, still_missing + missing[i:])  # keep rolling
        time.sleep(0.4)
    # Only rewrite final if fully completed
    if _t.time() - START <= CAP:
        save(MISSING_PATH, still_missing)
    print(f"\nAdded {added}. Still-missing this run: {len(still_missing)}", flush=True)

if __name__ == "__main__":
    main()
