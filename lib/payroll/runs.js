/* Mock payroll-run archive. Swap this module's internals for a real
   database query later (e.g. Postgres/Supabase) — api/payroll/list.js and
   the payroll-shell.html page never need to change, since they only depend
   on this function's return shape: an array of
   { id, monthLabel, uploadedAt, statusKey, fileUrl, attachments }, newest
   first. statusKey must match a key in payroll-shell.html's STATUS_CONFIG
   (keep the two in sync when adding a new status).

   Each run also carries an "attachments" list — one independent record per
   document type for that month (payroll sheet, invoice, receipt, ...).
   Adding a new attachment type later is just adding another object with
   the same shape: { key, label, statusKey, fileUrl, uploadedAt, note }. */
const RUNS = [
  {
    id: "2026-07",
    monthLabel: "يوليو 2026",
    uploadedAt: "2026-08-02",
    statusKey: "pending_invoice",
    fileUrl: "/payroll/2026-07.pdf",
    attachments: [
      { key: "payroll_sheet", label: "مسير الرواتب", statusKey: "attached", fileUrl: "/payroll/2026-07.pdf", uploadedAt: "2026-08-02", note: null },
      { key: "damanah_invoice", label: "فاتورة شركة ضمان", statusKey: "pending_upload", fileUrl: null, uploadedAt: null, note: "لم يتم رفع الفاتورة بعد." },
      { key: "payment_receipt", label: "إيصال السداد", statusKey: "pending_payment", fileUrl: null, uploadedAt: null, note: "لم يتم إرفاق إيصال السداد بعد." },
    ],
  },
  /* Add a new object here (same shape) for each new month's payroll run —
     the page and API need no changes; newest-first sorting is automatic. */
];

async function listPayrollRuns() {
  return [...RUNS].sort((a, b) => b.id.localeCompare(a.id));
}

async function getPayrollRunById(id) {
  return RUNS.find((r) => r.id === id) || null;
}

module.exports = { listPayrollRuns, getPayrollRunById };
