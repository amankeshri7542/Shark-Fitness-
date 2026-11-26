import type { PublicClasses } from '@shark/contracts';
import { SPOTS_LABEL, clock12, getJson, shortDay } from './api';

/**
 * "This week" on the Classes page: the next seven days for one branch with
 * live availability. The weekly pattern above it is built in and stays
 * correct without this; here a visitor sees real dates and which classes
 * are filling up. No member data reaches the page — only "Spaces", "Few
 * left" or "Full".
 */
export function mountLiveClasses(root: HTMLElement): void {
  const select = root.querySelector<HTMLSelectElement>('select')!;
  const output = root.querySelector<HTMLElement>('[data-live-output]')!;
  const state = root.querySelector<HTMLElement>('[data-live-state]')!;
  let request = 0;

  async function load(): Promise<void> {
    const mine = ++request;
    state.textContent = 'Loading this week’s classes…';
    try {
      const data = await getJson<PublicClasses>(`/classes?branchId=${encodeURIComponent(select.value)}`);
      if (mine !== request) return;
      render(data);
      state.textContent = data.items.length ? '' : 'No classes are scheduled here in the next seven days.';
    } catch {
      if (mine !== request) return;
      output.replaceChildren();
      state.textContent = 'Live availability is not available right now. The weekly timetable above is current.';
    }
  }

  function render(data: PublicClasses): void {
    const byDay = new Map<string, PublicClasses['items']>();
    for (const item of data.items) byDay.set(item.date, [...(byDay.get(item.date) ?? []), item]);
    const days = [...byDay.entries()].map(([date, items]) => {
      const section = document.createElement('section');
      section.className = 'cell day';
      const heading = document.createElement('h3');
      heading.textContent = shortDay(date);
      const list = document.createElement('ul');
      list.className = 'slots';
      for (const item of items) {
        const row = document.createElement('li');
        row.className = 'slot';
        const time = document.createElement('time');
        time.dateTime = item.startsAt;
        time.textContent = clock12(item.startTime);
        const body = document.createElement('div');
        const name = document.createElement('strong');
        name.textContent = item.name;
        const meta = document.createElement('div');
        meta.className = 'slot__meta';
        meta.textContent = `${item.durationMin} min${item.coach ? ` · with ${item.coach}` : ''}`;
        body.append(name, meta);
        const spots = document.createElement('span');
        spots.className = `spots spots--${item.spots}`;
        spots.textContent = SPOTS_LABEL[item.spots] ?? item.spots;
        row.append(time, body, spots);
        list.append(row);
      }
      section.append(heading, list);
      return section;
    });
    output.replaceChildren(...days);
  }

  root.hidden = false;
  select.addEventListener('change', () => void load());
  void load();
}
