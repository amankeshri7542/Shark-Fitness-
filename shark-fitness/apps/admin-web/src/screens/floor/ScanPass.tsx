import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { useMutation } from '@tanstack/react-query';
import { ApiError, api, idempotencyKey } from '../../lib/api';
import { Button, Chip, Field, Panel, SelectField, TextAreaField, cx } from '../../ui/console';

/**
 * Reception scans a member's rotating pass (UX-A08, PF-ATT-001/005).
 *
 * Three ways in, one endpoint: the console camera (BarcodeDetector where the
 * browser has it, otherwise a pinned JS decoder loaded only when the camera is
 * opened), a USB keyboard-wedge scanner (it types the code and presses Enter
 * into the code box) and a pasted code. The camera is never required: when it
 * is blocked or missing, the code box is the fallback and says so.
 */

export interface ScanResult {
  granted: boolean;
  outcome: 'admitted' | 'already_checked_in' | 'denied';
  decision: string;
  checkInId: string | null;
  denialCheckInId: string | null;
  overridable: boolean;
  canOverride: boolean;
  memberId: string | null;
  memberNo: string | null;
  initials: string | null;
  memberName: string | null;
  branchName: string | null;
  message: string | null;
  visitNumber: number | null;
  occupancy: { inside: number; capacity: number; label: string } | null;
}

export const SCAN_DECISION_LABEL: Record<string, string> = {
  granted: 'Admitted',
  denied_membership_inactive: 'Membership inactive',
  denied_grace_outstanding: 'Balance outstanding',
  denied_branch_not_permitted: 'Not entitled to this branch',
  denied_branch_closed: 'Branch closed',
  denied_outside_hours: 'Outside plan hours',
  denied_capacity: 'At capacity',
  denied_suspended: 'Suspended',
  denied_anti_passback: 'Just checked in elsewhere',
  denied_token_invalid: 'Not a valid pass',
  denied_token_expired: 'Code expired',
  denied_token_replayed: 'Code already used',
  denied_wrong_tenant: 'Pass from another gym',
};

type CameraState = 'off' | 'starting' | 'scanning' | 'denied' | 'unavailable';

interface Detector {
  detect: (source: HTMLVideoElement) => Promise<Array<{ rawValue: string }>>;
}

/** BarcodeDetector where it exists and reads QR codes; null otherwise. */
async function nativeDetector(): Promise<Detector | null> {
  const Ctor = (globalThis as { BarcodeDetector?: { new (o: { formats: string[] }): Detector; getSupportedFormats?: () => Promise<string[]> } })
    .BarcodeDetector;
  if (!Ctor) return null;
  try {
    const formats = (await Ctor.getSupportedFormats?.()) ?? ['qr_code'];
    return formats.includes('qr_code') ? new Ctor({ formats: ['qr_code'] }) : null;
  } catch {
    return null;
  }
}

/** The JS fallback decoder, fetched only when a camera scan starts. */
async function jsDetector(): Promise<Detector> {
  const { default: jsQR } = await import('jsqr');
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d', { willReadFrequently: true });
  return {
    detect: async (video) => {
      if (!context || video.videoWidth === 0) return [];
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const frame = context.getImageData(0, 0, canvas.width, canvas.height);
      const found = jsQR(frame.data, frame.width, frame.height, { inversionAttempts: 'dontInvert' });
      return found ? [{ rawValue: found.data }] : [];
    },
  };
}

