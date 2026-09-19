import fs from 'fs';
import path from 'path';

let CORPUS = null;
function loadCorpus() {
  if (CORPUS) return CORPUS;
  CORPUS = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'corpus_embedded.json'), 'utf-8'));
  return CORPUS;
}

export default function handler(req, res) {
  const title = (req.query.title || '').toLowerCase();
  if (!title) return res.status(400).json({error:'title required'});
  const corpus = loadCorpus();
  const song = corpus.find(s => s.title.toLowerCase() === title || s.title.toLowerCase().includes(title));
  if (!song) return res.status(404).json({error:'not found: ' + title});
  const {embedding, ...safe} = song;
  res.status(200).json(safe);
}
