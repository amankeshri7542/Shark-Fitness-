import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, OfflineError, api } from '../lib/api';
import { useBranchScope, usePermission } from '../lib/store';
import { useOnline } from '../lib/realtime';
import { Page } from '../ui/shell';
import {
  Button,
  Checkbox,
  Chip,
  EmptyState,
  ErrorState,
  Label,
  Panel,
  PermissionState,
  Segmented,
  Skeleton,
  Tabs,
  TextAreaField,
} from '../ui/console';
import { Modal } from '../ui/overlay';

/* ============================================================================
   Community — moderation (P07; PF-GAME-005, UX-M11).

   Three queues: what members reported, what is waiting for approval, and who
   is blocked from posting. Every decision needs a reason because the author is
   told it, and every decision is audited. "Hide" is reversible and leaves the
   author able to see their own words; "remove" leaves a tombstone for all.
   ========================================================================= */

type Section = 'reports' | 'approvals' | 'bans';

interface Author {
  id: string;
  name: string;
  memberNo: string;
  minor: boolean;
  banned: boolean;
}

export interface ReportItem {
  key: string;
  targetType: 'post' | 'comment';
  targetId: string;
  body: string;
  state: string;
  context: { postBody: string } | null;
  author: Author | null;
  reportCount: number;
  reasons: Array<{ reason: string; count: number }>;
  notes: string[];
  lastReportedRelative: string;
  resolution: string | null;
}

interface ApprovalItem {
  id: string;
  body: string;
  relativeTime: string;
  author: Author | null;
}

interface BanItem {
  memberId: string;
  name: string;
  memberNo: string;
  reason: string;
  relativeTime: string;
}

const REASON_LABEL: Record<string, string> = {
  harassment: 'Unkind or harassing',
  unsafe_advice: 'Unsafe advice',
  spam: 'Spam or selling',
  impersonation: 'Impersonation',
  other: 'Other',
};

type Decision =
  | { kind: 'content'; item: ReportItem; action: 'hide' | 'remove' | 'dismiss' | 'restore' }
  | { kind: 'reject'; item: ApprovalItem }
  | { kind: 'ban'; author: Author };

function failure(error: unknown): string {
  if (error instanceof OfflineError) return 'No connection. Nothing was changed.';
  if (error instanceof ApiError) return error.message;
  return 'That did not save. Try again.';
}

