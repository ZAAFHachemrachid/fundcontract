import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { CalendarDays, ChevronLeft, ChevronRight, Download, Eye, FileText, Plus, X, LayoutDashboard, PackagePlus, Pencil, Printer, ReceiptText, Settings, UserPlus, UsersRound } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { DirectionProvider } from "@/components/ui/direction";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { contractCanAcceptAssignment, contractEndMonth, allocationMonths, allocationsForAssignment, monthsLeftAfter, orderLabel, type OrderLine, formatMoney, formatMonth, type Employee, type ItemAssignment, type VendorContract } from "@/lib/ledger";
import { loadLedger, saveAssignment, updateAssignment as persistAssignmentUpdate, saveContract, saveEmployee, saveExportRecord, updateContract as persistContractUpdate, type ExportHistoryRecord } from "@/lib/storage";

type Page = "overview" | "contracts" | "employees" | "items" | "exports";
type Locale = "en" | "ar";
type ExportRecord = ExportHistoryRecord;

// Official letterhead, always printed in Arabic regardless of the UI language.
const ORGANIZATION = {
  country: "الجمهورية الجزائرية الديمقراطية الشعبية",
  hierarchy: ["وزارة الفلاحة والتنمية الريفية والصيد البحري", "المديرية العامة للغابات", "محافظة الغابات أدرار", "لجنة الخدمات الاجتماعية"],
  purpose: "اقتطاع",
};

