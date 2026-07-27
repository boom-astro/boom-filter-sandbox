/**
 * FilterBuilder — main visual filter builder component.
 * Renders a block/condition tree and generates a live MongoDB pipeline preview.
 * Supports toggling to raw JSON "Advanced Mode" for power users.
 * Includes LLM chat for natural language filter generation and Import/Export.
 */

import { useState, useMemo, useCallback, useEffect, forwardRef, useImperativeHandle } from "react";
import { Button } from "@/components/ui/button";
import { Code, Layers, ArrowUpDown, AlertTriangle } from "lucide-react";
import type { FilterBlock, FilterNode, FieldOption } from "@/lib/filterSchema";
import { createDefaultFilter } from "@/lib/filterSchema";
import { convertToMongoPipeline, formatPipeline } from "@/lib/mongoPipelineBuilder";
import { parseMongoPipeline } from "@/lib/mongoPipelineParser";
import { flattenAvroSchema } from "@/lib/filterConstants";
import { BlockNode } from "./BlockNode";
import { MongoPreview } from "./MongoPreview";
import { LLMFilterChat } from "./LLMFilterChat";
import { ImportExportDialog } from "./ImportExportDialog";
import type { AvroSchema } from "@/lib/api";

interface FilterBuilderProps {
  /** The Avro schema for the current survey (used to populate field dropdowns) */
  schema: AvroSchema | null;
  /** Additional projection fields to include (beyond objectId) */
  projectionFields?: string[];
  /** External raw pipeline text for Advanced Mode sync */
  rawPipelineText: string;
  onRawPipelineChange: (text: string) => void;
}

/** Methods exposed via ref */
export interface FilterBuilderHandle {
  addConditionWithField: (field: string) => void;
  /** Replace the current tree with a preset and show it in the visual builder. */
  loadFilterTree: (blocks: FilterBlock[]) => void;
}

