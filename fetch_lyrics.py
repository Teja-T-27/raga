import os, json, re, time
from dotenv import load_dotenv
import lyricsgenius

load_dotenv()
genius = lyricsgenius.Genius(
    os.getenv("GENIUS_TOKEN"),
    timeout=15,
    retries=2,
    remove_section_headers=True,
    skip_non_songs=True,
)

def clean_query(line):
    s = line.strip()
    s = re.sub(r"[\[\(].*?[\]\)]", "", s)
    s = re.sub(r"\s+", " ", s).strip(" -–—:•|")
    return s

with open("playlist_import.txt", encoding="utf-8") as f:
    raw = [l for l in f.read().splitlines() if l.strip()]

results, missing = [], []
for i, line in enumerate(raw, 1):
    q = clean_query(line)
    print(f"[{i}/{len(raw)}] {q[:70]}")
    try:
        song = genius.search_song(q)
        if song and song.lyrics:
            results.append({
                "raw": line, "query": q,
                "title": song.title, "artist": song.artist,
                "url": song.url, "lyrics": song.lyrics,
            })
        else:
            missing.append({"raw": line, "query": q, "reason": "not found"})
    except Exception as e:
        missing.append({"raw": line, "query": q, "reason": str(e)})
    time.sleep(0.3)

with open("lyrics.json", "w", encoding="utf-8") as f:
    json.dump(results, f, ensure_ascii=False, indent=2)
with open("missing.json", "w", encoding="utf-8") as f:
    json.dump(missing, f, ensure_ascii=False, indent=2)

print(f"\nDone. Got {len(results)} / {len(raw)}. Missing: {len(missing)}")