export default function CommunityScreen() {
  const canModerate = usePermission('community.moderate');
  const canSettings = usePermission('settings.manage');
  const { branchId, branchName } = useBranchScope();
  const online = useOnline();
  const queryClient = useQueryClient();
  const [section, setSection] = useState<Section>('reports');
  const [reportState, setReportState] = useState<'open' | 'resolved'>('open');
  const [decision, setDecision] = useState<Decision | null>(null);

  const reports = useQuery({
    queryKey: ['community', 'reports', branchId, reportState],
    queryFn: () => api<{ items: ReportItem[] }>(`/admin/community/reports?state=${reportState}`),
    enabled: canModerate,
  });
  const approvals = useQuery({
    queryKey: ['community', 'approvals', branchId],
    queryFn: () => api<{ approvalMode: boolean; items: ApprovalItem[] }>('/admin/community/approvals'),
    enabled: canModerate,
  });
  const bans = useQuery({
    queryKey: ['community', 'bans', branchId],
    queryFn: () => api<{ items: BanItem[] }>('/admin/community/bans'),
    enabled: canModerate && section === 'bans',
  });

  const refresh = (): void => void queryClient.invalidateQueries({ queryKey: ['community'] });

  const approve = useMutation({
    mutationFn: (postId: string) => api(`/admin/community/approvals/${postId}`, { method: 'POST', body: { decision: 'approve', reason: '' } }),
    onSuccess: refresh,
  });
  const lift = useMutation({
    mutationFn: (memberId: string) => api(`/admin/community/bans/${memberId}`, { method: 'DELETE' }),
    onSuccess: refresh,
  });
  const approvalMode = useMutation({
    mutationFn: (on: boolean) => api('/admin/settings/engagement', { method: 'PATCH', body: { communityApprovalMode: on } }),
    onSuccess: refresh,
  });

  if (!canModerate) {
    return (
      <Page title="Community">
        <PermissionState what="Community moderation" />
      </Page>
    );
  }

  const openReports = reportState === 'open' ? (reports.data?.items.length ?? 0) : 0;
  const pending = approvals.data?.items.length ?? 0;

  return (
    <Page
      title="Community"
      kicker={branchName}
      actions={
        <div className="flex items-center gap-2">
          {openReports > 0 ? <Chip tone="warn">{openReports} reported</Chip> : null}
          {pending > 0 ? <Chip tone="accent">{pending} waiting</Chip> : null}
          {!online ? <Chip tone="bad">Offline</Chip> : null}
        </div>
      }
    >
      <Tabs
        label="Community sections"
        items={[
          { key: 'reports', label: 'Reports', ...(openReports ? { hint: String(openReports) } : {}) },
          { key: 'approvals', label: 'Approval', ...(pending ? { hint: String(pending) } : {}) },
          { key: 'bans', label: 'Blocked from posting' },
        ]}
        active={section}
        onChange={(key) => setSection(key as Section)}
      />
      {!online ? (
        <Panel tone="warn" className="p-3">
          <p className="text-[13px] text-foam-80">Offline. Decisions will not save until the connection is back.</p>
        </Panel>
      ) : null}

      <div role="tabpanel" id={`panel-${section}`} aria-labelledby={`tab-${section}`} className="flex flex-col gap-3 p-4">
        {section === 'reports' ? (
          <>
            <Segmented
              label="Report state"
              options={[
                { value: 'open', label: 'To review' },
                { value: 'resolved', label: 'Decided' },
              ]}
              value={reportState}
              onChange={setReportState}
            />
            {reports.isPending ? (
              <Skeleton className="h-40" />
            ) : reports.isError ? (
              <ErrorState title="Could not load reports" body="This is not an empty queue — reports could not be read." onRetry={() => void reports.refetch()} />
            ) : reports.data.items.length === 0 ? (
              <EmptyState
                title={reportState === 'open' ? 'Nothing reported' : 'No decisions yet'}
                body="When a member reports a post or comment it appears here with what it replied to and why it was reported."
              />
            ) : (
              <ul className="flex flex-col gap-3">
                {reports.data.items.map((item) => (
                  <li key={item.key}>
                    <Panel className="flex flex-col gap-2 p-4">
                      <div className="flex flex-wrap items-center gap-2">
                        <Label>{item.targetType === 'comment' ? 'Comment' : 'Post'}</Label>
                        <Chip tone={item.reportCount >= 3 ? 'bad' : 'warn'}>
                          {item.reportCount} report{item.reportCount === 1 ? '' : 's'}
                        </Chip>
                        {item.reasons.map((r) => (
                          <Chip key={r.reason} tone="neutral">
                            {REASON_LABEL[r.reason] ?? r.reason}
                          </Chip>
                        ))}
                        {item.state !== 'visible' && item.state !== 'flagged' ? <Chip tone="neutral">{item.state}</Chip> : null}
                        <span className="flex-1" />
                        <span className="text-[11px] text-foam-50">{item.lastReportedRelative}</span>
                      </div>
                      {item.context ? (
                        <p className="border-l-2 border-line-strong pl-2.5 text-[12px] text-foam-50">Replying to: {item.context.postBody}</p>
                      ) : null}
                      <p className="whitespace-pre-wrap text-[14px] leading-relaxed">{item.body}</p>
                      <p className="text-[12px] text-foam-65">
                        By {item.author ? `${item.author.name} · ${item.author.memberNo}` : 'the gym'}
                        {item.author?.minor ? ' · under 18' : ''}
                        {item.author?.banned ? ' · blocked from posting' : ''}
                      </p>
                      {item.notes.length ? (
                        <ul className="text-[12px] text-foam-65">
                          {item.notes.map((n, i) => (
                            <li key={i}>“{n}”</li>
                          ))}
                        </ul>
                      ) : null}
                      {item.resolution ? <p className="text-[12px] text-foam-50">Decision: {item.resolution}</p> : null}
                      <div className="flex flex-wrap gap-2">
                        {reportState === 'open' ? (
                          <>
                            <Button variant="outline" disabled={!online} onClick={() => setDecision({ kind: 'content', item, action: 'hide' })}>
                              Hide
                            </Button>
                            <Button variant="danger" disabled={!online} onClick={() => setDecision({ kind: 'content', item, action: 'remove' })}>
                              Remove
                            </Button>
                            <Button variant="ghost" disabled={!online} onClick={() => setDecision({ kind: 'content', item, action: 'dismiss' })}>
                              Keep it
                            </Button>
                          </>
                        ) : item.state === 'hidden' || item.state === 'removed' ? (
                          <Button variant="outline" disabled={!online} onClick={() => setDecision({ kind: 'content', item, action: 'restore' })}>
                            Restore
                          </Button>
                        ) : null}
                        {item.author && !item.author.banned ? (
                          <Button variant="ghost" disabled={!online} onClick={() => setDecision({ kind: 'ban', author: item.author! })}>
                            Block from posting
                          </Button>
                        ) : null}
                      </div>
                    </Panel>
                  </li>
                ))}
              </ul>
            )}
          </>
        ) : null}

        {section === 'approvals' ? (
          <>
            <Panel className="p-3">
              {canSettings ? (
                <Checkbox
                  label="Approve member posts before they appear"
                  hint="When on, a new member post waits here and only its author can see it until a moderator approves it."
                  checked={approvals.data?.approvalMode ?? false}
                  disabled={!online || approvalMode.isPending || approvals.isPending}
                  onChange={(e) => approvalMode.mutate(e.target.checked)}
                />
              ) : (
                <p className="text-[13px] text-foam-65">
                  Approval mode is {approvals.data?.approvalMode ? 'on' : 'off'}. An owner can change it.
                </p>
              )}
              {approvalMode.isError ? <p role="alert" className="mt-1 text-[12px] text-chum">{failure(approvalMode.error)}</p> : null}
            </Panel>
            {approvals.isPending ? (
              <Skeleton className="h-32" />
            ) : approvals.isError ? (
              <ErrorState title="Could not load the approval queue" body="Posts may be waiting that could not be read." onRetry={() => void approvals.refetch()} />
            ) : approvals.data.items.length === 0 ? (
              <EmptyState title="Nothing waiting" body={approvals.data.approvalMode ? 'New member posts will wait here for a decision.' : 'Approval mode is off, so posts go straight to the feed.'} />
            ) : (
              <ul className="flex flex-col gap-3">
                {approvals.data.items.map((item) => (
                  <li key={item.id}>
                    <Panel className="flex flex-col gap-2 p-4">
                      <p className="whitespace-pre-wrap text-[14px] leading-relaxed">{item.body}</p>
                      <p className="text-[12px] text-foam-65">
                        {item.author ? `${item.author.name} · ${item.author.memberNo}` : 'Unknown'} · {item.relativeTime}
                      </p>
                      <div className="flex gap-2">
                        <Button variant="cta" disabled={!online} pending={approve.isPending && approve.variables === item.id} onClick={() => approve.mutate(item.id)}>
                          Approve
                        </Button>
                        <Button variant="outline" disabled={!online} onClick={() => setDecision({ kind: 'reject', item })}>
                          Reject
                        </Button>
                      </div>
                    </Panel>
                  </li>
                ))}
              </ul>
            )}
          </>
        ) : null}

        {section === 'bans' ? (
          bans.isPending ? (
            <Skeleton className="h-32" />
          ) : bans.isError ? (
            <ErrorState title="Could not load blocked members" body="Try again." onRetry={() => void bans.refetch()} />
          ) : bans.data.items.length === 0 ? (
            <EmptyState title="Nobody is blocked" body="Members you block from posting can still read the feed and use the rest of the app." />
          ) : (
            <ul className="flex flex-col gap-2">
              {bans.data.items.map((b) => (
                <li key={b.memberId}>
                  <Panel className="flex flex-wrap items-center gap-3 p-3">
                    <div className="min-w-0 flex-1">
                      <p className="text-[13px]">
                        {b.name} · {b.memberNo}
                      </p>
                      <p className="text-[12px] text-foam-65">
                        {b.reason} · {b.relativeTime}
                      </p>
                    </div>
                    <Button variant="outline" disabled={!online} pending={lift.isPending && lift.variables === b.memberId} onClick={() => lift.mutate(b.memberId)}>
                      Let them post again
                    </Button>
                  </Panel>
                </li>
              ))}
            </ul>
          )
        ) : null}
      </div>

      {decision ? <DecisionDialog decision={decision} onClose={() => setDecision(null)} onDone={refresh} /> : null}
    </Page>
  );
}

