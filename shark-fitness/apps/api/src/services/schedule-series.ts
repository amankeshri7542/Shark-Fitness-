import { and, asc, eq, gt, gte, inArray, isNotNull, ne, sql } from 'drizzle-orm';
import { channels } from '@shark/contracts';
import { db, schema, transact } from '../db/client.js';
import { branchScope, requirePermission, type RequestContext } from '../lib/context.js';
import { audit } from '../lib/audit.js';
import { emit } from '../lib/events.js';
import { invalid, notFound, precondition } from '../lib/errors.js';
import { id } from '../lib/ids.js';
import { DAY, MINUTE, addDays, isoDate, localClockOnDay, now } from '../lib/time.js';
import { branchTimeZone } from '../lib/branch-time.js';
import { detectClashes, loadSessionInScope, cancelSessions } from './schedule.js';

/**
 * Recurring classes (PF-SCH).
 *
 * A gym's timetable is a handful of rules — "Spin, Tuesdays and Thursdays,
 * 18:30, Cycle Studio, Nikhil" — and a few hundred occurrences generated from
 * them. Before this module the occurrences existed and the rules did not:
 * `class_sessions.seriesId` was a free-text key with no row behind it, so
 * "cancel the rest of the series" meant "every future row that happens to
 * share this string" and there was nothing to edit, extend or reason about.
 *
 * Four properties this module is built around.
 *
 * **Generation is idempotent.** Every occurrence is identified by
 * `(seriesId, occurrenceDate)` and a partial unique index enforces it in the
 * database. Running the generator twice, or three times concurrently, cannot
 * produce a second Tuesday — the second insert loses at the index rather than
 * relying on the service having checked first.
 *
 * **Local time is the rule; UTC is the result.** Each occurrence resolves its
 * own instant through `localClockOnDay` in the branch's zone, so a series
 * survives a DST transition holding its wall-clock time. Nothing here ever
 * adds 7 × 24 hours.
 *
 * **History is never rewritten.** Editing or cancelling touches occurrences
 * strictly in the future. A past class carries attendance and bookings, and a
 * timetable change made today must not restate what happened last Tuesday.
 *
 * **Conflicts still bind.** Every generated occurrence goes through the same
 * `detectClashes` the single-session path uses. A clashing occurrence is
 * skipped and reported rather than silently double-booking a room, and rather
 * than failing the whole series because one week has a workshop in the studio.
 */

/** How far ahead the generator materialises occurrences, in days.
 *
 *  Occurrences are real rows because bookings, waitlists and capacity all hang
 *  off them, so the horizon is a trade between rows and how far ahead members
 *  can book. Eight weeks is comfortably past the 14-day booking window the
 *  seed uses, and a scheduler job rolls it forward. */
export const SERIES_HORIZON_DAYS = 56;

const WEEKDAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

export type SeriesRow = typeof schema.classSeries.$inferSelect;

/* ============================================================================
   Calendar arithmetic

   Deliberately on date strings rather than instants: "which Tuesdays" is a
   question about a calendar, and answering it in epoch milliseconds is how a
   series drifts an hour twice a year.
   ========================================================================= */

/** 0 = Monday … 6 = Sunday, for a bare `YYYY-MM-DD`.
 *
 *  Timezone-free on purpose. A calendar date has a weekday regardless of where
 *  it is read, and parsing it as UTC keeps that true. */
export function weekdayOf(isoDay: string): number {
  return (new Date(`${isoDay}T00:00:00Z`).getUTCDay() + 6) % 7;
}

/** Whole weeks between two dates, counted from the Monday of each week, so
 *  `interval` means "every N weeks" rather than "every 7N days from the
 *  start date". */
function weeksBetween(fromDay: string, toDay: string): number {
  const startOfWeek = (day: string): number =>
    Date.parse(`${day}T00:00:00Z`) - weekdayOf(day) * DAY;
  return Math.round((startOfWeek(toDay) - startOfWeek(fromDay)) / (7 * DAY));
}

/**
 * The occurrence dates a series calls for, up to `throughDay`.
 *
 * Bounded by whichever of `endDate`, `occurrenceCount` and `throughDay` comes
 * first. `occurrenceCount` counts from the very first occurrence of the series
 * — not from the generation window — so extending the horizon never changes
 * how many occurrences a "10 sessions" course has.
 */
