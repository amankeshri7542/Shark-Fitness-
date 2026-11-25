import { useId, useMemo, useState, type ChangeEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, API_ORIGIN, OfflineError, api } from '../../lib/api';
import { PhotoPreparationError, prepareUpload } from '../../lib/photo';
import { useOnline } from '../../lib/realtime';
import { Sheet } from '../../ui/Sheet';
import { Button, Chip, Display, EmptyState, ErrorState, Label, Panel, SectionRule, Segmented, Skeleton } from '../../ui/primitives';

/**
 * Progress photos (P05; PF-PROG-004/006; UX-M08).
 *
 * Privacy copy is plain and complete: what is stored, who can see it, what
 * withdrawing consent does and when photos are deleted. Nothing is uploaded
 * without consent, and every photo is re-encoded on the phone first (which
 * drops location and camera data) before the server checks it again.
 */

export interface PhotoView {
  id: string;
  takenOn: string;
  pose: string;
  visibility: 'private' | 'coach';
  createdAt: string;
  width: number | null;
  height: number | null;
  url: string | null;
  urlExpiresAt: string | null;
  deleteAfter: string | null;
}

export interface PhotosPayload {
  consent: { granted: boolean; version: string | null; current: boolean; currentVersion: string; text: string };
  retentionDays: number;
  items: PhotoView[];
}

const POSES = [
  { value: 'front', label: 'Front' },
  { value: 'side', label: 'Side' },
  { value: 'back', label: 'Back' },
] as const;

