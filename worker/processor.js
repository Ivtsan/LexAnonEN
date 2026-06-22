/**
 * processor.js — Web Worker
 * Performs heavy document processing off the UI thread.
 *
 * Message protocol:
 *   popup → worker:  { type:'PARSE',  buffer, filename, options:{enabledCategories} }
 *   popup → worker:  { type:'APPLY',  entities, mode, buffer, filename, exportMapping }
 *   popup → worker:  { type:'MARKUP', entities, buffer, filename }
 *
 *   worker → popup:  { type:'PROGRESS', percent, message }
 *   worker → popup:  { type:'ENTITIES', entities, stats }
 *   worker → popup:  { type:'RESULT',   buffer, mapping, filename }
 *   worker → popup:  { type:'ERROR',    message }
 */
'use strict';

importScripts(
  '../vendor/jszip.min.js',
  '../lib/validators.js',
  '../lib/entity-finder.js',
  '../lib/replacer.js',
  '../lib/docx-parser.js',
  '../lib/llm-enhancer.js'
);

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------

self.onmessage = async (e) => {
  const { type } = e.data;
  try {
    if (type === 'PARSE')  await handleParse(e.data);
    else if (type === 'APPLY')  await handleApply(e.data);
    else if (type === 'MARKUP') await handleMarkup(e.data);
  } catch (err) {
    self.postMessage({ type: 'ERROR', message: err.message || String(err) });
  }
};

// ---------------------------------------------------------------------------
// PARSE: open .docx and find entities
// ---------------------------------------------------------------------------

async function handleParse({ buffer, filename, options }) {
  progress(5, 'Opening file…');

  const { zip, parts } = await parseDocx(buffer);
  progress(20, 'Analysing document structure…');

  const enabledCategories = new Set(options.enabledCategories || Object.keys(CATEGORIES));
  const exclusionSet      = new Set((options.exclusionWords || []).map(w => w.trim().toLowerCase()).filter(Boolean));
  const customCats        = options.customCategories || [];
  const llmEnabled        = options.llmEnabled || false;
  const llmServerUrl      = options.llmServerUrl || '';
  const llmModel          = options.llmModel || '';

  // Register custom categories in CATEGORIES (needed by Replacer)
  for (const cat of customCats) {
    CATEGORIES[cat.key] = {
      label:       cat.label,
      placeholder: cat.placeholder || cat.label.toUpperCase().slice(0, 10),
      color:       cat.color || '#8B5CF6',
      defaultOn:   true,
    };
  }

  const allParas    = getAllParagraphs(parts);
  const fullDocText = getFullDocumentText(parts);

  progress(25, 'Scanning for party details block…');

  const { text: reqText } = detectRequisitesBlock(fullDocText);
  const knowledgeBase     = buildKnowledgeBase(reqText);

  progress(30, `Found ${knowledgeBase.persons.length} persons, ${knowledgeBase.companies.length} companies in party details`);

  const entities = [];
  let entityId   = 0;
  const total    = allParas.length;

  // ── Phase 1: Regex detection ──────────────────────────────────────────
  progress(35, 'Regex: detecting entities…');

  for (let i = 0; i < allParas.length; i++) {
    const para = allParas[i];
    if (!para.virtualText.trim()) continue;

    const builtinFound = findEntities(para.virtualText, enabledCategories, knowledgeBase);
    const customFound  = customCats.length > 0
      ? findCustomEntities(para.virtualText, customCats, enabledCategories)
      : [];
    const found = customFound.length > 0
      ? resolveOverlaps([...builtinFound, ...customFound])
      : builtinFound;

    for (const match of found) {
      if (exclusionSet.has(match.value.trim().toLowerCase())) continue;
      entities.push({
        id:              String(++entityId),
        partName:        para.partName,
        paraIdx:         para.paraIdx,
        paraText:        para.virtualText,
        start:           match.start,
        end:             match.end,
        category:        match.category,
        value:           match.value,
        replacementText: '',
        enabled:         true,
      });
    }

    if (i % 20 === 0) {
      const pct = 35 + Math.round((i / total) * 20);
      progress(pct, `Regex: paragraphs ${i + 1} / ${total}`);
    }
  }

  progress(55, `Regex found ${entities.length} entities`);

  // ── Phase 2: LLM enhancement (optional) ───────────────────────────────
  if (llmEnabled && llmServerUrl && llmModel) {
    progress(58, 'LLM: connecting to server…');

    const health = await llmHealthCheck(llmServerUrl);
    if (health.ok) {
      progress(60, 'LLM: analysing document…');

      const llmResult = await llmEnhanceEntities(
        llmServerUrl,
        llmModel,
        allParas,
        entities,
        enabledCategories,
        function (pct, msg) {
          progress(60 + Math.round(pct * 0.32), msg);
        }
      );

      // Filter exclusions and add to entities
      for (const llmEnt of llmResult.entities) {
        if (exclusionSet.has(llmEnt.value.trim().toLowerCase())) continue;
        llmEnt.id = String(++entityId);
        entities.push(llmEnt);
      }

      let llmMsg = `LLM found ${llmResult.entities.length} additional entities`;
      if (llmResult.errors > 0) llmMsg += ` (${llmResult.errors} chunks failed)`;
      progress(93, llmMsg);
    } else {
      progress(93, 'LLM server unreachable — using regex results only');
    }
  }

  // Re-sort by document order after merging
  entities.sort(function (a, b) {
    if (a.partName !== b.partName) return a.partName < b.partName ? -1 : 1;
    if (a.paraIdx !== b.paraIdx) return a.paraIdx - b.paraIdx;
    return a.start - b.start;
  });

  // Reassign sequential IDs
  for (let i = 0; i < entities.length; i++) {
    entities[i].id = String(i + 1);
  }

  // Pre-compute placeholders for preview
  const previewReplacer = new Replacer('placeholder');
  previewReplacer.precompute(entities);

  const stats = { total: entities.length, byCategory: {} };
  for (const e of entities) {
    stats.byCategory[e.category] = (stats.byCategory[e.category] || 0) + 1;
  }

  progress(100, 'Done');
  self.postMessage({ type: 'ENTITIES', entities, stats });
}

