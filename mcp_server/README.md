# raga MCP server

Exposes the raga song corpus as MCP tools that any MCP-compatible client (Claude Desktop, Cursor, etc.) can call.

## Tools
- search_songs(query_embedding, top_k) - semantic search
- get_song(title) - full metadata
- list_by_language(language) - filter by language
- list_by_mood(mood_keyword) - filter by mood

## Run
    python mcp_server/server.py
