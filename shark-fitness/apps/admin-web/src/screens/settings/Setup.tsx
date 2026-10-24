import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import type { SetupChecklist } from '@shark/contracts';
import { ApiError, api } from '../../lib/api';
import { Bar, Chip, ErrorState, Skeleton, cx } from '../../ui/console';

/**
 * The guided setup checklist (PF-TEN-006).
 *
 * Every tick is counted from real rows rather than stored. A stored tick
 * survives the deletion of the thing it was ticked for, and "setup complete"
 * over a gym with no plans to sell is worse than no checklist at all.
 *
 * Blocking steps are separated from the rest because they are a different
 * kind of thing: one list is "before members arrive", the other is "when you
 * get to it". Ordering them together makes the second look optional and the
 * first look like a suggestion.
 */
export default function Setup({ canManage }: { canManage: boolean }) {
  const setup = useQuery({
    queryKey: ['settings', 'setup'],
    queryFn: () => api<SetupChecklist>('/admin/settings/setup'),
    enabled: canManage,
  });

  if (!canManage) return null;
  if (setup.isLoading) return <Skeleton className="h-64" />;
  if (setup.error || !setup.data) {
    return (
      <ErrorState
        title="The checklist could not be read"
        body={setup.error instanceof ApiError ? setup.error.message : 'The server did not answer.'}
        onRetry={() => void setup.refetch()}
      />
    );
  }

  const { items, done, total, readyToOpen } = setup.data;
  const blocking = items.filter((i) => i.blocking);
  const later = items.filter((i) => !i.blocking);
  const blockingLeft = blocking.filter((i) => !i.done).length;

  return (
    <>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line bg-hull px-3.5 py-3">
        <div className="min-w-[180px] flex-1">
          <div className="flex items-baseline gap-2">
            <span className="font-display text-[22px] leading-none tabular-nums">{done}</span>
            <span className="font-utility text-[10px] uppercase tracking-[0.12em] text-foam-35">of {total} done</span>
          </div>
          <div className="mt-2">
            <Bar value={done} max={total} tone={readyToOpen ? 'good' : 'accent'} />
          </div>
        </div>
        {/* The page header already carries the overall verdict on every tab.
            Repeating it here made the same sentence appear twice on one
            screen — say the thing this bar knows and nothing else. */}
        {blockingLeft > 0 ? (
          <Chip tone="warn">
            {blockingLeft} {blockingLeft === 1 ? 'step' : 'steps'} before members arrive
          </Chip>
        ) : null}
      </div>

      <Group title="Before members arrive" items={blocking} />
      <Group title="When you get to it" items={later} />
    </>
  );
}

function Group({ title, items }: { title: string; items: SetupChecklist['items'] }) {
  if (items.length === 0) return null;
  return (
    <section aria-label={title}>
      <h3 className="border-b border-line bg-hull px-3.5 py-2 font-utility text-[10px] font-semibold uppercase tracking-[0.18em] text-foam-45">
        {title}
      </h3>
      <ul className="divide-y divide-line">
        {items.map((item) => (
          <li key={item.key} className="flex flex-wrap items-start gap-x-3 gap-y-1 px-3.5 py-3">
            <span
              aria-hidden="true"
              className={cx(
                'mt-0.5 grid h-4 w-4 flex-none place-items-center border text-[10px]',
                item.done ? 'border-kelp text-kelp' : 'border-line-strong text-transparent',
              )}
            >
              ✓
            </span>
            <div className="min-w-[200px] flex-1">
              <div className={cx('text-[13px]', item.done ? 'text-foam-45 line-through' : 'text-foam')}>
                {item.label}
              </div>
              <p className="mt-0.5 max-w-[70ch] text-[11px] leading-relaxed text-foam-45">{item.why}</p>
            </div>
            {item.done ? (
              <span className="font-utility text-[10px] uppercase tracking-[0.1em] text-kelp">Done</span>
            ) : (
              <Link
                to={item.to.split('?')[0]!}
                className="font-utility text-[11px] font-semibold uppercase tracking-[0.12em] text-sonar hover:text-foam"
              >
                Do it
              </Link>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