export function occurrenceDates(series: SeriesRow, throughDay: string): string[] {
  const weekdays = [...new Set(series.weekdays)].sort((a, b) => a - b);
  if (weekdays.length === 0) return [];

  const hardEnd =
    series.endDate !== null && series.endDate < throughDay ? series.endDate : throughDay;

  const dates: string[] = [];
  let day = series.startDate;
  // A guard rather than a condition: the loop is bounded by `hardEnd`, and
  // this only stops a corrupt row from spinning.
  const maxIterations = 366 * 5;
  for (let i = 0; i < maxIterations && day <= hardEnd; i += 1, day = addDays(day, 1)) {
    if (!weekdays.includes(weekdayOf(day))) continue;
    if (series.interval > 1 && weeksBetween(series.startDate, day) % series.interval !== 0) continue;
    dates.push(day);
    if (series.occurrenceCount !== null && dates.length >= series.occurrenceCount) break;
  }
  return dates;
}

/* ============================================================================
   Loads and validation
   ========================================================================= */

export function loadSeriesInScope(ctx: { tenantId: string; branchIds: string[] }, seriesId: string): SeriesRow {
  const series = db
    .select()
    .from(schema.classSeries)
    .where(and(eq(schema.classSeries.id, seriesId), eq(schema.classSeries.tenantId, ctx.tenantId)))
    .get();
  // Not found rather than forbidden: a 403 confirms a series exists at a
  // branch the caller may not see.
  if (!series || !branchScope(ctx).includes(series.branchId)) throw notFound('That series');
  return series;
}

interface SeriesResources {
  branchId: string;
  classTypeId: string;
  roomId: string | null;
  trainerId: string | null;
  capacity: number;
}

/** The same resource checks the single-session path makes, applied once to the
 *  rule rather than once per occurrence. */
function assertSeriesResources(tenantId: string, input: SeriesResources) {
  const classType = db
    .select()
    .from(schema.classTypes)
    .where(and(eq(schema.classTypes.id, input.classTypeId), eq(schema.classTypes.tenantId, tenantId)))
    .get();
  if (!classType) throw invalid('That class type does not exist.');

  if (input.roomId) {
    const room = db
      .select()
      .from(schema.rooms)
      .where(and(eq(schema.rooms.id, input.roomId), eq(schema.rooms.tenantId, tenantId)))
      .get();
    if (!room) throw invalid('That room does not exist.');
    if (room.branchId !== input.branchId) throw invalid('That room belongs to another branch.');
    if (input.capacity > room.capacity) {
      throw invalid(`This room seats ${room.capacity}. Reduce the class capacity or choose a bigger room.`);
    }
  }

  if (input.trainerId) {
    const trainer = db
      .select({ branchIds: schema.staff.branchIds })
      .from(schema.staff)
      .where(and(eq(schema.staff.id, input.trainerId), eq(schema.staff.tenantId, tenantId)))
      .get();
    if (!trainer) throw invalid('That trainer does not exist.');
    if (!trainer.branchIds.includes(input.branchId)) throw invalid('That trainer is not assigned to this branch.');
  }

  return classType;
}

export interface SeriesInput {
  branchId: string;
  classTypeId: string;
  roomId: string | null;
  trainerId: string | null;
  weekdays: number[];
  interval: number;
  startDate: string;
  endDate: string | null;
  occurrenceCount: number | null;
  startTime: string;
  durationMin: number | null;
  capacity: number;
  creditsRequired: number;
  dropInPriceMinor: number | null;
  lateCancelFeeMinor: number;
  waitlistEnabled: boolean;
  bookingOpensMinBefore: number | null;
  cancelDeadlineMinBefore: number | null;
  notes: string | null;
}

function validateRecurrence(input: {
  weekdays: number[];
  interval: number;
  startDate: string;
  endDate: string | null;
  occurrenceCount: number | null;
  capacity: number;
}) {
  if (input.weekdays.length === 0) throw invalid('Pick at least one day of the week.');
  if (input.weekdays.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
    throw invalid('Days of the week must be 0 (Monday) to 6 (Sunday).');
  }
  if (input.interval < 1 || input.interval > 12) throw invalid('Repeat every 1 to 12 weeks.');
  if (input.capacity < 1) throw invalid('A class needs at least one seat.');
  if (input.endDate !== null && input.occurrenceCount !== null) {
    throw invalid('A series ends on a date or after a number of classes, not both.');
  }
  if (input.endDate !== null && input.endDate < input.startDate) {
    throw invalid('The series must end on or after the day it starts.');
  }
  if (input.occurrenceCount !== null && (input.occurrenceCount < 1 || input.occurrenceCount > 520)) {
    throw invalid('A series runs for 1 to 520 classes.');
  }
}