function dateLabel(iso: string): string {
  return new Date(`${iso.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

const src = (photo: PhotoView): string | undefined => (photo.url ? `${API_ORIGIN}${photo.url}` : undefined);

const failure = (error: unknown, fallback: string): string =>
  error instanceof OfflineError ? 'You are offline. Nothing changed. Try again when you are connected.' : error instanceof ApiError ? error.message : fallback;

export function PhotosSection() {
  const online = useOnline();
  const client = useQueryClient();
  const [uploading, setUploading] = useState(false);
  const [comparing, setComparing] = useState(false);
  const [deleting, setDeleting] = useState<PhotoView | null>(null);
  const [withdrawing, setWithdrawing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const photos = useQuery({
    queryKey: ['progress-photos'],
    queryFn: () => api<PhotosPayload>('/member/progress/photos'),
    // Signed links live five minutes; refresh before they lapse.
    refetchInterval: 4 * 60_000,
  });
  const refresh = () => void client.invalidateQueries({ queryKey: ['progress-photos'] });

  const consent = useMutation({
    mutationFn: (granted: boolean) => api<{ photos?: { scheduled: number } }>('/me/consents', { method: 'PUT', body: { purpose: 'progress_photos', granted } }),
    onSuccess: (_result, granted) => {
      setWithdrawing(false);
      setNotice(granted ? null : 'Photo consent withdrawn. Your coach can no longer see your photos.');
      refresh();
    },
    onError: (error) => setNotice(failure(error, 'That did not go through. Nothing changed.')),
  });

  const visibility = useMutation({
    mutationFn: (input: { id: string; visibility: 'private' | 'coach' }) =>
      api(`/member/progress/photos/${input.id}`, { method: 'PATCH', body: { visibility: input.visibility } }),
    onSuccess: (_r, input) => {
      setNotice(input.visibility === 'coach' ? 'Shared with your coach.' : 'Private again. Your coach can no longer see it.');
      refresh();
    },
    onError: (error) => setNotice(failure(error, 'That did not go through. Nothing changed.')),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api(`/member/progress/photos/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      setDeleting(null);
      setNotice('Photo deleted. The file is gone.');
      refresh();
    },
    onError: (error) => setNotice(failure(error, 'The photo was not deleted. Try again.')),
  });

  const data = photos.data;
  const scheduled = data?.items.find((photo) => photo.deleteAfter)?.deleteAfter ?? null;

  return (
    <div>
      <SectionRule>Progress photos</SectionRule>

      {photos.isLoading ? (
        <div className="grid grid-cols-3 gap-1.5" aria-label="Loading photos">
          {Array.from({ length: 3 }, (_, i) => (
            <Skeleton key={i} className="aspect-[3/4] w-full" />
          ))}
        </div>
      ) : photos.error || !data ? (
        !online ? (
          <Panel className="p-3.5">
            <p className="text-[13px] leading-relaxed text-foam-80">Photos need a connection. They are never kept on this phone. Connect to see them.</p>
          </Panel>
        ) : (
          <ErrorState title="Could not load your photos" body="Nothing was changed. Try again." onRetry={() => void photos.refetch()} />
        )
      ) : !data.consent.current ? (
        <ConsentCard consent={data.consent} retentionDays={data.retentionDays} busy={consent.isPending} online={online} onAgree={() => consent.mutate(true)} />
      ) : (
        <div className="flex flex-col gap-3">
          {scheduled ? (
            <Panel tone="warn" className="p-3" role="status">
              <p className="text-[13px] leading-relaxed">Photo consent is withdrawn. These photos are hidden from your coach and will be deleted on {dateLabel(scheduled)}.</p>
            </Panel>
          ) : null}
          {notice ? (
            <Panel className="p-3" role="status">
              <p className="text-[13px] leading-relaxed">{notice}</p>
            </Panel>
          ) : null}

          <div className="flex flex-wrap gap-2">
            <Button variant="cta" size="md" disabled={!online} onClick={() => setUploading(true)}>
              Add a photo
            </Button>
            {data.items.length >= 2 ? (
              <Button variant="outline" size="md" onClick={() => setComparing(true)}>
                Compare two dates
              </Button>
            ) : null}
          </div>
          {!online ? <p className="text-[12px] text-foam-65">You are offline. Photos can be added once you are connected.</p> : null}

          {data.items.length === 0 ? (
            <EmptyState title="No photos yet" body="Add one today and another in a few weeks. Side by side, they show what the scale does not." />
          ) : (
            <ul className="grid grid-cols-2 gap-2" aria-label="Your progress photos">
              {data.items.map((photo) => (
                <li key={photo.id} className="flex flex-col border border-line">
                  <img src={src(photo)} alt={`Progress photo, ${photo.pose}, ${dateLabel(photo.takenOn)}`} className="aspect-[3/4] w-full bg-abyss object-cover" loading="lazy" />
                  <div className="flex flex-col gap-1.5 p-2">
                    <div className="flex items-center justify-between gap-1">
                      <span className="text-[12px]">{dateLabel(photo.takenOn)}</span>
                      <Chip tone={photo.visibility === 'coach' ? 'accent' : 'neutral'} glyph={false}>
                        {photo.visibility === 'coach' ? 'Coach' : 'Private'}
                      </Chip>
                    </div>
                    <div className="flex gap-1.5">
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={!online || visibility.isPending || Boolean(photo.deleteAfter)}
                        onClick={() => visibility.mutate({ id: photo.id, visibility: photo.visibility === 'coach' ? 'private' : 'coach' })}
                        aria-label={photo.visibility === 'coach' ? `Make the ${dateLabel(photo.takenOn)} photo private` : `Share the ${dateLabel(photo.takenOn)} photo with my coach`}
                      >
                        {photo.visibility === 'coach' ? 'Make private' : 'Share with coach'}
                      </Button>
                      <Button variant="ghost" size="sm" disabled={!online} onClick={() => setDeleting(photo)} aria-label={`Delete the ${dateLabel(photo.takenOn)} photo`}>
                        Delete
                      </Button>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}

          <p className="text-[12px] leading-relaxed text-foam-65">
            Private unless you share a photo with your assigned coach. Nobody else at the gym can see them.{' '}
            <button type="button" className="underline" onClick={() => setWithdrawing(true)} disabled={!online}>
              Withdraw photo consent
            </button>
          </p>
        </div>
      )}

      {uploading ? (
        <UploadSheet
          onClose={() => setUploading(false)}
          onDone={(message) => {
            setUploading(false);
            setNotice(message);
            refresh();
          }}
        />
      ) : null}
      {comparing && data ? <CompareSheet photos={data.items} onClose={() => setComparing(false)} /> : null}
      {deleting ? (
        <Sheet label="Delete this photo" onClose={() => (remove.isPending ? undefined : setDeleting(null))}>
          <Display size="sm" as="h2">
            Delete this photo?
          </Display>
          <p className="mt-2.5 text-[14px] leading-relaxed text-foam-80">
            The {dateLabel(deleting.takenOn)} photo is deleted for good, from your coach&rsquo;s view too. This cannot be undone.
          </p>
          <div className="mt-3.5 flex gap-2.5">
            <Button variant="cta" size="lg" className="flex-1" disabled={remove.isPending} onClick={() => remove.mutate(deleting.id)}>
              {remove.isPending ? 'Deleting…' : 'Delete photo'}
            </Button>
            <Button variant="outline" size="lg" onClick={() => setDeleting(null)}>
              Keep it
            </Button>
          </div>
        </Sheet>
      ) : null}
      {withdrawing && data ? (
        <Sheet label="Withdraw photo consent" onClose={() => (consent.isPending ? undefined : setWithdrawing(false))}>
          <Display size="sm" as="h2">
            Withdraw photo consent?
          </Display>
          <p className="mt-2.5 text-[14px] leading-relaxed text-foam-80">
            Your coach stops seeing your photos straight away. All {data.items.length} {data.items.length === 1 ? 'photo is' : 'photos are'} deleted after{' '}
            {data.retentionDays} days unless you agree again before then. You can also delete any photo yourself now.
          </p>
          <div className="mt-3.5 flex gap-2.5">
            <Button variant="cta" size="lg" className="flex-1" disabled={consent.isPending} onClick={() => consent.mutate(false)}>
              {consent.isPending ? 'Withdrawing…' : 'Withdraw consent'}
            </Button>
            <Button variant="outline" size="lg" onClick={() => setWithdrawing(false)}>
              Cancel
            </Button>
          </div>
        </Sheet>
      ) : null}
    </div>
  );
}

function ConsentCard({ consent, retentionDays, busy, online, onAgree }: {
  consent: PhotosPayload['consent'];
  retentionDays: number;
  busy: boolean;
  online: boolean;
  onAgree: () => void;
}) {
  return (
    <Panel className="p-3.5">
      <Label>{consent.granted ? 'The photo consent has changed' : 'Before you add photos'}</Label>
      <p className="mt-2 text-[13px] leading-relaxed text-foam-80">{consent.text}</p>
      <p className="mt-2 text-[12px] leading-relaxed text-foam-65">
        Retention after withdrawal: {retentionDays} days. Consent version {consent.currentVersion}.
      </p>
      <Button variant="cta" size="md" className="mt-3" disabled={busy || !online} onClick={onAgree}>
        {busy ? 'Saving…' : 'I agree, store my photos'}
      </Button>
      {!online ? <p className="mt-2 text-[12px] text-foam-65">Connect to agree.</p> : null}
    </Panel>
  );
}

function today(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function UploadSheet({ onClose, onDone }: { onClose: () => void; onDone: (message: string) => void }) {
  const inputId = useId();
  const dateId = useId();
  const [file, setFile] = useState<File | null>(null);
  const [takenOn, setTakenOn] = useState(today());
  const [pose, setPose] = useState<'front' | 'side' | 'back'>('front');
  const [share, setShare] = useState<'private' | 'coach'>('private');
  const [error, setError] = useState<string | null>(null);

  const upload = useMutation({
    mutationFn: async () => {
      if (!file) throw new PhotoPreparationError('Choose a photo first.');
      const prepared = await prepareUpload(file);
      const form = new FormData();
      form.set('file', prepared, 'progress.jpg');
      form.set('purpose', 'progress_photo');
      form.set('takenOn', takenOn);
      form.set('pose', pose);
      form.set('visibility', share);
      return api<{ photo: PhotoView }>('/member/media/uploads', { method: 'POST', form });
    },
    onMutate: () => setError(null),
    onSuccess: () => onDone(share === 'coach' ? 'Photo saved and shared with your coach.' : 'Photo saved. Only you can see it.'),
    onError: (err) => setError(err instanceof PhotoPreparationError ? err.message : failure(err, 'The photo was not saved. Try again.')),
  });

  return (
    <Sheet label="Add a progress photo" onClose={() => (upload.isPending ? undefined : onClose())}>
      <Display size="sm" as="h2">
        Add a progress photo
      </Display>
      <div className="mt-3 flex flex-col gap-3">
        <div>
          <label htmlFor={inputId} className="block font-utility text-[11px] font-semibold uppercase tracking-[0.12em] text-foam-65">
            Photo
          </label>
          <input
            id={inputId}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            className="mt-1.5 block w-full text-[13px]"
            onChange={(event: ChangeEvent<HTMLInputElement>) => setFile(event.target.files?.[0] ?? null)}
          />
          <p className="mt-1 text-[12px] text-foam-65">Location and camera details are removed before it is sent.</p>
        </div>
        <div>
          <label htmlFor={dateId} className="block font-utility text-[11px] font-semibold uppercase tracking-[0.12em] text-foam-65">
            Taken on
          </label>
          <input id={dateId} type="date" value={takenOn} max={today()} onChange={(event) => setTakenOn(event.target.value)} className="mt-1.5 min-h-11 w-full border border-line bg-transparent px-3 text-[14px]" />
        </div>
        <div>
          <Label>Pose</Label>
          <Segmented className="mt-1.5" options={POSES.map((p) => ({ value: p.value, label: p.label }))} value={pose} onChange={setPose} />
        </div>
        <div>
          <Label>Who can see it</Label>
          <Segmented
            className="mt-1.5"
            options={[
              { value: 'private' as const, label: 'Only me' },
              { value: 'coach' as const, label: 'Me and my coach' },
            ]}
            value={share}
            onChange={setShare}
          />
        </div>
        {error ? (
          <p role="alert" className="text-[13px] text-chum">
            {error}
          </p>
        ) : null}
      </div>
      <div className="mt-3.5 flex gap-2.5">
        <Button variant="cta" size="lg" className="flex-1" disabled={!file || upload.isPending} onClick={() => upload.mutate()}>
          {upload.isPending ? 'Saving…' : 'Save photo'}
        </Button>
        <Button variant="outline" size="lg" disabled={upload.isPending} onClick={onClose}>
          Cancel
        </Button>
      </div>
    </Sheet>
  );
}

export function CompareSheet({ photos, onClose }: { photos: PhotoView[]; onClose: () => void }) {
  const ordered = useMemo(() => [...photos].sort((a, b) => a.takenOn.localeCompare(b.takenOn)), [photos]);
  const [beforeId, setBeforeId] = useState(ordered[0]?.id ?? '');
  const [afterId, setAfterId] = useState(ordered[ordered.length - 1]?.id ?? '');
  const [position, setPosition] = useState(50);
  const before = ordered.find((p) => p.id === beforeId) ?? null;
  const after = ordered.find((p) => p.id === afterId) ?? null;
  const beforeSelect = useId();
  const afterSelect = useId();
  const slider = useId();

  const option = (photo: PhotoView) => (
    <option key={photo.id} value={photo.id}>
      {dateLabel(photo.takenOn)} · {photo.pose}
    </option>
  );

  return (
    <Sheet label="Compare two photos" onClose={onClose}>
      <Display size="sm" as="h2">
        Compare
      </Display>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <label htmlFor={beforeSelect} className="text-[12px] text-foam-65">
          Before
          <select id={beforeSelect} value={beforeId} onChange={(event) => setBeforeId(event.target.value)} className="mt-1 min-h-11 w-full border border-line bg-overlay px-2 text-[13px] text-foam">
            {ordered.map(option)}
          </select>
        </label>
        <label htmlFor={afterSelect} className="text-[12px] text-foam-65">
          After
          <select id={afterSelect} value={afterId} onChange={(event) => setAfterId(event.target.value)} className="mt-1 min-h-11 w-full border border-line bg-overlay px-2 text-[13px] text-foam">
            {ordered.map(option)}
          </select>
        </label>
      </div>
      {before && after ? (
        <figure className="mt-3">
          <div className="relative aspect-[3/4] w-full overflow-hidden border border-line bg-abyss">
            <img src={src(after)} alt={`After: ${dateLabel(after.takenOn)}`} className="absolute inset-0 h-full w-full object-cover" />
            <img
              src={src(before)}
              alt={`Before: ${dateLabel(before.takenOn)}`}
              className="absolute inset-0 h-full w-full object-cover"
              style={{ clipPath: `inset(0 ${100 - position}% 0 0)` }}
            />
            <span aria-hidden="true" className="absolute inset-y-0 w-px bg-foam" style={{ left: `${position}%` }} />
          </div>
          <figcaption className="mt-2 flex justify-between text-[12px]">
            <span>Before · {dateLabel(before.takenOn)}</span>
            <span>After · {dateLabel(after.takenOn)}</span>
          </figcaption>
          <label htmlFor={slider} className="sr-only">
            Compare position: percent of the before photo shown
          </label>
          <input
            id={slider}
            type="range"
            min={0}
            max={100}
            value={position}
            onChange={(event) => setPosition(Number(event.target.value))}
            aria-valuetext={`${position}% before, ${100 - position}% after`}
            className="mt-2 w-full accent-sonar"
          />
        </figure>
      ) : null}
      <Button variant="outline" size="lg" className="mt-3 w-full" onClick={onClose}>
        Done
      </Button>
    </Sheet>
  );
}
