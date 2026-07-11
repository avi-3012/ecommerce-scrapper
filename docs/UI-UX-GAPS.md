# PricePulse — UI/UX Gap Assessment

_Date: 10 July 2026 · Scope: `apps/web` (React + Vite + Tailwind dashboard)_

An honest audit of where the current dashboard reads as a functional prototype rather than a
polished product, and what each gap would take to close. The frontend is **correct and complete in
behaviour** — every Phase 1/2/3 feature is wired and working. What follows is purely about visual
craft and interaction quality: the difference between "it works" and "it feels like a real product."

Findings are grouped by theme and tagged **[High] / [Med] / [Low]** by how much they move the
perceived-quality needle relative to effort. Each references the actual code so it's actionable.

---

## 1. Visual Design & Brand

### 1.1 No visual identity at all — [High]

There is no logo, no brand mark, no wordmark treatment. The app name "PricePulse" is rendered as
plain bold text ([Layout.tsx](../apps/web/src/Layout.tsx), [Login.tsx](../apps/web/src/pages/Login.tsx))
in the default system font. A real product has, at minimum, a logotype and a favicon; right now the
browser tab shows the default Vite icon and the title is a bare `<title>PricePulse</title>`.
**Better:** an SVG logo mark + wordmark, a real favicon/app-icon set, and a considered color story
(see 1.2). This single change does the most to shake the "college project" feel.

### 1.2 Default Tailwind palette, used flatly — [High]