/* ============================================================================
   Generation

   The idempotency story: `(series_id, occurrence_date)` is uniquely indexed,
   so the database refuses a second occurrence for a date that already has one.
   This function therefore never has to be the only writer, and a retry after a
   crash mid-generation resumes rather than duplicating.
   ========================================================================= */

export interface GenerationResult {
  seriesId: string;
  created: string[];
  /** Dates already materialised — the idempotent no-op path. */
  skippedExisting: string[];
  /** Dates a room or trainer collision kept us out of, with the reason. */
  skippedConflict: Array<{ date: string; reason: string }>;
  /** Dates already in the past when generation ran. */
  skippedPast: string[];
  generatedThrough: string;
}

/**
 * Materialise a series' occurrences up to the horizon.
 *
 * Safe to call repeatedly and from more than one place: creating a series,
 * editing one, and the nightly job all funnel through here.
 */
export function generateOccurrences(
  series: SeriesRow,
  options: { throughDay?: string; atMs?: number } = {},
): GenerationResult {
  const atMs = options.atMs ?? now();
  const tz = branchTimeZone(series.tenantId, series.branchId);
  const throughDay = options.throughDay ?? addDays(isoDate(atMs, tz), SERIES_HORIZON_DAYS);

  const result: GenerationResult = {
    seriesId: series.id,
    created: [],
    skippedExisting: [],
    skippedConflict: [],
    skippedPast: [],
    generatedThrough: throughDay,
  };

  if (series.state !== 'active') return result;

  const wanted = occurrenceDates(series, throughDay);
  if (wanted.length === 0) {
    db.update(schema.classSeries)
      .set({ generatedThrough: throughDay, updatedAt: atMs })
      .where(eq(schema.classSeries.id, series.id))
      .run();
    return result;
  }

  // One read for every date this series already owns, including cancelled and
  // moved ones. A cancelled occurrence must not be regenerated — that would
  // undo somebody's decision on the next tick of the job.
  const existing = new Set(
    db
      .select({ occurrenceDate: schema.classSessions.occurrenceDate })
      .from(schema.classSessions)
      .where(
        and(
          eq(schema.classSessions.tenantId, series.tenantId),
          eq(schema.classSessions.seriesId, series.id),
          isNotNull(schema.classSessions.occurrenceDate),
        ),
      )
      .all()
      .map((row) => row.occurrenceDate!),
  );

  const classType = db
    .select()
    .from(schema.classTypes)
    .where(eq(schema.classTypes.id, series.classTypeId))
    .get();

  for (const date of wanted) {
    if (existing.has(date)) {
      result.skippedExisting.push(date);
      continue;
    }

    // Resolved per date in the branch's zone: this is the line that keeps
    // "18:30 every Tuesday" true across a DST boundary.
    const startsAt = localClockOnDay(date, series.startTime, tz);
    const endsAt = startsAt + series.durationMin * MINUTE;

    if (startsAt <= atMs) {
      // Never backfill. A series created today does not invent classes that
      // members could not have attended.
      result.skippedPast.push(date);
      continue;
    }

    const clashes = detectClashes(series.tenantId, {
      branchId: series.branchId,
      roomId: series.roomId,
      trainerId: series.trainerId,
      startsAt,
      endsAt,
    });
    if (clashes.length > 0) {
      const clash = clashes[0]!;
      result.skippedConflict.push({
        date,
        reason:
          clash.kind === 'room'
            ? `The room is taken by ${clash.name}.`
            : `The trainer is teaching ${clash.name}.`,
      });
      continue;
    }

    try {
      db.insert(schema.classSessions)
        .values({
          id: id('ses'),
          tenantId: series.tenantId,
          branchId: series.branchId,
          classTypeId: series.classTypeId,
          roomId: series.roomId,
          trainerId: series.trainerId,
          seriesId: series.id,
          occurrenceDate: date,
          startsAt,
          endsAt,
          capacity: series.capacity,
          booked: 0,
          state: 'scheduled',
          bookingOpensAt:
            series.bookingOpensMinBefore === null ? null : startsAt - series.bookingOpensMinBefore * MINUTE,
          cancelDeadlineAt:
            series.cancelDeadlineMinBefore === null ? null : startsAt - series.cancelDeadlineMinBefore * MINUTE,
          creditsRequired: series.creditsRequired,
          dropInPriceMinor: series.dropInPriceMinor,
          lateCancelFeeMinor: series.lateCancelFeeMinor,
          waitlistEnabled: series.waitlistEnabled,
          cancelledReason: null,
          substituteFor: null,
          notes: series.notes,
          version: 1,
          createdAt: atMs,
          updatedAt: atMs,
        })
        .run();
      result.created.push(date);
    } catch (error) {
      // The unique index is the authority, not the `existing` set read above:
      // another generator may have inserted this date since. Losing the race
      // is the correct outcome and is not an error.
      if (String(error).includes('UNIQUE') || String(error).includes('constraint')) {
        result.skippedExisting.push(date);
        continue;
      }
      throw error;
    }
  }

  db.update(schema.classSeries)
    .set({ generatedThrough: throughDay, updatedAt: atMs })
    .where(eq(schema.classSeries.id, series.id))
    .run();

  if (result.created.length > 0) {
    emit({
      tenantId: series.tenantId,
      branchId: series.branchId,
      channel: channels.branch(series.branchId),
      topic: 'session.updated',
      payload: { seriesId: series.id, generated: result.created.length, className: classType?.name ?? null },
    });
  }

  return result;
}

