/**
 * The lead form's rules, kept free of the DOM so they can be unit-tested.
 * The API is the authority (packages/contracts PublicLeadInput); these
 * mirror it so most mistakes are caught before a request is spent — the
 * public endpoints allow five submissions per ten minutes.
 */

export interface FormValues {
  name: string;
  phone: string;
  email: string;
  branchId: string;
  goal: string;
  preferredTime: string;
  classSessionId: string;
  message: string;
  consentProcessing: boolean;
  consentMarketing: boolean;
  website: string;
}

export type FieldErrors = Record<string, string>;

/** The order fields appear in, so focus lands on the first problem on screen. */
export const FIELD_ORDER = ['name', 'phone', 'email', 'branchId', 'classSessionId', 'preferredTime', 'message', 'consent.processing'] as const;

/** Mirrors toE164Phone in @shark/contracts (default +91); a unit test keeps them in step. */
export function toE164(raw: string): string | null {
  const trimmed = raw.trim();
  if (!/^\+?[\d\s().-]+$/.test(trimmed)) return null;
  const digits = trimmed.replace(/\D/g, '');
  let international: string;
  if (trimmed.startsWith('+')) international = digits;
  else if (digits.startsWith('00')) international = digits.slice(2);
  else if (digits.length === 12 && digits.startsWith('91')) international = digits;
  else if (digits.length === 11 && digits.startsWith('0')) international = `91${digits.slice(1)}`;
  else if (digits.length === 10) international = `91${digits}`;
  else return null;
  if (international.startsWith('91')) {
    const national = international.slice(2);
    return /^[1-9]\d{9}$/.test(national) ? `+91${national}` : null;
  }
  return /^[1-9]\d{7,14}$/.test(international) ? `+${international}` : null;
}

export function validate(values: FormValues, kind: 'trial' | 'contact'): FieldErrors {
  const errors: FieldErrors = {};
  const name = values.name.trim();
  if (name.length < 2) errors.name = 'Enter your name.';
  else if (name.length > 80) errors.name = 'Keep your name under 80 characters.';
  if (!values.phone.trim()) errors.phone = 'Enter a mobile number so we can call you.';
  else if (!toE164(values.phone)) errors.phone = 'Enter a 10-digit mobile number, or include the country code.';
  if (values.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(values.email.trim())) {
    errors.email = 'Enter a valid email address, or leave it empty.';
  }
  if (!values.branchId) errors.branchId = 'Choose a branch.';
  if (kind === 'trial' && !values.classSessionId && !values.preferredTime) {
    errors.preferredTime = 'Pick a class or tell us when you would like to come in.';
  }
  if (kind === 'contact' && !values.message.trim()) errors.message = 'Tell us what you would like to know.';
  if (values.message.length > 1000) errors.message = 'Keep the message under 1,000 characters.';
  if (!values.consentProcessing) errors['consent.processing'] = 'We need your permission to use these details to call you back.';
  return errors;
}

export interface Attribution {
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  utm_term?: string;
  utm_content?: string;
  ref?: string;
}

export function payload(values: FormValues, attribution: Attribution, noticeVersion: string, formStartedAt: number) {
  return {
    name: values.name.trim(),
    phone: values.phone.trim(),
    ...(values.email.trim() ? { email: values.email.trim() } : {}),
    branchId: values.branchId,
    ...(values.goal ? { goal: values.goal } : {}),
    ...(values.preferredTime ? { preferredTime: values.preferredTime } : {}),
    ...(values.classSessionId ? { classSessionId: values.classSessionId } : {}),
    ...(values.message.trim() ? { message: values.message.trim() } : {}),
    consent: { processing: values.consentProcessing, marketing: values.consentMarketing, noticeVersion },
    utm: {
      ...(attribution.utm_source ? { source: attribution.utm_source } : {}),
      ...(attribution.utm_medium ? { medium: attribution.utm_medium } : {}),
      ...(attribution.utm_campaign ? { campaign: attribution.utm_campaign } : {}),
      ...(attribution.utm_term ? { term: attribution.utm_term } : {}),
      ...(attribution.utm_content ? { content: attribution.utm_content } : {}),
    },
    ...(attribution.ref ? { referralCode: attribution.ref } : {}),
    website: values.website,
    formStartedAt,
  };
}

/** The API's 422 field paths onto this form's fields; anything else becomes a general message. */
export function fieldErrorsFrom(fields: Array<{ path: string; message: string }>): FieldErrors {
  const errors: FieldErrors = {};
  for (const field of fields) {
    const key = (FIELD_ORDER as readonly string[]).includes(field.path) ? field.path : field.path.startsWith('consent') ? 'consent.processing' : '_form';
    errors[key] ??= field.message;
  }
  return errors;
}

export function firstInvalid(errors: FieldErrors): string | undefined {
  return FIELD_ORDER.find((field) => errors[field]);
}

/** Summary sentence for the live region. */
export function summary(errors: FieldErrors): string {
  const count = Object.keys(errors).filter((k) => k !== '_form').length;
  if (count === 0) return errors._form ?? '';
  return count === 1 ? `One field needs attention: ${Object.values(errors)[0]}` : `${count} fields need attention. The first is highlighted.`;
}