export const FilterBuilder = forwardRef<FilterBuilderHandle, FilterBuilderProps>(function FilterBuilder({
  schema,
  projectionFields,
  rawPipelineText,
  onRawPipelineChange,
}, ref) {
  const [filters, setFilters] = useState<FilterBlock[]>(createDefaultFilter);
  const [mode, setMode] = useState<"visual" | "advanced">("visual");
  const [importExportOpen, setImportExportOpen] = useState(false);
  // Why the raw JSON couldn't be turned into a tree, and what the conversion cost.
  const [parseError, setParseError] = useState<string | null>(null);
  const [parseWarnings, setParseWarnings] = useState<string[]>([]);

  // Expose addConditionWithField to parent via ref
  useImperativeHandle(ref, () => ({
    addConditionWithField(field: string) {
      setFilters((prev) => {
        const newCond = {
          id: `cond-${Date.now()}`,
          category: "condition" as const,
          field,
          operator: "$gt",
          value: "",
        };
        // Add to the first root block's children
        if (prev.length > 0) {
          const updated = [...prev];
          updated[0] = {
            ...updated[0],
            children: [...updated[0].children, newCond],
          };
          return updated;
        }
        return prev;
      });
      // Switch to visual mode if in advanced
      setMode("visual");
    },
    loadFilterTree(blocks: FilterBlock[]) {
      setFilters(blocks);
      setParseError(null);
      setParseWarnings([]);
      setMode("visual");
    },
  }), []);

  // Flatten the Avro schema into field options for dropdowns
  const fieldOptions: FieldOption[] = useMemo(() => {
    if (!schema) return [];
    return flattenAvroSchema(schema);
  }, [schema]);

  // Generate the MongoDB pipeline from the current filter tree
  const pipeline = useMemo(() => {
    if (mode === "advanced") return [];
    return convertToMongoPipeline(filters, projectionFields);
  }, [filters, projectionFields, mode]);

  const pipelineText = useMemo(() => formatPipeline(pipeline), [pipeline]);

  // Sync the generated pipeline text to the parent when in visual mode
  useEffect(() => {
    if (mode === "visual" && pipeline.length > 0) {
      onRawPipelineChange(pipelineText);
    }
  }, [pipelineText, mode, onRawPipelineChange, pipeline.length]);

  // Update a root block
  const updateRoot = useCallback((index: number, updated: FilterNode) => {
    // Notes from the last import describe the filter as it was imported, not as it is now.
    setParseWarnings([]);
    setFilters((prev) => {
      const next = [...prev];
      next[index] = updated as FilterBlock;
      return next;
    });
  }, []);

  // Import: accept either a block/condition tree (SkyPortal format) or a raw MongoDB
  // pipeline, and say why when neither works — a silent no-op reads as a broken button.
  const handleImportFromJson = useCallback((json: string) => {
    try {
      const parsed = JSON.parse(json);
      if (Array.isArray(parsed) && parsed.length > 0 && parsed[0]?.category === "block") {
        setFilters(parsed as FilterBlock[]);
        setParseError(null);
        setParseWarnings([]);
        setMode("visual");
        return true;
      }
    } catch {
      // Not JSON at all — parseMongoPipeline below reports it.
    }

    const result = parseMongoPipeline(json);
    if (!result.ok) {
      setParseError(result.error);
      return false;
    }
    setFilters(result.blocks);
    setParseWarnings(result.warnings);
    setParseError(null);
    setMode("visual");
    return true;
  }, []);

  const toggleMode = () => {
    if (mode === "visual") {
      // Switching to advanced: the tree stays as it is, the raw text takes over.
      onRawPipelineChange(pipelineText);
      setParseError(null);
      setParseWarnings([]);
      setMode("advanced");
      return;
    }
    // Switching back: the raw JSON is what the user has been editing, so it — not the
    // stale tree — is the source of truth. Refuse rather than show a filter that lies.
    handleImportFromJson(rawPipelineText);
  };

  // Escape hatch when the pipeline can't be represented: keep the tree, drop the raw edits.
  // The tree's own pipeline is pushed up right away — otherwise "discard" would be a lie,
  // the page would keep running the raw JSON the builder no longer shows. The sync effect
  // can't do it: it ignores an empty tree, which is exactly the case that matters here.
  const discardRawAndSwitch = () => {
    onRawPipelineChange(formatPipeline(convertToMongoPipeline(filters, projectionFields)));
    setParseError(null);
    setParseWarnings([]);
    setMode("visual");
  };

  // Handle LLM-generated filters
  const handleLLMFilter = useCallback((generated: FilterBlock[]) => {
    setFilters(generated);
    setParseError(null);
    setParseWarnings([]);
    setMode("visual");
  }, []);

  // Handle import from dialog
  const handleImportFromDialog = useCallback((imported: FilterBlock[]) => {
    setFilters(imported);
    setParseError(null);
    setParseWarnings([]);
    setMode("visual");
  }, []);

  return (
    <div className="space-y-3">
      {/* LLM Chat */}
      {mode === "visual" && (
        <LLMFilterChat
          fieldOptions={fieldOptions}
          onFilterGenerated={handleLLMFilter}
        />
      )}

      {/* Mode toggle + Import/Export */}
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground">
          {mode === "visual" ? "Visual Builder" : "Advanced Mode (Raw JSON)"}
        </span>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            onClick={() => setImportExportOpen(true)}
          >
            <ArrowUpDown className="h-3 w-3 mr-1" /> Import / Export
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            onClick={toggleMode}
          >
            {mode === "visual" ? (
              <><Code className="h-3 w-3 mr-1" /> Switch to Raw JSON</>
            ) : (
              <><Layers className="h-3 w-3 mr-1" /> Switch to Visual</>
            )}
          </Button>
        </div>
      </div>

      {/* Why the raw JSON couldn't become a tree, with a way out that says what it costs. */}
      {parseError && (
        <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs">
          <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0 text-amber-500" />
          <div className="space-y-1.5">
            <p>{parseError}</p>
            <p className="text-muted-foreground">
              Keep editing the JSON here, or switch and lose it — the visual builder would show its own
              tree, not this pipeline.
            </p>
            <Button
              variant="outline"
              size="sm"
              className="h-6 text-xs"
              onClick={discardRawAndSwitch}
            >
              Switch anyway and discard this JSON
            </Button>
          </div>
        </div>
      )}

      {/* What the last import had to give up */}
      {mode === "visual" && parseWarnings.length > 0 && (
        <div className="rounded-md border border-input bg-muted/40 px-3 py-2 text-xs text-muted-foreground space-y-1">
          {parseWarnings.map((warning) => (
            <p key={warning}>{warning}</p>
          ))}
        </div>
      )}

      {mode === "visual" ? (
        <>
          {/* Visual filter tree */}
          <div className="space-y-2">
            {filters.map((block, i) => (
              <BlockNode
                key={block.id}
                block={block}
                fieldOptions={fieldOptions}
                onChange={(updated) => updateRoot(i, updated)}
                isRoot
              />
            ))}
          </div>

          {/* MongoDB preview */}
          <MongoPreview pipeline={pipelineText} />
        </>
      ) : (
        /* Advanced mode: raw JSON textarea (same as the original) */
        <div>
          <textarea
            value={rawPipelineText}
            onChange={(e) => { onRawPipelineChange(e.target.value); setParseError(null); }}
            className="w-full h-64 font-mono text-xs bg-muted/50 border border-input rounded-md p-3 resize-y focus:outline-none focus:ring-2 focus:ring-ring"
            spellCheck={false}
            placeholder="Enter your MongoDB aggregation pipeline as a JSON array..."
          />
          <div className="flex items-center justify-between mt-1">
            <p className="text-[11px] text-muted-foreground">
              Must contain at least one <code>$match</code> and end with a <code>$project</code> that includes <code>"objectId": 1</code>.
            </p>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 text-xs text-muted-foreground"
              onClick={() => handleImportFromJson(rawPipelineText)}
            >
              Import as Visual Filter
            </Button>
          </div>
        </div>
      )}

      {/* Import/Export Dialog */}
      <ImportExportDialog
        open={importExportOpen}
        onClose={() => setImportExportOpen(false)}
        onImport={handleImportFromDialog}
        currentFilters={filters}
      />
    </div>
  );
});
