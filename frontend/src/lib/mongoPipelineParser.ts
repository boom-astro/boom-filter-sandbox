/**
 * Converts a MongoDB aggregation pipeline back into a block/condition filter tree —
 * the inverse of mongoPipelineBuilder, used when leaving Advanced (Raw JSON) mode.
 *
 * Only what the visual builder can express survives the trip: $match stages made of
 * field/operator/value conditions, $and/$or blocks, and $expr (kept as a read-only
 * expression node). Anything else fails with a reason instead of silently dropping
 * part of the filter — a filter that looks simpler than it is would be worse than
 * no import at all.
 */

import { createExpression, generateId } from "./filterSchema";
import type { FilterBlock, FilterCondition, FilterNode } from "./filterSchema";
import { OPERATORS } from "./filterConstants";
import { BUILDER_PROJECTION_FIELDS } from "./mongoPipelineBuilder";

export type ParseResult =
  | { ok: true; blocks: FilterBlock[]; warnings: string[] }
  | { ok: false; error: string };

const SUPPORTED_OPS = new Set(OPERATORS.map((op) => op.mongoOp));

/** Thrown for anything the visual builder has no way to show. */
class UnsupportedFilter extends Error {}

/** Collects what the conversion had to give up, reported back to the user. */
type Ctx = {
  /** Fields whose quoted value the builder will hand back as a number or boolean. */
  retyped: Set<string>;
  /** Projected fields the regenerated $project drops. */
  droppedProjection: string[];
};

/**
 * The tree stores condition values as plain text, and the builder re-types anything
 * that parses as a number or a boolean. So `"1"` comes back as `1` — worth saying out
 * loud on a field like `candidate.isdiffpos`, where "1" and 1 are different matches.
 */
function noteRetyped(field: string, value: unknown, ctx: Ctx): void {
  if (typeof value !== "string") return;
  const trimmed = value.trim();
  if (trimmed === "") return;
  if (trimmed === "true" || trimmed === "false" || !isNaN(Number(trimmed))) {
    ctx.retyped.add(field);
  }
}

function asObject(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new UnsupportedFilter(`${what} (expected an object)`);
  }
  return value as Record<string, unknown>;
}

function toConditionValue(value: unknown, field: string): string | number | boolean {
  if (typeof value === "number" || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  throw new UnsupportedFilter(`the value of "${field}" (only numbers, strings and booleans)`);
}

function condition(field: string, operator: string, value: string | number | boolean): FilterCondition {
  return { id: generateId("cond"), category: "condition", field, operator, value };
}

/** `{ field: 5 }`, `{ field: { $gt: 1, $lt: 2 } }` → one condition per operator. */
function parseFieldValue(field: string, value: unknown, ctx: Ctx): FilterCondition[] {
  // Shorthand equality: { "candidate.fid": 1 }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    noteRetyped(field, value, ctx);
    return [condition(field, "$eq", toConditionValue(value, field))];
  }

  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) {
    throw new UnsupportedFilter(`the empty operator object on "${field}"`);
  }
  // A plain sub-document (no $-keys) is an exact whole-document match, not a comparison.
  if (!entries.every(([key]) => key.startsWith("$"))) {
    throw new UnsupportedFilter(`the sub-document match on "${field}"`);
  }

  return entries.map(([op, operand]) => {
    if (!SUPPORTED_OPS.has(op)) {
      throw new UnsupportedFilter(`the "${op}" operator on "${field}"`);
    }
    if (op === "$in") {
      if (!Array.isArray(operand)) {
        throw new UnsupportedFilter(`"$in" on "${field}" (expected an array)`);
      }
      // The tree stores $in operands as the comma-separated string the UI edits.
      operand.forEach((item) => noteRetyped(field, item, ctx));
      return condition(field, "$in", operand.map((v) => String(toConditionValue(v, field))).join(", "));
    }
    if (op === "$exists") {
      return condition(field, "$exists", operand !== false);
    }
    noteRetyped(field, operand, ctx);
    return condition(field, op, toConditionValue(operand, field));
  });
}

