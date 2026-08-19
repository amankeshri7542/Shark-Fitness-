import type { ReactElement } from 'react';
import { render, type RenderResult } from '@testing-library/react';
import { MutationCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { RetentionView, TicketDetail, TicketQueue, TicketSummary } from '@shark/contracts';

/** Renders a Support panel with a throwaway query client, retries off. */
export function renderPanel(element: ReactElement): RenderResult {
  const client = new QueryClient({
    // Components show their own mutation errors; this stops a deliberately
    // rejected mock reaching Vitest's unhandled-rejection guard.
    mutationCache: new MutationCache({ onError: () => undefined }),
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{element}</QueryClientProvider>);
}

/** The branch clock the panels format against, so a run in London agrees. */
export const TZ = 'Asia/Kolkata';

export function ticket(overrides: Partial<TicketSummary> = {}): TicketSummary {
  return {
    id: 'tkt_1',
    reference: 'SUP-1051',
    branchId: 'br_kor',
    branchName: 'Koramangala Depot',
    memberId: 'mbr_1',
    memberName: 'Asha Iyer',
    memberInactive: false,
    category: 'billing',
    subject: 'Charged twice in July',
    priority: 'high',
    state: 'open',
    assigneeId: null,
    assigneeName: null,
    anonymous: false,
    escalated: false,
    vulnerabilityFlag: false,
    safetyCategories: [],
    reopenCount: 0,
    sla: {
      state: 'on_track',
      label: 'Reply due in 4h',
      dueInMinutes: 240,
      breached: false,
      dueAt: '2026-08-19T12:00:00.000Z',
      responseMinutes: 480,
      firstResponseAt: null,
    },
    openedAt: '2026-08-19T04:00:00.000Z',
    lastUpdateAt: '2026-08-19T04:00:00.000Z',
    resolvedAt: null,
    closedAt: null,
    ...overrides,
  };
}

export function queue(overrides: Partial<TicketQueue> = {}): TicketQueue {
  return {
    items: [ticket()],
    counts: {
      open: 1,
      pendingStaff: 0,
      pendingMember: 0,
      resolved: 0,
      closed: 0,
      breached: 0,
      unassigned: 1,
      escalated: 0,
      mine: 0,
    },
    assignees: [{ id: 'stf_1', name: 'Deepa Kumar' }],
    categories: [
      { value: 'billing', responseMinutes: 480 },
      { value: 'complaint', responseMinutes: 240 },
      { value: 'other', responseMinutes: 1440 },
    ],
    asOf: '2026-08-19T04:00:00.000Z',
    ...overrides,
  };
}

export function detail(overrides: Partial<TicketDetail> = {}): TicketDetail {
  return {
    ticket: ticket(),
    conversationId: 'cnv_1',
    messages: [
      {
        id: 'msg_1',
        senderName: 'Asha Iyer',
        senderRole: 'member',
        fromMember: true,
        body: 'I was charged twice for July.',
        attachments: [],
        safetyFlagged: false,
        readAt: null,
        at: '2026-08-19T04:00:00.000Z',
      },
    ],
    timeline: [
      {
        id: 'tev_1',
        kind: 'opened',
        actorName: 'Asha Iyer',
        actorRole: 'member',
        summary: 'SUP-1051 opened: Charged twice in July',
        messageId: null,
        at: '2026-08-19T04:00:00.000Z',
      },
    ],
    member: {
      memberId: 'mbr_1',
      memberNo: 'SF-40219',
      name: 'Asha Iyer',
      lifecycle: 'active',
      homeBranchName: 'Koramangala Depot',
      joinedOn: '2025-04-02',
      lastVisitAt: '2026-08-17T11:00:00.000Z',
      membershipState: 'active',
      membershipProduct: 'Reef Unlimited',
      membershipEndsOn: '2026-12-31',
      balanceMinor: 240_000,
      openTickets: 1,
      riskScore: 22,
      riskBand: 'low',
      inactive: false,
    },
    replyBlockedReason: null,
    resolution: null,
    escalation: null,
    ...overrides,
  };
}

export function retention(overrides: Partial<RetentionView> = {}): RetentionView {
  return {
    atRisk: [
      {
        memberId: 'mbr_2',
        memberNo: 'SF-40311',
        name: 'Rohit Bhaskar',
        branchId: 'br_kor',
        branchName: 'Koramangala Depot',
        score: 62,
        band: 'high',
        reasons: [
          { code: 'attendance_drop', label: 'Attendance down 55% on their own norm', points: 20 },
          { code: 'payment_failed', label: 'A payment failed and is unresolved', points: 18 },
        ],
        recommendedAction: 'Sort the failed payment first.',
        suppressed: null,
        lastVisitAt: '2026-08-01T09:00:00.000Z',
        membershipEndsOn: '2026-09-30',
        openInterventionId: null,
        outreach: { allowed: false, reason: 'Open complaint — automation paused' },
      },
    ],
    interventions: [],
    effectiveness: [
      {
        action: 'call',
        attempted: 4,
        retained: 2,
        churned: 1,
        noContact: 1,
        falsePositive: 0,
        pending: 0,
        retentionRate: 67,
      },
      {
        action: 'coach_checkin',
        attempted: 2,
        retained: 1,
        churned: 0,
        noContact: 0,
        falsePositive: 1,
        pending: 0,
        retentionRate: null,
      },
    ],
    bands: { high: 1, watch: 3, low: 30 },
    asOf: '2026-08-19T04:00:00.000Z',
    ...overrides,
  };
}