/* ============================================================================
   Lifecycle
   ========================================================================= */

export function createSeries(ctx: RequestContext, input: SeriesInput): { series: SeriesRow; generation: GenerationResult } {
  requirePermission(ctx, 'schedule.manage');
  const atMs = now();
  if (!branchScope(ctx).includes(input.branchId)) throw notFound('That branch');

  validateRecurrence(input);
  const classType = assertSeriesResources(ctx.tenantId, input);

  const durationMin = input.durationMin ?? classType.durationMin;
  if (durationMin < 1) throw invalid('A class must last at least a minute.');
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(input.startTime)) throw invalid('Start time must be HH:MM.');

  const tz = branchTimeZone(ctx.tenantId, input.branchId);
  const today = isoDate(atMs, tz);
  if (input.startDate < today) throw invalid('A series starts today or later.');

  const seriesId = id('ser');
  const row: typeof schema.classSeries.$inferInsert = {
    id: seriesId,
    tenantId: ctx.tenantId,
    branchId: input.branchId,
    classTypeId: input.classTypeId,
    roomId: input.roomId,
    trainerId: input.trainerId,
    frequency: 'weekly',
    interval: input.interval,
    weekdays: [...new Set(input.weekdays)].sort((a, b) => a - b),
    startDate: input.startDate,
    endDate: input.endDate,
    occurrenceCount: input.occurrenceCount,
    startTime: input.startTime,
    durationMin,
    capacity: input.capacity,
    creditsRequired: input.creditsRequired,
    dropInPriceMinor: input.dropInPriceMinor,
    lateCancelFeeMinor: input.lateCancelFeeMinor,
    waitlistEnabled: input.waitlistEnabled,
    bookingOpensMinBefore: input.bookingOpensMinBefore,
    cancelDeadlineMinBefore: input.cancelDeadlineMinBefore,
    notes: input.notes,
    state: 'active',
    generatedThrough: null,
    supersedesSeriesId: null,
    supersededBySeriesId: null,
    version: 1,
    createdAt: atMs,
    updatedAt: atMs,
  };

  let generation!: GenerationResult;
  transact(() => {
    db.insert(schema.classSeries).values(row).run();
    generation = generateOccurrences(row as SeriesRow, { atMs });

    audit(ctx, {
      action: 'series.created',
      entityType: 'class_series',
      entityId: seriesId,
      entityLabel: classType.name,
      branchId: input.branchId,
      after: {
        weekdays: row.weekdays.map((d) => WEEKDAY_NAMES[d]).join(', '),
        startTime: input.startTime,
        startDate: input.startDate,
        endDate: input.endDate,
        occurrenceCount: input.occurrenceCount,
        generated: generation.created.length,
      },
    });
  });

  return { series: db.select().from(schema.classSeries).where(eq(schema.classSeries.id, seriesId)).get()!, generation };
}

