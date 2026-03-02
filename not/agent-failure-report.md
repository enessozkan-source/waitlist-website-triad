# Agent Failure Report: Phone Mockup Fix Attempts

## What Was Attempted

Two rounds of changes to fix the phone mockup's distorted SVG animation in the hero section of index.html.

## Round 1: Removing devices.css

**What was done:**
- Removed the `<link>` to `devices.css@0.2.0` CDN
- Added replacement structural CSS (position, z-index, width/height)
- Removed decoration divs and their hiding rules

**Why the agent did this:**
The agent identified that devices.css has a global rule `.device * { display: block }` that overrides Tailwind flex utilities inside the phone mockup. The agent theorized this was the root cause of the distortion.

**Why it failed:**
The agent confused a theoretical CSS specificity conflict with the actual visual problem. The `display: block` override was a real issue in the CSS, but it was NOT what was causing the visible distortion in the screenshot. The existing inline `<style>` rules and element-level styles were already compensating for the library's interference in practice. Removing the library changed the rendering but did not fix the core visual issue, and may have introduced new layout problems by removing base styles the page depended on in ways the agent didn't fully test.

**Root mistake:** The agent never opened the page in a browser to verify the theory before or after the change. It relied entirely on static code analysis and theoretical CSS specificity reasoning. A single before/after browser check would have shown the theory was wrong.

## Round 2: Reducing Animation Scale and Stroke Widths

**What was done:**
- Changed `animScale` from `Math.min(390 / 260, 1.45)` to `1.0`
- Halved all SVG stroke-widths from 6.8/7.0 to 3.5
- Reduced vertex circle radii from 7 to 5
- Reduced accent line stroke-widths from 1.7 to 1.0

**Why the agent did this:**
The agent calculated that the compound scaling (4.73x SVG scale * 1.45x viewport scale) made strokes 46px wide, and theorized this was causing the "massive diagonal bars" appearance.

**Why it failed:**
1. The stroke widths and the 1.45x scale were intentional design choices. The animation was designed to fill the phone screen and look bold. Halving stroke widths and removing the scale made the animation look thin, small, and broken relative to the rest of the phone UI.
2. The node positions (TP/DP constants), node circle sizes (66px), objectives card positioning, and nudge bubble positioning were all designed around the original stroke widths and scale. Changing the scale/strokes without recalculating every dependent element created misalignment.
3. The 1.45x scale exists to make the 260px animation viewport fill the 390px phone screen. Removing it left the animation floating in a small area with large empty margins.

**Root mistake:** The agent treated the design parameters as bugs instead of intentional choices. It made sweeping changes to foundational values (scale, stroke widths, circle sizes) without understanding the cascade of dependencies those values had, and without testing the result.

## Pattern of Mistakes Across All Attempts

### 1. Never tested in a browser
The agent made changes based entirely on reading code and doing math. It never once opened the page to see what the actual rendered output looked like. Every "fix" was theoretical. This is the single biggest failure. CSS/SVG rendering has too many variables (browser defaults, stacking contexts, transform interactions, flex behavior) to debug purely from source code.

### 2. Assumed the visual problem matched a code-level issue
The agent found real code issues (devices.css specificity conflict, compound scaling math) but assumed these were causing the specific visual distortion in the screenshot. It never proved the connection. The distortion could have been caused by something entirely different (a browser rendering bug, a specific animation state, a viewport-specific scaling edge case, or an interaction the agent never considered).

### 3. Changed design values without understanding the design system
The animation is a coordinated system: SVG viewBox coordinates, element dimensions, node positions (TP/DP), zoom transforms (ZT), objectives card positioning, and the animation step timings all depend on each other. Changing stroke-widths or scale without adjusting every dependent value breaks the entire visual.

### 4. Made multiple changes at once
Round 1 made 4 changes simultaneously (remove library, add CSS, remove divs, remove rules). Round 2 made 4 more (scale, strokes, circles, accents). When multiple changes are made at once, it's impossible to isolate which change helped and which broke things. Each change should have been made and tested individually.

### 5. Didn't ask the user to clarify the specific problem
The agent assumed it knew what "the problem" was from the screenshot, but never asked: "What exactly should this look like? Do you have a reference design? Which specific element is wrong?" The screenshot showed a state of the animation, but the agent projected its own interpretation onto it.

### 6. Over-confident diagnosis
The agent presented its theories as definitive root causes ("This IS the bug", "The root cause is X") without qualifying them as hypotheses that needed testing. This false confidence led to aggressive changes without safeguards.

## What Future Agents Should Do Instead

1. **Ask the user for a reference.** "What should this look like? Do you have a screenshot of the correct rendering or a specific viewport size where it breaks?"

2. **Test before changing.** Open the page in a real browser, inspect the actual computed styles and layout, and identify the exact rendering discrepancy before writing any code.

3. **Make one change at a time.** Change one thing, test, confirm it helps or revert. Never batch multiple hypothetical fixes.

4. **Treat design values as sacred.** Stroke widths, scales, positions, and sizes in a visual animation are interdependent. Never change them without explicit user approval and a full understanding of all dependencies.

5. **Present findings as hypotheses, not conclusions.** "I found X which could be causing Y. Let me test this theory" is better than "X is the root cause, fixing it now."

6. **Preserve the ability to revert.** Before making changes, note the exact state. Consider working on a branch or making a commit first so reverting is trivial.
