/**
 * Ready-made example filters offered as one-click presets in the Filter Tester.
 *
 * These are expressed as block/condition trees (not raw JSON) so they load
 * straight into the visual builder and survive a Visual ⇄ Raw JSON round trip.
 */

import type { FilterBlock, FilterCondition, FilterExpression, FilterNode } from "./filterSchema";

/** Bands for which BOOM computes per-band light-curve statistics on ZTF alerts. */
const ZTF_PHOTSTATS_BANDS = ["g", "r", "i"];

/** Stable ids keep React keys predictable across reloads of the same preset. */
function cond(id: string, field: string, operator: string, value: string | number | boolean): FilterCondition {
  return { id: `fast-fading-${id}`, category: "condition", field, operator, value };
}

function expr(id: string, label: string, expression: Record<string, unknown>): FilterExpression {
  return { id: `fast-fading-${id}`, category: "expression", label, expr: expression };
}

function block(id: string, operator: "and" | "or", children: FilterNode[]): FilterBlock {
  return { id: `fast-fading-${id}`, category: "block", operator, children };
}

/**
 * "Fast fading transient" preset.
 *
 * Recent, high-confidence, extragalactic detections whose light curve is
 * fading quickly in at least one band.
 *
 * Note: BOOM's light-curve fit reports `red_chi2` (reduced chi-squared), not an
 * r-squared, so the "quality of the linear fit" cut is expressed as
 * `red_chi2 ≤ 2` — tighten or loosen it as needed.
 */
export const FAST_FADING_FILTER: FilterBlock[] = [
  block("root", "and", [
    // Deep Real/Bogus score
    cond("drb", "candidate.drb", "$gt", 0.9),
    // Limited historical detections
    cond("ndethist", "candidate.ndethist", "$lte", 200),
    // Few bad pixels in the stamp
    cond("nbad", "candidate.nbad", "$lt", 5),
    // New detection on a positive subtraction
    cond("isdiffpos", "candidate.isdiffpos", "$eq", true),
    // Not a known solar-system object, star, or bright-star neighbour
    cond("rock", "properties.rock", "$eq", false),
    cond("star", "properties.star", "$eq", false),
    cond("brightstar", "properties.near_brightstar", "$eq", false),
    // Stationary source
    cond("stationary", "properties.stationary", "$eq", true),
    // Recent: less than 7 days since the start of the detection history
    expr("recent", "|candidate.jd − candidate.jdstarthist| < 7", {
      $lt: [{ $abs: { $subtract: ["$candidate.jd", "$candidate.jdstarthist"] } }, 7],
    }),
    // Magnitude consistency: |magpsf − magap| < 0.75 mag
    expr("magconsistency", "|candidate.magpsf − candidate.magap| < 0.75", {
      $lt: [{ $abs: { $subtract: ["$candidate.magpsf", "$candidate.magap"] } }, 0.75],
    }),
    // More images covering the position than actual detections
    expr("coverage", "candidate.ncovhist > candidate.ndethist", {
      $gt: ["$candidate.ncovhist", "$candidate.ndethist"],
    }),
    // Away from the Galactic plane: |b| ≥ 20 deg
    block("galactic", "or", [
      cond("b-north", "coordinates.b", "$gte", 20),
      cond("b-south", "coordinates.b", "$lte", -20),
    ]),
    // At least one band fading at ≥ 0.3 mag/day with an acceptable linear fit
    block(
      "fading",
      "or",
      ZTF_PHOTSTATS_BANDS.map((band) =>
        block(`fading-${band}`, "and", [
          cond(`fading-${band}-rate`, `properties.photstats.${band}.fading.rate`, "$gte", 0.3),
          cond(`fading-${band}-chi2`, `properties.photstats.${band}.fading.red_chi2`, "$lte", 2),
        ]),
      ),
    ),
  ]),
];

/** Time window the preset is meant to be evaluated over (Julian dates). */
export const FAST_FADING_JD_RANGE = { start: "2460478", end: "2460490" };
