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

async function gemini(sys, user, key) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${key}`;
  const r = await fetch(url, {method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({
      systemInstruction:{parts:[{text:sys}]},
      contents:[{role:'user', parts:[{text:user}]}]
    })});
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

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({error:'POST only'});
  try {
    const { history, mode } = req.body;
    const key = process.env.GEMINI_KEY;
    const corpus = loadCorpus();
    const question = [...history].reverse().find(m => m.role === 'user')?.content || '';

    // simple mode: single RAG call (Rung 2 behaviour)
    if (mode !== 'research') {
      const qvec = await embed(question, key);
      const top = retrieve(corpus, qvec, 8);
      const sys = `You are raga, a companion to a personal playlist. Answer only from the retrieved songs. Cite by title and artist.\n\nRETRIEVED:\n${fmt(top)}`;
      const reply = await gemini(sys, question, key);
      return res.status(200).json({reply, retrieved: top.map(s=>s.title), mode:'simple'});
    }

    // research mode: planner → sub-agents → synth → judge
    const trace = [];

    // 1. Planner
    trace.push({step:'planning', detail:'Breaking your question into sub-questions...'});
    const planSys = `You are a research planner. Given a question about a personal playlist of 88 songs (multi-language: English, Hindi, Telugu, Punjabi, Korean, etc.), break it into 3 focused sub-questions that together answer it well. Return ONLY a JSON array of 3 strings, nothing else.`;
    const planRaw = await gemini(planSys, question, key);
    let subqs;
    try { subqs = JSON.parse(planRaw.match(/\[[\s\S]*\]/)[0]); }
    catch { subqs = [question]; }
    trace.push({step:'plan', detail:`Sub-questions: ${subqs.map((q,i)=>`(${i+1}) ${q}`).join(' ')}`});

    // 2. Sub-agents in parallel
    const subResults = await Promise.all(subqs.map(async (sq, i) => {
      const qvec = await embed(sq, key);
      const top = retrieve(corpus, qvec, 5);
      const sys = `You are a research sub-agent. Answer the sub-question using ONLY the retrieved songs. Cite by title and artist. Be concise (3-5 sentences).\n\nRETRIEVED:\n${fmt(top)}`;
      const answer = await gemini(sys, sq, key);
      return {subq: sq, retrieved: top.map(s=>s.title), answer};
    }));
    subResults.forEach((r,i) => trace.push({step:`sub-agent ${i+1}`, detail:`Retrieved: ${r.retrieved.join(', ')}`}));

    // 3. Synthesizer
    trace.push({step:'synthesizing', detail:'Combining sub-agent findings into a final answer...'});
    const synthSys = `You are a synthesizer. Combine these sub-agent findings into a coherent answer to the original question. Cite specific songs. Keep it focused, essay-style, 2-4 paragraphs.`;
    const synthUser = `ORIGINAL QUESTION: ${question}\n\nSUB-AGENT FINDINGS:\n${subResults.map((r,i)=>`[${i+1}] ${r.subq}\n${r.answer}`).join('\n\n')}`;
    const finalAnswer = await gemini(synthSys, synthUser, key);

    // 4. Judge
    trace.push({step:'judging', detail:'Scoring the answer against a rubric...'});
    const judgeSys = `You are an evaluator. Score the answer on: (1) grounding in cited songs (0-10), (2) coherence (0-10), (3) directly answers the question (0-10). Return JSON: {"grounding":N, "coherence":N, "directness":N, "notes":"one line"}. No prose outside JSON.`;
    const judgeUser = `QUESTION: ${question}\n\nANSWER: ${finalAnswer}`;
    const judgeRaw = await gemini(judgeSys, judgeUser, key);
    let judge = null;
    try { judge = JSON.parse(judgeRaw.match(/\{[\s\S]*\}/)[0]); } catch { judge = {raw: judgeRaw}; }

    return res.status(200).json({
      reply: finalAnswer,
      mode: 'research',
      trace,
      subResults,
      judge
    });

  } catch (e) {
    return res.status(500).json({error: e.message});
  }
}