The entire app is `indigo-600` for primary actions and `gray-*` for everything else — the untouched
Tailwind starter palette. There are **no design tokens**: colors are hardcoded as utility strings
inline and in `ui.tsx` ([`btnPrimary`](../apps/web/src/ui.tsx#L139) etc.). There is no semantic
theme layer (`--color-primary`, `--color-surface`, `--color-danger`), so a rebrand means find-and-
replace across every file. **Better:** define a small brand palette as CSS custom properties /
Tailwind theme extension, pick a primary that isn't the framework default, and reference tokens
rather than raw `indigo-600`/`gray-200` everywhere.

### 1.3 No dark mode — [Med]

The BRD persona "lives on their phone" and the app is for frequent glances, often at night, yet
there's no dark theme despite the marketing describing dark-mode dashboards. Everything is
`bg-gray-50` / `bg-white`. **Better:** a `dark:` variant pass keyed off `prefers-color-scheme` plus
a manual toggle. The token work in 1.2 makes this nearly free.

### 1.4 Emoji as iconography — [High]

Navigation and status use literal emoji: 📊 📦 🔔 📥 ⚙️ in the sidebar
([Layout.tsx](../apps/web/src/Layout.tsx#L6-L12)), 📦 as the product-image placeholder, 🔥 🔗 ⏸ ▶ ⟳ 🗑
as button glyphs ([Products.tsx](../apps/web/src/pages/Products.tsx)). Emoji render differently on
every OS, aren't aligned to the text baseline, can't be recolored, and are the single strongest
"prototype" tell. **Better:** an icon set (Lucide / Heroicons — tree-shakeable SVG React
components), sized and colored consistently with `currentColor`.

### 1.5 Flat, borderless depth — [Med]

Every surface is a `rounded-lg border border-gray-200 bg-white` box. No elevation system, no
shadows beyond the one modal (`shadow-xl`), no hover-lift on cards, no layering. The result reads as
a wireframe. **Better:** a 2–3 step elevation scale (subtle shadow on cards, stronger on popovers/
modals), and hover/active states on interactive cards.

### 1.6 Typography is entirely undifferentiated — [Med]

One system font, essentially two sizes in use (`text-sm` body, `text-xl`/`text-2xl` headings). No
type scale, no font pairing, no tabular-nums for the price columns (so numbers jitter as they change).
Headings are just `text-xl font-semibold` repeated on every page. **Better:** adopt a real font (e.g.
Inter via self-hosted woff2), define a type scale, and use `tabular-nums` for all prices and metrics.

---

## 2. Layout & Composition

### 2.1 Everything is a full-width stack of boxes — [Med]

Pages are a vertical `space-y-*` list of bordered rectangles at one width. There's no grid rhythm, no
use of whitespace to create hierarchy, no max-width reading measure on dense pages, and the sidebar
is a fixed 208px (`w-52`) with no collapse on desktop. The [ProductDetail](../apps/web/src/pages/ProductDetail.tsx)
page (625 lines) is one long scroll of stacked sections with no sticky sub-nav or column layout.
**Better:** a responsive content grid (e.g. chart + stats side-by-side on wide screens), a max
content width, and consistent vertical rhythm from a spacing scale.

### 2.2 The catalogue is a flat list, not a considered layout — [Med]

Products render as full-width rows ([Products.tsx](../apps/web/src/pages/Products.tsx#L153)); there's
no card-grid option, no density toggle, no column headers, and no sortable columns despite the BRD
listing sort options (biggest drop, recently changed, price…). Sorting isn't exposed in the UI at
all. **Better:** a grid/list toggle, a proper sortable table view for power users, and the sort
controls the spec calls for.

### 2.3 No global chrome beyond nav — [Med]

There's no top bar: no breadcrumb, no page-level actions area, no account menu, no visible
**logout** control anywhere in the UI (the endpoint exists; nothing calls it). The user's identity
is never shown. **Better:** a header with breadcrumb/title, contextual actions, and an account
menu (identity, logout, theme toggle).

### 2.4 Mobile is "it reflows," not "designed for mobile" — [Med]

The bottom nav exists ([Layout.tsx](../apps/web/src/Layout.tsx)) and layouts use `flex-wrap`, but
tables/rows just wrap awkwardly rather than becoming purpose-built mobile cards; tap targets on the
icon-buttons (`px-3 py-1.5` emoji) are below the ~44px comfortable-touch guideline. **Better:**
dedicated mobile card layouts for catalogue/alerts and larger touch targets.

---

## 3. Interaction & Feedback

### 3.1 No toast / notification system — [High]

Actions succeed silently. "Check now," pause, resume, link, unlink, retry-delivery all fire a
mutation with `onSettled: invalidate` and **no success confirmation**
([Products.tsx](../apps/web/src/pages/Products.tsx), [ProductDetail.tsx](../apps/web/src/pages/ProductDetail.tsx)).
Settings uses an inline note div; everywhere else the user gets nothing. Errors on those same
actions are swallowed entirely (no `onError`). **Better:** a global toast system (success + error),
used consistently for every mutation. This is the biggest _interaction_ quality gap.

### 3.2 No optimistic UI; actions feel laggy — [Med]

Pause/resume/check wait for the round-trip then refetch the whole list. On a 30-product catalogue
that's a visible stall with no affordance that anything is happening (no per-row spinner, no
disabled state on the clicked button). The M3 doc explicitly specified a "checking now…" indicator
that isn't present. **Better:** optimistic status flips with rollback, and a per-row in-flight
indicator.

### 3.3 Loading is a single centered spinner; no skeletons — [Med]

Every page shows one `<Spinner>` while loading ([ui.tsx](../apps/web/src/ui.tsx#L46)), so navigation
flashes blank → spinner → content. There are no skeleton placeholders that preserve layout.
**Better:** skeleton loaders for cards, table rows, and the chart, matching final layout to avoid
content jump.

### 3.4 Confirmations are inconsistent — [Low]

Deletion uses a proper `ConfirmDialog`, but it's the _only_ modal in the app; the delete confirm
also doesn't surface the history/alert counts the backend returns (the impact payload is computed
but the dialog body is static text). **Better:** show the real impact ("Deletes 342 price records
and 12 alerts") and reuse the dialog pattern for other destructive/irreversible actions.

### 3.5 No focus, keyboard, or transition polish — [Med]

Inputs use `focus:outline-none` and only a border-color change ([inputCls](../apps/web/src/ui.tsx#L143)) —
this actively _removes_ the accessible focus ring without a strong replacement. No focus-visible
rings on buttons, no keyboard handling in the modal (no Esc-to-close, no focus trap), no transitions
on hover/state changes (everything snaps). **Better:** a proper `focus-visible` ring token, modal
keyboard behaviour, and subtle `transition-colors`/`transition-transform`.

---

## 4. Data Visualization

### 4.1 Charts are unstyled Recharts defaults — [High]

The price history and comparison charts ([ProductDetail.tsx](../apps/web/src/pages/ProductDetail.tsx))
use stock Recharts with hardcoded hex colors (`#4f46e5`, `#d1d5db`, `#16a34a`, `#f59e0b`, `#2563eb`),
a default tooltip, thin axes, and no legend, no gradient fill, no area shading. The BRD/marketing
described "glassmorphism, composed area charts" — the reality is a plain line chart. Out-of-stock
periods and failed checks are mentioned in text but **not shaded on the chart** as the spec
intends. **Better:** a themed chart config (area gradient under the price line, branded series
colors from tokens, a custom tooltip card, shaded out-of-stock bands, distinct failure markers), and
a shared chart theme so the two charts match.

### 4.2 Stat cards are visually inert — [Med]

The four dashboard KPIs ([StatCard](../apps/web/src/ui.tsx#L77)) are label + number + subtext, no
icon, no trend arrow, no sparkline, no color coding for good/bad movement. They convey the number
but not the _story_. **Better:** iconography, delta vs. previous period, and a mini-sparkline where
it makes sense (e.g. drops over 7 days).

### 4.3 No deal-quality visualization beyond a badge — [Low]

Deal-quality context (all-time low/avg/high) is shown as a text row and a single reference line.
There's no low↔high range bar showing where the current price sits within its historical band —
the most intuitive "is this a good price?" visual. **Better:** a horizontal range meter (low ——●——
high) on the product card and detail.

---

## 5. Content, Empty States & Onboarding

### 5.1 Empty states are minimal — [Med]

The `EmptyState` is a dashed box with a line of text ([ui.tsx](../apps/web/src/ui.tsx#L55)). No
illustration, no visual warmth. First-run (empty catalogue) is the user's first impression and it's
a gray dashed rectangle. **Better:** a friendly illustration/graphic, and a short "how it works"
for first-run.

### 5.2 No in-app help, tooltips, or guidance surfaces — [Low]

The BRD (NFR-6) requires a non-technical user to operate everything unaided, and the M2 doc scoped an
in-app user guide/help section — there's no help affordance in the UI, no tooltips on the more
subtle controls (threshold %, crossing behaviour, cooldown semantics). Settings has good inline hint
text; the rest of the app has none. **Better:** contextual tooltips (a real tooltip primitive, not
`title=`), and a help/docs entry point.

### 5.3 Microcopy is functional but flat — [Low]

Headings are the bare noun ("Products", "Alert log", "Settings"). No supportive subheadings, no
personality. Fine, but part of what makes an app feel considered. **Better:** light page
subtitles and warmer, more specific empty/success copy.

---

## 6. Consistency & System Maturity

### 6.1 No real component library — styles are inline utility strings — [High]

`ui.tsx` has ~8 primitives, but buttons/inputs are exported as **className string constants**
(`btnPrimary`, `inputCls`) pasted into `className`, not components with variants/sizes/states. There's
no `<Button variant="primary" size="sm" loading>`; loading/disabled/icon states are hand-rolled per
call site. This is why interaction states are inconsistent. **Better:** promote Button, Input, Select,
Card, Badge, Table to real components with a variant API (or adopt a headless lib — Radix/shadcn —
which also solves modal/tooltip/focus behaviour in one move).

### 6.2 Repeated, drifting patterns — [Med]

Pagination is reimplemented in Products, Alerts, and (differently) history; filter-select markup is
copy-pasted; the "← Prev / Next →" control appears twice with slightly different code. Card markup is
duplicated across catalogue, dashboard activity, and detail. **Better:** extract `Pagination`,
`FilterBar`, `ProductCard` — consistency and less drift.

### 6.3 Accessibility is thin — [Med]

Beyond `role="status"`/`role="dialog"`, there's little: the removed focus outline (3.5), icon-only
buttons with only `title=` (not `aria-label`), color-only state signaling (badges rely on
background color alone), no skip-link, charts have no textual/table alternative (the M2 doc claimed
one as an accessibility floor). **Better:** aria-labels on icon buttons, a visible focus system,
non-color status cues (icon+text), and a data-table fallback for charts.

---

## 7. Priority Shortlist (most perceived-quality per unit effort)

1. **Replace emoji with a real SVG icon set** (1.4) — instant credibility.
2. **Add a global toast system** (3.1) — the biggest interaction-feel gap.
3. **Introduce brand tokens + a non-default palette + logo/favicon** (1.1, 1.2) — identity.
4. **Theme the charts** (4.1) — the dashboard's centerpiece currently looks generic.
5. **Promote buttons/inputs to real components with states** (6.1) — unlocks consistent polish everywhere.
6. **Skeleton loaders** (3.3) and **elevation/hover system** (1.5) — perceived speed and depth.
7. Then: dark mode (1.3), sortable/grid catalogue (2.2), range-meter deal viz (4.3), a11y pass (6.3).

None of this changes behaviour or the API — it's a frontend-only styling and interaction-polish
layer. A focused pass on items 1–5 would move the app from "works like a prototype" to "looks like a
product" without touching a single backend file.

---

## 8. What's Already Good (so a redesign keeps it)

- Consistent (if plain) spacing and the one design-system file mean a token retrofit is feasible.
- URL-encoded filters, real empty/loading/error branches on every query, and the confirm-before-
  delete pattern are all sound UX foundations.
- Settings' inline hint text is genuinely helpful microcopy — extend that voice, don't replace it.
- Responsive scaffolding (sidebar↔bottom-nav) exists; it needs refinement, not a rebuild.
