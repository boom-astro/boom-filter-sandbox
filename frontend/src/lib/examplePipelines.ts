/**
 * Ready-made example filters offered as one-click presets in the Filter Tester.
 *
 * These are expressed as block/condition trees (not raw JSON) so they load
 * straight into the visual builder and survive a Visual ⇄ Raw JSON round trip.
 */

import type { FilterBlock, FilterCondition, FilterNode } from "./filterSchema";

/** Stable ids keep React keys predictable across reloads of the same preset. */
function cond(id: string, field: string, operator: string, value: string | number | boolean): FilterCondition {
  return { id: `fast-fading-${id}`, category: "condition", field, operator, value };
}

function block(id: string, operator: "and" | "or", children: FilterNode[]): FilterBlock {
  return { id: `fast-fading-${id}`, category: "block", operator, children };
}

/**
 * "Fast fading transient" preset.
 *
 * High-confidence detections with a limited detection history and a clean stamp.
 */
export const FAST_FADING_FILTER: FilterBlock[] = [
  block("root", "and", [
    // Deep Real/Bogus score
    cond("drb", "candidate.drb", "$gt", 0.9),
    // Limited historical detections
    cond("ndethist", "candidate.ndethist", "$lte", 200),
    // Few bad pixels in the stamp
    cond("nbad", "candidate.nbad", "$lt", 5),
  ]),
];

/** Time window the preset is meant to be evaluated over (Julian dates). */
export const FAST_FADING_JD_RANGE = { start: "2460483", end: "2460490" };
