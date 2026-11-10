import Database from "@tauri-apps/plugin-sql";

import { orderLabel, type Employee, type ItemAssignment, type OrderLine, type VendorContract } from "@/lib/ledger";

export type ExportHistoryRecord = {
  id: string;
  month: string;
  kind: string;
  subject: string;
  rowCount: number;
  createdAt: string;
  snapshot: unknown[];
};

export type LedgerData = {
  contracts: VendorContract[];
  employees: Employee[];
  assignments: ItemAssignment[];
  history: ExportHistoryRecord[];
};

type ContractRow = {
  id: string;
  vendor: string;
  name: string;
  reference: string;
  start_date: string;
  duration_months: number;
  currency: string;
  status: VendorContract["status"];
};

type EmployeeRow = { id: string; name: string; account_code: string };
type AssignmentRow = {
  id: string;
  contract_id: string;
  employee_id: string;
  item_name: string;
  quantity: number;
  unit_price_cents: number;
  taken_date: string;
  reference: string;
  note: string;
  lines_json: string;
  total_cents: number | null;
  payment_months: number | null;
};
type ExportRow = {
  id: string;
  month: string;
  kind: string;
  subject: string | null;
  row_count: number;
  created_at: string;
  snapshot_json: string;
};

const DATABASE_PATH = "sqlite:fundcontract.db";
const isTauriRuntime = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

let database: Promise<Database> | undefined;

function getDatabase() {
  database ??= Database.load(DATABASE_PATH);
  return database;
}

async function seedIfEmpty(db: Database, seeds: Omit<LedgerData, "history">) {
  const rows = await db.select<{ count: number }[]>("SELECT COUNT(*) AS count FROM contracts");
  if (Number(rows[0]?.count ?? 0) > 0) return;

  for (const contract of seeds.contracts) await insertContract(db, contract);
  for (const employee of seeds.employees) await insertEmployee(db, employee);
  for (const assignment of seeds.assignments) await insertAssignment(db, assignment);
}

export async function loadLedger(seeds: Omit<LedgerData, "history">): Promise<LedgerData> {
  if (!isTauriRuntime()) return { ...seeds, history: [] };

  const db = await getDatabase();
  await seedIfEmpty(db, seeds);
  const [contractRows, employeeRows, assignmentRows, exportRows] = await Promise.all([
    db.select<ContractRow[]>("SELECT * FROM contracts ORDER BY vendor, name"),
    db.select<EmployeeRow[]>("SELECT * FROM employees ORDER BY name"),
    db.select<AssignmentRow[]>("SELECT * FROM item_assignments ORDER BY taken_date DESC"),
    db.select<ExportRow[]>("SELECT * FROM export_history ORDER BY created_at DESC"),
  ]);

  return {
    contracts: contractRows.map((row) => ({ id: row.id, vendor: row.vendor, name: row.name, reference: row.reference, startDate: row.start_date, durationMonths: Number(row.duration_months), currency: "DZD", status: row.status })),
    employees: employeeRows.map((row) => ({ id: row.id, name: row.name, accountCode: row.account_code })),
    assignments: assignmentRows.map((row) => ({ id: row.id, contractId: row.contract_id, employeeId: row.employee_id, lines: parseLines(row.lines_json, row.item_name, Number(row.quantity)), totalCents: Number(row.total_cents ?? row.quantity * row.unit_price_cents), paymentMonths: row.payment_months === null || row.payment_months === undefined ? null : Number(row.payment_months), takenDate: row.taken_date, reference: row.reference, note: row.note ?? "" })),
    history: exportRows.map((row) => ({ id: row.id, month: row.month, kind: row.kind, subject: row.subject ?? "", rowCount: Number(row.row_count), createdAt: row.created_at, snapshot: parseSnapshot(row.snapshot_json) })),
  };
}

export async function saveContract(contract: VendorContract) {
  if (!isTauriRuntime()) return;
  await insertContract(await getDatabase(), contract);
}

export async function updateContract(contract: VendorContract) {
  if (!isTauriRuntime()) return;
  const db = await getDatabase();
  await db.execute(
    "UPDATE contracts SET vendor = $1, name = $2, reference = $3, start_date = $4, duration_months = $5, currency = $6, status = $7 WHERE id = $8",
    [contract.vendor, contract.name, contract.reference, contract.startDate, contract.durationMonths, "DZD", contract.status, contract.id],
  );
}

export async function saveEmployee(employee: Employee) {
  if (!isTauriRuntime()) return;
  await insertEmployee(await getDatabase(), employee);
}

export async function saveAssignment(assignment: ItemAssignment) {
  if (!isTauriRuntime()) return;
  await insertAssignment(await getDatabase(), assignment);
}

export async function updateAssignment(assignment: ItemAssignment) {
  if (!isTauriRuntime()) return;
  const db = await getDatabase();
  await db.execute(
    "UPDATE item_assignments SET contract_id = $1, employee_id = $2, item_name = $3, quantity = $4, unit_price_cents = $5, taken_date = $6, reference = $7, note = $8, lines_json = $9, total_cents = $10, payment_months = $11 WHERE id = $12",
    [...assignmentValues(assignment), assignment.id],
  );
}

export async function saveExportRecord(record: ExportHistoryRecord) {
  if (!isTauriRuntime()) return;
  const db = await getDatabase();
  await db.execute(
    "INSERT INTO export_history (id, month, kind, subject, row_count, created_at, snapshot_json) VALUES ($1, $2, $3, $4, $5, $6, $7)",
    [record.id, record.month, record.kind, record.subject, record.rowCount, record.createdAt, JSON.stringify(record.snapshot)],
  );
}

async function insertContract(db: Database, contract: VendorContract) {
  await db.execute(
    "INSERT INTO contracts (id, vendor, name, reference, start_date, duration_months, currency, status) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
    [contract.id, contract.vendor, contract.name, contract.reference, contract.startDate, contract.durationMonths, "DZD", contract.status],
  );
}

async function insertEmployee(db: Database, employee: Employee) {
  await db.execute("INSERT INTO employees (id, name, account_code) VALUES ($1, $2, $3)", [employee.id, employee.name, employee.accountCode]);
}

async function insertAssignment(db: Database, assignment: ItemAssignment) {
  await db.execute(
    "INSERT INTO item_assignments (contract_id, employee_id, item_name, quantity, unit_price_cents, taken_date, reference, note, lines_json, total_cents, payment_months, id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)",
    [...assignmentValues(assignment), assignment.id],
  );
}

// item_name / quantity / unit_price_cents are kept filled for older readers of the table.
function assignmentValues(assignment: ItemAssignment) {
  const quantity = assignment.lines.reduce((sum, line) => sum + line.quantity, 0);
  return [assignment.contractId, assignment.employeeId, orderLabel(assignment), quantity, assignment.totalCents, assignment.takenDate, assignment.reference, assignment.note, JSON.stringify(assignment.lines), assignment.totalCents, assignment.paymentMonths];
}

function parseLines(value: string, fallbackName: string, fallbackQuantity: number): OrderLine[] {
  try {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed) && parsed.length > 0) return parsed as OrderLine[];
  } catch {
    // Rows created before multi-line orders have no lines_json.
  }
  return [{ name: fallbackName, quantity: fallbackQuantity }];
}

function parseSnapshot(value: string): unknown[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
