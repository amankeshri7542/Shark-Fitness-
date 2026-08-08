# Shark Fitness — design direction

The member app's visual direction is **not open**. It is fixed by
`Shark-inspired member app prototype/Shark Fitness Member App v2.dc.html` and this
document only records the extraction, plus the decisions for surfaces the
prototype never drew (admin dashboard, light mode, the ten member screens the
prototype omitted).

## The direction, in one line

**Sonar.** A ship's instrument readout at depth: an almost-black hull, blue-tinted
hairlines instead of grey ones, one bioluminescent cyan that is the only saturated
colour on screen, and heavy condensed display type set in all caps like a bulkhead
stencil. Nothing is rounded. Nothing casts a shadow. Everything is a panel seam.

## Colour

Six named values carry the whole system. Every other colour on screen is one of
these at an alpha.

| Token | Hex | Role |
|---|---|---|
| `abyss` | `#04080b` | canvas |
| `hull` | `#050b10` | nav bar, sticky chrome — one step darker than the canvas, not lighter |
| `shelf` | `#0b2331` → `#061119` | the hero gradient only |
| `foam` | `#e8f1f5` | text |
| `sonar` | `#46c8dd` | the accent |
| `flare` | `#e8823c` | warning, adaptive-rule notices, waitlist |

Two additions the prototype needed but never drew, taken from its own accent
picker (`#7fe0c0`) and the one gap in it:

| Token | Hex | Role |
|---|---|---|
| `kelp` | `#7fe0c0` | success, paid, checked-in |
| `chum` | `#e5544c` | danger, denial, failed payment, destructive confirm |

**The hairline rule.** Borders are never grey. Every rule, divider and panel edge
is `rgba(120,190,215, α)` — a steel-blue at 10–30% — which is what makes the dark
surface read as machined instrument metal rather than as a dark-mode default. This
one decision does more work than any other in the system.

**Status is never hue alone.** Every state pairs its colour with a glyph or an
uppercase label, per the design PRD and WCAG 2.2.

## Type

Three faces, three jobs, no overlap.

- **Anton** — display and every number that matters. Single weight, always
  uppercase, leading `0.92–0.96`. Used for headlines, metric values, timers,
  set counts. It is the loudest thing in the system and it earns that by being
  the only loud thing.
- **Archivo** — body copy, 400/500/600. Sentence case, `1.45` leading.
- **Archivo Narrow** — utility. 10–11px, uppercase, tracking `0.1em–0.2em`,
  weight 600. Eyebrows, column headers, chips, nav labels, unit suffixes.

All numeric data uses `font-variant-numeric: tabular-nums`. Weights, timers,
money and counts must not reflow as they tick.

## Structure

Zero border-radius. Zero box-shadow. Elevation is expressed by a hairline and a
half-stop of background lightness, never by a blur. The prototype's own idiom —
a bordered row of cells divided by `border-right` with **no gap between them** —
is the system's structural unit, scaled from a 3-up stat strip on the phone to
the entire admin layout.

Buttons: primary CTAs carry a clipped corner,
`clip-path: polygon(0 0, 100% 0, 100% 72%, calc(100% - 14px) 100%, 0 100%)`.
The notch is a cut, not a bevel — it reads as sheet metal.

## Motion

Four named animations, all from the prototype, all disabled under
`prefers-reduced-motion`:

- `sonar` — a 2px cyan gradient bar sweeping down a surface. Used **only** on
  things that are actively acquiring: the rotating QR pass, the live occupancy
  strip. Never decorative.
- `breath` — a 2.6s opacity pulse on the live-status dot.
- `surface` — the 300ms enter: 10px up, opacity 0→1.
- `tick` — an 800ms `scaleX` on progress fills.

## Signature

The member app's signature already exists in the prototype: the sonar sweep over
the rotating entry code. It is not duplicated elsewhere.

The **admin dashboard had no design**, and that is the one genuinely open axis.
Its signature is the **occupancy trace** on the Command Center: a full-bleed
24-hour band where the day's floor occupancy is drawn as a stepped trace, a cyan
`now` line sweeps it in real time, and each arriving check-in pings onto it as it
happens. It is a literal sonar readout of the building, and it is the only
animated element on the page.

### The admin risk

The whole dashboard is **one continuous hairline-seamed surface**. No gaps
between panels, no cards floating on a canvas, no `gap-6` grid. Panels share
edges and are separated by a single `rgba(120,190,215,.16)` line, exactly like
the prototype's stat strip.

Most dashboards would look broken doing this. It works here because the seam is
blue-tinted and the fill is uniform, so the eye reads a machined console rather
than a collapsed layout — and because the product PRD demands density
("dense but breathable"). It is a scale-up of the prototype's own vocabulary, not
a new idea imported into it.

## Light mode

Dark is the signature member experience; the design PRD requires light mode to be
first-class on the dashboard. Light mode is a token swap on `:root[data-theme]`,
not a second design: canvas `#eef2f4`, hairlines `rgba(45,90,110,.18)`, and the
accent darkens to `#0a6d81` to clear 4.5:1 on light. Anton, the seams and the
zero-radius geometry are unchanged, so the two themes are recognisably one system.

## Voice

The prototype ships a `predatorCopy` toggle: **Hunt / Strike / Depth / Pack**
against plain **Today / Train / Progress / Community**. It is implemented as a
real member preference, on by default as the prototype has it.

It is bounded. Predator copy never appears on payment, access denial, injury,
support, privacy or safety surfaces — those always use the plain register, because
the product PRD forbids shame, fear and manufactured urgency, and a failed payment
is not a moment for a hunting metaphor. Energetic on the training floor, plain at
the front desk.
