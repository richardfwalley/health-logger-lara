'use strict';



const express = require('express');

const fs = require('fs');

const path = require('path');

const Anthropic = require('@anthropic-ai/sdk');



const app = express();

const PORT = process.env.PORT || 3737;

const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data', 'health.json');



// ── Seed data (imported from widget) ───────────────────────────────────────

const SEED_DATA = [];



// ── Data helpers ────────────────────────────────────────────────────────────

function readData() {

  try {

    if (!fs.existsSync(DATA_FILE)) {

      fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });

      fs.writeFileSync(DATA_FILE, JSON.stringify(SEED_DATA, null, 2));

      return [...SEED_DATA];

    }

    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));

  } catch (e) {

    console.error('readData error:', e.message);

    return [...SEED_DATA];

  }

}



function writeData(data) {

  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });

  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));

}



// ── Parsers ─────────────────────────────────────────────────────────────────

function parseWithRegex(text, today) {

  today = today || new Date().toISOString().slice(0, 10);

  const entry = { date: today, weight_am: null, weight_pm: null, kcal: null, details: '' };

  let remaining = text;



  // Date: "yesterday"

  if (/\byesterday\b/i.test(remaining)) {

    const d = new Date(); d.setDate(d.getDate() - 1);

    entry.date = d.toISOString().slice(0, 10);

    remaining = remaining.replace(/\byesterday\b/gi, '');

  }



  // AM vs PM context

  const isPM = /\b(pm|evening|tonight|afternoon)\b/i.test(remaining);



  // Weight: number 80–200, optionally followed by kg, with weight context OR at start of string

  const weightPatterns = [

    /\bweight(?:ed|s)?\s+(?:was\s+)?(\d{2,3}(?:\.\d{1,2})?)\s*(?:kg)?\b/i,

    /\b(\d{2,3}(?:\.\d{1,2})?)\s*kg\b/i,

    /\bweigh(?:ing|s|ed)?\s+(?:in\s+at\s+)?(\d{2,3}(?:\.\d{1,2})?)/i,

    /^[\s]*(\d{2,3}(?:\.\d{1,2})?)\b/,

  ];

  for (const pat of weightPatterns) {

    const m = remaining.match(pat);

    if (m) {

      const w = parseFloat(m[1]);

      if (w >= 80 && w <= 200) {

        if (isPM) entry.weight_pm = w; else entry.weight_am = w;

        remaining = remaining.replace(m[0], ' ');

        break;

      }

    }

  }



  // Calories

  const kcalMatch = remaining.match(/\b(\d{3,5})\s*(?:kcal|k?cal(?:ories?)?)\b/i)

    || remaining.match(/[~≈]\s*(\d{3,5})\b/);

  if (kcalMatch) {

    entry.kcal = parseInt(kcalMatch[1]);

    remaining = remaining.replace(kcalMatch[0], ' ');

  }



  // Clean up remaining text as food details

  entry.details = remaining

    .replace(/\b(had|ate|drank?|consumed)\b/gi, ' ')

    .replace(/\b(?:for\s+)?(?:breakfast|lunch|dinner|snacks?)\b/gi, ' ')

    .replace(/,\s*/g, '; ')

    .replace(/\s+/g, ' ')

    .replace(/;\s*;/g, ';')

    .replace(/^[\s;]+|[\s;]+$/g, '')

    .trim();



  return entry;

}