// ---------------------------------------------------------------------------
// APPLY: apply replacements and rebuild .docx
// ---------------------------------------------------------------------------

async function handleApply({ entities, mode, buffer, filename, exportMapping }) {
  progress(5, 'Opening file for processing…');

  const { zip, parts } = await parseDocx(buffer);
  progress(20, 'Applying replacements…');

  if (mode !== 'placeholder') {
    const r = new Replacer(mode);
    for (const entity of entities) {
      if (entity.enabled) {
        entity.replacementText = r.getReplacement(entity.value, entity.category);
      }
    }
  }

  progress(40, 'Rebuilding paragraphs…');
  await applyEntityReplacements(zip, parts, entities);

  progress(80, 'Packing file…');
  const resultBuffer = await serializeDocx(zip);

  let mapping = null;
  if (exportMapping) {
    mapping = {};
    for (const e of entities) {
      if (e.enabled && e.replacementText && mode === 'placeholder') {
        mapping[e.replacementText] = e.value;
      }
    }
  }

  const resultFilename = filename.replace(/\.docx$/i, '_anonymized.docx');
  progress(100, 'Done');
  self.postMessage({ type: 'RESULT', buffer: resultBuffer, mapping, filename: resultFilename });
}

// ---------------------------------------------------------------------------
// MARKUP: download original file with entity labels and light-green highlight
// ---------------------------------------------------------------------------

async function handleMarkup({ entities, buffer, filename }) {
  progress(5, 'Opening file for markup…');
  const { zip, parts } = await parseDocx(buffer);
  progress(30, 'Adding markup…');

  const markupEntities = entities
    .filter(e => e.enabled !== false)
    .map(e => ({
      ...e,
      replacementText: `⟪${(CATEGORIES[e.category] || {}).placeholder || e.category}: ${e.value}⟫`,
    }));

  // Light-green highlight for marked fragments
  await applyMarkupWithHighlights(zip, parts, markupEntities, '90EE90');
  progress(80, 'Packing file…');
  const resultBuffer   = await serializeDocx(zip);
  const resultFilename = filename.replace(/\.docx$/i, '_marked.docx');
  progress(100, 'Done');
  self.postMessage({ type: 'RESULT', buffer: resultBuffer, mapping: null, filename: resultFilename });
}

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function progress(percent, message) {
  self.postMessage({ type: 'PROGRESS', percent, message });
}