/** Short label for an $expr node — the row shows the full JSON on hover. */
function summarizeExpr(expr: unknown): string {
  const json = JSON.stringify(expr);
  return json.length <= 60 ? json : `${json.slice(0, 57)}…`;
}

function parseMatchExpr(expr: Record<string, unknown>, ctx: Ctx): FilterNode[] {
  const nodes: FilterNode[] = [];

  for (const [key, value] of Object.entries(expr)) {
    if (key === "$and" || key === "$or") {
      if (!Array.isArray(value)) {
        throw new UnsupportedFilter(`"${key}" (expected an array)`);
      }
      const children = value.flatMap((child) => parseMatchExpr(asObject(child, `a "${key}" branch`), ctx));
      if (children.length === 0) {
        throw new UnsupportedFilter(`the empty "${key}"`);
      }
      nodes.push({
        id: generateId("block"),
        category: "block",
        operator: key === "$and" ? "and" : "or",
        children,
      });
    } else if (key === "$expr") {
      nodes.push(createExpression(summarizeExpr(value), asObject(value, "$expr")));
    } else if (key.startsWith("$")) {
      throw new UnsupportedFilter(`the top-level "${key}" operator`);
    } else {
      nodes.push(...parseFieldValue(key, value, ctx));
    }
  }

  return nodes;
}

/** Projected fields the builder would drop, since it regenerates its own $project. */
function droppedProjectionFields(project: unknown): string[] {
  if (typeof project !== "object" || project === null) return [];
  const kept = new Set([...BUILDER_PROJECTION_FIELDS, "objectId", "_id"]);
  return Object.entries(project as Record<string, unknown>)
    .filter(([field, include]) => include !== 0 && !kept.has(field))
    .map(([field]) => field);
}

/**
 * Parse a raw pipeline (as typed in Advanced Mode) into a filter tree.
 * Returns the reason instead of a tree when the pipeline goes beyond the builder.
 */
export function parseMongoPipeline(text: string): ParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: "Invalid JSON — check the syntax." };
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    return { ok: false, error: "The pipeline must be a non-empty JSON array." };
  }

  const nodes: FilterNode[] = [];
  const ctx: Ctx = { retyped: new Set(), droppedProjection: [] };

  try {
    for (const rawStage of parsed) {
      const stage = asObject(rawStage, "a pipeline stage");
      const names = Object.keys(stage);
      if (names.length !== 1) {
        throw new UnsupportedFilter("a stage holding more than one operator");
      }
      const [name] = names;
      if (name === "$match") {
        nodes.push(...parseMatchExpr(asObject(stage[name], "$match"), ctx));
      } else if (name === "$project") {
        ctx.droppedProjection.push(...droppedProjectionFields(stage[name]));
      } else {
        throw new UnsupportedFilter(`the "${name}" stage`);
      }
    }
  } catch (err) {
    if (err instanceof UnsupportedFilter) {
      return { ok: false, error: `The visual builder can't represent ${err.message}.` };
    }
    throw err;
  }

  if (nodes.length === 0) {
    return { ok: false, error: "Nothing to show: the pipeline has no conditions in a $match stage." };
  }

  const warnings: string[] = [];
  if (ctx.droppedProjection.length > 0) {
    warnings.push(
      `The visual builder regenerates its own $project, so these projected fields were dropped: ${[...new Set(ctx.droppedProjection)].join(", ")}.`,
    );
  }
  if (ctx.retyped.size > 0) {
    warnings.push(
      `Quoted values on ${[...ctx.retyped].join(", ")} are rebuilt as numbers or booleans — the visual builder stores values as plain text and can't tell "1" from 1.`,
    );
  }

  return {
    ok: true,
    blocks: [{ id: generateId("block"), category: "block", operator: "and", children: nodes }],
    warnings,
  };
}
