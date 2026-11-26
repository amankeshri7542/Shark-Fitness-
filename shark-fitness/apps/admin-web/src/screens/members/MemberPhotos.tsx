import { useQuery } from '@tanstack/react-query';
import { API_ORIGIN, api } from '../../lib/api';
import { EmptyState, ErrorState, Panel, Skeleton } from '../../ui/console';

interface CoachPhotos {
  access: 'coach' | 'not_assigned';
  message: string | null;
  items: Array<{ id: string; takenOn: string; pose: string; url: string | null }>;
}

/**
 * Progress photos a member has shared with their coach (P05, PF-PROG-006).
 * Only the assigned coach sees anything; for everyone else the panel says
 * who can, and shows nothing. Links are signed for this viewer and live five
 * minutes, so the list refreshes before they lapse.
 */
export function MemberPhotos({ memberId }: { memberId: string }) {
  const photos = useQuery({
    queryKey: ['member-photos', memberId],
    queryFn: () => api<CoachPhotos>(`/admin/members/${memberId}/progress-photos`),
    refetchInterval: 4 * 60_000,
  });

  return (
    <Panel title="Progress photos" className="border-b border-line">
      <div className="p-3.5 text-[13px]">
        {photos.isLoading ? (
          <Skeleton className="h-28 w-full" />
        ) : photos.error ? (
          <ErrorState title="Could not load photos" body={photos.error.message} onRetry={() => void photos.refetch()} />
        ) : photos.data?.access === 'not_assigned' ? (
          <p className="text-foam-65">{photos.data.message}</p>
        ) : photos.data && photos.data.items.length === 0 ? (
          <EmptyState title="Nothing shared" body={photos.data.message ?? 'The member has not shared any progress photos with you.'} />
        ) : photos.data ? (
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-2">
            {photos.data.items.map((photo) => (
              <li key={photo.id} className="border border-line">
                <img
                  src={photo.url ? `${API_ORIGIN}${photo.url}` : undefined}
                  alt={`Progress photo, ${photo.pose}, ${photo.takenOn}`}
                  className="aspect-[3/4] w-full object-cover"
                  loading="lazy"
                />
                <p className="px-2 py-1.5 text-[12px]">{photo.takenOn}</p>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </Panel>
  );
}
