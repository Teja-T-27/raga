import fs from 'fs';
import path from 'path';

let CORPUS = null;
function loadCorpus() {
  if (CORPUS) return CORPUS;
  const p = path.join(process.cwd(), 'corpus.json');
  CORPUS = JSON.parse(fs.readFileSync(p, 'utf-8'));
  return CORPUS;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({error:'POST only'});
  try {
    const { history } = req.body;
    const corpus = loadCorpus();
    const corpusText = corpus.map(s =>
      `- "${s.title}" by ${s.artist} [${s.language}] mood:${s.mood} themes:${s.themes.join(', ')} — ${s.summary}`
    ).join('\n');

    const sys = `You are raga, a companion to a personal playlist of 88 songs. Answer only from the corpus below. When you cite a song, use its title and artist. If nothing in the corpus fits, say so honestly.\n\nCORPUS:\n${corpusText}`;

    const contents = history.map(m => ({
      role: m.role === 'user' ? 'user' : 'model',
      parts: [{text: m.content}]
    }));

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${process.env.GEMINI_KEY}`;
    const r = await fetch(url, {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({
        systemInstruction: {parts:[{text: sys}]},
        contents
      })
    });
    const j = await r.json();
    if (j.error) return res.status(500).json({error: j.error.message});
    const reply = j.candidates?.[0]?.content?.parts?.[0]?.text || '(empty)';
    res.status(200).json({reply});
  } catch (e) {
    res.status(500).json({error: e.message});
  }
}