export function ScanPass({
  branches,
  defaultBranchId,
  online,
  canOverride,
  onDone,
}: {
  branches: Array<{ branchId: string; branchName: string }>;
  defaultBranchId: string | null;
  online: boolean;
  canOverride: boolean;
  /** Something changed on the floor: refresh occupancy and the feed. */
  onDone: () => void;
}) {
  const [branchId, setBranchId] = useState<string>(defaultBranchId ?? branches[0]?.branchId ?? '');
  const [code, setCode] = useState('');
  const [result, setResult] = useState<ScanResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [camera, setCamera] = useState<CameraState>('off');
  const [overrideReason, setOverrideReason] = useState('');
  const [overridden, setOverridden] = useState<string | null>(null);
  const inputId = useId();
  const focusCodeBox = () => document.getElementById(inputId)?.focus();
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const loopRef = useRef<number | null>(null);
  const resultId = useId();

  // The branch list can arrive after first render; never scan "nowhere".
  const effectiveBranch = defaultBranchId ?? (branchId || branches[0]?.branchId || '');

  const scan = useMutation({
    mutationFn: (token: string) =>
      api<ScanResult>('/admin/attendance/scan', {
        method: 'POST',
        body: { token, branchId: effectiveBranch },
        branchId: effectiveBranch,
        idempotencyKey: idempotencyKey('scan', effectiveBranch),
      }),
    onSuccess: (data) => {
      setError(null);
      setOverridden(null);
      setOverrideReason('');
      setResult(data);
      onDone();
    },
    onError: (err) => {
      setResult(null);
      setError(err instanceof ApiError ? err.message : 'That scan did not reach the server. Nobody was checked in. Try again.');
    },
  });

  const override = useMutation({
    mutationFn: (input: { checkInId: string; reason: string }) =>
      api<{ member: { name: string } }>('/admin/attendance/override', { method: 'POST', body: input, branchId: effectiveBranch }),
    onSuccess: (data) => {
      setOverridden(`${data.member.name} was let in. The reason is on the record.`);
      onDone();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'The override did not go through. Nothing changed.'),
  });

  const submit = useCallback(
    (raw: string) => {
      const token = raw.trim();
      if (token.length < 20 || scan.isPending || !effectiveBranch) return;
      setCode('');
      scan.mutate(token);
    },
    [effectiveBranch, scan],
  );

  const stopCamera = useCallback(() => {
    if (loopRef.current !== null) cancelAnimationFrame(loopRef.current);
    loopRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }, []);

  useEffect(() => stopCamera, [stopCamera]);

  const startCamera = async () => {
    setError(null);
    if (!navigator.mediaDevices?.getUserMedia) {
      setCamera('unavailable');
      focusCodeBox();
      return;
    }
    setCamera('starting');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
      streamRef.current = stream;
      const video = videoRef.current;
      if (!video) return;
      video.srcObject = stream;
      await video.play().catch(() => undefined);
      const detector = (await nativeDetector()) ?? (await jsDetector());
      setCamera('scanning');
      const tick = async () => {
        if (!streamRef.current) return;
        const found = await detector.detect(video).catch(() => []);
        const value = found[0]?.rawValue;
        if (value) {
          stopCamera();
          setCamera('off');
          submit(value);
          return;
        }
        loopRef.current = requestAnimationFrame(() => void tick());
      };
      void tick();
    } catch (err) {
      stopCamera();
      const name = err instanceof DOMException ? err.name : '';
      setCamera(name === 'NotAllowedError' || name === 'SecurityError' ? 'denied' : 'unavailable');
      focusCodeBox();
    }
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    submit(code);
  };

  return (
    <div className="flex flex-col gap-3 p-3.5">
      <form onSubmit={onSubmit} className="flex flex-wrap items-end gap-3">
        {defaultBranchId === null && branches.length > 1 ? (
          <SelectField
            label="Scanning at"
            value={effectiveBranch}
            onChange={(e) => setBranchId(e.target.value)}
            options={branches.map((b) => ({ value: b.branchId, label: b.branchName }))}
            className="w-[200px]"
          />
        ) : null}
        <Field
          id={inputId}
          label="Pass code"
          placeholder="Scan with a USB scanner, or paste the code"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          onPaste={(e) => {
            const pasted = e.clipboardData.getData('text');
            if (pasted.trim().length >= 20) {
              e.preventDefault();
              submit(pasted);
            }
          }}
          autoComplete="off"
          spellCheck={false}
          hint="A USB scanner types the code and presses Enter here."
          className="min-w-[260px] flex-1"
        />
        <Button type="submit" variant="cta" disabled={!online || code.trim().length < 20} pending={scan.isPending} pendingLabel="Checking…">
          Check pass
        </Button>
        {camera === 'scanning' || camera === 'starting' ? (
          <Button
            variant="outline"
            onClick={() => {
              stopCamera();
              setCamera('off');
            }}
          >
            Stop camera
          </Button>
        ) : (
          <Button variant="outline" disabled={!online} onClick={() => void startCamera()}>
            Scan with camera
          </Button>
        )}
      </form>

      {camera === 'starting' || camera === 'scanning' ? (
        <div className="relative w-full max-w-[360px] border border-line-accent bg-abyss">
          {/* Muted, inline, and never recorded: frames are read and dropped. */}
          <video ref={videoRef} muted playsInline aria-label="Camera view for scanning a member pass" className="block aspect-[4/3] w-full object-cover" />
          <p className="px-3 py-2 text-[12px] text-foam-65" role="status">
            {camera === 'starting' ? 'Starting the camera…' : 'Hold the member’s code inside the frame.'}
          </p>
        </div>
      ) : (
        <video ref={videoRef} muted playsInline hidden />
      )}

      {camera === 'denied' ? (
        <Panel tone="warn">
          <p className="px-3.5 py-2.5 text-[12px] leading-relaxed" role="alert">
            Camera access is blocked for this console. Type or paste the member’s code above, or use a USB scanner. To use the
            camera, allow it in the browser’s site settings and try again.
          </p>
        </Panel>
      ) : camera === 'unavailable' ? (
        <Panel tone="warn">
          <p className="px-3.5 py-2.5 text-[12px] leading-relaxed" role="alert">
            No camera is available on this machine. Type or paste the member’s code above, or use a USB scanner.
          </p>
        </Panel>
      ) : null}

      {error ? (
        <Panel tone="bad">
          <p className="px-3.5 py-2.5 text-[12px] leading-relaxed" role="alert">
            {error}
          </p>
        </Panel>
      ) : null}

      {result ? (
        <ScanOutcome
          id={resultId}
          result={result}
          canOverride={canOverride && result.canOverride && !overridden}
          overrideReason={overrideReason}
          setOverrideReason={setOverrideReason}
          overriding={override.isPending}
          overridden={overridden}
          onOverride={() =>
            result.denialCheckInId && override.mutate({ checkInId: result.denialCheckInId, reason: overrideReason.trim() })
          }
        />
      ) : null}
    </div>
  );
}

