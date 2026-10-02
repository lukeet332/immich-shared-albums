# web/ui/lib — the design system

One place each thing is written down, so a page states intent and the theme states everything else.
The layers below are the whole vocabulary; a rule that is not here is a rule a page invented.

## The layers

| File                  | Owns                                                                                                                                                                       |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tokens.css`          | Every colour, radius, space step and duration, in both schemes. The only file under `src/web/ui` allowed a colour literal (`scripts/check-tokens.mjs`).                    |
| `ui.css`              | The shared components: card, section, row, button, field, setting, switch, notice, dialog, spinner, keyframes. A page styles itself from here plus its own stylesheet.           |
| `base.css`            | The document shell our own pages render into — `body`, `main`, the heading reset, `.isa-page-*`, the focus ring. Imports `ui.css`.                                           |
| `<page>.css`          | Only what is that page's. Every page imports `base.css`; `share.css` imports `ui.css` directly, because its document frames Immich's page and must not restyle it.               |

`ui.css` is inlined **before** `base.css` — it is what `base.css` imports — so a rule in `ui.css`
that a `base.css` rule of the same specificity also names always loses to it. Narrow-screen overrides
for `.isa-page-*` therefore live in `base.css`, and the `@media` block at the end of `ui.css` carries
only selectors `base.css` does not declare.

`--isa-accent` is load-bearing outside this file: `demo/e2e/browser-test.mjs` asserts a signed-out
page's CTA computes to `rgb(66, 80, 175)`. Changing the light accent changes that contract.

## Components

| Export          | Renders                                                    | Used by                                              |
| --------------- | ---------------------------------------------------------- | ---------------------------------------------------- |
| `Button`        | `<button class="isa-btn isa-btn--{fill}">`, `type="button"` | every panel page, the accept page, `confirm.tsx`      |
| `Card`          | `<section class="isa-card isa-enter">` with an optional lede   | panel, me, root                                      |
| `Setting`       | `<label class="isa-setting">` — text, description, control | panel `Settings.tsx`, me `App.tsx`                   |
| `Switch`        | `<input type="checkbox" role="switch" class="isa-switch">` | panel `Settings.tsx`, me `App.tsx`                   |
| `Notice`        | `#notice`, the snackbar, `role=status`/`alert`            | me `App.tsx`, panel `App.tsx` and `LinkServer.tsx`     |
| `confirm.tsx`   | `Confirm` — the one dialog, `.isa-scrim` + `.isa-dialog`   | me, panel                                            |

`Button`'s `fill` is the only knob: `filled`, `outlined`, `text`, `danger`, `dangerFilled`.
Destructive in a list is `danger` (tonal) so a page of rows is not a wall of red; the filled
`dangerFilled` is for a confirmation, where the action is the only thing on screen.

`Button` does **not** forward a `ref`. Preact hands a function component's ref its own wrapper, not
the DOM node, and `confirm.tsx` — the one caller that needs the node, to take the caret — writes its
confirm button out as a host `<button>` instead. Anything else that needs the node does the same.

## The switch

- A **real `<input type="checkbox">`**, drawn by `ui.css` with `appearance: none`. No replacement
  element and no `div` with a click handler: the keyboard, the form and assistive technology get the
  control they already understand.
- `role="switch"` is what announces it as on/off rather than checked/unchecked.
- Track 52x32. Thumb 16 unselected and 24 selected, centred at Material's 16dp and 36dp; pressing
  grows it to 28 about that same centre, so it never slides.
- The whole row is the target: `Setting` wraps the control in a `<label>`, so nobody has to hit 52
  pixels of switch.

## Space

- `--isa-space-1..8` is a 4px step (4, 8, 12, 16, 20, 24, 32, 40). Nothing else is a margin.
- A page is one column of `--isa-page-max` (560px) inside `--isa-gutter`, 16px and 24px from 600px.
- Rows are `--isa-space-4` of padding with a hairline **between** them (`.isa-row + .isa-row`), never
  under the last.
- Cards are `--isa-pad-card`, 20px and 16px under 420px.
- Sections are `--isa-space-6` apart; a section's title is `.isa-section-title`.

## Motion

- Two curves, Google's: `--isa-ease-standard` for anything that settles, `--isa-ease-emphasized`
  for an entrance or a press that has to feel answered. Three durations: `--isa-duration-short`,
  `-medium`, `-long`.
- Four arrivals — the card (`isa-rise-in`), the sheet (`isa-sheet-in`), the dialog (`isa-dialog-in`,
  with its scrim's `isa-fade-in`) and the notice (`isa-notice-in`) — and one loop, the spinner
  (`isa-spin`). Everything else arrives and is then still. The notice also leaves (`isa-notice-out`),
  in the direction it was swiped.
- Buttons carry a state layer (`.isa-btn::after`, 8% hover / 12% pressed) rather than a colour swap;
  the switch answers a press by growing both its thumb and its halo.
- `prefers-reduced-motion: reduce` collapses all of it, scoped to `.isa-page` — the class
  `Document.tsx` puts on `<body>` — so the rule cannot reach the framed Immich page under the banner.

## The snackbar

- `Notice` is how **every** action reports: a card that writes its outcome into itself puts the
  message where the row it describes no longer is, and unlinking deletes that row.
- It spans the gutter — `width`, not `max-width` — because a bar that hugs its words wraps a
  one-line outcome into six, and a phone is the only place it is read.
- `--isa-notice-surface` is **dark in both schemes**, as Google Photos draws it. Inverting the page's
  ink instead puts a glaring white box on a dark page.
- **Three ways out**, because each leaves someone out otherwise: the × , a horizontal swipe
  (pointer events, so the finger and the mouse are one path), and Escape. A short swipe springs
  back — a bar that vanishes under a slip is worse than no bar.
- `touch-action: pan-y` keeps a vertical drag the page's scroll.

## Narrow screens

- Under 560px the accept card and the share banner become **sheets**: square bottom corners, padded
  above `env(safe-area-inset-bottom)`.
- Under 420px a row's action drops to its own line, full width — a button sharing a line with a long
  album name leaves neither readable.
- `--isa-touch` (44px) is the floor for anything tappable, whatever its type size says.

## Test contracts

Class names and ids the browser lane drives, which must survive a redesign:

| Selector                                          | Where                                                        |
| ------------------------------------------------- | ------------------------------------------------------------ |
| `#immich-shared-albums-banner .card/.dismiss/input/button.join/.err` | `pages/share/Share.tsx`                      |
| `#who`, `#go`, `#out`, `#reunion`, `#joinseparate`, `#openapp` | `pages/accept/Accept.tsx`                    |
| `a.choice`                                        | `pages/root/App.tsx` — asserted for `display:flex` and the chevron's position |
| `label:has-text(...) input[type=checkbox]`        | `pages/panel/Settings.tsx` — the switches are still checkboxes |
| `#audit-visible`                                  | `pages/me/App.tsx` — the album-activity switch               |
| `a[href="/auth/login"]`                           | `pages/sign-in/` — asserted `rgb(66, 80, 175)`               |

A section title is **rendered** text, not markup: `.isa-section-title` uppercases it, and Playwright's
`innerText` returns what was painted. Anything that reads a heading out of `innerText` must therefore
match it case-insensitively — `sectionBetween` in `demo/e2e/browser-test.mjs` is that helper, and it
exists because the uppercase broke the panel's "the pair appears" checks without failing loudly.