const DIALOG_COPY: Record<string, { title: string; confirm: string; help: string }> = {
  hide: { title: 'Hide this', confirm: 'Hide', help: 'Nobody else will see it. The author keeps seeing it with your reason. You can restore it later.' },
  remove: { title: 'Remove this', confirm: 'Remove', help: 'Everyone sees “removed after a moderation review” in its place. The author is told your reason.' },
  dismiss: { title: 'Keep it up', confirm: 'Keep it', help: 'The reports are closed and it stays in the feed. Add a note for the record if you like.' },
  restore: { title: 'Restore this', confirm: 'Restore', help: 'It goes back into the feed and the author is told.' },
  reject: { title: 'Reject this post', confirm: 'Reject', help: 'It stays visible only to its author, with your reason.' },
  ban: { title: 'Block from posting', confirm: 'Block from posting', help: 'They can still read the feed and use the app, but cannot post or comment. They are told your reason.' },
};

function DecisionDialog({ decision, onClose, onDone }: { decision: Decision; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const key = decision.kind === 'content' ? decision.action : decision.kind;
  const copy = DIALOG_COPY[key]!;
  const needsReason = key !== 'dismiss' && key !== 'restore';
  const save = useMutation({
    mutationFn: () => {
      if (decision.kind === 'content') {
        return api(`/admin/community/content/${decision.item.targetType}/${decision.item.targetId}`, {
          method: 'POST',
          body: { action: decision.action, reason: reason.trim() || (decision.action === 'restore' ? 'Restored after review' : '') },
        });
      }
      if (decision.kind === 'reject') {
        return api(`/admin/community/approvals/${decision.item.id}`, { method: 'POST', body: { decision: 'reject', reason: reason.trim() } });
      }
      return api('/admin/community/bans', { method: 'POST', body: { memberId: decision.author.id, reason: reason.trim() } });
    },
    onSuccess: () => {
      onDone();
      onClose();
    },
  });
  return (
    <Modal open title={copy.title} onClose={onClose}>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (!needsReason || reason.trim().length >= 3) save.mutate();
        }}
      >
        <p className="text-[13px] leading-relaxed text-foam-65">{copy.help}</p>
        <TextAreaField
          label={needsReason ? 'Reason (the member is told this)' : 'Note (optional)'}
          value={reason}
          maxLength={500}
          onChange={(e) => setReason(e.target.value)}
          rows={3}
        />
        {save.isError ? <p role="alert" className="text-[12px] text-chum">{failure(save.error)}</p> : null}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant={key === 'remove' || key === 'ban' || key === 'reject' ? 'danger' : 'cta'} disabled={needsReason && reason.trim().length < 3} pending={save.isPending}>
            {copy.confirm}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
