import { runtimeConfig } from './config.js';
import { rateLimited } from './errors.js';
import { DAY, HOUR } from './time.js';

/**
 * Send limits for sign-in codes, on top of the per-route IP limit. Each code
 * costs money and can be abused to spam a phone, so they are keyed on where
 * the code goes, not on what the caller typed.
 *
 * In-memory: correct for the single API instance we run today. A second
 * instance needs these counters in a shared store.
 */

/** SHARK_OTP_RESEND_COOLDOWN_SEC, SHARK_OTP_MAX_PER_DESTINATION_PER_DAY and
 * SHARK_OTP_MAX_PER_IP_PER_HOUR, validated at boot by lib/config.ts. */
export const OTP_LIMITS = runtimeConfig.otp.limits;

type Window = { count: number; resetAt: number };
const windows = new Map<string, Window>();

function take(key: string, max: number, windowMs: number, at: number): void {
  const current = windows.get(key);
  if (!current || current.resetAt <= at) {
    windows.set(key, { count: 1, resetAt: at + windowMs });
    return;
  }
  if (current.count >= max) throw rateLimited(Math.ceil((current.resetAt - at) / 1000));
  current.count += 1;
}

/** Checks the caller's IP. Runs for every request, known member or not. */
export function takeIpSend(ip: string, at = Date.now()): void {
  take(`ip:${ip}`, OTP_LIMITS.perIpPerHour, HOUR, at);
}

/** Checks the resend cooldown and daily cap for one phone or email. */
export function takeDestinationSend(destination: string, at = Date.now()): void {
  take(`cool:${destination}`, 1, OTP_LIMITS.resendCooldownMs, at);
  take(`day:${destination}`, OTP_LIMITS.perDestinationPerDay, DAY, at);
}

export function resetOtpLimits(): void {
  windows.clear();
}