async function parseWithClaude(text, today) {

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  today = today || new Date().toISOString().slice(0, 10);



  const response = await client.messages.create({

    model: 'claude-haiku-4-5-20251001',

    max_tokens: 300,

    messages: [{

      role: 'user',

      content: `Parse this health log entry. Today is ${today}. Return ONLY valid JSON, no markdown.



Schema: {"date":"YYYY-MM-DD","weight_am":number|null,"weight_pm":number|null,"kcal":number|null,"details":"semicolon-separated food and drink items","exercise":"description of exercise or null","kcal_burned":number|null}



Rules:

- date defaults to today unless "yesterday" or an explicit date is mentioned

- weight_am = morning/AM weight; weight_pm = evening/PM weight; both in kg

- kcal: ALWAYS provide a calorie estimate using your nutrition knowledge. Use reasonable UK portion sizes if amounts not specified. Only use null if literally no food or drink is mentioned at all. Reference: flat white 150, Vogels slice+butter 125, egg yolk 55, 150g rice+peas+chicken thigh 600, chicken salad+avocado 450, 440ml 6% beer 210, 330ml 5% beer 150, Guinness 0 70, half avocado 120, slice toast 80, tbsp olive oil 120, pork scratchings 30g 175

- details: all food and drink as concise semicolon-separated list, preserving amounts

- exercise: describe any exercise performed (e.g. "30 min cross trainer level 8"); null if none mentioned

- kcal_burned: calories burned from exercise; if kJ given divide by 4.184 and round to nearest 5; if only description estimate from type/duration/intensity; null if no exercise



Input: "${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`

    }]

  });



  const raw = response.content[0].text.replace(/```json\n?|\n?```/g, '').trim();

  return JSON.parse(raw);

}



async function parseEntry(text, today) {

  if (process.env.ANTHROPIC_API_KEY) {

    try {

      return await parseWithClaude(text, today);

    } catch (e) {

      console.error('Claude parse failed, using regex fallback:', e.message);

    }

  }

  return parseWithRegex(text, today);

}



// ── Express app ─────────────────────────────────────────────────────────────

app.use(express.json());

app.use(express.static(path.join(__dirname, 'public')));

app.use((req, res, next) => {

  res.setHeader('Access-Control-Allow-Origin', '*');

  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');

  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.sendStatus(200);

  next();

});



// GET /api/entries — all entries sorted by date

app.get('/api/entries', (req, res) => {

  res.json(readData());

});



// POST /api/refine — apply a correction to an existing parsed entry
app.post('/api/refine', async (req, res) => {
  try {
    const { entry, instruction } = req.body;
    if (!entry || !instruction) return res.status(400).json({ error: 'Provide entry and instruction' });

    if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'No API key' });

    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 400,
      messages: [{
        role: 'user',
        content: `Refine this health log entry based on the user's instruction. Return ONLY the updated entry as valid JSON, no markdown.

Current entry:
${JSON.stringify(entry)}

User instruction: "${instruction.replace(/"/g, '\\"')}"

Apply the change and return the full updated entry. Same schema: {"date","weight_am","weight_pm","kcal","details","exercise","kcal_burned"}. Keep all fields unchanged unless the instruction specifically relates to them.`
      }]
    });

    const raw = response.content[0].text.replace(/```json\n?|\n?```/g, '').trim();
    res.json(JSON.parse(raw));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/parse — parse text, return entry without saving

app.post('/api/parse', async (req, res) => {

  try {

    const entry = await parseEntry(req.body.text || '', req.body.today);

    res.json(entry);

  } catch (e) {

    res.status(500).json({ error: e.message });

  }

});



// POST /api/log — parse text (or accept structured entry) and save

