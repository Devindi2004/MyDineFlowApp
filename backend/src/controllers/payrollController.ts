import { Response, NextFunction } from "express";
import { AuthRequest } from "../middleware/auth";
import { StaffAttendance } from "../models/StaffAttendance";
import { StaffPayroll } from "../models/StaffPayroll";
import { User } from "../models/User";
import { sendPayslipToWhatsApp } from "../services/whatsappService";
import { sendSuccess, sendError } from "../utils/response";

const payrollRoles = ["waiter", "chef", "staff", "kitchen"];

function calculateTotal(baseSalary = 0, allowances = 0, deductions = 0): number {
  return Math.max(0, Number(baseSalary) + Number(allowances || 0) - Number(deductions || 0));
}

function getDaysInMonth(month: string): number {
  const [year, monthIndex] = month.split("-").map(Number);
  return new Date(year, monthIndex, 0).getDate();
}

function payrollNumbers(staff: InstanceType<typeof User>, attendance: Array<{ status: string; workingHours?: number; workedHours?: number; overtimeHours?: number }>, month: string) {
  const presentDays = attendance.filter((record) => ["present", "late", "short-leave"].includes(record.status)).length;
  const totalHours = Math.round(attendance.reduce((sum, record) => sum + Number(record.workingHours || record.workedHours || 0), 0) * 100) / 100;
  const overtimeHours = Math.round(attendance.reduce((sum, record) => sum + Number(record.overtimeHours || 0), 0) * 100) / 100;
  const workingDays = getDaysInMonth(month);
  const monthlySalary = Number(staff.monthlySalary || 0);
  const hourlyRate = Number(staff.hourlyRate || 0);
  const overtimeRate = Number(staff.overtimeRate || 0) || hourlyRate * 1.5;
  const basicSalary = staff.salaryType === "hourly"
    ? Math.round((hourlyRate * totalHours) * 100) / 100
    : Math.round(((monthlySalary / Math.max(1, workingDays)) * presentDays) * 100) / 100;
  const overtimeAmount = Math.round((overtimeHours * overtimeRate) * 100) / 100;

  return {
    presentDays,
    totalHours,
    overtimeHours,
    basicSalary,
    overtimeAmount,
    totalSalary: Math.round((basicSalary + overtimeAmount) * 100) / 100,
  };
}

