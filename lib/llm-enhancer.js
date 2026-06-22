/**
 * llm-enhancer.js
 * Enhances regex-based entity detection using a locally-hosted LLM (Ollama).
 * All requests stay within the firm's network — no data leaves the VPN.
 *
 * Depends on: entity-finder.js (resolveOverlaps must be available).
 */
'use strict';

const LLM_VALID_CATEGORIES = [
  'PERSON', 'COMPANY', 'SSN', 'TAXID', 'SWIFT', 'IBAN',
  'EMAIL', 'PHONE', 'URL', 'ADDRESS', 'CONTRACT', 'AMOUNT',
];

const LLM_SYSTEM_PROMPT = `You are a legal document anonymization assistant. Identify all personally identifiable information (PII) and sensitive entities in the provided text.

Return a JSON array of objects with:
- "text": the exact verbatim text from the input (must match exactly)
- "category": one of PERSON, COMPANY, SSN, TAXID, SWIFT, IBAN, EMAIL, PHONE, URL, ADDRESS, CONTRACT, AMOUNT

Rules:
- Only include text that appears verbatim in the input
- PERSON: full names (first + last at minimum), not single names or generic titles/roles
- COMPANY: company/organisation names, even without legal suffixes if context is clear
- ADDRESS: physical addresses, P.O. boxes, postcodes
- Do not include dates, generic legal terms, or section headings
- Return ONLY a valid JSON array, no commentary

If no entities found, return: []`;

// ---------------------------------------------------------------------------
// URL validation
// ---------------------------------------------------------------------------

