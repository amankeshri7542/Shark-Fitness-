import { Link } from '@tanstack/react-router';
import { useActiveBranch } from '../lib/store';
import { ScreenBody, Stack } from '../ui/shell';
import { Display, Eyebrow, Panel, SectionRule } from '../ui/primitives';

/**
 * Help. Plain register: support is one of the surfaces where the predator
 * voice is never used (docs/DESIGN.md "Voice").
 */
export default function HelpScreen() {
  const branch = useActiveBranch();
  const phone = branch?.phone ?? null;

  return (
    <ScreenBody>
      <Stack>
        <div>
          <Eyebrow>Help</Eyebrow>
          <Display size="md" className="mt-1.5">
            How can we help
          </Display>
        </div>

        <div>
          <SectionRule>Talk to the gym</SectionRule>
          <Panel className="flex flex-col gap-3 p-4">
            <p className="text-[13px] leading-relaxed text-foam-65">
              Questions about your membership, a payment, a class or your plan go to the front desk or your coach.
            </p>
            <Link to="/messages" className="sf-btn">
              Send a message
            </Link>
            {phone ? (
              <a href={`tel:${phone.replace(/[^\d+]/g, '')}`} className="sf-btn">
                Call {branch?.name ?? 'reception'} · {phone}
              </a>
            ) : null}
            {branch ? (
              <p className="text-[12px] leading-relaxed text-foam-50">
                {branch.name}: open {branch.opensAt}–{branch.closesAt}. {branch.addressLine}, {branch.city}.
              </p>
            ) : null}
          </Panel>
        </div>

        <div>
          <SectionRule>Using the app</SectionRule>
          <Panel className="flex flex-col divide-y divide-line">
            <HelpItem title="No signal on the gym floor?">
              Log your sets anyway. They are saved on this phone and upload on their own when you are back online. Home,
              your plan and the class list show what was last saved.
            </HelpItem>
            <HelpItem title="Getting in">
              Show your pass at reception. If the app is offline, give your member number; reception can check you in
              by hand.
            </HelpItem>
            <HelpItem title="Notifications">
              Turn them on or off in Profile › Phone notifications. On iPhone, add the app to your Home Screen first
              (Profile › More › Install app).
            </HelpItem>
            <HelpItem title="A shared phone">
              Sign out from Profile when you are done. It removes your data from the phone, including anything saved for
              offline use.
            </HelpItem>
            <HelpItem title="Your data">
              Export, consent and deletion requests are in Profile › Your data and Export and deletion.
            </HelpItem>
          </Panel>
        </div>
      </Stack>
    </ScreenBody>
  );
}

function HelpItem({ title, children }: { title: string; children: string }) {
  return (
    <div className="p-4">
      <h2 className="font-body text-[14px] font-semibold normal-case tracking-normal">{title}</h2>
      <p className="mt-1 text-[13px] leading-relaxed text-foam-65">{children}</p>
    </div>
  );
}