/** Fields a series edit may change. The recurrence rule and the resources —
 *  never the identity. */
export interface SeriesPatch {
  roomId?: string | null;
  trainerId?: string | null;
  weekdays?: number[];
  interval?: number;
  startTime?: string;
  durationMin?: number;
  capacity?: number;
  endDate?: string | null;
  occurrenceCount?: number | null;
  notes?: string | null;
  waitlistEnabled?: boolean;
  creditsRequired?: number;
  dropInPriceMinor?: number | null;
  lateCancelFeeMinor?: number;
  bookingOpensMinBefore?: number | null;
  cancelDeadlineMinBefore?: number | null;
}

export interface SeriesEditResult {
  series: SeriesRow;
  /** Set when the edit split the series; this is the new one taking over. */
  successorSeriesId: string | null;
  removedOccurrences: number;
  generation: GenerationResult;
}

/**
 * Edit a whole series, or this occurrence and every later one.
 *
 * `scope: 'series'` changes the rule from today forward. `scope:
 * 'this_and_future'` closes the current series the day before the pivot and
 * starts a successor — the model a calendar uses, and the only one that leaves
 * past occurrences describing what actually happened.
 *
 * In both cases future occurrences that nobody has booked are removed and
 * regenerated from the new rule. **Occurrences with live bookings are left
 * alone** and reported, because silently moving a class a member has booked is
 * the behaviour this whole module exists to avoid. The operator cancels those
 * explicitly, which notifies and refunds.
 */
