"""Read one JSON entry from stdin, append to lyrics.json, remove from missing.json."""
import json, sys, os
ROOT = os.path.expanduser("~/mnt/raga")
entry = json.loads(sys.stdin.read())
lp = os.path.join(ROOT, "lyrics.json")
mp = os.path.join(ROOT, "missing.json")
L = json.load(open(lp))
M = json.load(open(mp))
if not any(x.get("raw")==entry["raw"] for x in L):
    L.append(entry)
    json.dump(L, open(lp+".tmp","w"), ensure_ascii=False, indent=2); os.replace(lp+".tmp", lp)
M = [x for x in M if x.get("raw") != entry["raw"]]
json.dump(M, open(mp+".tmp","w"), ensure_ascii=False, indent=2); os.replace(mp+".tmp", mp)
print(f"OK. lyrics={len(L)} missing={len(M)}")
