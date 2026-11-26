import { Chip, Label } from './console';

/** What the API reports for each notification channel (P07). */
export interface ChannelAvailability {
  channel: 'in_app' | 'push' | 'email' | 'sms' | 'whatsapp';
  available: boolean;
  delivers: boolean;
  driver: string;
  label: string;
  note: string;
}

/**
 * The real state of every channel, in one line each: "Delivers", "Logged
 * only" (the log driver: recorded, nobody receives it) or "Not set up". An
 * operator choosing SMS for a rule or a broadcast sees this before they find
 * out from a member that nothing arrived.
 */
export function ChannelStrip({ channels }: { channels: ChannelAvailability[] }) {
  return (
    <section aria-label="Message channels" className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line px-4 py-2.5">
      <Label>Channels</Label>
      <ul className="flex flex-wrap items-center gap-x-4 gap-y-2">
        {channels.map((c) => (
          <li key={c.channel} className="flex items-center gap-1.5" title={c.note}>
            <span className="text-[12px] text-foam">{c.label}</span>
            <Chip tone={channelTone(c)}>{channelState(c)}</Chip>
            <span className="sr-only">{c.note}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function channelState(c: Pick<ChannelAvailability, 'available' | 'delivers'>): string {
  if (!c.available) return 'Not set up';
  return c.delivers ? 'Delivers' : 'Logged only';
}

export function channelTone(c: Pick<ChannelAvailability, 'available' | 'delivers'>): 'good' | 'warn' | 'bad' {
  if (!c.available) return 'bad';
  return c.delivers ? 'good' : 'warn';
}
