# Ensemble brand — "delicate dark" (ref: pacomepertant.com)

One art style, everywhere. The reference is a motion designer's portfolio: **vast pure-black space, one clean grotesque sans, lowercase voice, enormous whitespace, and a single vivid accent object floating in the dark.** We adapt that delicacy to a live mission-control without losing legibility.

## Tokens (CSS custom properties, define once in a shared stylesheet)

```css
--ink-black:   #050505;   /* page ground — near-pure black */
--ink-panel:   #0b0b0c;   /* panels barely lift off the ground */
--ink-line:    rgba(255,255,255,0.10);  /* hairline borders, 1px only */
--ink-text:    #f4f4f2;   /* near-white, warm */
--ink-dim:     rgba(244,244,242,0.55);
--ink-faint:   rgba(244,244,242,0.32);
--blue:        #2418ff;   /* THE accent — electric blue, used sparingly */
--blue-soft:   rgba(36,24,255,0.35);
--live-green:  #7ef0a2;   /* only for the LIVE dot + success ticks */
--warn:        #ff5b45;   /* interrupt/failure only */
```

## Rules

1. **Type**: single family — `"Helvetica Neue", Inter, -apple-system, sans-serif`. Display text is big, centered where possible, `letter-spacing: -0.02em`, `text-transform: lowercase` on hero/headings/labels (the brand voice is lowercase: "ensemble", "the multiplayer moment for ai"). Small labels: 11px, `letter-spacing: 0.08em`, lowercase, `--ink-faint`. NO monospace except command lines in the timeline (keep those — they're content).
2. **Space is the ornament.** Double all section padding on the home page; the hero floats in black with nothing else on screen. In the session view, replace boxy card borders with hairlines (`1px solid var(--ink-line)`) and transparent backgrounds; let black breathe between regions.
3. **One accent.** `--blue` appears only as: the primary button, the driver ring, links/focus, and one floating orb motif. Everything else is grayscale. Agent avatar colors become subtle: tint at 25% opacity ring + faint glow, not filled chips.
4. **The orb motif** (from the ref's glossy sphere): a circle with `radial-gradient(circle at 35% 30%, rgba(255,255,255,.9), var(--blue) 45%, #0a0680 100%)` + soft box-shadow glow. Use it for: the home hero mark, the LIVE indicator, agent avatars (each agent gets the orb treatment in its hue). Humans stay flat circles with initials — delicate distinction.
5. **Motion**: everything eases `cubic-bezier(0.22, 1, 0.36, 1)`; entries fade+rise 8px over 500ms; the hero orb floats (translateY ±6px, 6s infinite alternate); buttons scale 0.98 on press. Nothing bounces. Nothing is faster than 200ms or slower than 700ms.
6. **Buttons**: pill-shaped (`border-radius: 999px`), lowercase labels. Primary = `--blue` filled, white text. Everything else = transparent with hairline border, text `--ink-dim`, hover: border brightens + text to `--ink-text`.
7. **QR code**: render on white rounded-square tile with 8px padding (a small white object floating in black — on-brand and more scannable).
8. **Consistency checklist** (every page must pass): pure black ground · one sans everywhere · lowercase display voice · hairlines not boxes · blue used ≤4 places per screen · orbs for agents/live · pill buttons · same ease curve.
```