function llmValidateUrl(url) {
  if (typeof url !== 'string') return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function llmBaseUrl(url) {
  return url.replace(/\/+$/, '');
}

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

/**
 * Checks if the LLM server is reachable and returns available models.
 * @param {string} serverUrl
 * @returns {Promise<{ok: boolean, models: string[], error: string}>}
 */
async function llmHealthCheck(serverUrl) {
  if (!llmValidateUrl(serverUrl)) {
    return { ok: false, models: [], error: 'Invalid URL' };
  }
  try {
    const resp = await fetch(`${llmBaseUrl(serverUrl)}/api/tags`, {
      method: 'GET',
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) return { ok: false, models: [], error: `Server returned ${resp.status}` };
    const data = await resp.json();
    const models = (data.models || []).map(m => m.name || m.model).filter(Boolean);
    return { ok: true, models, error: '' };
  } catch (err) {
    return { ok: false, models: [], error: err.message || 'Connection failed' };
  }
}

// ---------------------------------------------------------------------------
// LLM entity detection for a single text chunk
// ---------------------------------------------------------------------------

/**
 * Sends a text chunk to the LLM and returns entities found.
 * @param {string}      serverUrl - Ollama server base URL
 * @param {string}      model     - Model name (e.g. 'llama3.1:8b')
 * @param {string}      text      - Text to analyze
 * @param {Array}       existing  - Entities already found by regex [{value, category}]
 * @param {AbortSignal} [signal]  - Optional signal for cancellation
 * @returns {Promise<{entities: Array, error: string}>}
 */
async function llmDetectEntities(serverUrl, model, text, existing, signal) {
  let userMsg = `Identify all PII entities in this text:\n\n${text}`;

  if (existing.length > 0) {
    userMsg += '\n\nAlready found by automated rules (verify these and find any the rules missed):\n';
    const seen = new Set();
    for (const e of existing) {
      const key = `${e.value}::${e.category}`;
      if (seen.has(key)) continue;
      seen.add(key);
      userMsg += `- "${e.value}" (${e.category})\n`;
    }
  }

  // Combine external signal with per-request timeout
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 60000);
  if (signal) {
    signal.addEventListener('abort', () => controller.abort());
  }

  let resp;
  try {
    resp = await fetch(`${llmBaseUrl(serverUrl)}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: LLM_SYSTEM_PROMPT },
          { role: 'user',   content: userMsg },
        ],
        stream: false,
        options: { temperature: 0.1 },
      }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timeoutId);
    if (signal && signal.aborted) return { entities: [], error: 'cancelled' };
    return { entities: [], error: err.message || 'fetch failed' };
  }

  clearTimeout(timeoutId);

  if (!resp.ok) return { entities: [], error: `HTTP ${resp.status}` };

  let data;
  try { data = await resp.json(); } catch { return { entities: [], error: 'invalid JSON response' }; }

  const content = data?.message?.content || '';
  return { entities: llmParseResponse(content, text), error: '' };
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

/**
 * Extracts entity objects from the LLM's text response.
 * Handles markdown code fences, stray text around JSON, etc.
 */
function llmParseResponse(content, sourceText) {
  let jsonStr = content.trim();

  // Strip markdown code fences
  const fenced = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) jsonStr = fenced[1].trim();

  let parsed;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    // Try extracting a JSON array substring
    const m = jsonStr.match(/\[[\s\S]*\]/);
    if (!m) return [];
    try { parsed = JSON.parse(m[0]); } catch { return []; }
  }

  if (!Array.isArray(parsed)) return [];

  const results = [];
  const seen = new Set();   // dedup by "start::end::category"

  for (const item of parsed) {
    if (!item || typeof item.text !== 'string' || typeof item.category !== 'string') continue;
    if (!LLM_VALID_CATEGORIES.includes(item.category)) continue;

    // Find every occurrence in the source text
    let pos = 0;
    while (true) {
      const idx = sourceText.indexOf(item.text, pos);
      if (idx === -1) break;

      const key = `${idx}::${idx + item.text.length}::${item.category}`;
      if (!seen.has(key)) {
        seen.add(key);
        results.push({
          start:    idx,
          end:      idx + item.text.length,
          category: item.category,
          value:    item.text,
        });
      }
      pos = idx + item.text.length;
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Main enhancement pipeline
// ---------------------------------------------------------------------------

/**
 * Runs LLM-based entity detection across all paragraphs, then merges with
 * regex results. Paragraphs are batched into chunks (~1500 chars) so the
 * LLM gets enough context without exceeding reasonable prompt size.
 *
 * @param {string}      serverUrl         - Ollama base URL
 * @param {string}      model             - Model name
 * @param {Array}       allParas          - [{virtualText, partName, paraIdx}, ...]
 * @param {Array}       regexEntities     - Entities from regex pass
 * @param {Set}         enabledCategories
 * @param {Function}    progressCb        - function(percent, message)
 * @param {AbortSignal} [signal]          - Optional cancellation signal
 * @returns {Promise<{entities: Array, errors: number}>}
 */
async function llmEnhanceEntities(serverUrl, model, allParas, regexEntities, enabledCategories, progressCb, signal) {
  if (!llmValidateUrl(serverUrl)) return { entities: [], errors: 0 };

  // Index regex entities by paragraph key for fast lookup
  const regexByPara = Object.create(null);
  for (const e of regexEntities) {
    const k = `${e.partName}::${e.paraIdx}`;
    if (!regexByPara[k]) regexByPara[k] = [];
    regexByPara[k].push(e);
  }

  // Build chunks by batching consecutive paragraphs up to ~1500 chars
  const chunks = [];
  let cur = { text: '', paras: [], offsets: [] };

  for (const para of allParas) {
    const t = para.virtualText;
    if (!t || t.trim().length < 5) continue;

    if (cur.text.length > 0 && cur.text.length + t.length > 1500) {
      chunks.push(cur);
      cur = { text: '', paras: [], offsets: [] };
    }

    const offset = cur.text.length > 0 ? cur.text.length + 1 : 0;
    if (cur.text.length > 0) cur.text += '\n';
    cur.text += t;
    cur.paras.push(para);
    cur.offsets.push(offset);
  }
  if (cur.text.length > 0) chunks.push(cur);

  if (chunks.length === 0) return { entities: [], errors: 0 };

  let additional = [];
  let errorCount = 0;

  for (let ci = 0; ci < chunks.length; ci++) {
    // Check cancellation
    if (signal && signal.aborted) break;

    const chunk = chunks[ci];

    // Collect regex entities for paragraphs in this chunk
    const chunkExisting = [];
    for (const cpara of chunk.paras) {
      const ck = `${cpara.partName}::${cpara.paraIdx}`;
      if (regexByPara[ck]) {
        for (const re of regexByPara[ck]) chunkExisting.push(re);
      }
    }

    const result = await llmDetectEntities(serverUrl, model, chunk.text, chunkExisting, signal);
    if (result.error) {
      errorCount++;
      if (result.error === 'cancelled') break;
    }

    // Map each LLM entity back to its source paragraph
    for (const found of result.entities) {
      if (!enabledCategories.has(found.category)) continue;

      for (let mpi = 0; mpi < chunk.paras.length; mpi++) {
        const mpara     = chunk.paras[mpi];
        const paraStart = chunk.offsets[mpi];
        const paraEnd   = paraStart + mpara.virtualText.length;

        if (found.start >= paraStart && found.end <= paraEnd) {
          const adjStart = found.start - paraStart;
          const adjEnd   = found.end - paraStart;

          // Skip if overlapping with an existing regex entity in this paragraph
          const mk = `${mpara.partName}::${mpara.paraIdx}`;
          const existing = regexByPara[mk] || [];
          const overlaps = existing.some(e => !(adjEnd <= e.start || adjStart >= e.end));

          if (!overlaps) {
            additional.push({
              partName:        mpara.partName,
              paraIdx:         mpara.paraIdx,
              paraText:        mpara.virtualText,
              start:           adjStart,
              end:             adjEnd,
              category:        found.category,
              value:           found.value,
              replacementText: '',
              enabled:         true,
            });
          }
          break;
        }
      }
    }

    if (progressCb) {
      const pct = Math.round(((ci + 1) / chunks.length) * 100);
      let msg = `LLM analysis: chunk ${ci + 1} / ${chunks.length}`;
      if (errorCount > 0) msg += ` (${errorCount} failed)`;
      progressCb(pct, msg);
    }
  }

  // Resolve overlaps among LLM entities within each paragraph
  if (additional.length > 1) {
    const byPara = Object.create(null);
    for (const ent of additional) {
      const ak = `${ent.partName}::${ent.paraIdx}`;
      if (!byPara[ak]) byPara[ak] = [];
      byPara[ak].push(ent);
    }
    additional = [];
    for (const key of Object.keys(byPara)) {
      let paraEnts = byPara[key];
      if (paraEnts.length > 1) {
        paraEnts = resolveOverlaps(paraEnts);
      }
      for (const pe of paraEnts) additional.push(pe);
    }
  }

  return { entities: additional, errors: errorCount };
}