function ScanOutcome({
  id,
  result,
  canOverride,
  overrideReason,
  setOverrideReason,
  overriding,
  overridden,
  onOverride,
}: {
  id: string;
  result: ScanResult;
  canOverride: boolean;
  overrideReason: string;
  setOverrideReason: (value: string) => void;
  overriding: boolean;
  overridden: string | null;
  onOverride: () => void;
}) {
  const tone = result.outcome === 'admitted' ? 'good' : result.outcome === 'already_checked_in' ? 'accent' : 'bad';
  const heading =
    result.outcome === 'admitted'
      ? 'Admitted'
      : result.outcome === 'already_checked_in'
        ? 'Already checked in'
        : `Refused: ${SCAN_DECISION_LABEL[result.decision] ?? 'entry refused'}`;

  return (
    <Panel tone={tone === 'accent' ? 'plain' : tone} className="border border-line">
      <div aria-live="polite" aria-labelledby={`${id}-heading`} className="flex items-start gap-3 p-3.5">
        <span
          aria-hidden="true"
          className={cx(
            'grid h-12 w-12 flex-none place-items-center border font-display text-[18px]',
            tone === 'good' ? 'border-kelp text-kelp' : tone === 'bad' ? 'border-chum text-chum' : 'border-sonar text-sonar',
          )}
        >
          {result.initials ?? '?'}
        </span>
        <div className="min-w-0 flex-1">
          <h3 id={`${id}-heading`} className="font-display text-[20px] uppercase leading-none tracking-[0.02em]">
            {heading}
          </h3>
          <p className="mt-1.5 text-[14px]">
            {result.memberName ?? 'Unknown pass'}
            {result.memberNo ? <span className="text-foam-65"> · {result.memberNo}</span> : null}
          </p>
          {result.outcome === 'admitted' && result.visitNumber ? (
            <p className="mt-1 text-[12px] text-foam-65">Visit {result.visitNumber}</p>
          ) : null}
          {result.outcome === 'denied' && result.message ? (
            <p className="mt-1 text-[12px] leading-relaxed text-foam-65">Tell the member: “{result.message}”</p>
          ) : null}
          {result.occupancy ? (
            <div className="mt-2">
              <Chip tone="neutral">
                {result.occupancy.inside}/{result.occupancy.capacity} inside
              </Chip>
            </div>
          ) : null}
        </div>
      </div>

      {overridden ? (
        <p className="border-t border-line px-3.5 py-2.5 text-[12px]" role="status">
          {overridden}
        </p>
      ) : canOverride ? (
        <div className="flex flex-wrap items-end gap-3 border-t border-line px-3.5 py-3">
          <TextAreaField
            label="Reason to let them in"
            rows={2}
            value={overrideReason}
            onChange={(e) => setOverrideReason(e.target.value)}
            hint="At least 4 characters. Recorded against your name."
            className="min-w-[260px] flex-1"
          />
          <Button variant="cta" disabled={overrideReason.trim().length < 4} pending={overriding} pendingLabel="Letting in…" onClick={onOverride}>
            Let them in
          </Button>
        </div>
      ) : result.outcome === 'denied' && result.overridable ? (
        <p className="border-t border-line px-3.5 py-2.5 text-[12px] text-foam-65">
          A manager can override this refusal from the door feed below.
        </p>
      ) : null}
    </Panel>
  );
}
