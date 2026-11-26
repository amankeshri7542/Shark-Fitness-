import { useState, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { promptInstall, useInstallOption } from '../lib/install';
import { Chip, SectionRule, cx } from './primitives';
import { IosInstallSheet } from './Install';

const row =
  'flex min-h-[56px] w-full cursor-pointer items-center gap-3 border-b border-line px-4 text-left last:border-b-0 hover:bg-wash-sonar-soft';

function RowText({ title, hint }: { title: string; hint: string }) {
  return (
    <span className="min-w-0 flex-1 py-2.5">
      <span className="block text-[14px]">{title}</span>
      <span className="mt-0.5 block text-[12px] leading-snug text-foam-50">{hint}</span>
    </span>
  );
}

const Arrow = () => (
  <span aria-hidden="true" className="font-display text-[16px] leading-none text-foam-35">
    ›
  </span>
);

function LinkRow({ to, title, hint }: { to: '/billing' | '/library' | '/messages' | '/help'; title: string; hint: string }) {
  return (
    <Link to={to} className={row}>
      <RowText title={title} hint={hint} />
      <Arrow />
    </Link>
  );
}

function ButtonRow({ title, hint, onClick, trailing }: { title: string; hint: string; onClick?: () => void; trailing?: ReactNode }) {
  return (
    <button type="button" onClick={onClick} disabled={!onClick} className={cx(row, !onClick && 'cursor-default hover:bg-transparent')}>
      <RowText title={title} hint={hint} />
      {trailing ?? <Arrow />}
    </button>
  );
}

/**
 * Everything that is not a tab, two taps from Home at most (Home → Profile →
 * here): billing, the exercise library, messages, installing the app, help.
 */
export function MoreMenu() {
  const install = useInstallOption();
  const [iosSheet, setIosSheet] = useState(false);
  const [manualHint, setManualHint] = useState(false);

  return (
    <div>
      <SectionRule>More</SectionRule>
      <nav aria-label="More" className="border border-line">
        <LinkRow to="/billing" title="Billing" hint="Membership, invoices and receipts" />
        <LinkRow to="/library" title="Library" hint="Exercise demos and how-tos" />
        <LinkRow to="/messages" title="Messages" hint="Your coach and the front desk" />
        {install === 'installed' ? (
          <ButtonRow title="Install app" hint="Shark is installed on this device." trailing={<Chip tone="good">Installed</Chip>} />
        ) : (
          <ButtonRow
            title="Install app"
            hint={
              manualHint
                ? "Use your browser's menu and choose Install app or Add to Home screen."
                : 'Open Shark from your home screen, full screen.'
            }
            onClick={() => {
              if (install === 'prompt') void promptInstall();
              else if (install === 'ios') setIosSheet(true);
              else setManualHint(true);
            }}
          />
        )}
        <LinkRow to="/help" title="Help" hint="Contact the gym, opening hours, how the app works" />
      </nav>
      {iosSheet ? <IosInstallSheet onClose={() => setIosSheet(false)} /> : null}
    </div>
  );
}
