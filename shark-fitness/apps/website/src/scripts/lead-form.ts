import type { PublicClasses } from '@shark/contracts';
import { SPOTS_LABEL, clock12, getJson, publicUrl, shortDay } from './api';
import { fieldErrorsFrom, firstInvalid, payload, summary, validate, type Attribution, type FieldErrors, type FormValues } from './form-logic';

/**
 * The free-trial and contact forms. Plain HTML controls, so the whole form
 * works from the keyboard; this script adds validation that is announced
 * (aria-live summary, errors tied to fields with aria-describedby) and moves
 * focus to the first problem, then posts to the public API.
 */

const FIELD_ELEMENT: Record<string, string> = {
  name: 'name',
  phone: 'phone',
  email: 'email',
  branchId: 'branchId',
  preferredTime: 'preferredTime',
  message: 'message',
  'consent.processing': 'consentProcessing',
};

function attribution(): Attribution {
  try {
    const stored = sessionStorage.getItem('sf.attribution');
    return stored ? (JSON.parse(stored) as Attribution) : {};
  } catch {
    return {};
  }
}

function newKey(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `k${Date.now()}${Math.random().toString(36).slice(2)}`;
}

export function mountLeadForm(root: HTMLElement): void {
  const kind = root.dataset.leadForm === 'trial' ? 'trial' : 'contact';
  const form = root.querySelector('form')!;
  const status = root.querySelector<HTMLElement>('#form-status')!;
  const done = root.querySelector<HTMLElement>('[data-form-done]')!;
  const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  const branch = form.querySelector<HTMLSelectElement>('#branchId')!;
  const classList = form.querySelector<HTMLElement>('[data-class-list]');
  const classStatus = form.querySelector<HTMLElement>('[data-class-status]');
  const params = new URLSearchParams(location.search);
  const planId = params.get('plan') ?? undefined;

  let formStartedAt = 0;
  let idempotencyKey = newKey();
  let shownErrors: FieldErrors = {};
  const markStarted = () => {
    if (!formStartedAt) formStartedAt = Date.now();
  };
  form.addEventListener('focusin', markStarted);
  form.addEventListener('input', markStarted);

  // ?branch=koramangala (branch pages link here with it).
  const wanted = params.get('branch');
  if (wanted) {
    const option = [...branch.options].find((o) => o.dataset.slug === wanted || o.value === wanted);
    if (option) branch.value = option.value;
  }

  const values = (): FormValues => {
    const data = new FormData(form);
    const text = (key: string) => String(data.get(key) ?? '');
    return {
      name: text('name'),
      phone: text('phone'),
      email: text('email'),
      branchId: text('branchId'),
      goal: text('goal'),
      preferredTime: text('preferredTime'),
      classSessionId: text('classSessionId'),
      message: text('message'),
      consentProcessing: data.get('consentProcessing') === 'on',
      consentMarketing: data.get('consentMarketing') === 'on',
      website: text('website'),
    };
  };

  function elementFor(field: string): HTMLElement | null {
    if (field === 'classSessionId') {
      return form.querySelector<HTMLInputElement>('input[name="classSessionId"]:checked') ?? form.querySelector<HTMLInputElement>('input[name="classSessionId"]');
    }
    const id = FIELD_ELEMENT[field];
    return id ? form.querySelector<HTMLElement>(`#${id}`) : null;
  }

  function show(errors: FieldErrors, focus: boolean): void {
    shownErrors = errors;
    for (const slot of form.querySelectorAll<HTMLElement>('[data-error-for]')) {
      const field = slot.dataset.errorFor!;
      slot.textContent = errors[field] ?? '';
      const element = elementFor(field);
      if (element) {
        if (errors[field]) element.setAttribute('aria-invalid', 'true');
        else element.removeAttribute('aria-invalid');
      }
    }
    status.textContent = summary(errors);
    const first = firstInvalid(errors);
    if (focus && first) elementFor(first)?.focus();
  }

  // Once an error is shown, re-check that field as the visitor fixes it.
  form.addEventListener('input', (event) => {
    const target = event.target as HTMLInputElement;
    const field = Object.entries(FIELD_ELEMENT).find(([, id]) => id === target.id)?.[0] ?? (target.name === 'classSessionId' ? 'preferredTime' : undefined);
    if (!field || !shownErrors[field]) return;
    const next = validate(values(), kind);
    const remaining = { ...shownErrors };
    if (next[field]) remaining[field] = next[field]!;
    else delete remaining[field];
    show(remaining, false);
  });

  /* — Class picker (free trial) —————————————————————————————————— */

  let classRequest = 0;
  async function loadClasses(): Promise<void> {
    if (!classList || !classStatus) return;
    const branchId = branch.value;
    const request = ++classRequest;
    classList.replaceChildren();
    if (!branchId) {
      classStatus.textContent = 'Choose a branch to see its classes for the next seven days.';
      return;
    }
    classStatus.textContent = 'Loading classes…';
    try {
      const data = await getJson<PublicClasses>(`/classes?branchId=${encodeURIComponent(branchId)}`);
      if (request !== classRequest) return;
      const items = data.items;
      const none = choice('', 'No particular class', 'I will pick a time below', null, false);
      none.querySelector('input')!.checked = true;
      classList.append(none);
      for (const item of items) {
        const label = `${shortDay(item.date)}, ${clock12(item.startTime)}: ${item.name}`;
        const detail = item.coach ? `with ${item.coach}` : '';
        classList.append(choice(item.id, label, detail, item.spots, item.spots === 'full'));
      }
      classStatus.textContent = items.length
        ? `${items.length} classes in the next seven days. Full classes cannot be picked.`
        : 'No classes are scheduled here this week. Pick a time below instead.';
    } catch {
      if (request !== classRequest) return;
      classStatus.textContent = 'Classes could not be loaded right now. Pick a time below and we will suggest one when we call.';
    }
  }

  function choice(value: string, label: string, detail: string, spots: string | null, disabled: boolean): HTMLLabelElement {
    const wrapper = document.createElement('label');
    wrapper.className = 'choice';
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'classSessionId';
    input.value = value;
    input.disabled = disabled;
    const text = document.createElement('span');
    const strong = document.createElement('strong');
    strong.textContent = label;
    text.append(strong);
    if (detail) {
      const small = document.createElement('span');
      small.className = 'muted';
      small.textContent = ` ${detail}`;
      text.append(small);
    }
    const tag = document.createElement('span');
    if (spots) {
      tag.className = `spots spots--${spots}`;
      tag.textContent = SPOTS_LABEL[spots] ?? spots;
    }
    wrapper.append(input, text, tag);
    return wrapper;
  }

  if (classList) {
    branch.addEventListener('change', () => void loadClasses());
    if (branch.value) void loadClasses();
  }

  /* — Submit ———————————————————————————————————————————————————— */

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const current = values();
    const errors = validate(current, kind);
    if (Object.keys(errors).length > 0) {
      show(errors, true);
      return;
    }
    show({}, false);
    submit.disabled = true;
    const label = submit.textContent;
    submit.textContent = 'Sending…';
    try {
      const body = { ...payload(current, attribution(), root.dataset.noticeVersion ?? '', formStartedAt || Date.now()), ...(planId ? { planId } : {}) };
      const response = await fetch(publicUrl(kind === 'trial' ? '/trial-requests' : '/leads'), {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', 'idempotency-key': idempotencyKey },
        body: JSON.stringify(body),
      });
      if (response.status === 202) {
        const receipt = (await response.json().catch(() => null)) as { message?: string } | null;
        if (receipt?.message) root.querySelector('[data-done-message]')!.textContent = receipt.message;
        form.hidden = true;
        done.hidden = false;
        done.focus();
        return;
      }
      const envelope = (await response.json().catch(() => null)) as { error?: { message?: string; fields?: Array<{ path: string; message: string }> } } | null;
      if (response.status === 422 && envelope?.error?.fields?.length) {
        // A changed body needs a new key; the API refuses a reused key with a different body.
        idempotencyKey = newKey();
        show(fieldErrorsFrom(envelope.error.fields), true);
      } else if (response.status === 429) {
        show({ _form: 'This form has been sent several times from your connection. Please wait ten minutes, or call us instead.' }, false);
        status.focus();
      } else {
        show({ _form: envelope?.error?.message ?? 'That did not go through. Check your connection and try again, or call us.' }, false);
      }
    } catch {
      show({ _form: 'That did not go through. Check your connection and try again, or call us.' }, false);
    } finally {
      submit.disabled = false;
      submit.textContent = label;
    }
  });
}
