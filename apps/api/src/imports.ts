import { parse } from 'csv-parse/sync';
import { randomUUID } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { validateModel } from '../../../packages/engine/src/index.js';
import { DomainError } from './domain.js';
import { type State, canonical } from './store.js';
import { modelStructureIssues } from './validation.js';

export function validateFilename(name: any) {
  if (typeof name !== 'string' || name.length > 200 || /[\\/\x00-\x1f]/.test(name) || name === '.' || name === '..') throw new DomainError('invalid_filename', 'Nieprawidłowa nazwa pliku.');
  return name;
}
function inspectDocxZip(data: Buffer) {
  let end = -1;
  for (let i = data.length - 22; i >= Math.max(0, data.length - 65557); i--) if (data.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  if (end < 0) throw new DomainError('invalid_docx', 'Nieprawidłowy kontener DOCX.');
  const count = data.readUInt16LE(end + 10), centralSize = data.readUInt32LE(end + 12); let offset = data.readUInt32LE(end + 16), expanded = 0, actualExpanded = 0, document = false;
  const centralOffset=offset;
  if (count > 2000 || centralSize > data.length || offset + centralSize > data.length) throw new DomainError('unsafe_archive', 'Przekroczono limit archiwum.');
  for (let n = 0; n < count; n++) {
    if (offset + 46 > data.length || data.readUInt32LE(offset) !== 0x02014b50) throw new DomainError('invalid_docx', 'Uszkodzony indeks DOCX.');
    const flags = data.readUInt16LE(offset + 8), method=data.readUInt16LE(offset+10), compressedSize=data.readUInt32LE(offset+20), size = data.readUInt32LE(offset + 24), nameLength = data.readUInt16LE(offset + 28), extra = data.readUInt16LE(offset + 30), comment = data.readUInt16LE(offset + 32), localOffset=data.readUInt32LE(offset+42);
    const name = data.subarray(offset + 46, offset + 46 + nameLength).toString('utf8'); expanded += size;
    if (expanded > 24 * 1024 * 1024 || flags & 1 || name.startsWith('/') || name.includes('\\') || name.split('/').includes('..') || /vbaProject|externalLinks/i.test(name)) throw new DomainError('unsafe_archive', 'Archiwum zawiera niedozwoloną ścieżkę, makra lub przekracza limit.');
    if(localOffset+30>centralOffset||data.readUInt32LE(localOffset)!==0x04034b50||![0,8].includes(method))throw new DomainError('unsafe_archive','Nieobsługiwana metoda lub nieprawidłowy indeks archiwum.');
    const localNameLength=data.readUInt16LE(localOffset+26),localExtraLength=data.readUInt16LE(localOffset+28),contentOffset=localOffset+30+localNameLength+localExtraLength;
    if(contentOffset+compressedSize>centralOffset||data.subarray(localOffset+30,localOffset+30+localNameLength).toString('utf8')!==name)throw new DomainError('unsafe_archive','Niespójna ścieżka lub rozmiar wpisu archiwum.');
    try {
      const compressed=data.subarray(contentOffset,contentOffset+compressedSize),uncompressed=method===0?compressed:inflateRawSync(compressed,{maxOutputLength:Math.max(1,24*1024*1024-actualExpanded)});
      actualExpanded+=uncompressed.length;
      if(uncompressed.length!==size||actualExpanded>24*1024*1024)throw new Error('expanded_size_mismatch');
    }catch{throw new DomainError('unsafe_archive','Rzeczywisty rozmiar rozpakowanych danych jest niezgodny z indeksem lub przekracza limit.');}
    if (name === 'word/document.xml') document = true;
    offset += 46 + nameLength + extra + comment;
  }
  if (!document) throw new DomainError('invalid_docx', 'Brak tekstu dokumentu DOCX.');
}
export async function previewImport(state: State, payload: any) {
  const format = String(payload.format ?? 'json').toLowerCase();
  let model: any; let sourceText = ''; let manualRequired = false; const warnings: string[] = [];
  const filename = validateFilename(payload.filename ?? `import.${format}`);
  if (format === 'json') {
    try { model = payload.model ?? (typeof payload.content === 'string' ? JSON.parse(payload.content) : payload.content); } catch { throw new DomainError('invalid_json', 'Nieprawidłowy JSON.'); }
  } else if (format === 'csv') {
    if (typeof payload.content !== 'string' || payload.content.length > 2_000_000) throw new DomainError('invalid_csv', 'Nieprawidłowy CSV.');
    const rows: any[] = parse(payload.content, { columns: true, skip_empty_lines: true, bom: true, max_record_size: 100_000 });
    model = structuredClone(state.model);
    const target = payload.entity ?? 'services'; if (!['services','resources','dependencies','modes','procedures','verificationContracts'].includes(target)) throw new DomainError('invalid_entity', 'Nieobsługiwany rodzaj danych CSV.');
    const seen = new Set();
    const converted = rows.map(row => {
      if (!row.id || seen.has(row.id)) throw new DomainError('duplicate_id', 'CSV zawiera brakujące lub powtórzone identyfikatory.'); seen.add(row.id);
      const existing = model[target].find((x: any) => x.id === row.id) ?? {};
      for (const [key, value] of Object.entries(row)) {
        if (['minimum','priority','weight','toleratedOutageMinutes','quantity','version','capacity','setupMinutes','level','validityMinutes','autonomyMinutes'].includes(key)) { row[key] = Number(value); if (!Number.isFinite(row[key])) throw new DomainError('invalid_number', `Nieprawidłowa liczba: ${key}.`); }
        if (['inputs','skills','tags','steps','requirements','prerequisites','verifierRoles','provenance'].includes(key)) { try { row[key] = JSON.parse(String(value)); } catch { throw new DomainError('invalid_json_cell', `Kolumna ${key} wymaga JSON.`); } }
        if (['approved','mandatory','evidenceRequired','simulated'].includes(key)) row[key] = value === 'true';
      }
      return { ...existing, ...row };
    });
    for (const row of converted) { const index = model[target].findIndex((x: any) => x.id === row.id); if (index >= 0) model[target][index] = row; else model[target].push(row); }
  } else if (['pdf','docx','txt'].includes(format)) {
    const bytes = payload.base64 ? Buffer.from(payload.base64, 'base64') : Buffer.from(payload.content ?? '', 'utf8');
    if (bytes.length > 5 * 1024 * 1024) throw new DomainError('file_too_large', 'Limit dokumentu to 5 MiB.', 413);
    if (format === 'pdf') {
      if (bytes.subarray(0, 5).toString() !== '%PDF-') throw new DomainError('invalid_pdf', 'Plik nie jest dokumentem PDF.');
      const { PDFParse } = await import('pdf-parse'); const parser = new PDFParse({ data: bytes });
      try { const result = await parser.getText({ first: 100 }); sourceText = result.text; if (result.total > 100) warnings.push('Wyodrębniono pierwszych 100 stron; dokument wymaga przeglądu.'); } finally { await parser.destroy(); }
    } else if (format === 'docx') {
      inspectDocxZip(bytes); const mammoth = await import('mammoth'); sourceText = (await mammoth.extractRawText({ buffer: bytes })).value;
    } else sourceText = bytes.toString('utf8');
    sourceText = sourceText.slice(0, 200000); manualRequired = sourceText.trim().length === 0;
    return { id: randomUUID(), type: 'document-draft', format, filename, sourceText, fragments: sourceText.split(/\n\s*\n/).filter(Boolean).map((text, index) => ({ index: index + 1, source: filename, text })), manualRequired, warnings, published: false, instructions: 'Przepisz zweryfikowane pola do formularza modelu. Ekstrakcja pozostaje szkicem i nie zatwierdza procedury.' };
  } else return { id: randomUUID(), type: 'document-draft', format, filename, sourceText: '', fragments: [], manualRequired: true, warnings: ['Nieznany format. Wprowadź dane ręcznie.'], published: false };
  let validation;
  try { const issues = modelStructureIssues(model, true); validation = issues.length ? {valid:false,issues,warnings:[]} : validateModel(model); } catch { throw new DomainError('invalid_model', 'Brak wymaganej struktury modelu.'); }
  const differences = ['services','modes','resources','dependencies','procedures','verificationContracts'].flatMap(entity => {
    if (!Array.isArray(model?.[entity])) return [];
    return [...model[entity].filter((value: any) => value && canonical(value) !== canonical(state.model[entity]?.find((old: any) => old.id === value.id))).map((value: any) => ({ entity, id: value.id, change: state.model[entity]?.some((old: any) => old.id === value.id) ? 'changed' : 'added' })),...state.model[entity].filter((value:any)=>!model[entity].some((next:any)=>next?.id===value.id)).map((value:any)=>({entity,id:value.id,change:'removed'}))];
  });
  return { id: randomUUID(), type: 'model', format, filename, model, validation, differences, baseRevision: state.revision, warnings };
}
