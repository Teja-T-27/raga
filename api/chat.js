import fs from 'fs';
import path from 'path';

let CORPUS = null;
function loadCorpus() {
  if (CORPUS) return CORPUS;
  CORPUS = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'corpus_embedded.json'), 'utf-8'));
  return CORPUS;
}

function cosine(a, b) {
  let d=0, na=0, nb=0;
  for (let i=0; i<a.length; i++) { d+=a[i]*b[i]; na+=a[i]*a[i]; nb+=b[i]*b[i]; }
  return d/(Math.sqrt(na)*Math.sqrt(nb));
}

async function embed(text, key) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent?key=${key}`;
  const r = await fetch(url, {method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({content:{parts:[{text}]}})});
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j.embedding.values;
}

async function geminiStream(sys, user, key, onChunk) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:streamGenerateContent?alt=sse&key=${key}`;
  const r = await fetch(url, {method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({
      systemInstruction:{parts:[{text:sys}]},
      contents:[{role:'user', parts:[{text:user}]}]
    })});
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let full = '', buf = '';
  while (true) {
    const {done, value} = await reader.read();
    if (done) break;
    buf += dec.decode(value, {stream:true});
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const payload = line.slice(6).trim();
      if (!payload) continue;
      try {
        const j = JSON.parse(payload);
        const text = j.candidates?.[0]?.content?.parts?.[0]?.text || '';
        if (text) { full += text; onChunk(text); }
      } catch {}
    }
  }
  return full;
}

async function gemini(sys, user, key) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${key}`;
  const r = await fetch(url, {method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({systemInstruction:{parts:[{text:sys}]}, contents:[{role:'user', parts:[{text:user}]}]})});
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

function retrieve(corpus, qvec, k=5) {
  const scored = corpus.map(s => ({s, score: cosine(qvec, s.embedding)}));
  scored.sort((a,b) => b.score - a.score);
  return scored.slice(0,k).map(x => x.s);
}

function fmt(songs) {
  return songs.map(s => `- "${s.title}" by ${s.artist} [${s.language}] mood:${s.mood} themes:${s.themes.join(', ')} — ${s.summary}${s.translation ? ' translation: ' + s.translation : ''}`).join('\n');
}

function sse(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({error:'POST only'});

  res.writeHead(200, {
    'Content-Type':'text/event-stream',
    'Cache-Control':'no-cache',
    'Connection':'keep-alive'
  });

  try {
    const { history, mode } = req.body;
    const key = process.env.GEMINI_KEY;
    const corpus = loadCorpus();
    const question = [...history].reverse().find(m => m.role === 'user')?.content || '';

    if (mode !== 'research') {
      sse(res, 'status', {text:'retrieving relevant songs...'});
      const qvec = await embed(question, key);
      const top = retrieve(corpus, qvec, 8);
      sse(res, 'retrieved', {songs: top.map(s => ({title:s.title, artist:s.artist}))});
      const sys = `You are raga, a companion to a personal playlist. Answer only from the retrieved songs. Cite by title and artist.\n\nRETRIEVED:\n${fmt(top)}`;
      await geminiStream(sys, question, key, (chunk) => sse(res, 'chunk', {text:chunk}));
      sse(res, 'done', {});
      return res.end();
    }

    // research mode
    sse(res, 'status', {text:'planning sub-questions...'});
    const planSys = `You are a research planner. Given a question about a personal playlist of 88 songs (multi-language), break it into 3 focused sub-questions that together answer it well. Return ONLY a JSON array of 3 strings.`;
    const planRaw = await gemini(planSys, question, key);
    let subqs;
    try { subqs = JSON.parse(planRaw.match(/\[[\s\S]*\]/)[0]); } catch { subqs = [question]; }
    sse(res, 'plan', {subqs});

    const subResults = [];
    for (let i=0; i<subqs.length; i++) {
      sse(res, 'status', {text:`sub-agent ${i+1} researching...`});
      const qvec = await embed(subqs[i], key);
      const top = retrieve(corpus, qvec, 5);
      const sys = `You are a research sub-agent. Answer using ONLY the retrieved songs. Cite by title and artist. Be concise (3-5 sentences).\n\nRETRIEVED:\n${fmt(top)}`;
      const answer = await gemini(sys, subqs[i], key);
      subResults.push({subq: subqs[i], retrieved: top.map(s=>s.title), answer});
      sse(res, 'sub', {i:i+1, retrieved: top.map(s=>s.title)});
    }

    sse(res, 'status', {text:'synthesizing final answer...'});
    const synthSys = `You are a synthesizer. Combine these sub-agent findings into a coherent answer to the original question. Cite specific songs. Keep it focused, essay-style, 2-4 paragraphs.`;
    const synthUser = `ORIGINAL: ${question}\n\nFINDINGS:\n${subResults.map((r,i)=>`[${i+1}] ${r.subq}\n${r.answer}`).join('\n\n')}`;
    const finalAnswer = await geminiStream(synthSys, synthUser, key, (chunk) => sse(res, 'chunk', {text:chunk}));

    sse(res, 'status', {text:'judging...'});
    const judgeSys = `You are an evaluator. Score the answer on: grounding (0-10), coherence (0-10), directness (0-10). Return JSON: {"grounding":N,"coherence":N,"directness":N,"notes":"one line"}. JSON only.`;
    const judgeRaw = await gemini(judgeSys, `QUESTION: ${question}\n\nANSWER: ${finalAnswer}`, key);
    let judge = null;
    try { judge = JSON.parse(judgeRaw.match(/\{[\s\S]*\}/)[0]); } catch { judge = {notes: judgeRaw}; }
    sse(res, 'judge', judge);
    sse(res, 'done', {});
    res.end();
  } catch (e) {
    sse(res, 'error', {message: e.message});
    res.end();
  }
}