const text = (locale: Locale, english: string, arabic: string) => locale === "ar" ? arabic : english;
const planLabel = (locale: Locale, paymentMonths: number | null) => paymentMonths === 0 ? text(locale, "Paid now", "دفع فوري") : paymentMonths === null ? text(locale, "Until contract end", "حتى نهاية العقد") : text(locale, `${paymentMonths} months`, `${paymentMonths} أشهر`);
const monthLabel = (locale: Locale, month: string) => new Intl.DateTimeFormat(locale === "ar" ? "ar" : "en", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${month}-01T00:00:00Z`));
// A period is "YYYY-MM" (one month) or "YYYY-MM_YYYY-MM" (inclusive range). Export history stores it in its month column.
type Period = string;
const periodBounds = (period: Period): [string, string] => { const [from, to = from] = period.split("_"); return [from, to]; };
const periodLabel = (locale: Locale, period: Period) => { const [from, to] = periodBounds(period); return from === to ? monthLabel(locale, from) : `${monthLabel(locale, from)} → ${monthLabel(locale, to)}`; };
const inPeriod = (month: string, period: Period) => { const [from, to] = periodBounds(period); return month >= from && month <= to; };
const periodSlug = (period: Period) => period.replace("_", "_to_");

const seedContracts: VendorContract[] = [
  { id: "contract-atlas", vendor: "Atlas Electronics", name: "Workplace equipment agreement", reference: "ATL-2026-01", startDate: "2026-01-01", durationMonths: 24, currency: "DZD", status: "Active" },
  { id: "contract-nova", vendor: "Nova Office Supply", name: "Office tools agreement", reference: "NOV-2026-02", startDate: "2026-01-01", durationMonths: 12, currency: "DZD", status: "Active" },
];

const seedEmployees: Employee[] = [
  { id: "employee-amina", name: "Amina Morgan", accountCode: "OPS-140" },
  { id: "employee-julien", name: "Julien Chen", accountCode: "FIN-220" },
];

const seedAssignments: ItemAssignment[] = [
  { id: "item-workstation", contractId: "contract-atlas", employeeId: "employee-amina", lines: [{ name: "Design workstation", quantity: 1 }], totalCents: 1_000_000, paymentMonths: null, takenDate: "2026-06-12", reference: "ATL-4418", note: "Design team replacement" },
  { id: "item-tablet", contractId: "contract-nova", employeeId: "employee-julien", lines: [{ name: "Field tablet", quantity: 2 }], totalCents: 240_000, paymentMonths: null, takenDate: "2026-04-08", reference: "NOV-1902", note: "Issued for field inspections" },
];

function useStoredState<T>(key: string, initialValue: T) {
  const [value, setValue] = useState<T>(() => {
    try {
      const saved = localStorage.getItem(key);
      return saved ? JSON.parse(saved) as T : initialValue;
    } catch {
      return initialValue;
    }
  });
  useEffect(() => { localStorage.setItem(key, JSON.stringify(value)); }, [key, value]);
  return [value, setValue] as const;
}

function csvEscape(value: string | number) {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

async function saveCsv(fileName: string, columns: string[], rows: (string | number)[][]) {
  // BOM so Excel opens UTF-8 (Arabic names) correctly.
  const contents = "﻿" + [columns, ...rows].map((row) => row.map(csvEscape).join(",")).join("\r\n");
  if ("__TAURI_INTERNALS__" in window) return invoke<string>("save_export", { fileName, contents });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([contents], { type: "text/csv;charset=utf-8" }));
  link.download = fileName;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  return fileName;
}

const amount = (cents: number) => (cents / 100).toFixed(2);

async function printStatement(fileName: string) {
  const previousTitle = document.title;
  document.title = fileName;
  try {
    if ("__TAURI_INTERNALS__" in window) await invoke("print_window");
    else window.print();
  } catch {
    window.print();
  } finally {
    document.title = previousTitle;
  }
}

function App() {
  const [page, setPage] = useState<Page>("overview");
  // Lives here so the Overview vendor cards can open Exports already filtered to one contract.
  const [exportContract, setExportContract] = useState("all");
  const [locale, setLocale] = useStoredState<Locale>("fundcontract-locale", "en");
  const direction = locale === "ar" ? "rtl" : "ltr";
  const [month, setMonth] = useStoredState("fundcontract-month", new Date().toISOString().slice(0, 7));
  // Range mode is shared by the Overview vendor cards and the Exports page, so "Export this vendor" keeps the range.
  const [rangeMode, setRangeMode] = useState(false);
  const [rangeFrom, setRangeFrom] = useState(month);
  const [rangeTo, setRangeTo] = useState(month);
  const period: Period = rangeMode ? (rangeFrom <= rangeTo ? `${rangeFrom}_${rangeTo}` : `${rangeTo}_${rangeFrom}`) : month;
  const periodState: PeriodState = { month, setMonth, rangeMode, setRangeMode, rangeFrom, setRangeFrom, rangeTo, setRangeTo };
  const [contracts, setContracts] = useState<VendorContract[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [assignments, setAssignments] = useState<ItemAssignment[]>([]);
  const [history, setHistory] = useState<ExportRecord[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [contractOpen, setContractOpen] = useState(false);
  const [editingContract, setEditingContract] = useState<VendorContract | null>(null);
  const [employeeOpen, setEmployeeOpen] = useState(false);
  const [itemOpen, setItemOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<ItemAssignment | null>(null);
  const [message, setMessage] = useState("");


  useEffect(() => {
    let active = true;
    // Demo data only in dev; a release build starts with an empty database.
    void loadLedger(import.meta.env.DEV ? { contracts: seedContracts, employees: seedEmployees, assignments: seedAssignments } : { contracts: [], employees: [], assignments: [] })
      .then((data) => {
        if (!active) return;
        setContracts(data.contracts);
        setEmployees(data.employees);
        setAssignments(data.assignments);
        setHistory(data.history);
      })
      .catch(() => {
        if (active) setMessage(text(locale, "Unable to open the local database. Your changes will not be saved.", "تعذّر فتح قاعدة البيانات المحلية. لن يتم حفظ التغييرات."));
      })
      .finally(() => { if (active) setIsLoading(false); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    document.documentElement.dir = direction;
    document.documentElement.lang = locale;
  }, [direction, locale]);

  const contractById = useMemo(() => new Map(contracts.map((contract) => [contract.id, contract])), [contracts]);
  const employeeById = useMemo(() => new Map(employees.map((employee) => [employee.id, employee])), [employees]);
  const allocations = useMemo(() => assignments.flatMap((assignment) => {
    const contract = contractById.get(assignment.contractId);
    return contract ? allocationsForAssignment(assignment, contract) : [];
  }), [assignments, contractById]);
  const allDueRows: DueRow[] = useMemo(() => allocations.map((allocation) => ({
    ...allocation,
    item: assignments.find((assignment) => assignment.id === allocation.assignmentId)!,
    contract: contractById.get(allocation.contractId)!,
    employee: employeeById.get(allocation.employeeId)!,
  })), [allocations, assignments, contractById, employeeById]);
  const dueRows = allDueRows.filter((row) => row.month === month);
  const periodRows = allDueRows.filter((row) => inPeriod(row.month, period));

  const totals = {
    due: dueRows.reduce((sum, row) => sum + row.amountCents, 0),
    active: contracts.filter((contract) => contract.status === "Active").length,
    assigned: assignments.length,
    people: employees.length,
  };

  const addExportRecord = (kind: string, subject: string, rows: DueRow[], recordPeriod: Period) => {
    const record: ExportRecord = { id: crypto.randomUUID(), kind, subject, month: recordPeriod, rowCount: rows.length, createdAt: new Date().toISOString(), snapshot: rows };
    setHistory((records) => [record, ...records]);
    void saveExportRecord(record).catch(() => setMessage(text(locale, "The statement was created, but could not be saved to SQLite.", "تم إنشاء البيان، ولكن تعذّر حفظه في SQLite.")));
  };

  const addContract = (contract: VendorContract) => {
    setContracts((current) => [...current, contract]);
    setContractOpen(false);
    setMessage(text(locale, "Contract created.", "تم إنشاء العقد."));
    void saveContract(contract).catch(() => setMessage(text(locale, "The contract was added, but could not be saved to SQLite.", "تمت إضافة العقد، ولكن تعذّر حفظه في SQLite.")));
  };

  const editContract = (contract: VendorContract) => {
    setContracts((current) => current.map((entry) => entry.id === contract.id ? contract : entry));
    setEditingContract(null);
    setMessage(text(locale, "Contract updated.", "تم تحديث العقد."));
    void persistContractUpdate(contract).catch(() => setMessage(text(locale, "The contract was updated, but could not be saved to SQLite.", "تم تحديث العقد، ولكن تعذّر حفظه في SQLite.")));
  };

  const addEmployee = (employee: Employee) => {
    setEmployees((current) => [...current, employee]);
    setEmployeeOpen(false);
    setMessage(text(locale, "Employee created.", "تم إنشاء الموظف."));
    void saveEmployee(employee).catch(() => setMessage(text(locale, "The employee was added, but could not be saved to SQLite.", "تمت إضافة الموظف، ولكن تعذّر حفظه في SQLite.")));
  };

  const addItem = (item: ItemAssignment) => {
    setAssignments((current) => [...current, item]);
    setItemOpen(false);
    setMessage(text(locale, "Item assigned and monthly allocations created.", "تم تخصيص العنصر وإنشاء التوزيعات الشهرية."));
    void saveAssignment(item).catch(() => setMessage(text(locale, "The item was assigned, but could not be saved to SQLite.", "تم تخصيص العنصر، ولكن تعذّر حفظه في SQLite.")));
  };

  const editItem = (item: ItemAssignment) => {
    setAssignments((current) => current.map((entry) => entry.id === item.id ? item : entry));
    setEditingItem(null);
    setMessage(text(locale, "Order updated and payments rescheduled.", "تم تحديث الطلب وإعادة جدولة الدفعات."));
    void persistAssignmentUpdate(item).catch(() => setMessage(text(locale, "The order was updated, but could not be saved to SQLite.", "تم تحديث الطلب، ولكن تعذّر حفظه في SQLite.")));
  };

  const runExport = async ({ format, rows, subject, period: exportPeriod }: ExportRequest) => {
    const fileName = subject === "All" ? `statement-${periodSlug(exportPeriod)}` : `statement-${periodSlug(exportPeriod)}-${subject.replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "")}`;
    const kind = `Statement ${format}`;
    const total = rows.reduce((sum, row) => sum + row.amountCents, 0);
    if (format === "PDF") {
      addExportRecord(kind, subject, rows, exportPeriod);
      return printStatement(fileName);
    }
    // Same sections as the paper: each vendor's workers, then that vendor's subtotal.
    const body = statementGroups(statementLines(rows)).flatMap((group) => [
      ...group.lines.map((line) => [group.vendor, line.name, amount(line.amountCents)]),
      [group.vendor, "Subtotal", amount(group.lines.reduce((sum, line) => sum + line.amountCents, 0))],
    ]);
    try {
      const savedTo = await saveCsv(`${fileName}.csv`, ["Vendor", "Name", "Amount owed (دج)"], [...body, ["", "Total", amount(total)]]);
      addExportRecord(kind, subject, rows, exportPeriod);
      setMessage(text(locale, `Excel file saved: ${savedTo}`, `تم حفظ ملف Excel: ${savedTo}`));
    } catch (error) {
      setMessage(text(locale, `Could not save the Excel file: ${error}`, `تعذّر حفظ ملف Excel: ${error}`));
    }
  };



  return (
    <DirectionProvider direction={direction}>
    <div className="app-shell min-h-svh bg-emerald-50/60 text-emerald-950" dir={direction} lang={locale}>
      <a href="#main-content" className="sr-only focus:not-sr-only focus:absolute focus:start-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-emerald-800 focus:px-3 focus:py-2 focus:text-white">{text(locale, "Skip to main content", "انتقل إلى المحتوى الرئيسي")}</a>
      <div className="flex min-h-svh">
        <aside className="hidden w-64 shrink-0 flex-col border-e border-emerald-900/20 bg-emerald-950 px-3 py-4 text-emerald-50 md:flex" aria-label={text(locale, "Primary navigation", "التنقل الرئيسي")}>
          <div className="flex h-10 items-center gap-2 px-2"><img src="/logo.svg" alt="" className="size-7" /><span className="text-sm font-semibold tracking-tight">H47 Ledger</span></div>
          <nav className="mt-8 flex flex-1 flex-col gap-1" aria-label={text(locale, "Workspace", "مساحة العمل")}>
            <NavButton label={text(locale, "Overview", "نظرة عامة")} icon={LayoutDashboard} active={page === "overview"} onClick={() => setPage("overview")} />
            <NavButton label={text(locale, "Contracts", "العقود")} icon={FileText} active={page === "contracts"} onClick={() => setPage("contracts")} />
            <NavButton label={text(locale, "Employees", "الموظفون")} icon={UsersRound} active={page === "employees"} onClick={() => setPage("employees")} />
            <NavButton label={text(locale, "Items", "العناصر")} icon={PackagePlus} active={page === "items"} onClick={() => setPage("items")} />
            <NavButton label={text(locale, "Exports", "التصدير")} icon={ReceiptText} active={page === "exports"} onClick={() => setPage("exports")} />
            <NavButton label={text(locale, "Settings", "الإعدادات")} icon={Settings} active={false} onClick={() => setMessage(text(locale, "Settings are the next module to add.", "الإعدادات هي الوحدة التالية التي سنضيفها."))} />
          </nav>
          <p className="rounded-xl border border-emerald-800 bg-emerald-900/60 p-3 text-xs leading-5 text-emerald-100">{text(locale, "Costs start in the month after an item is taken and are spread through the final contract month.", "تبدأ التكلفة في الشهر التالي لاستلام العنصر وتوزّع حتى الشهر الأخير من العقد.")}</p>
        </aside>

        <div className="min-w-0 flex-1">
          <header className="flex min-h-16 items-center justify-between gap-3 border-b border-emerald-100 bg-white/90 px-4 py-3 backdrop-blur sm:px-7"><div><p className="text-sm font-semibold text-emerald-950" lang="ar">{ORGANIZATION.hierarchy[3]}</p><p className="text-xs text-emerald-700" lang="ar">{ORGANIZATION.hierarchy[2]}</p></div><div className="flex flex-wrap items-center justify-end gap-2"><Button variant="ghost" size="sm" onClick={() => setLocale(locale === "en" ? "ar" : "en")}>{locale === "en" ? "العربية" : "English"}</Button><Dialog open={contractOpen} onOpenChange={setContractOpen}><DialogTrigger render={<Button variant="outline" size="sm" disabled={isLoading} />}><FileText className="size-4" aria-hidden="true" />{text(locale, "Contract", "عقد")}</DialogTrigger><ContractForm locale={locale} assignments={assignments} onSave={addContract} /></Dialog><Dialog open={employeeOpen} onOpenChange={setEmployeeOpen}><DialogTrigger render={<Button variant="outline" size="sm" disabled={isLoading} />}><UserPlus className="size-4" aria-hidden="true" />{text(locale, "Employee", "موظف")}</DialogTrigger><EmployeeForm locale={locale} onAdd={addEmployee} /></Dialog><Dialog open={itemOpen} onOpenChange={setItemOpen}><DialogTrigger render={<Button size="sm" disabled={isLoading} />}><PackagePlus className="size-4" aria-hidden="true" />{text(locale, "New order", "طلب جديد")}</DialogTrigger><ItemForm locale={locale} contracts={contracts} employees={employees} onSave={addItem} /></Dialog></div></header>

          <main id="main-content" className="px-4 py-6 sm:px-7 sm:py-8"><div className="mx-auto max-w-6xl">
            {isLoading && <div role="status" className="mb-5 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900 shadow-sm">{text(locale, "Opening your local SQLite database…", "يتم فتح قاعدة بيانات SQLite المحلية…")}</div>}
            {message && <div role="status" className="mb-5 flex items-center justify-between gap-3 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900 shadow-sm"><span>{message}</span><Button variant="ghost" size="sm" onClick={() => setMessage("")}>{text(locale, "Dismiss", "إغلاق")}</Button></div>}
            {page === "overview" && <Overview locale={locale} month={month} setMonth={setMonth} totals={totals} dueRows={dueRows} period={period} periodRows={periodRows} periodState={periodState} onExportVendor={(contractId) => { setExportContract(contractId); setPage("exports"); }} />}
            {page === "contracts" && <ContractsPage locale={locale} contracts={contracts} onEdit={setEditingContract} />}
            {page === "employees" && <EmployeesPage locale={locale} employees={employees} />}
            {page === "items" && <ItemsPage locale={locale} assignments={assignments} contracts={contractById} employees={employeeById} onEdit={setEditingItem} />}
            {page === "exports" && <ExportsPage locale={locale} direction={direction} period={period} periodRows={periodRows} periodState={periodState} contractFilter={exportContract} setContractFilter={setExportContract} contracts={contracts} history={history} onExport={(request) => void runExport(request)} />}
          </div></main>
          <Dialog open={Boolean(editingItem)} onOpenChange={(open) => { if (!open) setEditingItem(null); }}>
            {editingItem && <ItemForm locale={locale} item={editingItem} contracts={contracts} employees={employees} onSave={editItem} />}
          </Dialog>
          <Dialog open={Boolean(editingContract)} onOpenChange={(open) => { if (!open) setEditingContract(null); }}>
            {editingContract && <ContractForm locale={locale} contract={editingContract} assignments={assignments} onSave={editContract} />}
          </Dialog>
        </div>
      </div>
    </div>
    </DirectionProvider>
  );
}

function NavButton({ label, icon: Icon, active, onClick }: { label: string; icon: typeof LayoutDashboard; active: boolean; onClick: () => void }) {
  return <button type="button" aria-current={active ? "page" : undefined} onClick={onClick} className={`flex h-10 items-center gap-3 rounded-lg px-3 text-start text-sm transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-200 ${active ? "bg-emerald-400 font-medium text-emerald-950 shadow-sm" : "text-emerald-100 hover:bg-emerald-900 hover:text-white"}`}><Icon className="size-4" aria-hidden="true" />{label}</button>;
}

// Built from plain selects: <input type="month"> is not editable in the Linux WebKitGTK webview.
const MONTH_NAMES_AR = ["جانفي", "فيفري", "مارس", "أفريل", "ماي", "جوان", "جويلية", "أوت", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر"];
function MonthSelect({ locale, value, onChange, label }: { locale: Locale; value: string; onChange: (value: string) => void; label: string }) {
  const now = new Date();
  const match = /^(\d{4})-(\d{2})$/.exec(value);
  const year = match ? Number(match[1]) : now.getFullYear();
  const monthNumber = match ? Number(match[2]) : now.getMonth() + 1;
  const set = (nextYear: number, nextMonth: number) => onChange(`${nextYear}-${String(nextMonth).padStart(2, "0")}`);
  const shift = (delta: number) => { const index = year * 12 + monthNumber - 1 + delta; set(Math.floor(index / 12), (index % 12) + 1); };
  const firstYear = Math.min(year, now.getFullYear() - 5);
  const lastYear = Math.max(year, now.getFullYear() + 5);
  const years = Array.from({ length: lastYear - firstYear + 1 }, (_, index) => firstYear + index);
  const monthName = (index: number) => locale === "ar" ? MONTH_NAMES_AR[index] : new Intl.DateTimeFormat("en", { month: "long", timeZone: "UTC" }).format(new Date(Date.UTC(2000, index, 1)));
  const arrow = "flex h-full items-center px-1.5 text-emerald-700 hover:bg-emerald-50 hover:text-emerald-950";
  return <div role="group" aria-label={label} className="flex h-8 items-stretch overflow-hidden rounded-md border border-emerald-200 bg-white text-sm text-emerald-950">
    <button type="button" className={arrow} onClick={() => shift(-1)} aria-label={text(locale, "Previous month", "الشهر السابق")}><ChevronLeft className="size-4 rtl:rotate-180" aria-hidden="true" /></button>
    <select aria-label={text(locale, "Month", "الشهر")} value={monthNumber} onChange={(event) => set(year, Number(event.target.value))} className="cursor-pointer bg-transparent px-1 outline-none">{Array.from({ length: 12 }, (_, index) => <option key={index} value={index + 1}>{monthName(index)}</option>)}</select>
    <select aria-label={text(locale, "Year", "السنة")} value={year} onChange={(event) => set(Number(event.target.value), monthNumber)} className="cursor-pointer bg-transparent px-1 outline-none">{years.map((option) => <option key={option} value={option}>{option}</option>)}</select>
    <button type="button" className={arrow} onClick={() => shift(1)} aria-label={text(locale, "Next month", "الشهر التالي")}><ChevronRight className="size-4 rtl:rotate-180" aria-hidden="true" /></button>
  </div>;
}
function MonthPicker({ locale, month, setMonth }: { locale: Locale; month: string; setMonth: (value: string) => void }) {
  return <div className="flex items-center gap-2 text-sm text-emerald-800"><CalendarDays className="size-4" aria-hidden="true" /><MonthSelect locale={locale} value={month} onChange={setMonth} label={text(locale, "Statement month", "شهر البيان")} /></div>;
}

type VendorDue = { contract: VendorContract; rows: DueRow[]; amountCents: number; workers: number; orders: number };
function vendorDues(rows: DueRow[]): VendorDue[] {
  const byContract = new Map<string, DueRow[]>();
  for (const row of rows) byContract.set(row.contractId, [...(byContract.get(row.contractId) ?? []), row]);
  return [...byContract.values()].map((group) => ({
    contract: group[0].contract,
    rows: group,
    amountCents: group.reduce((sum, row) => sum + row.amountCents, 0),
    workers: workerCount(group),
    orders: new Set(group.map((row) => row.assignmentId)).size,
  })).sort((a, b) => b.amountCents - a.amountCents);
}

type PeriodState = { month: string; setMonth: (value: string) => void; rangeMode: boolean; setRangeMode: (value: boolean) => void; rangeFrom: string; setRangeFrom: (value: string) => void; rangeTo: string; setRangeTo: (value: string) => void };
// Month / range switch. showMonth adds the single-month picker for pages that have none elsewhere.
function PeriodControl({ locale, state, showMonth }: { locale: Locale; state: PeriodState; showMonth: boolean }) {
  const modeButton = (range: boolean, label: string) => <button type="button" aria-pressed={state.rangeMode === range} onClick={() => state.setRangeMode(range)} className={`h-7 rounded-md px-3 text-xs font-medium transition-colors ${state.rangeMode === range ? "bg-white text-emerald-950 shadow-sm" : "text-emerald-800 hover:text-emerald-950"}`}>{label}</button>;
  const monthField = (label: string, value: string, onChange: (value: string) => void) => <div className="flex items-center gap-1.5 text-xs text-emerald-700"><span>{label}</span><MonthSelect locale={locale} value={value} onChange={onChange} label={label} /></div>;
  return <div className="flex flex-wrap items-center gap-2"><div role="group" className="flex gap-1 rounded-lg bg-emerald-100/70 p-1">{modeButton(false, text(locale, "One month", "شهر واحد"))}{modeButton(true, text(locale, "Range", "فترة"))}</div>
    {state.rangeMode ? <>{monthField(text(locale, "From", "من"), state.rangeFrom, state.setRangeFrom)}{monthField(text(locale, "To", "إلى"), state.rangeTo, state.setRangeTo)}</> : showMonth && <MonthPicker locale={locale} month={state.month} setMonth={state.setMonth} />}</div>;
}

// Collapse one order's monthly payments inside a range into a single line carrying the range total.
function sumByOrder(rows: DueRow[]): DueRow[] {
  const byOrder = new Map<string, DueRow>();
  for (const row of rows) {
    const existing = byOrder.get(row.assignmentId);
    byOrder.set(row.assignmentId, existing ? { ...existing, amountCents: existing.amountCents + row.amountCents } : { ...row });
  }
  return [...byOrder.values()];
}

// What the organisation owes each vendor in the selected month, or across a month range; a card opens that vendor's lines.
function VendorDueSection({ locale, period, rows, periodState, onExportVendor }: { locale: Locale; period: Period; rows: DueRow[]; periodState: PeriodState; onExportVendor: (contractId: string) => void }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const isRange = periodState.rangeMode;
  const dues = vendorDues(rows);
  const grandTotal = dues.reduce((sum, due) => sum + due.amountCents, 0);
  const open = dues.find((due) => due.contract.id === openId);
  const label = periodLabel(locale, period);
  return <section className="mt-8" aria-label={text(locale, "Owed per vendor", "المستحق لكل مورد")}>
    <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-base font-semibold text-emerald-950">{text(locale, "What we owe each vendor", "ما ندين به لكل مورد")} · {label}</h2>{dues.length > 0 && <p className="mt-0.5 text-sm text-emerald-800">{dues.length} {text(locale, "vendors", "موردين")} · <span className="font-semibold text-emerald-950">{formatMoney(grandTotal)}</span></p>}</div>
      <PeriodControl locale={locale} state={periodState} showMonth={false} /></div>
    {dues.length === 0 ? <p className="mt-3 rounded-xl border border-dashed border-emerald-200 px-4 py-8 text-center text-sm text-emerald-700">{isRange ? text(locale, "Nothing is owed to any vendor in this range.", "لا يوجد مبلغ مستحق لأي مورد في هذه الفترة.") : text(locale, "Nothing is owed to any vendor this month.", "لا يوجد مبلغ مستحق لأي مورد هذا الشهر.")}</p> : <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{dues.map((due) => { const exactShare = grandTotal > 0 ? (due.amountCents / grandTotal) * 100 : 0; const share = Math.round(exactShare); const shareLabel = exactShare > 0 && share === 0 ? "<1" : String(share); return <button key={due.contract.id} type="button" onClick={() => setOpenId(due.contract.id)} className="group rounded-xl border border-emerald-100 bg-white p-4 text-start shadow-sm shadow-emerald-950/5 transition hover:border-emerald-300 hover:shadow-md focus-visible:ring-2 focus-visible:ring-emerald-600 focus-visible:outline-none">
      <div className="flex items-start justify-between gap-3"><div className="min-w-0"><p className="truncate font-semibold text-emerald-950">{due.contract.vendor}</p><p className="truncate text-xs text-emerald-700">{due.contract.reference} · {text(locale, "ends", "ينتهي")} {formatMonth(contractEndMonth(due.contract))}</p></div><Eye className="size-4 shrink-0 text-emerald-600 opacity-60 group-hover:opacity-100" aria-hidden="true" /></div>
      <p className="mt-3 text-xl font-semibold tracking-tight text-emerald-950">{formatMoney(due.amountCents)}</p>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-emerald-100" aria-hidden="true"><div className="h-full rounded-full bg-emerald-600" style={{ width: `${Math.max(share, 2)}%` }} /></div>
      <p className="mt-2 text-xs text-emerald-700">{shareLabel}% {isRange ? text(locale, "of the range", "من الفترة") : text(locale, "of the month", "من الشهر")} · {due.workers} {text(locale, "workers", "عمال")} · {due.orders} {text(locale, "orders", "طلبات")}</p>
    </button>; })}</div>}
    <Dialog open={open !== undefined} onOpenChange={(value) => { if (!value) setOpenId(null); }}>{open && <DialogContent className="max-h-[92svh] overflow-y-auto sm:max-w-4xl"><DialogHeader><DialogTitle>{open.contract.vendor} · {label}</DialogTitle><DialogDescription>{open.contract.name} · {open.contract.reference} · {text(locale, "owed", "المستحق")} <span className="font-semibold text-emerald-950">{formatMoney(open.amountCents)}</span></DialogDescription></DialogHeader>
      <AllocationTable locale={locale} rows={isRange ? sumByOrder(open.rows) : open.rows} amountLabel={isRange ? text(locale, "In range", "في الفترة") : undefined} />
      <DialogFooter><Button onClick={() => { setOpenId(null); onExportVendor(open.contract.id); }}><Download className="size-4" aria-hidden="true" />{text(locale, "Export this vendor", "تصدير هذا المورد")}</Button></DialogFooter></DialogContent>}</Dialog>
  </section>;
}

function Overview({ locale, month, setMonth, totals, dueRows, period, periodRows, periodState, onExportVendor }: { locale: Locale; month: string; setMonth: (value: string) => void; totals: { due: number; active: number; assigned: number; people: number }; dueRows: DueRow[]; period: Period; periodRows: DueRow[]; periodState: PeriodState; onExportVendor: (contractId: string) => void }) {
  return <><div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end"><div><p className="text-sm font-medium text-emerald-700">{text(locale, "Overview", "نظرة عامة")}</p><h1 className="mt-1 text-2xl font-semibold tracking-tight text-emerald-950 sm:text-3xl">{text(locale, "Monthly allocation workspace", "مساحة عمل التوزيع الشهري")}</h1><p className="mt-2 text-sm leading-6 text-emerald-800">{text(locale, "Item costs are split from the next month through the end of each contract.", "يتم توزيع تكلفة العناصر بدءاً من الشهر التالي وحتى نهاية كل عقد.")}</p></div><MonthPicker locale={locale} month={month} setMonth={setMonth} /></div><section className="mt-8 grid gap-4 sm:grid-cols-2 xl:grid-cols-4" aria-label={text(locale, "Monthly summary", "ملخص الشهر")}><Metric label={text(locale, "Due this month", "مستحق هذا الشهر")} value={formatMoney(totals.due)} detail={monthLabel(locale, month)} /><Metric label={text(locale, "Active contracts", "العقود النشطة")} value={String(totals.active)} detail={text(locale, "Available for new items", "متاحة لعناصر جديدة")} /><Metric label={text(locale, "Assigned items", "العناصر المخصصة")} value={String(totals.assigned)} detail={text(locale, "Tracked allocations", "توزيعات متتبعة")} /><Metric label={text(locale, "Employee accounts", "حسابات الموظفين")} value={String(totals.people)} detail={text(locale, "Ready for export", "جاهزة للتصدير")} /></section><VendorDueSection locale={locale} period={period} rows={periodRows} periodState={periodState} onExportVendor={onExportVendor} /><section className="mt-8"><h2 className="text-base font-semibold text-emerald-950">{text(locale, "Charges due in", "المبالغ المستحقة في")} {monthLabel(locale, month)}</h2><p className="mt-1 text-sm text-emerald-700">{text(locale, "Every line is traceable to an employee, item, and vendor contract.", "يمكن تتبع كل سطر إلى موظف وعنصر وعقد مورد.")}</p><AllocationTable locale={locale} rows={dueRows} className="mt-4" /></section></>;
}

function ContractsPage({ locale, contracts, onEdit }: { locale: Locale; contracts: VendorContract[]; onEdit: (contract: VendorContract) => void }) {
  return <><PageTitle locale={locale} eyebrow={text(locale, "Contracts", "العقود")} title={text(locale, "Vendor contracts", "عقود الموردين")} detail={text(locale, "Edit a contract while keeping existing item assignments valid.", "عدّل العقد مع الحفاظ على صلاحية العناصر المخصصة الحالية.")} /><Card className="mt-6 gap-0 overflow-hidden border-emerald-100 py-0 shadow-none"><CardContent className="p-0"><Table><TableHeader className="bg-emerald-50/80"><TableRow><TableHead className="ps-5">{text(locale, "Vendor", "المورد")}</TableHead><TableHead>{text(locale, "Contract", "العقد")}</TableHead><TableHead>{text(locale, "Term", "المدة")}</TableHead><TableHead>{text(locale, "End month", "شهر الانتهاء")}</TableHead><TableHead>{text(locale, "Status", "الحالة")}</TableHead><TableHead className="pe-5 text-end"><span className="sr-only">{text(locale, "Actions", "الإجراءات")}</span></TableHead></TableRow></TableHeader><TableBody>{contracts.map((contract) => <TableRow key={contract.id}><TableCell className="ps-5 font-medium">{contract.vendor}<p className="mt-0.5 text-xs font-normal text-emerald-700">{contract.reference}</p></TableCell><TableCell>{contract.name}</TableCell><TableCell>{contract.durationMonths} {text(locale, "months", "شهراً")}</TableCell><TableCell>{formatMonth(contractEndMonth(contract))}</TableCell><TableCell><Badge variant="outline" className="border-emerald-200 bg-emerald-50 text-emerald-700">{contract.status}</Badge></TableCell><TableCell className="pe-5 text-end"><Button variant="ghost" size="sm" onClick={() => onEdit(contract)}><Pencil className="size-4" aria-hidden="true" />{text(locale, "Edit", "تعديل")}</Button></TableCell></TableRow>)}</TableBody></Table></CardContent></Card></>;
}

function EmployeesPage({ locale, employees }: { locale: Locale; employees: Employee[] }) {
  return <><PageTitle locale={locale} eyebrow={text(locale, "Employees", "الموظفون")} title={text(locale, "Employee accounts", "حسابات الموظفين")} detail={text(locale, "Each monthly allocation carries this account code into the employee export.", "يحمل كل توزيع شهري رمز الحساب في تصدير الموظف.")} /><div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{employees.map((employee) => <Card key={employee.id} className="gap-1 border-emerald-100 shadow-none"><CardTitle className="text-base text-emerald-950">{employee.name}</CardTitle><p className="text-sm text-emerald-700">{text(locale, "Account code", "رمز الحساب")}</p><p className="font-mono text-sm font-semibold">{employee.accountCode}</p></Card>)}</div></>;
}

function ItemsPage({ locale, assignments, contracts, employees, onEdit }: { locale: Locale; assignments: ItemAssignment[]; contracts: Map<string, VendorContract>; employees: Map<string, Employee>; onEdit: (item: ItemAssignment) => void }) {
  return <><PageTitle locale={locale} eyebrow={text(locale, "Items", "العناصر")} title={text(locale, "Vendor orders", "طلبات الموردين")} detail={text(locale, "One order can hold several items. Its total is charged by the payment plan you choose.", "يمكن أن يضم الطلب عدة عناصر. يُحتسب إجماليه حسب خطة الدفع التي تختارها.")} /><Card className="mt-6 gap-0 overflow-hidden border-emerald-100 py-0 shadow-none"><CardContent className="p-0"><Table><TableHeader className="bg-emerald-50/80"><TableRow><TableHead className="ps-5">{text(locale, "Items", "العناصر")}</TableHead><TableHead>{text(locale, "Employee", "الموظف")}</TableHead><TableHead>{text(locale, "Vendor", "المورد")}</TableHead><TableHead>{text(locale, "Taken", "تاريخ الاستلام")}</TableHead><TableHead>{text(locale, "Payment", "الدفع")}</TableHead><TableHead className="text-end">{text(locale, "Total", "الإجمالي")}</TableHead><TableHead className="pe-5 text-end"><span className="sr-only">{text(locale, "Actions", "الإجراءات")}</span></TableHead></TableRow></TableHeader><TableBody>{assignments.map((item) => { const contract = contracts.get(item.contractId)!; const employee = employees.get(item.employeeId)!; return <TableRow key={item.id}><TableCell className="ps-5 align-top"><ul className="grid gap-0.5">{item.lines.map((line, index) => <li key={index} className="font-medium">{line.name} <span className="text-xs font-normal text-emerald-700">×{line.quantity}</span></li>)}</ul><p className="mt-0.5 text-xs text-emerald-700">{item.reference || text(locale, "No reference", "لا يوجد مرجع")}{item.note && ` · ${item.note}`}</p></TableCell><TableCell className="align-top">{employee.name}<p className="mt-0.5 text-xs text-emerald-700">{employee.accountCode}</p></TableCell><TableCell className="align-top">{contract.vendor}</TableCell><TableCell className="align-top">{item.takenDate}</TableCell><TableCell className="align-top"><Badge variant="outline" className="border-emerald-200 bg-emerald-50 text-emerald-700">{planLabel(locale, item.paymentMonths)}</Badge></TableCell><TableCell className="text-end align-top font-medium">{formatMoney(item.totalCents)}</TableCell><TableCell className="pe-5 text-end align-top"><Button variant="ghost" size="sm" onClick={() => onEdit(item)}><Pencil className="size-4" aria-hidden="true" />{text(locale, "Edit", "تعديل")}</Button></TableCell></TableRow>; })}</TableBody></Table></CardContent></Card></>;
}

function ExportsPage({ locale, direction, period, periodRows, periodState, contractFilter, setContractFilter, contracts, history, onExport }: { locale: Locale; direction: "ltr" | "rtl"; period: Period; periodRows: DueRow[]; periodState: PeriodState; contractFilter: string; setContractFilter: (value: string) => void; contracts: VendorContract[]; history: ExportRecord[]; onExport: (request: ExportRequest) => void }) {
  // Workers unticked in the preview are left off the paper and out of the total.
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  // "all" exports every vendor; a contract id limits the statement to that one vendor contract.
  const selectedContract = contracts.find((contract) => contract.id === contractFilter);
  const toggleRow = (key: string) => setExcluded((current) => { const next = new Set(current); if (!next.delete(key)) next.add(key); return next; });
  const scopedRows = selectedContract ? periodRows.filter((row) => row.contractId === selectedContract.id) : periodRows;
  const rows = scopedRows.filter((row) => !excluded.has(lineKey(row)));
  const lineCount = workerCount(rows);
  const total = rows.reduce((sum, row) => sum + row.amountCents, 0);
  const exportAs = (format: ExportRequest["format"]) => onExport({ format, rows, subject: selectedContract?.vendor ?? "All", period });
  // A past export reopened from the history table; while open, printing reprints that snapshot instead of the live selection.
  const [viewing, setViewing] = useState<ExportRecord | null>(null);
  const viewingRows = viewing ? snapshotRows(viewing) : [];
  const viewingVendor = viewing && viewing.subject && viewing.subject !== "All" ? viewing.subject : undefined;

  return <><div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end"><PageTitle locale={locale} eyebrow={text(locale, "Exports", "التصدير")} title={text(locale, "Statements", "البيانات")} detail={text(locale, "Pick a month or a range, review what each worker owes, then export it.", "اختر شهراً أو فترة، راجع ما يستحق على كل عامل، ثم صدّره.")} /><div className="flex flex-wrap items-end gap-2"><div className="grid gap-1"><Label htmlFor="exportContract" className="text-xs text-emerald-700">{text(locale, "Vendor contract", "عقد المورد")}</Label><select id="exportContract" value={selectedContract?.id ?? "all"} onChange={(event) => setContractFilter(event.target.value)} className="h-8 rounded-md border border-emerald-200 bg-white px-2 text-sm"><option value="all">{text(locale, "All vendors", "كل الموردين")}</option>{contracts.map((contract) => <option key={contract.id} value={contract.id}>{contract.vendor} — {contract.reference}</option>)}</select></div><PeriodControl locale={locale} state={periodState} showMonth /></div></div>
    <Card className="mt-6 gap-0 border-emerald-100 py-0 shadow-sm shadow-emerald-950/5"><CardContent className="flex flex-col gap-4 p-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:flex-1"><p className="text-sm text-emerald-800"><span className="font-semibold text-emerald-950">{lineCount}</span> {text(locale, "workers", "عمال")} ·<span className="font-semibold text-emerald-950">{formatMoney(total)}</span></p><div className="flex gap-2"><Button disabled={rows.length === 0} onClick={() => exportAs("Excel")}><Download className="size-4" aria-hidden="true" />{text(locale, "Excel", "Excel")}</Button><Button variant="outline" disabled={rows.length === 0} onClick={() => exportAs("PDF")}><Printer className="size-4" aria-hidden="true" />{text(locale, "Print / PDF", "طباعة / PDF")}</Button></div></div>
    </CardContent></Card>
    <section className="mt-6" aria-label={text(locale, "Statement preview", "معاينة البيان")}><p className="mb-2 flex items-center gap-2 text-sm font-medium text-emerald-700"><Eye className="size-4" aria-hidden="true" />{text(locale, "Preview — untick a line to leave it off the paper", "معاينة — ألغِ تحديد سطر لاستبعاده من الورقة")}</p><div className="overflow-x-auto rounded-xl bg-emerald-950/5 p-3 sm:p-6"><StatementDocument locale={locale} period={period} vendor={selectedContract?.vendor} rows={scopedRows} excluded={excluded} onToggle={toggleRow} className="mx-auto max-w-[210mm] min-w-[640px] shadow-md" /></div></section>
    {createPortal(<div className="print-root" dir={direction} lang={locale}>{viewing ? <StatementDocument locale={locale} period={viewing.month} vendor={viewingVendor} rows={viewingRows} /> : <StatementDocument locale={locale} period={period} vendor={selectedContract?.vendor} rows={rows} />}</div>, document.body)}
    <Dialog open={viewing !== null} onOpenChange={(open) => { if (!open) setViewing(null); }}>{viewing && <DialogContent className="max-h-[92svh] overflow-y-auto sm:max-w-3xl"><DialogHeader><DialogTitle>{viewing.kind} · {periodLabel(locale, viewing.month)}</DialogTitle><DialogDescription>{viewingVendor ?? text(locale, "All vendors", "كل الموردين")} · {text(locale, "exported", "صُدّر في")} {new Date(viewing.createdAt).toLocaleString()}</DialogDescription></DialogHeader>
      <div className="overflow-x-auto rounded-xl bg-emerald-950/5 p-3"><StatementDocument locale={locale} period={viewing.month} vendor={viewingVendor} rows={viewingRows} className="mx-auto min-w-[560px] shadow-md" /></div>
      <DialogFooter><Button variant="outline" disabled={viewingRows.length === 0} onClick={() => void printStatement(`statement-${periodSlug(viewing.month)}`)}><Printer className="size-4" aria-hidden="true" />{text(locale, "Print again", "إعادة الطباعة")}</Button></DialogFooter></DialogContent>}</Dialog>
    <section className="mt-8"><h2 className="text-base font-semibold text-emerald-950">{text(locale, "Export history", "سجل التصدير")}</h2><Card className="mt-3 gap-0 overflow-hidden border-emerald-100 py-0 shadow-none"><CardContent className="p-0"><Table><TableHeader className="bg-emerald-50/80"><TableRow><TableHead className="ps-5">{text(locale, "Statement", "البيان")}</TableHead><TableHead>{text(locale, "For", "لـ")}</TableHead><TableHead>{text(locale, "Period", "الفترة")}</TableHead><TableHead>{text(locale, "Lines", "السطور")}</TableHead><TableHead>{text(locale, "Created", "تاريخ الإنشاء")}</TableHead><TableHead className="pe-5 text-end"><span className="sr-only">{text(locale, "Open", "فتح")}</span></TableHead></TableRow></TableHeader><TableBody>{history.length === 0 ? <TableRow><TableCell colSpan={6} className="h-24 text-center text-sm text-emerald-700">{text(locale, "No statements have been exported yet.", "لم يتم تصدير أي بيان بعد.")}</TableCell></TableRow> : history.map((record) => <TableRow key={record.id}><TableCell className="ps-5 font-medium">{record.kind}</TableCell><TableCell>{record.subject || "All"}</TableCell><TableCell>{periodLabel(locale, record.month)}</TableCell><TableCell>{record.rowCount}</TableCell><TableCell>{new Date(record.createdAt).toLocaleString()}</TableCell><TableCell className="pe-5 text-end"><Button variant="outline" size="sm" onClick={() => setViewing(record)}><Eye className="size-4" aria-hidden="true" />{text(locale, "View", "عرض")}</Button></TableCell></TableRow>)}</TableBody></Table></CardContent></Card></section></>;
}

type ExportRequest = { format: "Excel" | "PDF"; rows: DueRow[]; subject: string; period: Period };
type DueRow = { assignmentId: string; contractId: string; employeeId: string; month: string; amountCents: number; item: ItemAssignment; contract: VendorContract; employee: Employee };
function AllocationTable({ locale, rows, amountLabel, className = "" }: { locale: Locale; rows: DueRow[]; amountLabel?: string; className?: string }) {
  return <Card className={`gap-0 overflow-hidden border-emerald-100 py-0 shadow-sm shadow-emerald-950/5 ${className}`}><CardContent className="p-0"><Table><TableHeader className="bg-emerald-50/80"><TableRow><TableHead className="ps-5">{text(locale, "Employee", "الموظف")}</TableHead><TableHead>{text(locale, "Item", "العنصر")}</TableHead><TableHead>{text(locale, "Vendor", "المورد")}</TableHead><TableHead>{text(locale, "Account", "الحساب")}</TableHead><TableHead>{text(locale, "Note", "ملاحظة")}</TableHead><TableHead className="text-end">{amountLabel ?? text(locale, "This month", "هذا الشهر")}</TableHead></TableRow></TableHeader><TableBody>{rows.length === 0 ? <TableRow><TableCell colSpan={6} className="h-28 text-center text-sm text-emerald-700">{text(locale, "No allocation is due in this month.", "لا توجد توزيعات مستحقة هذا الشهر.")}</TableCell></TableRow> : rows.map((row) => <TableRow key={`${row.assignmentId}-${row.month}`}><TableCell className="ps-5 font-medium">{row.employee.name}</TableCell><TableCell>{orderLabel(row.item)}<p className="mt-0.5 text-xs text-emerald-700">{text(locale, "Taken", "استلم في")} {row.item.takenDate}</p></TableCell><TableCell>{row.contract.vendor}</TableCell><TableCell className="font-mono text-sm">{row.employee.accountCode}</TableCell><TableCell className="max-w-56 truncate text-sm text-emerald-800" title={row.item.note}>{row.item.note || "—"}</TableCell><TableCell className="text-end font-medium">{formatMoney(row.amountCents)}</TableCell></TableRow>)}</TableBody></Table></CardContent></Card>;
}


// The statement lists each worker once per vendor contract with their total for the month.
type StatementLine = { key: string; contractId: string; vendor: string; name: string; amountCents: number };
type StatementGroup = { contractId: string; vendor: string; lines: StatementLine[] };
const lineKey = (row: DueRow) => `${row.contractId}:${row.employee.id}`;
function statementLines(rows: DueRow[]): StatementLine[] {
  const lines = new Map<string, StatementLine>();
  for (const row of rows) {
    const key = lineKey(row);
    const line = lines.get(key);
    if (line) line.amountCents += row.amountCents;
    else lines.set(key, { key, contractId: row.contractId, vendor: row.contract.vendor, name: row.employee.name, amountCents: row.amountCents });
  }
  return [...lines.values()];
}
function statementGroups(lines: StatementLine[]): StatementGroup[] {
  const groups = new Map<string, StatementGroup>();
  for (const line of lines) {
    const group = groups.get(line.contractId);
    if (group) group.lines.push(line);
    else groups.set(line.contractId, { contractId: line.contractId, vendor: line.vendor, lines: [line] });
  }
  return [...groups.values()];
}
// Snapshots are stored as JSON; drop any row from an older format that lacks the contract or employee it needs to render.
function snapshotRows(record: ExportRecord): DueRow[] {
  return (record.snapshot as Partial<DueRow>[]).filter((row): row is DueRow => Boolean(row?.contract?.vendor && row?.employee?.name && typeof row.amountCents === "number"));
}
const workerCount = (rows: DueRow[]) => new Set(rows.map((row) => row.employeeId)).size;

// With onToggle (the on-screen preview) every row gets a checkbox; excluded rows stay visible but greyed and uncounted.
function StatementDocument({ locale, period, vendor, rows, excluded, onToggle, className = "" }: { locale: Locale; period: Period; vendor?: string; rows: DueRow[]; excluded?: Set<string>; onToggle?: (key: string) => void; className?: string }) {
  const lines = statementLines(rows);
  const groups = statementGroups(lines);
  // A single-vendor statement names the vendor in the header; "all vendors" splits the table into one section per contract.
  const grouped = !vendor;
  const isCounted = (line: StatementLine) => !excluded?.has(line.key);
  const counted = lines.filter(isCounted);
  const total = counted.reduce((sum, line) => sum + line.amountCents, 0);
  const countedWorkers = workerCount(rows.filter((row) => !excluded?.has(lineKey(row))));
  const head = "py-2 pe-3 text-start font-medium last:pe-0 last:text-end";
  const columns = [text(locale, "Name", "الاسم"), text(locale, "Amount owed", "المبلغ المستحق")];
  const span = columns.length + (onToggle ? 1 : 0);
  const lineRow = (line: StatementLine) => { const off = !isCounted(line); return <tr key={line.key} className={`border-b border-emerald-100 align-top ${off ? "text-emerald-950/35 line-through" : ""}`}>
    {onToggle && <td className="py-2 pe-3"><input type="checkbox" checked={!off} onChange={() => onToggle(line.key)} aria-label={text(locale, "Include on paper", "تضمين في الورقة")} className="size-4 accent-emerald-700" /></td>}
    <td className="py-2 pe-3 font-medium">{line.name}</td>
    <td className="py-2 text-end font-medium whitespace-nowrap">{formatMoney(line.amountCents)}</td>
  </tr>; };
  return <article className={`statement-document bg-white p-8 text-[13px] text-emerald-950 ${className}`}>
    <header dir="rtl" lang="ar" className="border-b-2 border-emerald-900 pb-4"><p className="text-center text-base font-bold">{ORGANIZATION.country}</p><div className="mt-3 flex items-start justify-between gap-6"><div className="text-start text-sm leading-6 font-semibold">{ORGANIZATION.hierarchy.map((line) => <p key={line}>{line}</p>)}</div><p className="self-end text-sm font-semibold">({ORGANIZATION.purpose})</p></div></header>
    <div className="mt-4 flex items-end justify-between gap-4"><p className="text-sm font-semibold">{vendor && <>{text(locale, "Vendor", "المورد")}: {vendor}</>}</p><p className="text-end text-xs text-emerald-700">{periodLabel(locale, period)}<br />{text(locale, "Generated", "أنشئ في")} {new Date().toLocaleDateString(locale === "ar" ? "ar" : "en")}</p></div>
    <table className="mt-5 w-full border-collapse"><thead><tr className="border-b border-emerald-300 text-xs uppercase tracking-wide text-emerald-700">{onToggle && <th className="w-8 py-2 pe-3"><span className="sr-only">{text(locale, "Include", "تضمين")}</span></th>}{columns.map((column) => <th key={column} className={head}>{column}</th>)}</tr></thead>
      {lines.length === 0 ? <tbody><tr><td colSpan={span} className="py-10 text-center text-emerald-700">{text(locale, "No allocation is due for this selection.", "لا توجد توزيعات مستحقة لهذا الاختيار.")}</td></tr></tbody> : grouped ? groups.map((group) => { const subtotal = group.lines.filter(isCounted).reduce((sum, line) => sum + line.amountCents, 0); return <tbody key={group.contractId} className="break-inside-avoid">
        <tr><td colSpan={span} className="pt-5 pb-2 text-sm font-bold">{text(locale, "Vendor", "المورد")}: {group.vendor}</td></tr>
        {group.lines.map(lineRow)}
        <tr className="border-b border-emerald-300 bg-emerald-50/60"><td colSpan={span - 1} className="py-2 pe-3 font-semibold">{text(locale, "Subtotal", "المجموع الفرعي")}</td><td className="py-2 text-end font-semibold whitespace-nowrap">{formatMoney(subtotal)}</td></tr>
      </tbody>; }) : <tbody>{lines.map(lineRow)}</tbody>}
      {counted.length > 0 && <tfoot><tr className="border-t-2 border-emerald-900"><td colSpan={span - 1} className="py-3 font-semibold">{grouped ? text(locale, "Grand total", "المجموع الكلي") : text(locale, "Total", "المجموع")} · {countedWorkers} {text(locale, "workers", "عمال")}</td><td className="py-3 text-end font-semibold whitespace-nowrap">{formatMoney(total)}</td></tr></tfoot>}
    </table>
  </article>;
}

function PageTitle({ locale: _locale, eyebrow, title, detail }: { locale: Locale; eyebrow: string; title: string; detail: string }) { return <div><p className="text-sm font-medium text-emerald-700">{eyebrow}</p><h1 className="mt-1 text-2xl font-semibold tracking-tight text-emerald-950 sm:text-3xl">{title}</h1><p className="mt-2 text-sm leading-6 text-emerald-800">{detail}</p></div>; }
function Metric({ label, value, detail }: { label: string; value: string; detail: string }) { return <Card className="gap-0 border-emerald-100 py-0 shadow-sm shadow-emerald-950/5"><CardHeader className="px-5 pt-5 pb-0"><CardTitle className="text-sm font-medium text-emerald-800">{label}</CardTitle></CardHeader><CardContent className="px-5 pt-3 pb-5"><p className="text-2xl font-semibold tracking-tight text-emerald-950">{value}</p><p className="mt-1 text-xs text-emerald-700">{detail}</p></CardContent></Card>; }

function ContractForm({ locale, contract, assignments, onSave }: { locale: Locale; contract?: VendorContract; assignments: ItemAssignment[]; onSave: (contract: VendorContract) => void }) {
  const [error, setError] = useState("");
  const editing = Boolean(contract);
  return <DialogContent className="sm:max-w-lg"><DialogHeader><DialogTitle>{editing ? text(locale, "Edit vendor contract", "تعديل عقد المورد") : text(locale, "Add vendor contract", "إضافة عقد مورد")}</DialogTitle><DialogDescription>{text(locale, "The end month is calculated from the contract start date and duration.", "يُحسب شهر الانتهاء من تاريخ بدء العقد ومدته.")}</DialogDescription></DialogHeader><form className="grid gap-4" onSubmit={(event) => { event.preventDefault(); const data = new FormData(event.currentTarget); const months = Number(data.get("months")); if (!Number.isInteger(months) || months < 2) return setError(text(locale, "Duration must be at least 2 months so items can be allocated.", "يجب أن تكون المدة شهرين على الأقل لتوزيع العناصر.")); const updated: VendorContract = { id: contract?.id ?? crypto.randomUUID(), vendor: String(data.get("vendor")), name: String(data.get("name")), reference: String(data.get("reference")), startDate: String(data.get("startDate")), durationMonths: months, currency: "DZD", status: String(data.get("status")) as VendorContract["status"] }; const invalidItem = assignments.some((item) => item.contractId === updated.id && !contractCanAcceptAssignment(updated, item.takenDate, item.paymentMonths)); if (invalidItem) return setError(text(locale, "These dates would put an assigned item outside the contract. Extend or restore the contract term first.", "هذه التواريخ ستجعل عنصراً مخصصاً خارج العقد. مدّد مدة العقد أو أعد التواريخ السابقة أولاً.")); onSave(updated); }}><FormError error={error} /><Field label={text(locale, "Vendor", "المورد")} name="vendor" defaultValue={contract?.vendor} placeholder={text(locale, "e.g. Atlas Electronics", "مثال: أطلس للإلكترونيات")} required /><Field label={text(locale, "Contract name", "اسم العقد")} name="name" defaultValue={contract?.name} placeholder={text(locale, "e.g. Workplace equipment agreement", "مثال: اتفاقية معدات العمل")} required /><div className="grid gap-4 sm:grid-cols-2"><Field label={text(locale, "Reference", "المرجع")} name="reference" defaultValue={contract?.reference} placeholder="ATL-2026-01" required /><Field label={text(locale, "Start date", "تاريخ البدء")} name="startDate" type="date" defaultValue={contract?.startDate ?? "2026-01-01"} required /></div><div className="grid gap-4 sm:grid-cols-2"><Field label={text(locale, "Duration in months", "المدة بالأشهر")} name="months" type="number" min="2" defaultValue={contract?.durationMonths ?? 24} required /><div className="grid gap-2"><Label>{text(locale, "Currency", "العملة")}</Label><div className="flex h-8 items-center rounded-md border border-emerald-200 bg-emerald-50 px-3 text-sm font-medium text-emerald-900">DZD — {text(locale, "Algerian dinar", "الدينار الجزائري")}</div></div></div><div className="grid gap-2"><Label htmlFor="status">{text(locale, "Status", "الحالة")}</Label><select id="status" name="status" defaultValue={contract?.status ?? "Active"} className="h-8 rounded-md border border-emerald-200 bg-white px-2 text-sm"><option value="Active">{text(locale, "Active", "نشط")}</option><option value="Draft">{text(locale, "Draft", "مسودة")}</option><option value="Ended">{text(locale, "Ended", "منتهٍ")}</option></select></div><DialogFooter><Button type="submit">{editing ? text(locale, "Save changes", "حفظ التغييرات") : text(locale, "Create contract", "إنشاء العقد")}</Button></DialogFooter></form></DialogContent>;
}
function EmployeeForm({ locale, onAdd }: { locale: Locale; onAdd: (employee: Employee) => void }) { return <DialogContent><DialogHeader><DialogTitle>{text(locale, "Add employee account", "إضافة حساب موظف")}</DialogTitle><DialogDescription>{text(locale, "This code is included in every employee allocation export.", "يُدرج هذا الرمز في كل تصدير خاص بالموظف.")}</DialogDescription></DialogHeader><form className="grid gap-4" onSubmit={(event) => { event.preventDefault(); const data = new FormData(event.currentTarget); onAdd({ id: crypto.randomUUID(), name: String(data.get("name")), accountCode: String(data.get("accountCode")).toUpperCase() }); }}><Field label={text(locale, "Employee name", "اسم الموظف")} name="name" placeholder={text(locale, "e.g. Amina Morgan", "مثال: أمينة مورغان")} required /><Field label={text(locale, "Account or cost-center code", "رمز الحساب أو مركز التكلفة")} name="accountCode" placeholder="OPS-140" required /><DialogFooter><Button type="submit">{text(locale, "Create employee", "إنشاء الموظف")}</Button></DialogFooter></form></DialogContent>; }
function ItemForm({ locale, item, contracts, employees, onSave }: { locale: Locale; item?: ItemAssignment; contracts: VendorContract[]; employees: Employee[]; onSave: (item: ItemAssignment) => void }) {
  const [error, setError] = useState("");
  const [lines, setLines] = useState<OrderLine[]>(item?.lines ?? [{ name: "", quantity: 1 }]);
  const [contractId, setContractId] = useState(item?.contractId ?? contracts[0]?.id ?? "");
  const [takenDate, setTakenDate] = useState(item?.takenDate ?? new Date().toISOString().slice(0, 10));
  const [total, setTotal] = useState(item ? (item.totalCents / 100).toFixed(2) : "");
  const [plan, setPlan] = useState<"now" | "months" | "contract">(item?.paymentMonths === 0 ? "now" : item?.paymentMonths ? "months" : "contract");
  const [months, setMonths] = useState(String(item?.paymentMonths || 3));
  // The form mounts before contracts load from the DB, so fall back to the first contract instead of a stale "".
  const contract = contracts.find((entry) => entry.id === contractId) ?? contracts[0];
  const paymentMonths = plan === "now" ? 0 : plan === "contract" ? null : Number(months);
  const totalCents = Math.round(Number(total) * 100);
  const monthsLeft = contract && takenDate ? monthsLeftAfter(contract, takenDate) : 0;
  const schedule = contract && takenDate && totalCents > 0 && contractCanAcceptAssignment(contract, takenDate, paymentMonths) ? allocationMonths(contract, takenDate, paymentMonths) : [];
  const setLine = (index: number, patch: Partial<OrderLine>) => setLines((current) => current.map((line, at) => at === index ? { ...line, ...patch } : line));
  const planButton = (value: typeof plan, label: string) => <button type="button" aria-pressed={plan === value} onClick={() => setPlan(value)} className={`h-8 flex-1 rounded-md px-3 text-sm font-medium transition-colors ${plan === value ? "bg-white text-emerald-950 shadow-sm" : "text-emerald-800 hover:text-emerald-950"}`}>{label}</button>;

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const cleanLines = lines.map((line) => ({ name: line.name.trim(), quantity: line.quantity })).filter((line) => line.name);
    if (cleanLines.length === 0) return setError(text(locale, "Add at least one item.", "أضف عنصراً واحداً على الأقل."));
    if (cleanLines.some((line) => !Number.isInteger(line.quantity) || line.quantity < 1)) return setError(text(locale, "Each item needs a count of 1 or more.", "يجب أن تكون كمية كل عنصر 1 أو أكثر."));
    if (!Number.isFinite(totalCents) || totalCents <= 0) return setError(text(locale, "Enter the order total.", "أدخل إجمالي الطلب."));
    if (plan === "months" && (!Number.isInteger(paymentMonths) || paymentMonths! < 1)) return setError(text(locale, "Enter the number of monthly payments.", "أدخل عدد الدفعات الشهرية."));
    if (!contract || !contractCanAcceptAssignment(contract, takenDate, paymentMonths)) return setError(plan === "months" && monthsLeft > 0 ? text(locale, `This contract only has ${monthsLeft} months left after the order date.`, `يتبقى لهذا العقد ${monthsLeft} أشهر فقط بعد تاريخ الطلب.`) : text(locale, "The order date must fall inside the contract (before its final month for monthly plans).", "يجب أن يقع تاريخ الطلب داخل مدة العقد (قبل الشهر الأخير للدفع الشهري)."));
    onSave({ id: item?.id ?? crypto.randomUUID(), contractId: contract.id, employeeId: String(data.get("employeeId")), lines: cleanLines, totalCents, paymentMonths, takenDate, reference: String(data.get("reference")), note: String(data.get("note")) });
  };

  return <DialogContent className="max-h-[92svh] overflow-y-auto sm:max-w-xl"><DialogHeader><DialogTitle>{item ? text(locale, "Edit order", "تعديل الطلب") : text(locale, "New vendor order", "طلب مورد جديد")}</DialogTitle><DialogDescription>{text(locale, "List the items and their counts, then enter one total for the whole order.", "أدخل العناصر وكمياتها، ثم إجمالياً واحداً للطلب كله.")}</DialogDescription></DialogHeader><form className="grid gap-4" onSubmit={submit}><FormError error={error} />
    <div className="grid gap-4 sm:grid-cols-2"><div className="grid gap-2"><Label htmlFor="contractId">{text(locale, "Vendor contract", "عقد المورد")}</Label><select id="contractId" value={contract?.id ?? ""} onChange={(event) => setContractId(event.target.value)} className="h-8 rounded-md border border-emerald-200 bg-white px-2 text-sm" required>{contracts.map((entry) => <option key={entry.id} value={entry.id}>{entry.vendor} — {text(locale, "ends", "ينتهي")} {formatMonth(contractEndMonth(entry))}</option>)}</select></div><div className="grid gap-2"><Label htmlFor="employeeId">{text(locale, "Employee", "الموظف")}</Label><select id="employeeId" name="employeeId" defaultValue={item?.employeeId} className="h-8 rounded-md border border-emerald-200 bg-white px-2 text-sm" required>{employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.name} — {employee.accountCode}</option>)}</select></div></div>
    <fieldset className="grid gap-2"><legend className="mb-2 text-sm font-medium">{text(locale, "Items in this order", "عناصر هذا الطلب")}</legend>{lines.map((line, index) => <div key={index} className="flex items-center gap-2"><Input aria-label={text(locale, `Item ${index + 1} name`, `اسم العنصر ${index + 1}`)} value={line.name} onChange={(event) => setLine(index, { name: event.target.value })} placeholder={index === 0 ? text(locale, "e.g. Fridge", "مثال: ثلاجة") : text(locale, "e.g. Microwave", "مثال: ميكروويف")} className="flex-1" /><Input aria-label={text(locale, `Item ${index + 1} count`, `كمية العنصر ${index + 1}`)} type="number" min="1" value={line.quantity} onChange={(event) => setLine(index, { quantity: Number(event.target.value) })} className="w-20" /><Button type="button" variant="ghost" size="icon" disabled={lines.length === 1} onClick={() => setLines((current) => current.filter((_, at) => at !== index))} aria-label={text(locale, "Remove item", "إزالة العنصر")}><X className="size-4" aria-hidden="true" /></Button></div>)}<Button type="button" variant="outline" size="sm" className="w-fit" onClick={() => setLines((current) => [...current, { name: "", quantity: 1 }])}><Plus className="size-4" aria-hidden="true" />{text(locale, "Add item", "إضافة عنصر")}</Button></fieldset>
    <div className="grid gap-4 sm:grid-cols-2"><div className="grid gap-2"><Label htmlFor="total">{text(locale, "Order total (DZD)", "إجمالي الطلب (دج)")}</Label><Input id="total" type="number" min="0.01" step="0.01" value={total} onChange={(event) => setTotal(event.target.value)} placeholder="0.00" required /></div><div className="grid gap-2"><Label htmlFor="takenDate">{text(locale, "Date taken", "تاريخ الاستلام")}</Label><Input id="takenDate" type="date" value={takenDate} onChange={(event) => setTakenDate(event.target.value)} required /></div></div>
    <div className="grid gap-2"><Label>{text(locale, "Payment", "الدفع")}</Label><div role="group" className="flex gap-1 rounded-lg bg-emerald-100/70 p-1">{planButton("now", text(locale, "Pay now", "دفع فوري"))}{planButton("months", text(locale, "Monthly", "شهري"))}{planButton("contract", text(locale, "Until contract end", "حتى نهاية العقد"))}</div>
      {plan === "months" && <div className="flex flex-wrap items-center gap-2"><Input aria-label={text(locale, "Number of months", "عدد الأشهر")} type="number" min="1" max={monthsLeft || undefined} value={months} onChange={(event) => setMonths(event.target.value)} className="w-24" /><span className="text-sm text-emerald-800">{text(locale, "months", "أشهر")}</span>{[3, 6, 12].filter((value) => value <= monthsLeft).map((value) => <Button key={value} type="button" variant={Number(months) === value ? "secondary" : "ghost"} size="sm" onClick={() => setMonths(String(value))}>{value}</Button>)}{monthsLeft > 0 && <span className="text-xs text-emerald-700">{text(locale, `max ${monthsLeft}`, `الحد الأقصى ${monthsLeft}`)}</span>}</div>}
      <p className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-900">{schedule.length === 0 ? text(locale, "Enter a total and a valid date to see the schedule.", "أدخل الإجمالي وتاريخاً صحيحاً لرؤية الجدول.") : schedule.length === 1 ? text(locale, `One payment of ${formatMoney(totalCents)} in ${formatMonth(schedule[0])}.`, `دفعة واحدة بقيمة ${formatMoney(totalCents)} في ${formatMonth(schedule[0])}.`) : text(locale, `${schedule.length} payments of about ${formatMoney(Math.floor(totalCents / schedule.length))}, ${formatMonth(schedule[0])} → ${formatMonth(schedule[schedule.length - 1])}.`, `${schedule.length} دفعات بقيمة ${formatMoney(Math.floor(totalCents / schedule.length))} تقريباً، من ${formatMonth(schedule[0])} إلى ${formatMonth(schedule[schedule.length - 1])}.`)}</p></div>
    <div className="grid gap-4 sm:grid-cols-2"><Field label={text(locale, "Vendor reference (optional)", "مرجع المورد (اختياري)")} name="reference" defaultValue={item?.reference} placeholder={text(locale, "Invoice or delivery note", "فاتورة أو إشعار تسليم")} /><Field label={text(locale, "Note (optional)", "ملاحظة (اختيارية)")} name="note" defaultValue={item?.note} placeholder={text(locale, "Purpose or other context", "الغرض أو تفاصيل أخرى")} /></div>
    <DialogFooter><Button type="submit" disabled={contracts.length === 0 || employees.length === 0}>{item ? text(locale, "Save changes", "حفظ التغييرات") : text(locale, "Create order", "إنشاء الطلب")}</Button></DialogFooter></form></DialogContent>;
}
function Field({ label, name, ...props }: React.ComponentProps<typeof Input> & { label: string; name: string }) { return <div className="grid gap-2"><Label htmlFor={name}>{label}</Label><Input id={name} name={name} {...props} /></div>; }
function FormError({ error }: { error: string }) { return error ? <div role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div> : null; }

export default App;
