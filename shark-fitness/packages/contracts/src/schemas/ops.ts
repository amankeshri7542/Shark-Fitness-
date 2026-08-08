import { z } from 'zod';
import {
  EquipmentStatus,
  LeadStage,
  Role,
  WorkOrderState,
} from '../enums.js';
import { Id, IsoDate, IsoDateTime, Money } from './identity.js';

/* — CRM (PF-CRM) ————————————————————————————————————————————— */

export const Lead = z.object({
  id: Id,
  name: z.string(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  source: z.enum(['walk_in', 'web_form', 'referral', 'campaign', 'import', 'trial', 'api', 'call']),
  campaign: z.string().nullable(),
  stage: LeadStage,
  branchId: Id,
  branchName: z.string(),
  ownerId: Id.nullable(),
  ownerName: z.string().nullable(),
  expectedValueMinor: Money,
  nextActionAt: IsoDateTime.nullable(),
  nextActionLabel: z.string().nullable(),
  lastTouchedAt: IsoDateTime.nullable(),
  createdAt: IsoDateTime,
  lossReason: z.string().nullable(),
  convertedMemberId: Id.nullable(),
  /** Raised when the lead has breached its follow-up SLA (PF-CRM-006). */
  slaBreached: z.boolean(),
  /** Set when another record shares a normalised phone or email. */
  duplicateOfId: Id.nullable(),
  tags: z.array(z.string()),
});
export type Lead = z.infer<typeof Lead>;

export const LeadActivity = z.object({
  id: Id,
  leadId: Id,
  kind: z.enum(['note', 'call', 'message', 'email', 'stage_change', 'task', 'tour', 'trial']),
  body: z.string(),
  actorName: z.string(),
  at: IsoDateTime,
  fromStage: LeadStage.nullable(),
  toStage: LeadStage.nullable(),
});
export type LeadActivity = z.infer<typeof LeadActivity>;

/* — Staff (PF-STAFF) ————————————————————————————————————————— */

export const StaffMember = z.object({
  id: Id,
  userId: Id,
  name: z.string(),
  initials: z.string(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  role: Role,
  employmentStatus: z.enum(['active', 'on_leave', 'notice', 'former']),
  branchIds: z.array(Id),
  specialties: z.array(z.string()),
  certifications: z.array(z.object({ name: z.string(), expiresOn: IsoDate.nullable() })),
  assignedMemberCount: z.number().int(),
  utilisationPct: z.number().int(),
  joinedOn: IsoDate,
});
export type StaffMember = z.infer<typeof StaffMember>;

export const Shift = z.object({
  id: Id,
  staffId: Id,
  staffName: z.string(),
  branchId: Id,
  startsAt: IsoDateTime,
  endsAt: IsoDateTime,
  role: z.string(),
  state: z.enum(['planned', 'confirmed', 'in_progress', 'completed', 'absent', 'covered']),
  coveredByName: z.string().nullable(),
  /** Set when this shift overlaps another for the same person, or leaves a
   *  branch without cover. */
  conflict: z.string().nullable(),
});
export type Shift = z.infer<typeof Shift>;

export const CommissionLine = z.object({
  id: Id,
  staffId: Id,
  staffName: z.string(),
  periodStart: IsoDate,
  periodEnd: IsoDate,
  kind: z.enum(['session', 'package', 'sale', 'renewal', 'class']),
  basisMinor: Money,
  ratePct: z.number(),
  amountMinor: Money,
  /** The rule version and inputs used, preserved so a mid-period rule change
   *  can be explained rather than silently reapplied (PF-STAFF-004). */
  ruleVersion: z.string(),
  evidence: z.array(z.string()),
  state: z.enum(['accrued', 'approved', 'paid', 'disputed']),
});
export type CommissionLine = z.infer<typeof CommissionLine>;

/* — Inventory and POS (PF-POS) ———————————————————————————————— */

export const RetailProduct = z.object({
  id: Id,
  name: z.string(),
  sku: z.string(),
  barcode: z.string().nullable(),
  category: z.string(),
  priceMinor: Money,
  costMinor: Money,
  taxRateBp: z.number().int(),
  stock: z.number().int(),
  reorderAt: z.number().int(),
  lowStock: z.boolean(),
  marginPct: z.number(),
});
export type RetailProduct = z.infer<typeof RetailProduct>;

export const StockMovement = z.object({
  id: Id,
  productId: Id,
  productName: z.string(),
  branchId: Id,
  delta: z.number().int(),
  reason: z.enum(['purchase', 'sale', 'return', 'transfer_out', 'transfer_in', 'adjustment', 'damage']),
  refType: z.string().nullable(),
  refId: Id.nullable(),
  actorName: z.string(),
  note: z.string().nullable(),
  at: IsoDateTime,
});
export type StockMovement = z.infer<typeof StockMovement>;

export const PosOrder = z.object({
  id: Id,
  reference: z.string(),
  branchId: Id,
  memberId: Id.nullable(),
  memberName: z.string().nullable(),
  lines: z.array(
    z.object({
      productId: Id,
      name: z.string(),
      quantity: z.number().int(),
      unitMinor: Money,
      totalMinor: Money,
    }),
  ),
  subtotalMinor: Money,
  taxMinor: Money,
  totalMinor: Money,
  state: z.enum(['open', 'paid', 'voided', 'returned', 'partially_returned']),
  staffName: z.string(),
  createdAt: IsoDateTime,
});
export type PosOrder = z.infer<typeof PosOrder>;

/* — Facility (PF-FAC) ————————————————————————————————————————— */

export const EquipmentItem = z.object({
  id: Id,
  name: z.string(),
  assetTag: z.string(),
  branchId: Id,
  area: z.string(),
  model: z.string(),
  serial: z.string(),
  vendor: z.string(),
  warrantyUntil: IsoDate.nullable(),
  status: EquipmentStatus,
  lastServicedOn: IsoDate.nullable(),
  nextServiceDue: IsoDate.nullable(),
  overdue: z.boolean(),
  openWorkOrders: z.number().int(),
  downtimeDays30: z.number().int(),
  linkedExerciseId: Id.nullable(),
});
export type EquipmentItem = z.infer<typeof EquipmentItem>;

export const WorkOrder = z.object({
  id: Id,
  reference: z.string(),
  equipmentId: Id.nullable(),
  equipmentName: z.string().nullable(),
  branchId: Id,
  title: z.string(),
  description: z.string(),
  severity: z.enum(['low', 'medium', 'high', 'safety']),
  state: WorkOrderState,
  reportedByName: z.string(),
  reportedByKind: z.enum(['member', 'staff', 'system']),
  assigneeName: z.string().nullable(),
  costMinor: Money,
  openedAt: IsoDateTime,
  closedAt: IsoDateTime.nullable(),
  duplicateOfId: Id.nullable(),
});
export type WorkOrder = z.infer<typeof WorkOrder>;

/* — Reporting (PF-RPT) ———————————————————————————————————————— */

export const Freshness = z.enum(['realtime', 'near_realtime', 'batch']);
export type Freshness = z.infer<typeof Freshness>;

export const Kpi = z.object({
  key: z.string(),
  label: z.string(),
  value: z.number(),
  display: z.string(),
  unit: z.string().nullable(),
  previous: z.number().nullable(),
  changePct: z.number().nullable(),
  direction: z.enum(['up', 'down', 'flat']),
  /** Whether up is good. Revenue up is good; churn up is not. */
  goodDirection: z.enum(['up', 'down', 'neutral']),
  freshness: Freshness,
  asOf: IsoDateTime,
  /** Where clicking this KPI lands, with filters pre-applied (PF-DASH-002). */
  drillTo: z.string().nullable(),
  /** Set when the metric could not be computed. Not the same as zero. */
  unavailableReason: z.string().nullable(),
  definition: z.string(),
});
export type Kpi = z.infer<typeof Kpi>;

export const OperationalAlert = z.object({
  id: Id,
  severity: z.enum(['info', 'warning', 'critical']),
  kind: z.enum([
    'failed_payment',
    'access_denied',
    'overbooked_class',
    'member_risk',
    'equipment_down',
    'low_stock',
    'expiring_plans',
    'sla_breach',
    'integration_down',
  ]),
  title: z.string(),
  detail: z.string(),
  count: z.number().int(),
  branchId: Id.nullable(),
  branchName: z.string().nullable(),
  raisedAt: IsoDateTime,
  actionLabel: z.string(),
  actionTo: z.string(),
});
export type OperationalAlert = z.infer<typeof OperationalAlert>;

export const ReportRequest = z.object({
  report: z.string(),
  branchIds: z.array(Id),
  from: IsoDate,
  to: IsoDate,
  compareTo: z.enum(['none', 'previous_period', 'previous_year']).default('previous_period'),
  groupBy: z.string().optional(),
  format: z.enum(['json', 'csv']).default('json'),
});
export type ReportRequest = z.infer<typeof ReportRequest>;

export const ReportResult = z.object({
  report: z.string(),
  columns: z.array(
    z.object({
      key: z.string(),
      label: z.string(),
      type: z.enum(['text', 'number', 'money', 'percent', 'date']),
      /** Marks a column the viewer's role may not see; rendered as a
       *  permission state, never as blank data (PF-RPT-005). */
      restricted: z.boolean(),
    }),
  ),
  rows: z.array(z.record(z.unknown())),
  totals: z.record(z.number()).nullable(),
  freshness: Freshness,
  asOf: IsoDateTime,
  /** Labels values that are estimated, delayed or model-derived. */
  caveats: z.array(z.string()),
  truncated: z.boolean(),
});
export type ReportResult = z.infer<typeof ReportResult>;

/* — Automation (PF-COMM-004) ——————————————————————————————————— */

export const Automation = z.object({
  id: Id,
  name: z.string(),
  trigger: z.string(),
  description: z.string(),
  conditions: z.array(z.object({ field: z.string(), op: z.string(), value: z.string() })),
  actions: z.array(z.object({ kind: z.string(), templateCode: z.string().nullable(), delayMin: z.number().int() })),
  quietHours: z.object({ from: z.string(), to: z.string() }).nullable(),
  state: z.enum(['draft', 'active', 'paused']),
  dryRun: z.boolean(),
  runsLast30: z.number().int(),
  lastRunAt: IsoDateTime.nullable(),
  estimatedCostMinor: Money,
});
export type Automation = z.infer<typeof Automation>;

/* — Audit (Compliance PRD) ———————————————————————————————————— */

export const AuditEntry = z.object({
  id: Id,
  at: IsoDateTime,
  actorName: z.string(),
  actorRole: Role,
  action: z.string(),
  entityType: z.string(),
  entityId: Id,
  entityLabel: z.string(),
  reason: z.string().nullable(),
  /** Field-level before/after for the diff viewer. */
  changes: z.array(z.object({ field: z.string(), from: z.string(), to: z.string() })),
  ip: z.string().nullable(),
});
export type AuditEntry = z.infer<typeof AuditEntry>;