app.post('/api/log', async (req, res) => {

  try {

    let entry;

    if (req.body.text) {

      entry = await parseEntry(req.body.text, req.body.today);

    } else if (req.body.entry) {

      entry = req.body.entry;

    } else {

      return res.status(400).json({ error: 'Provide text or entry' });

    }

    if (!entry || !entry.date) return res.status(400).json({ error: 'Could not parse entry' });



    const data = readData();

    const idx = data.findIndex(r => r.date === entry.date);

    let savedEntry;

    if (idx >= 0) {

      const existing = data[idx];

      data[idx] = {

        date: entry.date,

        weight_am: entry.weight_am ?? existing.weight_am,

        weight_pm: entry.weight_pm ?? existing.weight_pm,

        kcal: existing.kcal == null && entry.kcal == null

              ? null

              : (existing.kcal ?? 0) + (entry.kcal ?? 0),

        details: [existing.details, entry.details].filter(Boolean).join('; '),

        exercise: [existing.exercise, entry.exercise].filter(Boolean).join('; ') || null,

        kcal_burned: existing.kcal_burned == null && entry.kcal_burned == null

              ? null

              : (existing.kcal_burned ?? 0) + (entry.kcal_burned ?? 0),

      };

      savedEntry = data[idx];

    } else {

      data.push(entry);

      data.sort((a, b) => a.date.localeCompare(b.date));

      savedEntry = entry;

    }

    writeData(data);

    res.json({ success: true, entry: savedEntry });

  } catch (e) {

    res.status(500).json({ error: e.message });

  }

});



// PUT /api/entries/:date — update a specific entry

app.put('/api/entries/:date', (req, res) => {

  try {

    const data = readData();

    const idx = data.findIndex(r => r.date === req.params.date);

    if (idx < 0) return res.status(404).json({ error: 'Entry not found' });

    const updated = {

      date: req.params.date,

      weight_am: req.body.weight_am !== '' ? parseFloat(req.body.weight_am) || null : null,

      weight_pm: req.body.weight_pm !== '' ? parseFloat(req.body.weight_pm) || null : null,

      kcal: req.body.kcal !== '' ? parseInt(req.body.kcal) || null : null,

      details: req.body.details || '',

      exercise: req.body.exercise || null,

      kcal_burned: req.body.kcal_burned !== '' ? parseInt(req.body.kcal_burned) || null : null,

    };

    data[idx] = updated;

    writeData(data);

    res.json({ success: true, entry: updated });

  } catch (e) {

    res.status(500).json({ error: e.message });

  }

});



// DELETE /api/entries/:date

app.delete('/api/entries/:date', (req, res) => {

  try {

    const data = readData().filter(r => r.date !== req.params.date);

    writeData(data);

    res.json({ success: true });

  } catch (e) {

    res.status(500).json({ error: e.message });

  }

});



// POST /api/import — bulk upsert entries from CSV import
app.post('/api/import', (req, res) => {
  try {
    const { entries } = req.body;
    if (!Array.isArray(entries)) return res.status(400).json({ error: 'entries must be an array' });
    const data = readData();
    let imported = 0;
    for (const entry of entries) {
      if (!entry.date || !/^\d{4}-\d{2}-\d{2}$/.test(entry.date)) continue;
      const idx = data.findIndex(r => r.date === entry.date);
      if (idx >= 0) { data[idx] = entry; } else { data.push(entry); }
      imported++;
    }
    data.sort((a, b) => a.date.localeCompare(b.date));
    writeData(data);
    res.json({ success: true, imported });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});



// GET /api/export.csv

app.get('/api/export.csv', (req, res) => {

  const data = readData();

  const csv = [

    'DATE,WEIGHT_AM,WEIGHT_PM,DAY_TOTAL_KCAL,DETAILS,EXERCISE,KCAL_BURNED',

    ...data.map(r => [

      r.date,

      r.weight_am ?? '',

      r.weight_pm ?? '',

      r.kcal ?? '',

      `"${(r.details || '').replace(/"/g, '""')}"`,

      `"${(r.exercise || '').replace(/"/g, '""')}"`,

      r.kcal_burned ?? '',

    ].join(','))

  ].join('\n');

  res.setHeader('Content-Type', 'text/csv');

  res.setHeader('Content-Disposition', 'attachment; filename=health.csv');

  res.send(csv);

});



app.listen(PORT, '0.0.0.0', () => {

  console.log(`Health logger running on port ${PORT}`);

  console.log(`Data file: ${DATA_FILE}`);

  console.log(`Claude parsing: ${process.env.ANTHROPIC_API_KEY ? 'enabled' : 'disabled (using regex fallback)'}`);

});

