import React, { useMemo, useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Upload, FileSpreadsheet, CheckCircle2, AlertTriangle, Loader2 } from 'lucide-react';
import { leads as leadsApi, type ImportResult } from '@/lib/api';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { normaliseLeadRecords, parseDelimited, spreadsheetMlToCsv, looksLikeSpreadsheetMl, type ParsedImport } from '@/lib/leadColumns';

// The server caps one request at ~6 MB / 5000 rows; we split larger files into chunks
// below that and send them in sequence, summing the counts.
// Both ceilings must hold per chunk: the server caps rows AND total characters, and a sheet
// with long notes/description columns blows the size limit long before the row limit.
const MAX_CHUNK_ROWS = 2000;
const MAX_CHUNK_CHARS = 5_500_000; // under the server's 6 MB
const MAX_FILE_BYTES = 40 * 1024 * 1024;

/**
 * CSV / TSV import with automatic dedup.
 *
 * The file is parsed here purely for the preview (which columns we recognised, how many
 * rows look usable); the server re-parses the raw text and owns every dedup decision, so
 * what a user sees as "will merge" can never disagree with what actually happens.
 */
export function ImportLeadsModal({
  open, onClose, onDone,
}: {
  open: boolean;
  onClose: () => void;
  /** Called after a successful commit so the list refetches. */
  onDone: (result: ImportResult) => void;
}) {
  const [fileName, setFileName] = useState('');
  const [text, setText] = useState('');
  const [parsed, setParsed] = useState<ParsedImport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [plan, setPlan] = useState<ImportResult | null>(null);
  const [progress, setProgress] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const reset = () => {
    setFileName(''); setText(''); setParsed(null); setError(null); setPlan(null);
    if (fileRef.current) fileRef.current.value = '';
  };

  const analyse = (name: string, contents: string) => {
    setFileName(name); setText(contents); setPlan(null); setError(null);
    try {
      const table = parseDelimited(contents);
      if (table.length < 2) { setError('Need a header row plus at least one data row.'); setParsed(null); return; }
      const p = normaliseLeadRecords(table);
      if (Object.keys(p.mapped).length === 0) {
        setError('None of the column headers matched a known field. Rename them to match our export, or use common names like Company, Job Title, Email.');
        setParsed(null); return;
      }
      if (p.records.length === 0) {
        setError('Headers were recognised but no row had a company, job title or contact.');
        setParsed(null); return;
      }
      setParsed(p);
    } catch (e: any) {
      setError(e?.message ?? 'Could not read that file');
      setParsed(null);
    }
  };

  const onFile = (f: File | undefined) => {
    if (!f) return reset();
    if (f.size > MAX_FILE_BYTES) {
      setError(`File is ${(f.size / 1048576).toFixed(1)} MB. Split it into smaller files (max ${MAX_FILE_BYTES / 1048576} MB).`);
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => setError('Could not read the file');
    reader.onload = () => {
      const bytes = new Uint8Array(reader.result as ArrayBuffer);
      // Native Excel workbooks (xlsx = zip, old .xls = OLE) are binary: they cannot be
      // parsed without a spreadsheet library, so say exactly what to do instead of
      // showing a confusing "no headers matched" error. Our own HireGen .xls export is
      // SpreadsheetML XML and imports directly (see below).
      if ((bytes[0] === 0x50 && bytes[1] === 0x4b) || (bytes[0] === 0xd0 && bytes[1] === 0xcf)) {
        setError('That is a native Excel workbook (.xlsx / .xls binary). Open it in Excel and Save As → CSV UTF-8, then import the CSV. Files exported from HireGen import directly.');
        return;
      }
      let contents = new TextDecoder().decode(bytes);
      if (looksLikeSpreadsheetMl(contents)) {
        try {
          contents = spreadsheetMlToCsv(contents);
        } catch {
          setError('That workbook has no readable Leads sheet. Export a fresh copy from HireGen, or save it as CSV UTF-8 first.');
          return;
        }
      }
      analyse(f.name, contents);
    };
    reader.readAsArrayBuffer(f);
  };

  /** Header line plus up to `size` data rows per request. */
  const chunkText = useMemo(() => {
    if (!text) return [] as string[];
    const table = parseDelimited(text);
    if (table.length < 2) return [];
    const header = table[0];
    const join = (rows: string[][]) => [header, ...rows].map((r) => r.map((c) => /[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c).join(',')).join('\r\n');
    const out: string[] = [];
    let cur: string[][] = [];
    let curLen = 0;
    const flush = () => { if (cur.length) { out.push(join(cur)); cur = []; curLen = 0; } };
    for (let i = 1; i < table.length; i++) {
      // +2 for the quotes/commas the joiner adds around each field
      const cost = table[i].reduce((a, c) => a + c.length + 2, 0);
      if (cur.length >= MAX_CHUNK_ROWS || (curLen + cost > MAX_CHUNK_CHARS && cur.length)) flush();
      cur.push(table[i]);
      curLen += cost;
    }
    flush();
    return out;
  }, [text]);

  const runChunks = async (dryRunFlag: boolean): Promise<ImportResult> => {
    const parts: ImportResult[] = [];
    // A big file is several sequential requests; without this the button reads
    // "Importing…" and looks frozen for the whole upload.
    setProgress('');
    for (let i = 0; i < chunkText.length; i++) {
      if (chunkText.length > 1) setProgress(`batch ${i + 1} of ${chunkText.length}`);
      parts.push(await leadsApi.importCsv({ csv: chunkText[i], dry_run: dryRunFlag }));
    }
    setProgress('');
    const sum = (k: keyof ImportResult) => parts.reduce((a, p) => a + (p[k] as number), 0);
    return {
      total_rows: sum('total_rows'), created: sum('created'), merged: sum('merged'),
      merged_fuzzy: sum('merged_fuzzy'), skipped: sum('skipped'),
      columns_mapped: parts[0]?.columns_mapped ?? {}, columns_ignored: parts[0]?.columns_ignored ?? [],
      errors: parts.flatMap((p) => p.errors),
    };
  };

  const dryRun = useMutation({
    mutationFn: () => runChunks(true),
    onSuccess: (r) => setPlan(r),
    onError: (e: any) => setError(readableError(e)),
  });

  const commit = useMutation({
    mutationFn: () => runChunks(false),
    onSuccess: (r) => { onDone(r); reset(); onClose(); },
    onError: (e: any) => setError(readableError(e)),
  });

  const mappedEntries = parsed ? Object.entries(parsed.mapped) : [];
  const sample = parsed?.records.slice(0, 5) ?? [];
  const sampleFields = useMemo(
    () => ['company_name', 'job_title', 'hr_name', 'hr_email', 'location', 'salary_range'].filter((f) => mappedEntries.some(([k]) => k === f)),
    [mappedEntries],
  );

  return (
    <Modal
      open={open}
      onClose={() => { if (!commit.isPending) { reset(); onClose(); } }}
      title="Import leads from CSV"
      description="Drop a CSV or TSV from another agency or your own sheet. Columns are matched by name and duplicates are merged automatically — re-importing an export merges onto the same leads via the Lead ID column, so nothing is ever imported twice."
      size="lg"
      footer={
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">
            {parsed ? `${parsed.records.length} usable rows · ${mappedEntries.length} columns matched${parsed.unmapped.length ? ` · ${parsed.unmapped.length} ignored` : ''}` : 'No file loaded'}
          </span>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => { reset(); onClose(); }} disabled={commit.isPending}>Close</Button>
            <Button variant="outline" onClick={() => dryRun.mutate()} disabled={!text || dryRun.isPending}>
              {dryRun.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
              {dryRun.isPending ? (progress ? `Checking ${progress}` : 'Checking…') : 'Check for duplicates'}
            </Button>
            <Button onClick={() => commit.mutate()} disabled={!parsed || commit.isPending}>
              {commit.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
              {commit.isPending ? (progress ? `Importing ${progress}` : 'Importing…') : `Import ${parsed?.records.length ?? 0} leads`}
            </Button>
          </div>
        </div>
      }
    >
      <div className="space-y-4">
        <label
          className="flex cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-input bg-muted/30 px-4 py-6 text-center transition-colors hover:border-primary hover:bg-primary-soft/40"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => { e.preventDefault(); onFile(e.dataTransfer.files?.[0]); }}
        >
          <input
            ref={fileRef} type="file" accept=".csv,.tsv,.txt,.xls,text/csv,text/plain" className="sr-only"
            aria-label="Choose CSV file" onChange={(e) => onFile(e.target.files?.[0] ?? undefined)}
          />
          <FileSpreadsheet className="h-6 w-6 text-muted-foreground" />
          <span className="text-sm font-medium">{fileName || 'Choose a .csv / .tsv / HireGen .xls file or drag it here'}</span>
          <span className="text-xs text-muted-foreground">
            Native Excel workbooks (.xlsx): save as CSV UTF-8 first. Exported HireGen files import straight back.
            {chunkText.length > 1 && ` Large files are sent in ${chunkText.length} batches.`}
          </span>
        </label>

        {error && (
          <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /><span>{error}</span>
          </div>
        )}

        {plan && (
          <div className="rounded-md border border-border bg-muted/30 p-3 text-sm">
            <p className="mb-2 font-medium">Dry run — nothing was written</p>
            <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs">
              <Stat label="New leads" value={plan.created} tone="ok" />
              <Stat label="Merged into existing" value={plan.merged} tone="warn" />
              <Stat label="Near-duplicates flagged" value={plan.merged_fuzzy} tone="warn" />
              <Stat label="Skipped" value={plan.skipped} tone={plan.skipped ? 'bad' : 'muted'} />
            </div>
          </div>
        )}

        {parsed && (
          <>
            <div>
              <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Detected columns</p>
              <div className="flex flex-wrap gap-1.5">
                {mappedEntries.map(([field, header]) => (
                  <Badge key={field} variant="secondary" className="font-normal">{header} → {field.replace(/_/g, ' ')}</Badge>
                ))}
                {parsed.unmapped.map((h) => (
                  <Badge key={h} variant="outline" className="font-normal text-muted-foreground line-through">{h}</Badge>
                ))}
              </div>
            </div>

            <div className="overflow-x-auto rounded-md border border-border">
              <table className="w-full text-left text-xs">
                <thead className="bg-muted/50">
                  <tr>{sampleFields.map((f) => <th key={f} className="whitespace-nowrap px-2.5 py-1.5 font-medium">{f.replace(/_/g, ' ')}</th>)}</tr>
                </thead>
                <tbody>
                  {sample.map((r, i) => (
                    <tr key={i} className="border-t border-border">
                      {sampleFields.map((f) => (
                        <td key={f} className="max-w-[220px] truncate px-2.5 py-1.5" title={r[f]}>{r[f] || '—'}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              {parsed.records.length > sample.length && (
                <p className="px-2.5 py-1.5 text-[11px] text-muted-foreground">+ {parsed.records.length - sample.length} more rows</p>
              )}
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone: 'ok' | 'warn' | 'bad' | 'muted' }) {
  const cls = { ok: 'text-success', warn: 'text-warning', bad: 'text-destructive', muted: 'text-muted-foreground' }[tone];
  return <span><b className={cls}>{value}</b> <span className="text-muted-foreground">{label}</span></span>;
}

/** Axios errors carry either { error } or Fastify's validation issues array. */
export function readableError(e: any): string {
  const data = e?.response?.data;
  if (typeof data === 'string') return data.slice(0, 300);
  if (data?.error) return String(data.error).slice(0, 300);
  if (Array.isArray(data?.details) && data.details[0]?.message) return data.details[0].message;
  return e?.message || 'Import failed';
}
