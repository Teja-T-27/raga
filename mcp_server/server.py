"""MCP server exposing the raga song corpus as tools."""
import json, os, math
from mcp.server.fastmcp import FastMCP

CORPUS = json.load(open(os.path.join(os.path.dirname(__file__), "..", "corpus_embedded.json")))
mcp = FastMCP("raga")

def cosine(a, b):
    dot = sum(x*y for x,y in zip(a,b))
    na = math.sqrt(sum(x*x for x in a))
    nb = math.sqrt(sum(x*x for x in b))
    return dot / (na * nb)

@mcp.tool()
def search_songs(query_embedding: list[float], top_k: int = 5) -> list[dict]:
    """Semantic search over the raga corpus."""
    scored = [(cosine(query_embedding, s["embedding"]), s) for s in CORPUS]
    scored.sort(reverse=True, key=lambda x: x[0])
    return [{"title": s["title"], "artist": s["artist"], "language": s["language"],
             "mood": s["mood"], "themes": s["themes"], "summary": s["summary"],
             "translation": s.get("translation"), "score": round(sc, 3)}
            for sc, s in scored[:top_k]]

@mcp.tool()
def get_song(title: str) -> dict:
    """Get full metadata for a specific song by title."""
    tl = title.lower()
    for s in CORPUS:
        if tl in s["title"].lower():
            return {k:v for k,v in s.items() if k != "embedding"}
    return {"error": f"no song matching '{title}'"}

@mcp.tool()
def list_by_language(language: str) -> list[str]:
    """List all song titles in a given language."""
    return [s["title"] for s in CORPUS if language.lower() in s["language"].lower()]

@mcp.tool()
def list_by_mood(mood_keyword: str) -> list[dict]:
    """Find songs whose mood tag contains this keyword."""
    return [{"title":s["title"],"artist":s["artist"],"mood":s["mood"]}
            for s in CORPUS if mood_keyword.lower() in s["mood"].lower()]

if __name__ == "__main__":
    mcp.run()