function escapePdfText(value: unknown): string {
  return String(value ?? "").replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function createSimplePdf(lines: string[]): Buffer {
  const content = lines.map((line, index) => `BT /F1 12 Tf 50 ${760 - index * 22} Td (${escapePdfText(line)}) Tj ET`).join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  offsets.slice(1).forEach((offset) => {
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  });
  pdf += `trailer << /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(pdf);
}

function createPayslipPdf(payroll: {
  staffName: string;
  staffRole: string;
  month: string;
  presentDays: number;
  totalHours: number;
  overtimeHours: number;
  basicSalary: number;
  overtimeAmount: number;
  totalAmount: number;
  status: string;
}): Buffer {
  return createSimplePdf([
    "DineFlow Staff Payslip",
    `Staff: ${payroll.staffName}`,
    `Role: ${payroll.staffRole}`,
    `Month: ${payroll.month}`,
    `Present days: ${payroll.presentDays}`,
    `Total hours: ${payroll.totalHours}`,
    `Overtime hours: ${payroll.overtimeHours}`,
    `Basic salary: LKR ${payroll.basicSalary}`,
    `Overtime amount: LKR ${payroll.overtimeAmount}`,
    `Total salary: LKR ${payroll.totalAmount}`,
    `Status: ${payroll.status}`,
  ]);
}

export async function listPayroll(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const { month, status, role } = req.query as { month?: string; status?: string; role?: string };
    const filter: Record<string, unknown> = {};

    if (req.user?.restaurantId) filter.restaurantId = req.user.restaurantId;
    if (month) filter.month = month;
    if (status) filter.status = status;
    if (role) filter.staffRole = role;

    const payroll = await StaffPayroll.find(filter).sort({ month: -1, staffName: 1 }).lean();
    sendSuccess(res, payroll);
  } catch (err) {
    next(err);
  }
}

export async function createPayroll(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const { staffId, month, baseSalary, allowances = 0, deductions = 0, notes } = req.body as {
      staffId?: string;
      month?: string;
      baseSalary?: number;
      allowances?: number;
      deductions?: number;
      notes?: string;
    };

    const staff = await User.findById(staffId);
    if (!staff || !payrollRoles.includes(staff.role)) {
      sendError(res, "Select a valid staff member for payroll.", 400);
      return;
    }

    const restaurantId = staff.restaurantId ?? req.user?.restaurantId;
    if (req.user?.restaurantId && String(restaurantId) !== req.user.restaurantId) {
      sendError(res, "Selected staff member does not belong to your restaurant.", 403);
      return;
    }

    const payroll = await StaffPayroll.create({
      staffId: staff._id,
      staffName: staff.name,
      staffRole: staff.role,
      month,
      presentDays: 0,
      totalHours: 0,
      overtimeHours: 0,
      basicSalary: Number(baseSalary || 0),
      overtimeAmount: 0,
      baseSalary: Number(baseSalary || 0),
      allowances: Number(allowances || 0),
      deductions: Number(deductions || 0),
      totalAmount: calculateTotal(Number(baseSalary || 0), Number(allowances || 0), Number(deductions || 0)),
      notes,
      restaurantId,
    });

    sendSuccess(res, payroll, "Payroll record created.", 201);
  } catch (err) {
    next(err);
  }
}

export async function generatePayroll(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const { month, staffId } = req.body as { month?: string; staffId?: string };
    if (!month) {
      sendError(res, "Payroll month is required.", 400);
      return;
    }

    const staffFilter: Record<string, unknown> = { role: { $in: payrollRoles } };
    if (staffId) staffFilter._id = staffId;
    if (req.user?.restaurantId) staffFilter.restaurantId = req.user.restaurantId;

    const staffMembers = await User.find(staffFilter);
    const records = [];
    for (const staff of staffMembers) {
      const attendance = await StaffAttendance.find({ staffId: staff._id, month }).lean();
      const numbers = payrollNumbers(staff, attendance, month);
      const payroll = await StaffPayroll.findOneAndUpdate(
        { staffId: staff._id, month },
        {
          staffId: staff._id,
          staffName: staff.name,
          staffRole: staff.role,
          month,
          presentDays: numbers.presentDays,
          totalHours: numbers.totalHours,
          overtimeHours: numbers.overtimeHours,
          basicSalary: numbers.basicSalary,
          overtimeAmount: numbers.overtimeAmount,
          baseSalary: Number(staff.monthlySalary || 0),
          allowances: 0,
          deductions: 0,
          totalAmount: numbers.totalSalary,
          restaurantId: staff.restaurantId ?? req.user?.restaurantId,
          notes: `Auto-generated from attendance for ${month}.`,
        },
        { new: true, upsert: true, runValidators: true }
      );
      records.push(payroll);
    }

    sendSuccess(res, records, "Payroll generated.");
  } catch (err) {
    next(err);
  }
}

export async function updatePayroll(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const existing = await StaffPayroll.findById(req.params.id);
    if (!existing) {
      sendError(res, "Payroll record not found.", 404);
      return;
    }

    if (req.user?.restaurantId && existing.restaurantId && String(existing.restaurantId) !== req.user.restaurantId) {
      sendError(res, "Access denied.", 403);
      return;
    }

    const update = { ...req.body };
    const baseSalary = update.baseSalary ?? existing.baseSalary;
    const allowances = update.allowances ?? existing.allowances;
    const deductions = update.deductions ?? existing.deductions;
    update.totalAmount = calculateTotal(baseSalary, allowances, deductions);

    const payroll = await StaffPayroll.findByIdAndUpdate(req.params.id, update, { new: true, runValidators: true });
    sendSuccess(res, payroll, "Payroll record updated.");
  } catch (err) {
    next(err);
  }
}

export async function markPayrollPaid(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const existing = await StaffPayroll.findById(req.params.id);
    if (!existing) {
      sendError(res, "Payroll record not found.", 404);
      return;
    }

    if (req.user?.restaurantId && existing.restaurantId && String(existing.restaurantId) !== req.user.restaurantId) {
      sendError(res, "Access denied.", 403);
      return;
    }

    let payroll = await StaffPayroll.findByIdAndUpdate(
      req.params.id,
      { status: "paid", paidAt: new Date(), whatsappError: undefined },
      { new: true, runValidators: true }
    );

    if (payroll) {
      const staff = await User.findById(payroll.staffId).lean();
      const pdf = createPayslipPdf(payroll);
      const whatsapp = await sendPayslipToWhatsApp({
        to: staff?.whatsappNumber || staff?.phone || "",
        staffName: payroll.staffName,
        month: payroll.month,
        totalSalary: payroll.totalAmount,
        pdf,
      });
      payroll = await StaffPayroll.findByIdAndUpdate(
        payroll._id,
        whatsapp.messageId
          ? { whatsappSentAt: new Date(), whatsappMessageId: whatsapp.messageId, whatsappError: undefined }
          : { whatsappError: whatsapp.error || "WhatsApp payslip was not sent." },
        { new: true, runValidators: true }
      );
    }

    sendSuccess(res, payroll, "Payroll marked as paid.");
  } catch (err) {
    next(err);
  }
}

export async function deletePayroll(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const existing = await StaffPayroll.findById(req.params.id);
    if (!existing) {
      sendError(res, "Payroll record not found.", 404);
      return;
    }

    if (req.user?.restaurantId && existing.restaurantId && String(existing.restaurantId) !== req.user.restaurantId) {
      sendError(res, "Access denied.", 403);
      return;
    }

    await StaffPayroll.findByIdAndDelete(req.params.id);
    sendSuccess(res, null, "Payroll record deleted.");
  } catch (err) {
    next(err);
  }
}

export async function downloadPayslip(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const payroll = await StaffPayroll.findById(req.params.id).lean();
    if (!payroll) {
      sendError(res, "Payroll record not found.", 404);
      return;
    }

    if (req.user?.restaurantId && payroll.restaurantId && String(payroll.restaurantId) !== req.user.restaurantId) {
      sendError(res, "Access denied.", 403);
      return;
    }

    const pdf = createPayslipPdf(payroll);

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="payslip-${payroll.staffName}-${payroll.month}.pdf"`);
    res.send(pdf);
  } catch (err) {
    next(err);
  }
}