export function editSeries(
  ctx: RequestContext,
  seriesId: string,
  patch: SeriesPatch,
  options: { scope: 'series' | 'this_and_future'; fromSessionId?: string },
): SeriesEditResult {
  requirePermission(ctx, 'schedule.manage');
  const atMs = now();
  const series = loadSeriesInScope(ctx, seriesId);
  if (series.state === 'cancelled') throw precondition('That series was cancelled.');

  const tz = branchTimeZone(ctx.tenantId, series.branchId);
  const today = isoDate(atMs, tz);

  // The first date the new rule applies to. For a whole-series edit that is
  // tomorrow — today's classes may already have people on the way to them.
  let pivot = addDays(today, 1);
  if (options.scope === 'this_and_future') {
    if (!options.fromSessionId) throw invalid('Editing this and future classes needs the class to start from.');
    const anchor = loadSessionInScope(ctx, options.fromSessionId);
    if (anchor.seriesId !== series.id) throw invalid('That class is not part of this series.');
    if (!anchor.occurrenceDate) throw invalid('That class is not a generated occurrence of this series.');
    if (anchor.startsAt <= atMs) throw precondition('That class has already started. Edit a future one instead.');
    pivot = anchor.occurrenceDate;
  }

  const merged = {
    ...series,
    ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)),
  } as SeriesRow;

  validateRecurrence({
    weekdays: merged.weekdays,
    interval: merged.interval,
    startDate: merged.startDate,
    endDate: merged.endDate,
    occurrenceCount: merged.occurrenceCount,
    capacity: merged.capacity,
  });
  const classType = assertSeriesResources(ctx.tenantId, {
    branchId: merged.branchId,
    classTypeId: merged.classTypeId,
    roomId: merged.roomId,
    trainerId: merged.trainerId,
    capacity: merged.capacity,
  });
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(merged.startTime)) throw invalid('Start time must be HH:MM.');

  let successorSeriesId: string | null = null;
  let removedOccurrences = 0;
  let generation!: GenerationResult;

  transact(() => {
    // Future, unbooked, not-yet-cancelled occurrences from the pivot on. These
    // are the only rows an edit may delete.
    const future = db
      .select()
      .from(schema.classSessions)
      .where(
        and(
          eq(schema.classSessions.tenantId, ctx.tenantId),
          eq(schema.classSessions.seriesId, series.id),
          gte(schema.classSessions.occurrenceDate, pivot),
          gt(schema.classSessions.startsAt, atMs),
          ne(schema.classSessions.state, 'cancelled'),
        ),
      )
      .all();

    const bookedSessionIds = new Set(
      future.length === 0
        ? []
        : db
            .select({ sessionId: schema.bookings.sessionId })
            .from(schema.bookings)
            .where(
              and(
                inArray(schema.bookings.sessionId, future.map((row) => row.id)),
                inArray(schema.bookings.state, ['held', 'confirmed', 'attended']),
              ),
            )
            .all()
            .map((row) => row.sessionId),
    );

    for (const occurrence of future) {
      if (bookedSessionIds.has(occurrence.id)) continue;
      db.delete(schema.classSessions).where(eq(schema.classSessions.id, occurrence.id)).run();
      removedOccurrences += 1;
    }

    if (options.scope === 'this_and_future') {
      // Close the old series the day before the pivot and start a successor.
      // `occurrenceCount` cannot survive a split — the successor counts from
      // its own start — so it becomes an end date or open-ended.
      const successorId = id('ser');
      successorSeriesId = successorId;

      db.insert(schema.classSeries)
        .values({
          ...merged,
          id: successorId,
          startDate: pivot,
          occurrenceCount: null,
          endDate: merged.endDate,
          state: 'active',
          generatedThrough: null,
          supersedesSeriesId: series.id,
          supersededBySeriesId: null,
          version: 1,
          createdAt: atMs,
          updatedAt: atMs,
        })
        .run();

      const previousDay = addDays(pivot, -1);
      db.update(schema.classSeries)
        .set({
          endDate: previousDay,
          occurrenceCount: null,
          state: series.startDate > previousDay ? 'ended' : 'active',
          supersededBySeriesId: successorId,
          updatedAt: atMs,
          version: sql`${schema.classSeries.version} + 1`,
        })
        .where(eq(schema.classSeries.id, series.id))
        .run();

      generation = generateOccurrences(
        db.select().from(schema.classSeries).where(eq(schema.classSeries.id, successorId)).get()!,
        { atMs },
      );
    } else {
      db.update(schema.classSeries)
        .set({
          roomId: merged.roomId,
          trainerId: merged.trainerId,
          weekdays: [...new Set(merged.weekdays)].sort((a, b) => a - b),
          interval: merged.interval,
          startTime: merged.startTime,
          durationMin: merged.durationMin,
          capacity: merged.capacity,
          endDate: merged.endDate,
          occurrenceCount: merged.occurrenceCount,
          notes: merged.notes,
          waitlistEnabled: merged.waitlistEnabled,
          creditsRequired: merged.creditsRequired,
          dropInPriceMinor: merged.dropInPriceMinor,
          lateCancelFeeMinor: merged.lateCancelFeeMinor,
          bookingOpensMinBefore: merged.bookingOpensMinBefore,
          cancelDeadlineMinBefore: merged.cancelDeadlineMinBefore,
          updatedAt: atMs,
          version: sql`${schema.classSeries.version} + 1`,
        })
        .where(eq(schema.classSeries.id, series.id))
        .run();

      generation = generateOccurrences(
        db.select().from(schema.classSeries).where(eq(schema.classSeries.id, series.id)).get()!,
        { atMs },
      );
    }

    audit(ctx, {
      action: options.scope === 'this_and_future' ? 'series.split' : 'series.updated',
      entityType: 'class_series',
      entityId: series.id,
      entityLabel: classType.name,
      branchId: series.branchId,
      before: {
        weekdays: series.weekdays.map((d) => WEEKDAY_NAMES[d]).join(', '),
        startTime: series.startTime,
        trainerId: series.trainerId,
        roomId: series.roomId,
        capacity: series.capacity,
      },
      after: {
        weekdays: merged.weekdays.map((d) => WEEKDAY_NAMES[d]).join(', '),
        startTime: merged.startTime,
        trainerId: merged.trainerId,
        roomId: merged.roomId,
        capacity: merged.capacity,
        from: pivot,
        successorSeriesId,
        removedOccurrences,
      },
    });
  });

  return {
    series: db
      .select()
      .from(schema.classSeries)
      .where(eq(schema.classSeries.id, successorSeriesId ?? series.id))
      .get()!,
    successorSeriesId,
    removedOccurrences,
    generation,
  };
}

export interface SeriesCancelResult {
  seriesId: string;
  cancelledSessions: string[];
  bookingsReleased: number;
  creditsReturned: number;
  notified: number;
  seriesState: string;
}

/**
 * Cancel the whole series, or every occurrence from one onwards.
 *
 * Delegates each occurrence to `cancelSessions`, so members are made whole
 * exactly as they are for a one-off cancellation: seats released, credits
 * returned, waitlist closed, everyone told. Past occurrences are never
 * touched — they are attendance records, not plans.
 */
