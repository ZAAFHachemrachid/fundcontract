export type VendorContract = {
  id: string;
  vendor: string;
  name: string;
  reference: string;
  startDate: string;
  durationMonths: number;
  currency: string;
  status: "Active" | "Draft" | "Ended";
};

export type Employee = {
  id: string;
  name: string;
  accountCode: string;
};

export type OrderLine = {
  name: string;
  quantity: number;
};

export type ItemAssignment = {
  id: string;
  contractId: string;
  employeeId: string;
  lines: OrderLine[];
  totalCents: number;
  // 0 = pay now (in the month taken), N = N monthly payments from the next month, null = until the contract ends.
  paymentMonths: number | null;
  takenDate: string;
  reference: string;
  note: string;
};

export type Allocation = {
  assignmentId: string;
  contractId: string;
  employeeId: string;
  month: string;
  amountCents: number;
};

function dateParts(value: string) {
  const [year, month] = value.slice(0, 7).split("-").map(Number);
  return { year, month: month - 1 };
}

function monthKey(year: number, month: number) {
  return `${year}-${String(month + 1).padStart(2, "0")}`;
}

function addMonths(month: string, amount: number) {
  const { year, month: monthIndex } = dateParts(month);
  const date = new Date(Date.UTC(year, monthIndex + amount, 1));
  return monthKey(date.getUTCFullYear(), date.getUTCMonth());
}

export function contractEndMonth(contract: VendorContract) {
  return addMonths(contract.startDate.slice(0, 7), contract.durationMonths - 1);
}

export function contractCanAcceptAssignment(contract: VendorContract, takenDate: string, paymentMonths: number | null = null) {
  const takenMonth = takenDate.slice(0, 7);
  const endMonth = contractEndMonth(contract);
  if (takenMonth < contract.startDate.slice(0, 7)) return false;
  if (paymentMonths === 0) return takenMonth <= endMonth;
  if (takenMonth >= endMonth) return false;
  return paymentMonths === null || addMonths(takenMonth, paymentMonths) <= endMonth;
}

export function monthsLeftAfter(contract: VendorContract, takenDate: string) {
  const { year, month } = dateParts(takenDate);
  const end = dateParts(contractEndMonth(contract));
  return (end.year - year) * 12 + end.month - month;
}

export function allocationMonths(contract: VendorContract, takenDate: string, paymentMonths: number | null = null) {
  const takenMonth = takenDate.slice(0, 7);
  if (paymentMonths === 0) return [takenMonth];
  const firstMonth = addMonths(takenMonth, 1);
  const contractEnd = contractEndMonth(contract);
  const planEnd = paymentMonths === null ? contractEnd : addMonths(takenMonth, paymentMonths);
  const endMonth = planEnd < contractEnd ? planEnd : contractEnd;
  const result: string[] = [];
  for (let month = firstMonth; month <= endMonth; month = addMonths(month, 1)) result.push(month);
  return result;
}

export function orderLabel(assignment: Pick<ItemAssignment, "lines">) {
  return assignment.lines.map((line) => line.quantity > 1 ? `${line.name} ×${line.quantity}` : line.name).join(", ");
}

export function allocationsForAssignment(assignment: ItemAssignment, contract: VendorContract): Allocation[] {
  const months = allocationMonths(contract, assignment.takenDate, assignment.paymentMonths);
  if (months.length === 0) return [];
  const totalCents = assignment.totalCents;
  const baseCents = Math.floor(totalCents / months.length);
  const finalCents = totalCents - baseCents * (months.length - 1);
  return months.map((month, index) => ({
    assignmentId: assignment.id,
    contractId: contract.id,
    employeeId: assignment.employeeId,
    month,
    amountCents: index === months.length - 1 ? finalCents : baseCents,
  }));
}

export function formatMoney(cents: number) {
  return `${new Intl.NumberFormat("en", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(cents / 100)} دج`;
}

export function formatMonth(month: string) {
  const { year, month: monthIndex } = dateParts(month);
  return new Intl.DateTimeFormat("en", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(year, monthIndex, 1)));
}
