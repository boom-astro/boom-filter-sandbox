/**
 * ExpressionRow — a raw MongoDB `$expr` condition inside the visual tree.
 * Shown read-only (with its human-readable label) since these expressions
 * can't be edited with the field/operator/value controls.
 */

import { Button } from "@/components/ui/button";
import { X, FunctionSquare } from "lucide-react";
import type { FilterExpression } from "@/lib/filterSchema";

interface ExpressionRowProps {
  expression: FilterExpression;
  onRemove: () => void;
  removable: boolean;
}

export function ExpressionRow({ expression, onRemove, removable }: ExpressionRowProps) {
  return (
    <div className="flex items-center gap-2 group">
      <div
        className="flex items-center gap-2 rounded-md border border-dashed border-input bg-muted/40 px-2 py-1.5 text-xs"
        title={JSON.stringify({ $expr: expression.expr }, null, 2)}
      >
        <FunctionSquare className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="font-mono">{expression.label}</span>
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">expr</span>
      </div>

      {removable && (
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-destructive"
          onClick={onRemove}
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      )}
    </div>
  );
}