export function cancelSeries(
  ctx: RequestContext,
  seriesId: string,
  input: { reason: string; scope: 'series' | 'future'; fromSessionId?: string },
): SeriesCancelResult {
  requirePermission(ctx, 'schedule.manage');
  const atMs = now();
  const reason = input.reason.trim();
  if (reason.length < 4) throw invalid('Cancelling a series needs a reason of at least 4 characters.');

  const series = loadSeriesInScope(ctx, seriesId);
  if (series.state === 'cancelled') throw precondition('That series is already cancelled.');

  const tz = branchTimeZone(ctx.tenantId, series.branchId);
  let fromDate = isoDate(atMs, tz);
  if (input.scope === 'future') {
    if (!input.fromSessionId) throw invalid('Cancelling future classes needs the class to start from.');
    const anchor = loadSessionInScope(ctx, input.fromSessionId);
    if (anchor.seriesId !== series.id) throw invalid('That class is not part of this series.');
    if (!anchor.occurrenceDate) throw invalid('That class is not a generated occurrence of this series.');
    fromDate = anchor.occurrenceDate;
  }

  const targets = db
    .select()
    .from(schema.classSessions)
    .where(
      and(
        eq(schema.classSessions.tenantId, ctx.tenantId),
        eq(schema.classSessions.seriesId, series.id),
        gte(schema.classSessions.occurrenceDate, fromDate),
        // History is off limits regardless of the date asked for.
        gt(schema.classSessions.startsAt, atMs),
        ne(schema.classSessions.state, 'cancelled'),
      ),
    )
    .orderBy(asc(schema.classSessions.startsAt))
    .all();

  const result: SeriesCancelResult = {
    seriesId: series.id,
    cancelledSessions: [],
    bookingsReleased: 0,
    creditsReturned: 0,
    notified: 0,
    seriesState: series.state,
  };

  for (const target of targets) {
    // Occurrence scope: `cancelSessions` must not walk the series itself, or
    // each call would redo the whole set.
    const one = cancelSessions(ctx, { sessionId: target.id, reason, scope: 'occurrence' });
    result.cancelledSessions.push(...one.cancelled);
    result.bookingsReleased += one.bookingsReleased;
    result.creditsReturned += one.creditsReturned;
    result.notified += one.notified;
  }

  transact(() => {
    // Cancelling the whole series stops it generating for good. Cancelling
    // from a date forward is the same as ending it the day before, which
    // leaves the earlier occurrences standing as the record they are.
    const nextState = input.scope === 'series' ? 'cancelled' : 'ended';
    db.update(schema.classSeries)
      .set({
        state: nextState,
        endDate: input.scope === 'series' ? series.endDate : addDays(fromDate, -1),
        updatedAt: atMs,
        version: sql`${schema.classSeries.version} + 1`,
      })
      .where(eq(schema.classSeries.id, series.id))
      .run();
    result.seriesState = nextState;

    audit(ctx, {
      action: input.scope === 'series' ? 'series.cancelled' : 'series.cancelled_from',
      entityType: 'class_series',
      entityId: series.id,
      branchId: series.branchId,
      reason,
      before: { state: series.state },
      after: { state: nextState, from: fromDate, occurrences: result.cancelledSessions.length },
    });
  });

  return result;
}

/* ============================================================================
   Reads
   ========================================================================= */

