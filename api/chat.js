import fs from 'fs';
import path from 'path';

let CORPUS = null;
function loadCorpus() {
  if (CORPUS) return CORPUS;
  const p = path.join(process.cwd(), 'corpus_embedded.json');
  CORPUS = JSON.parse(fs.readFileSync(p, 'utf-8'));
  return CORPUS;
}

function cosine(a, b) {
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { d += a[i]*b[i]; na += a[i]*a[i]; nb += b[i]*b[i]; }
  return d / (Math.sqrt(na) * Math.sqrt(nb));
}

async function embed(text, key) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent?key=${key}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({content:{parts:[{text}]}})
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j.embedding.values;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({error:'POST only'});
  try {
    const { history } = req.body;
    const key = process.env.GEMINI_KEY;
    const corpus = loadCorpus();
    const lastUser = [...history].reverse().find(m => m.role === 'user')?.content || '';

    // RAG: embed query, pick top-8 songs
    const qvec = await embed(lastUser, key);
    const scored = corpus.map(s => ({s, score: cosine(qvec, s.embedding)}));
    scored.sort((a,b) => b.score - a.score);
    const top = scored.slice(0, 8).map(x => x.s);

    const context = top.map(s =>
      `- "${s.title}" by ${s.artist} [${s.language}] mood:${s.mood} themes:${s.themes.join(', ')} — ${s.summary}${s.translation ? ' translation: ' + s.translation : ''}`
    ).join('\n');

    const sys = `You are raga, a companion to a personal playlist. Answer only from the retrieved songs below (they're the top matches for the user's question). Cite songs by title and artist. If none fit, say so honestly.\n\nRETRIEVED SONGS:\n${context}`;

    const contents = history.map(m => ({
      role: m.role === 'user' ? 'user' : 'model',
      parts: [{text: m.content}]
    }));

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${key}`;
    const r = await fetch(url, {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({systemInstruction:{parts:[{text:sys}]}, contents})
    });
    const j = await r.json();
    if (j.error) return res.status(500).json({error: j.error.message});
    const reply = j.candidates?.[0]?.content?.parts?.[0]?.text || '(empty)';
    res.status(200).json({reply, retrieved: top.map(s => s.title)});
  } catch (e) {
    res.status(500).json({error: e.message});
  }
}
