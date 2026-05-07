/**
 * Options Ring — hold-to-open radial navigator
 *
 * - Reads the site structure from `#site-nav` (built by `site-nav.js`).
 * - Renders concentric tiers, optional idle rotation, branch “spokes”, and pick UX.
 *
 * File map: constants → nav parsing & layout → ring lifecycle → rotation →
 * navigation animation → pointer/hit testing → branch geometry & spokes →
 * submenu sync → pointer fusion → DOM build → document listeners.
 */
(function () {
  const HOLD_MS = 200;
  const FONT_SIZE_PX = 15;
  const CHAR_WIDTH_EST = FONT_SIZE_PX * 0.55;
  /** Increase/decrease perceived tracking between characters */
  const CHAR_SPACING_FACTOR = 1.33;
  const CHILD_FONT_SIZE_PX = 11;
  const CHILD_CHAR_WIDTH_EST = CHILD_FONT_SIZE_PX * 0.55;
  const INNER_RADIUS = 44;
  const RING_GAP = 30;
  /** Hover / branch expansion: ignore pointer until it leaves the hole inside the innermost ring (layout circle). */
  const INNERMOST_RING_HOVER_MIN_R = INNER_RADIUS;
  /** Rotation ceases once cursor passes beyond this radius (25% smaller than inner hole). */
  const ROTATION_STOP_R = INNERMOST_RING_HOVER_MIN_R * 0.75;
  /** Prevent accidental submenu collapse while moving across other links. */
  const SUBMENU_GRACE_MS = 220;
  /** First child tier radius offset beyond parent's distance from ring center */
  const CHILD_TIER_FIRST_GAP = 26;
  /** Extra radius per successive child (each on its own concentric tier) */
  const CHILD_TIER_GAP = 36;
  /** Extra pixels beyond glyph bounds for pointer hit-testing */
  const MAIN_HIT_PAD = 12;
  const CHILD_HIT_PAD = 26;
  /** Must match `.ring-nav-child-slot { transition: transform … }` in styles.css */
  const CHILD_SLIDE_MS = 300;
  /** Wait for slide + opacity sweep before removing spoke DOM */
  const CHILD_REMOVE_AFTER_MS = CHILD_SLIDE_MS + 120;
  /** Extra radius so child labels hide slightly before geometric center crosses parent tier */
  const CHILD_UNDER_PARENT_R_PAD = 5;
  /** Master toggle for all ring rotation behavior */
  const ENABLE_RING_ROTATION = true;
  /** Decorative interstitial rings between tiers */
  const ENABLE_INTERSTITIAL_RINGS = true;
  /** Idle rotation while cursor stays in the center hole */
  const RING_ROT_RPM = 2;
  const RING_ROT_DEG_PER_S = (RING_ROT_RPM * 360) / 60;
  /** Cancel pending ring open if finger moves beyond this (allows scrolling). */
  const TOUCH_MOVE_SLOP_PX = 14;
  /** Ignore synthetic mouse events shortly after touch (mobile WebKit). */
  const SYNTHETIC_MOUSE_IGNORE_MS = 900;

  let holdTimer = null;
  let ringEl = null;
  /** Per-tier rotators for counter-rotation */
  let tierRotators = [];
  /** Decorative interstitial ring rotators */
  let interstitialDotRotators = [];
  let interstitialDashRotators = [];
  let active = false;
  let anchorX = 0;
  let anchorY = 0;
  let hoveredOptId = null;
  let lastClientX = 0;
  let lastClientY = 0;
  let picking = false;
  let dismissing = false;
  let rotateRaf = 0;
  let rotateLastT = 0;
  let rotateDeg = 0;
  let rotateStopped = false;
  let rotateHoverArmed = false;
  let submenuGraceTimer = 0;
  let submenuGraceTarget = null;

  /** Active primary touch id during hold / ring drag (null if mouse-only). */
  let touchHoldId = null;
  let touchStartX = 0;
  let touchStartY = 0;
  let lastTouchGestureAt = 0;

  let currentRingItems = [];
  let expandedBranchOptId = null;

  function trimText(el) {
    return (el.textContent || "").trim();
  }

  /** Canonical nav root injected by `site-nav.js`. */
  function siteNav() {
    return document.getElementById("site-nav");
  }

  // --- Nav model (DOM → ring items)

  const ACTIVE_NAV_AREA_CLASS = "active-nav-area";
  const ACTIVE_NAV_ATTR_URL = "data-nav-url";
  const ACTIVE_NAV_ATTR_TITLE = "data-nav-title";
  // Back-compat typo tolerance (user request had `dana-nav-url`).
  const ACTIVE_NAV_ATTR_URL_TYPO = "dana-nav-url";

  /**
   * Best-effort hit test for "text whitespace". Some browsers may report the
   * paragraph/container element when pointing at a rendered space or between
   * glyphs. We fall back to caret APIs to recover the underlying text node.
   */
  function elementAtPointIncludingText(clientX, clientY) {
    let el = null;
    try {
      el = document.elementFromPoint(clientX, clientY);
    } catch (_) {
      el = null;
    }
    if (el) return el;

    // Firefox: caretPositionFromPoint. WebKit: caretRangeFromPoint.
    try {
      const cp = document.caretPositionFromPoint
        ? document.caretPositionFromPoint(clientX, clientY)
        : null;
      if (cp && cp.offsetNode) {
        return cp.offsetNode.nodeType === Node.TEXT_NODE
          ? cp.offsetNode.parentElement
          : cp.offsetNode;
      }
    } catch (_) {}

    try {
      const cr = document.caretRangeFromPoint
        ? document.caretRangeFromPoint(clientX, clientY)
        : null;
      if (cr && cr.startContainer) {
        return cr.startContainer.nodeType === Node.TEXT_NODE
          ? cr.startContainer.parentElement
          : cr.startContainer;
      }
    } catch (_) {}

    return null;
  }

  function extractContextualLeavesFromSpan(span) {
    const pairs = [];
    if (!span || !span.getAttribute) return pairs;

    // Supported patterns:
    // - data-nav-title / data-nav-url
    // - data-nav-title-2 / data-nav-url-2, data-nav-title-3 / data-nav-url-3, ...
    // Also accept the `dana-nav-url` typo (with or without suffix).
    const titles = [];
    for (let i = 0; i < span.attributes.length; i++) {
      const a = span.attributes[i];
      if (!a || !a.name) continue;
      const m = a.name.match(/^data-nav-title(?:-(\d+))?$/);
      if (!m) continue;
      const idx = m[1] ? Number(m[1]) : 1;
      titles.push({ idx, name: a.name });
    }

    titles.sort((a, b) => a.idx - b.idx || a.name.localeCompare(b.name));

    for (const t of titles) {
      const suffix = t.idx === 1 ? "" : `-${t.idx}`;
      const text = span.getAttribute(t.name);
      const href =
        span.getAttribute(`${ACTIVE_NAV_ATTR_URL}${suffix}`) ||
        span.getAttribute(`${ACTIVE_NAV_ATTR_URL_TYPO}${suffix}`) ||
        span.getAttribute(`${ACTIVE_NAV_ATTR_URL}${suffix}`.toLowerCase()) ||
        span.getAttribute(`${ACTIVE_NAV_ATTR_URL_TYPO}${suffix}`.toLowerCase());
      if (!text || !href) continue;
      pairs.push({ kind: "leaf", href, text });
    }

    // If no numbered titles were present, fall back to the base attributes.
    if (!pairs.length) {
      const text = span.getAttribute(ACTIVE_NAV_ATTR_TITLE);
      const href =
        span.getAttribute(ACTIVE_NAV_ATTR_URL) ||
        span.getAttribute(ACTIVE_NAV_ATTR_URL_TYPO);
      if (text && href) pairs.push({ kind: "leaf", href, text });
    }

    return pairs;
  }

  /**
   * If the ring is invoked inside a span like:
   *   <span class="active-nav-area" data-nav-title="…" data-nav-url="…">…</span>
   * then we inject that URL/title as an additional leaf option.
   */
  function contextualLeavesAt(clientX, clientY) {
    const el = elementAtPointIncludingText(clientX, clientY);
    if (!el || !el.closest) return null;

    const out = [];

    // Support nested contextual spans: inner-most first, then walk outward.
    let cur = el.closest(`span.${ACTIVE_NAV_AREA_CLASS}`);
    while (cur) {
      out.push(...extractContextualLeavesFromSpan(cur));
      cur = cur.parentElement
        ? cur.parentElement.closest(`span.${ACTIVE_NAV_AREA_CLASS}`)
        : null;
    }

    return out.length ? out : null;
  }

  function parseNavForRing() {
    const nav = siteNav();
    if (!nav) return [];

    const items = [];

    for (const node of nav.children) {
      if (node.matches("a[href]")) {
        if (node.getAttribute("aria-current") === "page") continue;
        items.push({
          kind: "leaf",
          href: node.getAttribute("href"),
          text: trimText(node),
        });
      } else if (node.matches(".nav-branch")) {
        const parentA = node.querySelector(":scope > a[href]");
        if (!parentA) continue;

        const parentIsCurrent =
          parentA.getAttribute("aria-current") === "page";

        const children = Array.from(
          node.querySelectorAll(":scope > .nav-branch-children a[href]")
        )
          .filter((a) => a.getAttribute("aria-current") !== "page")
          .map((a) => ({
            href: a.getAttribute("href"),
            text: trimText(a),
          }));

        if (parentIsCurrent && children.length === 0) {
          continue;
        }

        items.push({
          kind: "branch",
          href: parentA.getAttribute("href"),
          text: trimText(parentA),
          children,
        });
      }
    }

    return items;
  }

  // --- Layout: flat character plan + tier assignment (no splitting a link across tiers)

  function buildCharPlan(items) {
    const plan = [];
    items.forEach((link, i) => {
      if (i > 0) {
        for (const ch of " | ") {
          plan.push({ ch, optId: null });
        }
      }
      for (const ch of link.text) {
        plan.push({ ch, optId: i, href: link.href });
      }
    });
    if (items.length > 0) {
      for (const ch of " | ") {
        plan.push({ ch, optId: null });
      }
    }
    return plan;
  }

  function layoutRings(plan) {
    const rings = [];
    const charCount = plan.length;
    let idx = 0;
    let ringIdx = 0;
    while (idx < charCount) {
      const r = INNER_RADIUS + ringIdx * RING_GAP;
      // Packing heuristic: underfill inner tiers so more text spills outward.
      // This avoids cramming most labels into the innermost ring while leaving
      // outer rings sparse.
      const utilInner = 0.68;
      const utilOuter = 0.92;
      const util = Math.min(utilOuter, utilInner + ringIdx * 0.06);
      const cap = Math.max(
        3,
        Math.floor(((2 * Math.PI * r) / (CHAR_WIDTH_EST * CHAR_SPACING_FACTOR)) * util)
      );

      // Never split a link label across tiers. We pack whole contiguous runs of the
      // same optId (including null separators). That ensures each option's text
      // stays together on a single ring.
      let take = 0;
      while (idx + take < charCount) {
        const runOptId = plan[idx + take].optId ?? null;
        let runLen = 1;
        while (
          idx + take + runLen < charCount &&
          (plan[idx + take + runLen].optId ?? null) === runOptId
        ) {
          runLen += 1;
        }

        if (take > 0 && take + runLen > cap) break;
        if (take === 0 && runLen > cap) {
          // If a single label is longer than this ring's cap, place it alone anyway.
          take = runLen;
          break;
        }
        take += runLen;
      }

      rings.push({ r, startIdx: idx, count: take });
      idx += take;
      ringIdx += 1;
    }
    return rings;
  }

  // --- Ring lifecycle (teardown, dismiss animation)

  function removeRing() {
    if (holdTimer) {
      clearTimeout(holdTimer);
      holdTimer = null;
    }
    hoveredOptId = null;
    picking = false;
    dismissing = false;
    active = false;
    currentRingItems = [];
    expandedBranchOptId = null;
    rotateStopped = false;
    rotateHoverArmed = false;
    rotateDeg = 0;
    rotateLastT = 0;
    if (rotateRaf) cancelAnimationFrame(rotateRaf);
    rotateRaf = 0;
    if (submenuGraceTimer) window.clearTimeout(submenuGraceTimer);
    submenuGraceTimer = 0;
    submenuGraceTarget = null;
    touchHoldId = null;
    document.documentElement.classList.remove("ring-nav-hold-pending");
    if (ringEl) {
      ringEl.remove();
      ringEl = null;
    }
    tierRotators = [];
    interstitialDotRotators = [];
    interstitialDashRotators = [];
    document.body.classList.remove("ring-nav-active");
  }

  // --- Idle rotation (tiers alternate direction; interstitial marks at half speed)

  function setRingRotationDeg(deg) {
    rotateDeg = deg;
    tierRotators.forEach((el, tierIdx) => {
      if (!el) return;
      // Tier 0 (innermost): clockwise. Tier 1: counter-clockwise. Alternate outward.
      const sign = tierIdx % 2 === 0 ? 1 : -1;
      el.style.transform = `rotate(${sign * deg}deg)`;
    });

    const decoDeg = deg * 0.5;
    interstitialDotRotators.forEach((el) => {
      if (!el) return;
      el.style.transform = `rotate(${decoDeg}deg)`;
    });
    interstitialDashRotators.forEach((el) => {
      if (!el) return;
      el.style.transform = `rotate(${-decoDeg}deg)`;
    });
  }

  function tickRotation(t) {
    if (!active || !ringEl || tierRotators.length === 0) {
      rotateRaf = 0;
      return;
    }
    if (rotateStopped) {
      rotateRaf = 0;
      return;
    }

    // Hard stop: rotation must cease as soon as the cursor leaves the empty inner circle,
    // even if we miss mousemove events.
    const d = pointerRadialDistanceFromRingCenter(lastClientX, lastClientY);
    if (d >= ROTATION_STOP_R) {
      stopRotation();
      return;
    }

    if (!rotateLastT) rotateLastT = t;
    const dt = Math.max(0, Math.min(0.05, (t - rotateLastT) / 1000));
    rotateLastT = t;

    setRingRotationDeg(rotateDeg + dt * RING_ROT_DEG_PER_S);
    rotateRaf = requestAnimationFrame(tickRotation);
  }

  function startRotation() {
    if (!ENABLE_RING_ROTATION) return;
    if (!active || !ringEl || tierRotators.length === 0) return;
    if (rotateStopped) return;
    if (rotateRaf) return;
    rotateLastT = 0;
    rotateRaf = requestAnimationFrame(tickRotation);
  }

  function stopRotation() {
    if (!ENABLE_RING_ROTATION) return;
    rotateStopped = true;
    if (rotateRaf) cancelAnimationFrame(rotateRaf);
    rotateRaf = 0;
  }

  // --- Dismiss overlay (scale-out transition, then teardown)

  function dismissRingAnimated() {
    if (!ringEl || dismissing || picking) return;
    dismissing = true;
    const el = ringEl;
    let finished = false;
    el.classList.remove("ring-nav-root--visible");

    const finish = () => {
      if (finished) return;
      finished = true;
      el.removeEventListener("transitionend", onTransitionEnd);
      removeRing();
    };

    function onTransitionEnd(e) {
      if (e.target !== el || e.propertyName !== "transform") return;
      finish();
    }

    el.addEventListener("transitionend", onTransitionEnd);
    window.setTimeout(finish, 400);
  }

  // --- Navigate (picked glyph animation, then `location.assign`)

  function beginNavigate(optId) {
    if (!ringEl || picking) return;
    picking = true;
    setHoveredOpt(null);
    syncBranchExpansion(null);

    ringEl.querySelectorAll(".ring-char-slot").forEach((slot) => {
      if (
        slot.dataset.optId === String(optId) &&
        slot.hasAttribute("data-nav-href")
      ) {
        slot.classList.remove("ring-char-slot--hover");
        slot.classList.add("ring-char-slot--picked");
      }
    });

    const sample = ringEl.querySelector(
      `.ring-char-slot[data-opt-id="${optId}"][data-nav-href]`
    );
    const href = sample ? sample.getAttribute("data-nav-href") : null;
    if (!href) {
      picking = false;
      return;
    }

    window.setTimeout(() => {
      window.location.assign(href);
    }, 250);
  }

  function beginNavigateChild(href) {
    if (!ringEl || picking) return;
    picking = true;
    setHoveredOpt(null);

    ringEl.querySelectorAll(".ring-nav-child-slot").forEach((slot) => {
      if (slot.getAttribute("data-nav-href") !== href) return;
      const inner = slot.querySelector(".ring-nav-child-inner");
      if (inner) {
        inner.style.opacity = "";
        inner.style.transition = "";
      }
      slot.classList.add("ring-nav-child-slot--picked");
    });

    window.setTimeout(() => {
      window.location.assign(href);
    }, 250);
  }

  // --- Pointer geometry

  function pointerRadialDistanceFromRingCenter(clientX, clientY) {
    if (!ringEl) return 0;
    const rr = ringEl.getBoundingClientRect();
    const rcx = rr.left + rr.width / 2;
    const rcy = rr.top + rr.height / 2;
    return Math.hypot(clientX - rcx, clientY - rcy);
  }

  /** Applies hover styling to all glyph slots belonging to one top-level option id. */
  function setHoveredOpt(id) {
    if (hoveredOptId === id) return;
    hoveredOptId = id;
    if (!ringEl) return;
    ringEl.querySelectorAll(".ring-char-slot").forEach((el) => {
      const oid = el.dataset.optId;
      const on =
        id !== null &&
        oid !== "" &&
        oid !== undefined &&
        Number(oid) === id;
      el.classList.toggle("ring-char-slot--hover", on);
    });
  }

  // --- Hit testing (main ring slots, then child spokes)

  function pickOptAt(x, y) {
    if (!ringEl) return null;
    const els = ringEl.querySelectorAll(".ring-char-slot[data-opt-id]");
    for (const el of els) {
      if (el.dataset.optId === "") continue;
      const r = el.getBoundingClientRect();
      if (
        x >= r.left - MAIN_HIT_PAD &&
        x <= r.right + MAIN_HIT_PAD &&
        y >= r.top - MAIN_HIT_PAD &&
        y <= r.bottom + MAIN_HIT_PAD
      ) {
        return Number(el.dataset.optId);
      }
    }
    return null;
  }

  function pickChildAt(x, y) {
    if (!ringEl) return null;

    let stack = [];
    try {
      stack = document.elementsFromPoint(x, y);
    } catch (_) {
      stack = [];
    }

    for (const el of stack) {
      const slot = el.closest(".ring-nav-child-slot");
      if (!slot || !ringEl.contains(slot)) continue;
      const href = slot.getAttribute("data-nav-href");
      if (!href) continue;
      const parentOptId = Number(slot.getAttribute("data-parent-opt-id") || "-1");
      if (pointerIntendsBranchParent(x, y, parentOptId)) continue;
      return {
        href,
        parentOptId,
      };
    }

    const rr = ringEl.getBoundingClientRect();
    const ringCx = rr.left + rr.width / 2;
    const ringCy = rr.top + rr.height / 2;

    let bestSlot = null;
    let bestTier = -1;
    let bestDistSq = -1;

    for (const slot of ringEl.querySelectorAll(".ring-nav-child-slot")) {
      const r = slot.getBoundingClientRect();
      if (
        x < r.left - CHILD_HIT_PAD ||
        x > r.right + CHILD_HIT_PAD ||
        y < r.top - CHILD_HIT_PAD ||
        y > r.bottom + CHILD_HIT_PAD
      ) {
        continue;
      }

      const cx = (r.left + r.right) / 2;
      const cy = (r.top + r.bottom) / 2;
      const distSq =
        (cx - ringCx) * (cx - ringCx) + (cy - ringCy) * (cy - ringCy);
      const tier = Number(slot.getAttribute("data-tier-index") || "0");

      if (
        bestSlot === null ||
        tier > bestTier ||
        (tier === bestTier && distSq > bestDistSq)
      ) {
        bestTier = tier;
        bestDistSq = distSq;
        bestSlot = slot;
      }
    }

    if (!bestSlot) return null;
    const pid = Number(bestSlot.getAttribute("data-parent-opt-id") || "-1");
    if (pointerIntendsBranchParent(x, y, pid)) return null;
    const href = bestSlot.getAttribute("data-nav-href");
    if (!href) return null;
    return {
      href,
      parentOptId: pid,
    };
  }

  // --- Branch geometry (glyph centroids, parent tier radius, child proximity)

  function parentGlyphCentroid(optId) {
    const slots = ringEl.querySelectorAll(
      `.ring-char-slot[data-opt-id="${optId}"][data-nav-href]`
    );
    if (!slots.length) return null;

    const rr = ringEl.getBoundingClientRect();
    let sx = 0;
    let sy = 0;
    slots.forEach((s) => {
      const r = s.getBoundingClientRect();
      sx += (r.left + r.right) / 2 - rr.left;
      sy += (r.top + r.bottom) / 2 - rr.top;
    });
    return { cx: sx / slots.length, cy: sy / slots.length };
  }

  /**
   * Outer radial boundary of the parent branch label on the main ring (furthest
   * glyph center from ring center, plus pad). Children should hide once their
   * centroid slides inside this radius during retract.
   */
  function computeParentTierOuterRadius(branchOptId) {
    if (!ringEl) return null;
    const ox = ringEl.offsetWidth / 2;
    const oy = ringEl.offsetHeight / 2;
    const slots = ringEl.querySelectorAll(
      `.ring-char-slot[data-opt-id="${branchOptId}"][data-nav-href]`
    );
    if (!slots.length) return null;

    let rMax = 0;
    slots.forEach((s) => {
      const x = parseFloat(s.style.left);
      const y = parseFloat(s.style.top);
      if (Number.isNaN(x) || Number.isNaN(y)) return;
      const r = Math.hypot(x - ox, y - oy);
      if (r > rMax) rMax = r;
    });

    if (rMax <= 0) return null;
    return rMax + CHILD_UNDER_PARENT_R_PAD;
  }

  /** Shortest screen-space distance from ring center to any child label centroid for this branch. */
  function minChildCentroidScreenRadius(branchOptId) {
    if (!ringEl) return null;
    const group = ringEl.querySelector(
      `.ring-nav-spoke-group[data-branch-opt="${branchOptId}"]`
    );
    if (!group) return null;
    const rr = ringEl.getBoundingClientRect();
    const rcx = rr.left + rr.width / 2;
    const rcy = rr.top + rr.height / 2;
    let minR = Infinity;
    group.querySelectorAll(".ring-nav-child-slot").forEach((slot) => {
      const r = slot.getBoundingClientRect();
      const cx = (r.left + r.right) / 2;
      const cy = (r.top + r.bottom) / 2;
      minR = Math.min(minR, Math.hypot(cx - rcx, cy - rcy));
    });
    return minR === Infinity ? null : minR;
  }

  /**
   * True when the pointer is still in the parent's main-ring zone vs farther-out child tiers.
   * Prevents stacked child hit targets (especially inner tiers + padding) from stealing clicks on the parent label.
   */
  function pointerIntendsBranchParent(clientX, clientY, branchOptId) {
    if (!ringEl) return false;
    const rr = ringEl.getBoundingClientRect();
    const rcx = rr.left + rr.width / 2;
    const rcy = rr.top + rr.height / 2;
    const d = Math.hypot(clientX - rcx, clientY - rcy);

    const minChildR = minChildCentroidScreenRadius(branchOptId);
    if (minChildR != null && Number.isFinite(minChildR)) {
      const margin = 16;
      return d < minChildR - margin;
    }

    const rOuter = computeParentTierOuterRadius(branchOptId);
    if (rOuter == null || rOuter <= 0) return false;
    return d <= rOuter + MAIN_HIT_PAD + 6;
  }

  // --- Branch spokes: slide/opacity choreography

  function retractChildSlotTransform(slot) {
    const sx = slot.dataset.slideDx || "0";
    const sy = slot.dataset.slideDy || "0";
    const rotDeg = slot.dataset.rotDeg ?? "0";
    slot.style.transform =
      `translate(calc(-50% + ${sx}px), calc(-50% + ${sy}px)) rotate(${rotDeg}deg)`;
  }

  function extendChildSlotTransform(slot) {
    const rotDeg = slot.dataset.rotDeg ?? "0";
    slot.style.transform = `translate(-50%, -50%) rotate(${rotDeg}deg)`;
  }

  function clearRevealTimers(group) {
    const ids = group._revealTimers;
    if (ids && ids.length) {
      ids.forEach((id) => window.clearTimeout(id));
      ids.length = 0;
    }
  }

  /** Parent tier outer radius + each child label centroid distance from ring center. */
  function computeTierRadialLayout(group, branchOptId) {
    const tierDist = new Map();
    let rTierOuter = 0;
    if (!ringEl) return { rTierOuter, tierDist };

    const ox = ringEl.offsetWidth / 2;
    const oy = ringEl.offsetHeight / 2;

    const rFromGlyphs = computeParentTierOuterRadius(branchOptId);
    if (rFromGlyphs != null && rFromGlyphs > 0) {
      rTierOuter = rFromGlyphs;
    } else {
      const pc = parentGlyphCentroid(Number(branchOptId));
      if (!pc) return { rTierOuter, tierDist };
      rTierOuter = Math.hypot(pc.cx - ox, pc.cy - oy) + CHILD_UNDER_PARENT_R_PAD;
    }

    const byTier = new Map();
    group.querySelectorAll(".ring-nav-child-slot").forEach((slot) => {
      const t = slot.getAttribute("data-tier-index") || "0";
      if (!byTier.has(t)) byTier.set(t, []);
      byTier.get(t).push(slot);
    });

    byTier.forEach((tierSlots, tierKey) => {
      let sx = 0;
      let sy = 0;
      tierSlots.forEach((s) => {
        sx += parseFloat(s.style.left) || 0;
        sy += parseFloat(s.style.top) || 0;
      });
      const n = tierSlots.length;
      const cxLabel = sx / n;
      const cyLabel = sy / n;
      tierDist.set(tierKey, Math.hypot(cxLabel - ox, cyLabel - oy));
    });

    return { rTierOuter, tierDist };
  }

  /**
   * Outward slide: time when label centroid passes outside the parent's ring tier.
   */
  function computeTierRevealDelaysMs(group, branchOptId) {
    const delays = new Map();
    const { rTierOuter, tierDist } = computeTierRadialLayout(group, branchOptId);

    tierDist.forEach((distFinal, tierKey) => {
      if (distFinal <= rTierOuter + 0.5) return;

      const delayMs = Math.round((rTierOuter / distFinal) * CHILD_SLIDE_MS);
      delays.set(
        tierKey,
        Math.min(CHILD_SLIDE_MS - 1, Math.max(0, delayMs))
      );
    });

    return delays;
  }

  /**
   * Inward slide: time when centroid passes back inside the parent's ring tier.
   */
  function computeTierHideDelaysMs(group, branchOptId) {
    const delays = new Map();
    const { rTierOuter, tierDist } = computeTierRadialLayout(group, branchOptId);

    tierDist.forEach((distFinal, tierKey) => {
      if (distFinal <= rTierOuter + 0.5) {
        delays.set(tierKey, 0);
        return;
      }

      const hideMs = Math.round(
        (1 - rTierOuter / distFinal) * CHILD_SLIDE_MS
      );
      delays.set(
        tierKey,
        Math.min(CHILD_SLIDE_MS - 1, Math.max(0, hideMs))
      );
    });

    return delays;
  }

  function animateChildGroupExpand(group, branchOptId) {
    clearRevealTimers(group);
    group._revealTimers = group._revealTimers || [];

    const slots = group.querySelectorAll(".ring-nav-child-slot");
    slots.forEach((slot) => {
      retractChildSlotTransform(slot);
      slot.style.transition = "none";
      const inner = slot.querySelector(".ring-nav-child-inner");
      if (inner) {
        inner.style.transition = "none";
        inner.style.opacity = "0";
      }
    });

    const tierDelays = computeTierRevealDelaysMs(group, branchOptId);

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (!ringEl) return;

        slots.forEach((slot) => {
          slot.style.transition = "";
          extendChildSlotTransform(slot);
        });
        group.dataset.slideExpanded = "1";

        tierDelays.forEach((delayMs, tierKey) => {
          const tid = window.setTimeout(() => {
            group
              .querySelectorAll(
                `.ring-nav-child-slot[data-tier-index="${tierKey}"]`
              )
              .forEach((slot) => {
                const inner = slot.querySelector(".ring-nav-child-inner");
                if (inner) inner.style.opacity = "1";
              });
          }, delayMs);
          group._revealTimers.push(tid);
        });
      });
    });
  }

  function animateChildGroupRetract(group) {
    if (group.dataset.retracting === "1") return;
    group.dataset.retracting = "1";

    clearRevealTimers(group);
    group._revealTimers = group._revealTimers || [];
    group.dataset.slideExpanded = "0";

    const branchOptId = Number(group.dataset.branchOpt);
    const hideDelays = computeTierHideDelaysMs(group, branchOptId);

    group.querySelectorAll(".ring-nav-child-inner").forEach((inner) => {
      inner.style.transition = "opacity 0.09s linear";
    });

    hideDelays.forEach((delayMs, tierKey) => {
      const tid = window.setTimeout(() => {
        group
          .querySelectorAll(
            `.ring-nav-child-slot[data-tier-index="${tierKey}"]`
          )
          .forEach((slot) => {
            const inner = slot.querySelector(".ring-nav-child-inner");
            if (inner) inner.style.opacity = "0";
          });
      }, delayMs);
      group._revealTimers.push(tid);
    });

    const sweep = window.setTimeout(() => {
      group.querySelectorAll(".ring-nav-child-inner").forEach((inner) => {
        inner.style.opacity = "0";
        inner.style.transition = "none";
      });
    }, CHILD_SLIDE_MS + 90);
    group._revealTimers.push(sweep);

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        group.querySelectorAll(".ring-nav-child-slot").forEach((slot) => {
          slot.style.transition = `transform ${CHILD_SLIDE_MS}ms ease-out`;
          retractChildSlotTransform(slot);
        });
      });
    });
  }

  function buildSpokeGroup(optId) {
    const item = currentRingItems[optId];
    if (!item || item.kind !== "branch" || !item.children.length) return null;

    const centroid = parentGlyphCentroid(optId);
    if (!centroid) return null;

    const ox = ringEl.offsetWidth / 2;
    const oy = ringEl.offsetHeight / 2;
    let vx = centroid.cx - ox;
    let vy = centroid.cy - oy;
    const rParent = Math.hypot(vx, vy);
    if (rParent < 8) {
      vx = 0;
      vy = -1;
    } else {
      vx /= rParent;
      vy /= rParent;
    }

    const group = document.createElement("div");
    group.className = "ring-nav-spoke-group";
    group.dataset.branchOpt = String(optId);
    group.dataset.slideExpanded = "0";

    const thetaParent = Math.atan2(centroid.cy - oy, centroid.cx - ox);

    item.children.forEach((ch, tierIndex) => {
      const tierRadius =
        rParent + CHILD_TIER_FIRST_GAP + tierIndex * CHILD_TIER_GAP;
      const label = ch.text;
      const len = label.length;
      const deltaTheta =
        tierRadius > 0 ? CHILD_CHAR_WIDTH_EST / tierRadius : 0.12;
      const totalSpan = len > 1 ? (len - 1) * deltaTheta : 0;
      const thetaStart = thetaParent - totalSpan / 2;

      const glyphs = [];
      for (let k = 0; k < len; k++) {
        const theta =
          len === 1 ? thetaParent : thetaStart + k * deltaTheta;
        const x = ox + tierRadius * Math.cos(theta);
        const y = oy + tierRadius * Math.sin(theta);
        const rotDeg = ((theta + Math.PI / 2) * 180) / Math.PI;
        glyphs.push({ x, y, rotDeg, k });
      }

      let cxLabel = 0;
      let cyLabel = 0;
      glyphs.forEach((g) => {
        cxLabel += g.x;
        cyLabel += g.y;
      });
      cxLabel /= len;
      cyLabel /= len;
      const slideDx = Math.round(ox - cxLabel);
      const slideDy = Math.round(oy - cyLabel);

      glyphs.forEach((g) => {
        const slot = document.createElement("span");
        slot.className = "ring-nav-child-slot";
        slot.setAttribute("data-nav-href", ch.href);
        slot.setAttribute("data-parent-opt-id", String(optId));
        slot.setAttribute("data-tier-index", String(tierIndex));

        const inner = document.createElement("span");
        inner.className = "ring-nav-child-inner";
        inner.textContent = label[g.k];
        inner.style.fontSize = `${CHILD_FONT_SIZE_PX}px`;
        inner.style.opacity = "0";

        slot.appendChild(inner);
        slot.style.left = `${g.x}px`;
        slot.style.top = `${g.y}px`;
        slot.dataset.slideDx = String(slideDx);
        slot.dataset.slideDy = String(slideDy);
        slot.dataset.rotDeg = String(g.rotDeg);
        retractChildSlotTransform(slot);

        group.appendChild(slot);
      });
    });

    return group;
  }

  // --- Submenu expand/collapse (with grace timer against accidental collapse)

  function syncBranchExpansionImmediate(wantOptId) {
    if (!ringEl) return;
    const spokes = ringEl.querySelector(".ring-nav-spokes");
    if (!spokes) return;

    const valid =
      wantOptId !== null &&
      currentRingItems[wantOptId] &&
      currentRingItems[wantOptId].kind === "branch" &&
      currentRingItems[wantOptId].children.length > 0;

    if (!valid) {
      spokes.querySelectorAll(".ring-nav-spoke-group").forEach((g) => {
        animateChildGroupRetract(g);
        if (g.dataset.ringNavRemoveScheduled === "1") return;
        g.dataset.ringNavRemoveScheduled = "1";
        window.setTimeout(() => {
          if (g.isConnected) g.remove();
        }, CHILD_REMOVE_AFTER_MS);
      });
      expandedBranchOptId = null;
      return;
    }

    const existing = spokes.querySelector(
      `.ring-nav-spoke-group[data-branch-opt="${wantOptId}"]`
    );
    const existingStable =
      existing &&
      existing.dataset.retracting !== "1" &&
      existing.dataset.slideExpanded === "1";
    if (expandedBranchOptId === wantOptId && existingStable) {
      return;
    }

    spokes.querySelectorAll(".ring-nav-spoke-group").forEach((g) => {
      if (Number(g.dataset.branchOpt) === wantOptId) return;
      clearRevealTimers(g);
      g.remove();
    });

    expandedBranchOptId = wantOptId;

    let group = spokes.querySelector(
      `.ring-nav-spoke-group[data-branch-opt="${wantOptId}"]`
    );
    if (group && group.dataset.retracting === "1") {
      clearRevealTimers(group);
      group.remove();
      group = null;
    }
    if (!group) {
      group = buildSpokeGroup(wantOptId);
      if (!group) {
        expandedBranchOptId = null;
        return;
      }
      spokes.appendChild(group);
    }

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (!ringEl || expandedBranchOptId !== wantOptId) return;
        animateChildGroupExpand(group, wantOptId);
      });
    });
  }

  function syncBranchExpansion(wantOptId) {
    // If a submenu is already open, avoid collapsing/switching it instantly when
    // the cursor briefly grazes another link (common when navigating from inner tiers).
    if (expandedBranchOptId !== null && wantOptId !== expandedBranchOptId) {
      if (submenuGraceTimer) window.clearTimeout(submenuGraceTimer);
      submenuGraceTarget = wantOptId;
      submenuGraceTimer = window.setTimeout(() => {
        submenuGraceTimer = 0;
        const target = submenuGraceTarget;
        submenuGraceTarget = null;
        syncBranchExpansionImmediate(target);
      }, SUBMENU_GRACE_MS);
      return;
    }

    if (submenuGraceTimer) {
      window.clearTimeout(submenuGraceTimer);
      submenuGraceTimer = 0;
      submenuGraceTarget = null;
    }

    syncBranchExpansionImmediate(wantOptId);
  }

  // --- Hover, rotation stop rules, branch expansion driver

  function updateRingPointerState(clientX, clientY) {
    if (!ringEl) return;

    const radialDist = pointerRadialDistanceFromRingCenter(clientX, clientY);
    if (ENABLE_RING_ROTATION) {
      // Only start applying "stop on hover" after the pointer has actually left the center hole once.
      if (!rotateHoverArmed && radialDist >= INNERMOST_RING_HOVER_MIN_R) {
        rotateHoverArmed = true;
      }
      // Hard stop: rotation must cease as soon as the cursor leaves the empty inner circle.
      if (!rotateStopped && radialDist >= ROTATION_STOP_R) {
        stopRotation();
      }
    }
    const mainHit = pickOptAt(clientX, clientY);
    if (radialDist < INNERMOST_RING_HOVER_MIN_R && mainHit === null) {
      setHoveredOpt(null);
      syncBranchExpansion(null);
      return;
    }
    const childHit = pickChildAt(clientX, clientY);

    const childHitTrusted =
      childHit !== null &&
      (mainHit === null || mainHit === childHit.parentOptId);

    let logicalHover = mainHit;
    if (childHitTrusted) {
      logicalHover = childHit.parentOptId;
    }

    if (ENABLE_RING_ROTATION) {
      // Freeze rotation when hovering any option (after leaving the center hole once).
      if (
        rotateHoverArmed &&
        !rotateStopped &&
        (mainHit !== null || childHitTrusted)
      ) {
        stopRotation();
      }
    }

    setHoveredOpt(logicalHover);

    let expand = null;
    if (
      mainHit !== null &&
      currentRingItems[mainHit] &&
      currentRingItems[mainHit].kind === "branch"
    ) {
      expand = mainHit;
    } else if (childHitTrusted) {
      expand = childHit.parentOptId;
    }

    syncBranchExpansion(expand);
  }

  // --- Build Options Ring DOM (tiers, pipes, interstitials, spokes container)

  function createRing(cx, cy) {
    const contextual = contextualLeavesAt(cx, cy);
    currentRingItems = parseNavForRing();
    if (contextual) {
      // Put contextual option(s) first so they’re easy to reach.
      // Avoid duplicating an existing href (rare but possible).
      for (let i = contextual.length - 1; i >= 0; i--) {
        const leaf = contextual[i];
        const dup = currentRingItems.some((it) => it && it.href === leaf.href);
        if (!dup) currentRingItems.unshift(leaf);
      }
    }
    if (!currentRingItems.length) return;

    const plan = buildCharPlan(currentRingItems);
    const rings = layoutRings(plan);

    const root = document.createElement("div");
    root.className = "ring-nav-root";
    root.setAttribute("role", "presentation");

    const maxR =
      rings.length > 0
        ? rings[rings.length - 1].r + FONT_SIZE_PX
        : INNER_RADIUS;
    const size = Math.ceil(maxR * 2 + FONT_SIZE_PX * 2);
    root.style.width = `${size}px`;
    root.style.height = `${size}px`;
    root.style.left = `${cx - size / 2}px`;
    root.style.top = `${cy - size / 2}px`;

    const ox = size / 2;
    const oy = size / 2;

    tierRotators = [];
    interstitialDotRotators = [];
    interstitialDashRotators = [];

    function computeRingThetas(ring) {
      const n = ring.count;
      if (n <= 0) return [];

      // Tight per-character spacing, independent of how many chars are on this tier.
      // Any leftover arc length becomes whitespace BETWEEN groups (links/separators),
      // not between letters.
      const minStep = (CHAR_WIDTH_EST * CHAR_SPACING_FACTOR) / ring.r;
      const full = 2 * Math.PI;
      const minSpan = n * minStep;

      if (!Number.isFinite(minStep) || minStep <= 0 || minSpan >= full) {
        const thetas = [];
        for (let k = 0; k < n; k++) {
          thetas.push(-Math.PI / 2 + (k / n) * full);
        }
        return thetas;
      }

      // Group contiguous identical optIds (including null for separators).
      const groups = [];
      let gStart = 0;
      let gOpt = plan[ring.startIdx]?.optId ?? null;
      for (let k = 1; k < n; k++) {
        const opt = plan[ring.startIdx + k]?.optId ?? null;
        if (opt !== gOpt) {
          groups.push({ start: gStart, len: k - gStart });
          gStart = k;
          gOpt = opt;
        }
      }
      groups.push({ start: gStart, len: n - gStart });

      const gapCount = groups.length;
      const gap = gapCount > 0 ? (full - minSpan) / gapCount : 0;

      const thetas = new Array(n);
      let theta = -Math.PI / 2;
      for (const g of groups) {
        for (let j = 0; j < g.len; j++) {
          thetas[g.start + j] = theta;
          theta += minStep;
        }
        theta += gap;
      }
      return thetas;
    }

    rings.forEach((ring) => {
      const tierIdx = Math.round((ring.r - INNER_RADIUS) / RING_GAP);
      const rotator = document.createElement("div");
      rotator.className = "ring-nav-rotator";
      rotator.dataset.tierIndex = String(tierIdx);
      rotator.dataset.rotDir = tierIdx % 2 === 0 ? "cw" : "ccw";
      root.appendChild(rotator);
      tierRotators[tierIdx] = rotator;

      const n = ring.count;
      const thetas = computeRingThetas(ring);
      for (let k = 0; k < n; k++) {
        const planIdx = ring.startIdx + k;
        const item = plan[planIdx];
        const theta = thetas[k] ?? (-Math.PI / 2 + (k / n) * 2 * Math.PI);
        const x = ox + ring.r * Math.cos(theta);
        const y = oy + ring.r * Math.sin(theta);
        const rotDeg = ((theta + Math.PI / 2) * 180) / Math.PI;

        const slot = document.createElement("span");
        slot.className = "ring-char-slot";
        const inner = document.createElement("span");
        inner.className = "ring-char-inner";
        inner.textContent = item.ch;
        inner.style.fontSize = `${FONT_SIZE_PX}px`;
        slot.appendChild(inner);

        if (item.ch === "|" && item.optId === null) {
          slot.classList.add("ring-char-slot--pipe");
          inner.textContent = "";
          inner.setAttribute("aria-hidden", "true");
        }

        if (item.optId !== null) {
          slot.dataset.optId = String(item.optId);
          slot.setAttribute("data-nav-href", item.href);
        } else {
          slot.dataset.optId = "";
        }

        slot.style.left = `${x}px`;
        slot.style.top = `${y}px`;
        slot.style.transform = `translate(-50%, -50%) rotate(${rotDeg}deg)`;

        rotator.appendChild(slot);
      }
    });

    if (ENABLE_INTERSTITIAL_RINGS && rings.length > 1) {
      // Decorative interstitial rings between each pair of text tiers.
      for (let i = 0; i < rings.length - 1; i++) {
        const rA = rings[i].r;
        const rB = rings[i + 1].r;
        const rMid = (rA + rB) / 2;

        const inter = document.createElement("div");
        inter.className = "ring-nav-interstitial";
        root.appendChild(inter);

        const dotsRot = document.createElement("div");
        dotsRot.className = "ring-nav-interstitial-rotator ring-nav-interstitial-rotator--dots";
        inter.appendChild(dotsRot);
        interstitialDotRotators.push(dotsRot);

        const dashesRot = document.createElement("div");
        dashesRot.className = "ring-nav-interstitial-rotator ring-nav-interstitial-rotator--dashes";
        inter.appendChild(dashesRot);
        interstitialDashRotators.push(dashesRot);

        // Random population per spawn.
        const dotCount = 8 + Math.floor(Math.random() * 18); // 8..25
        const dashCount = 6 + Math.floor(Math.random() * 14); // 6..19

        for (let k = 0; k < dotCount; k++) {
          const theta = Math.random() * 2 * Math.PI;
          const x = ox + rMid * Math.cos(theta);
          const y = oy + rMid * Math.sin(theta);
          const dot = document.createElement("span");
          dot.className = "ring-nav-mark ring-nav-mark--dot";
          dot.style.left = `${x}px`;
          dot.style.top = `${y}px`;
          dot.style.transform = "translate(-50%, -50%)";
          dotsRot.appendChild(dot);
        }

        for (let k = 0; k < dashCount; k++) {
          const theta = Math.random() * 2 * Math.PI;
          const x = ox + rMid * Math.cos(theta);
          const y = oy + rMid * Math.sin(theta);
          const rotDeg = ((theta + Math.PI / 2) * 180) / Math.PI;
          const dash = document.createElement("span");
          dash.className = "ring-nav-mark ring-nav-mark--dash";
          dash.style.left = `${x}px`;
          dash.style.top = `${y}px`;
          dash.style.transform = `translate(-50%, -50%) rotate(${rotDeg}deg)`;
          dashesRot.appendChild(dash);
        }
      }
    }

    const spokes = document.createElement("div");
    spokes.className = "ring-nav-spokes";
    root.appendChild(spokes);

    document.body.appendChild(root);
    ringEl = root;
    active = true;
    dismissing = false;
    expandedBranchOptId = null;
    document.body.classList.add("ring-nav-active");
    document.documentElement.classList.remove("ring-nav-hold-pending");
    rotateHoverArmed = false;

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (!ringEl) return;
        ringEl.classList.add("ring-nav-root--visible");
        setRingRotationDeg(0);
        if (ENABLE_RING_ROTATION) startRotation();
        updateRingPointerState(lastClientX, lastClientY);
      });
    });
  }

  // --- Document listeners (hold to open, move/up to hover/pick)

  function clearHoldTimer() {
    if (holdTimer) {
      clearTimeout(holdTimer);
      holdTimer = null;
    }
  }

  /** True if default touch OS behaviors (selection, callout) should be suppressed for this target. */
  function shouldSuppressTouchChrome(el) {
    if (!el || !el.closest) return true;
    return !el.closest(
      "a[href], button, input, textarea, select, [contenteditable='true']"
    );
  }

  function beginHoldAt(clientX, clientY) {
    anchorX = clientX;
    anchorY = clientY;
    lastClientX = clientX;
    lastClientY = clientY;
    clearHoldTimer();
    holdTimer = setTimeout(() => {
      holdTimer = null;
      createRing(anchorX, anchorY);
    }, HOLD_MS);
  }

  /** Pointer-up / finger-up: pick or dismiss (shared by mouse and touch). */
  function handleRingRelease(clientX, clientY) {
    if (!active || !ringEl || picking || dismissing) return;

    const x = clientX;
    const y = clientY;
    const mainHit = pickOptAt(x, y);
    const childHit = pickChildAt(x, y);

    const mainItem =
      mainHit !== null && !Number.isNaN(mainHit)
        ? currentRingItems[mainHit]
        : null;

    if (mainItem && mainItem.kind === "leaf") {
      beginNavigate(mainHit);
      return;
    }

    if (mainItem && mainItem.kind === "branch") {
      if (pointerIntendsBranchParent(x, y, mainHit)) {
        beginNavigate(mainHit);
        return;
      }
    }

    const childTrusted =
      childHit &&
      !pointerIntendsBranchParent(x, y, childHit.parentOptId) &&
      (mainHit === null ||
        Number(mainHit) === childHit.parentOptId);

    if (childTrusted && childHit.href) {
      beginNavigateChild(childHit.href);
      return;
    }

    if (mainHit !== null && !Number.isNaN(mainHit)) {
      const sample = ringEl.querySelector(
        `.ring-char-slot[data-opt-id="${mainHit}"][data-nav-href]`
      );
      if (sample && sample.hasAttribute("data-nav-href")) {
        beginNavigate(mainHit);
        return;
      }
    }

    dismissRingAnimated();
  }

  function onMouseDown(e) {
    if (e.button !== 0) return;
    if (active || picking || dismissing) return;
    if (Date.now() - lastTouchGestureAt < SYNTHETIC_MOUSE_IGNORE_MS) return;

    beginHoldAt(e.clientX, e.clientY);
  }

  function onMouseMove(e) {
    lastClientX = e.clientX;
    lastClientY = e.clientY;
    if (!active || !ringEl || picking || dismissing) return;
    updateRingPointerState(e.clientX, e.clientY);
  }

  function onMouseUp(e) {
    clearHoldTimer();

    if (!active || !ringEl || picking || dismissing) return;
    handleRingRelease(e.clientX, e.clientY);
  }

  function touchById(e, id) {
    for (let i = 0; i < e.touches.length; i++) {
      if (e.touches[i].identifier === id) return e.touches[i];
    }
    return null;
  }

  function changedTouchById(e, id) {
    for (let i = 0; i < e.changedTouches.length; i++) {
      if (e.changedTouches[i].identifier === id) return e.changedTouches[i];
    }
    return null;
  }

  function endTouchHoldTracking() {
    touchHoldId = null;
    document.documentElement.classList.remove("ring-nav-hold-pending");
  }

  function onTouchStart(e) {
    if (active || picking || dismissing) return;
    if (e.touches.length !== 1) return;

    lastTouchGestureAt = Date.now();
    const t = e.touches[0];
    touchHoldId = t.identifier;
    touchStartX = t.clientX;
    touchStartY = t.clientY;

    document.documentElement.classList.add("ring-nav-hold-pending");

    // Blocks iOS/Android long-press selection & system sheets for this touch sequence.
    // (Sliding past slop cancels the ring timer but scrolling may wait until finger-up.)
    if (e.cancelable && shouldSuppressTouchChrome(e.target)) {
      e.preventDefault();
    }

    beginHoldAt(t.clientX, t.clientY);
  }

  function onTouchMove(e) {
    if (touchHoldId === null) {
      if (active && ringEl && !picking && !dismissing && e.cancelable) {
        e.preventDefault();
      }
      return;
    }

    const t = touchById(e, touchHoldId);
    if (!t) return;

    lastClientX = t.clientX;
    lastClientY = t.clientY;

    if (holdTimer) {
      const dx = t.clientX - touchStartX;
      const dy = t.clientY - touchStartY;
      if (dx * dx + dy * dy > TOUCH_MOVE_SLOP_PX * TOUCH_MOVE_SLOP_PX) {
        clearHoldTimer();
        endTouchHoldTracking();
      }
    }

    if (active && ringEl && !picking && !dismissing) {
      updateRingPointerState(t.clientX, t.clientY);
      if (e.cancelable) e.preventDefault();
    }
  }

  function onTouchEnd(e) {
    if (touchHoldId !== null) {
      const ended = changedTouchById(e, touchHoldId);
      if (!ended) return;

      clearHoldTimer();
      endTouchHoldTracking();

      if (active && ringEl && !picking && !dismissing) {
        handleRingRelease(ended.clientX, ended.clientY);
      }
      if (e.cancelable) e.preventDefault();
      return;
    }

    clearHoldTimer();

    if (active && ringEl && !picking && !dismissing && e.changedTouches[0]) {
      const ct = e.changedTouches[0];
      handleRingRelease(ct.clientX, ct.clientY);
    }
    if (e.cancelable) e.preventDefault();
  }

  function onTouchCancel(e) {
    clearHoldTimer();
    endTouchHoldTracking();
    if (active && !picking && !dismissing) dismissRingAnimated();
  }

  const captureOpts = true;
  const passiveFalse = { capture: true, passive: false };

  document.addEventListener("mousedown", onMouseDown, captureOpts);
  document.addEventListener("mousemove", onMouseMove, captureOpts);
  window.addEventListener("mouseup", onMouseUp, captureOpts);

  document.addEventListener("touchstart", onTouchStart, passiveFalse);
  document.addEventListener("touchmove", onTouchMove, passiveFalse);
  document.addEventListener("touchend", onTouchEnd, passiveFalse);
  document.addEventListener("touchcancel", onTouchCancel, passiveFalse);

  // --- Navigation / BFCache safety
  //
  // Mobile and Safari often use the back/forward cache (BFCache). When a page is
  // restored from BFCache, JS state and DOM can resume exactly where they were,
  // which would leave the ring overlay and `picking` state stuck. These hooks
  // ensure the overlay is always torn down on navigation away and on restore.
  window.addEventListener("pagehide", () => removeRing(), true);
  window.addEventListener(
    "pageshow",
    (e) => {
      if (e.persisted) removeRing();
    },
    true
  );

  document.addEventListener("contextmenu", (e) => {
    if (active || document.documentElement.classList.contains("ring-nav-hold-pending")) {
      e.preventDefault();
    }
  });
})();