export function listSeries(ctx: RequestContext, query: { branchId?: string; includeEnded?: boolean }) {
  requirePermission(ctx, 'schedule.view');
  const scope = query.branchId ? [query.branchId] : branchScope(ctx);
  if (query.branchId && !branchScope(ctx).includes(query.branchId)) throw notFound('That branch');
  if (scope.length === 0) return { series: [] };

  const rows = db
    .select({ series: schema.classSeries, className: schema.classTypes.name, roomName: schema.rooms.name })
    .from(schema.classSeries)
    .innerJoin(schema.classTypes, eq(schema.classTypes.id, schema.classSeries.classTypeId))
    .leftJoin(schema.rooms, eq(schema.rooms.id, schema.classSeries.roomId))
    .where(
      and(
        eq(schema.classSeries.tenantId, ctx.tenantId),
        inArray(schema.classSeries.branchId, scope),
        query.includeEnded ? undefined : eq(schema.classSeries.state, 'active'),
      ),
    )
    .all();

  const atMs = now();
  return {
    series: rows.map((row) => ({
      id: row.series.id,
      branchId: row.series.branchId,
      className: row.className,
      roomName: row.roomName,
      trainerId: row.series.trainerId,
      weekdays: row.series.weekdays,
      weekdayLabel: row.series.weekdays.map((d) => WEEKDAY_NAMES[d]?.slice(0, 3)).join(', '),
      interval: row.series.interval,
      startTime: row.series.startTime,
      durationMin: row.series.durationMin,
      capacity: row.series.capacity,
      startDate: row.series.startDate,
      endDate: row.series.endDate,
      occurrenceCount: row.series.occurrenceCount,
      state: row.series.state,
      generatedThrough: row.series.generatedThrough,
      supersedesSeriesId: row.series.supersedesSeriesId,
      supersededBySeriesId: row.series.supersededBySeriesId,
      upcoming: db
        .select({ n: sql<number>`count(*)` })
        .from(schema.classSessions)
        .where(
          and(
            eq(schema.classSessions.seriesId, row.series.id),
            gt(schema.classSessions.startsAt, atMs),
            ne(schema.classSessions.state, 'cancelled'),
          ),
        )
        .get()?.n ?? 0,
    })),
  };
}

export function seriesDetail(ctx: RequestContext, seriesId: string) {
  requirePermission(ctx, 'schedule.view');
  const series = loadSeriesInScope(ctx, seriesId);
  const atMs = now();

  const occurrences = db
    .select({
      id: schema.classSessions.id,
      occurrenceDate: schema.classSessions.occurrenceDate,
      startsAt: schema.classSessions.startsAt,
      endsAt: schema.classSessions.endsAt,
      state: schema.classSessions.state,
      capacity: schema.classSessions.capacity,
      booked: schema.classSessions.booked,
      trainerId: schema.classSessions.trainerId,
      roomId: schema.classSessions.roomId,
      cancelledReason: schema.classSessions.cancelledReason,
    })
    .from(schema.classSessions)
    .where(
      and(eq(schema.classSessions.tenantId, ctx.tenantId), eq(schema.classSessions.seriesId, series.id)),
    )
    .orderBy(asc(schema.classSessions.startsAt))
    .all();

  return {
    series,
    weekdayLabel: series.weekdays.map((d) => WEEKDAY_NAMES[d]).join(', '),
    occurrences: occurrences.map((row) => ({
      ...row,
      // The console needs to know which rows it may not touch, and why.
      past: row.startsAt <= atMs,
      /** True where the occurrence no longer matches the rule — somebody moved
       *  or re-staffed this one class. */
      edited:
        row.trainerId !== series.trainerId ||
        row.roomId !== series.roomId ||
        row.capacity !== series.capacity,
    })),
  };
}

/** Roll every active series' horizon forward. The scheduler's entry point.
 *
 *  Idempotent by construction, so a job that runs twice — or two instances
 *  that both run it — costs a wasted read rather than a duplicated timetable. */
export function extendActiveSeries(atMs = now()): { series: number; created: number } {
  const active = db
    .select()
    .from(schema.classSeries)
    .where(eq(schema.classSeries.state, 'active'))
    .all();

  let created = 0;
  for (const series of active) {
    const tz = branchTimeZone(series.tenantId, series.branchId);
    const throughDay = addDays(isoDate(atMs, tz), SERIES_HORIZON_DAYS);
    // Nothing to do when the watermark already covers the horizon and the
    // series has a hard end behind it.
    if (series.endDate !== null && series.endDate < isoDate(atMs, tz)) {
      db.update(schema.classSeries)
        .set({ state: 'ended', updatedAt: atMs })
        .where(eq(schema.classSeries.id, series.id))
        .run();
      continue;
    }
    created += generateOccurrences(series, { throughDay, atMs }).created.length;
  }
  return { series: active.length, created };
}

/** Guard for the single-occurrence paths: a lone class inside a series may be
 *  edited freely, but the caller has to say that is what they meant. */
export function occurrenceBelongsToSeries(sessionId: string, tenantId: string): string | null {
  return (
    db
      .select({ seriesId: schema.classSessions.seriesId })
      .from(schema.classSessions)
      .where(and(eq(schema.classSessions.id, sessionId), eq(schema.classSessions.tenantId, tenantId)))
      .get()?.seriesId ?? null
  );
}
