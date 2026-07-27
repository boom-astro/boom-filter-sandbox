import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { Card, CardHeader, CardTitle, CardDescription, CardAction, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Select, SelectTrigger, SelectContent, SelectItem, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { AlertTriangle, ChevronLeft, ChevronRight, Info, Sparkles } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { FilterBuilder } from "@/components/filter/FilterBuilder";
import type { FilterBuilderHandle } from "@/components/filter/FilterBuilder";
import { FilterFieldBrowser } from "@/components/filter/FilterFieldBrowser";
import { FilterHealthPanel } from "@/components/filter/FilterHealthPanel";
import { TimeFormatSelect, TimeInput } from "@/components/alert-filter-form";
import { AlertCutoutCard, type AlertCardData } from "@/components/alert-cutout-card";
import { jdToFormatString, type TimeFormat } from "@/lib/time";
import { flattenAvroSchema } from "@/lib/filterConstants";
import api, { type FilterTestParams, type FilterTestCountResult, type AvroSchema, type Cutouts } from "@/lib/api";
import { ZTF_FALLBACK_SCHEMA } from "@/lib/ztfFallbackSchema";
import { FAST_FADING_FILTER, FAST_FADING_JD_RANGE } from "@/lib/examplePipelines";

const DEFAULT_PIPELINE = `[
  {
    "$match": {
      "candidate.drb": { "$gt": 0.5 }
    }
  },
  {
    "$project": {
      "_id": 1,
      "objectId": 1,
      "candid": 1,
      "candidate.ra": 1,
      "candidate.dec": 1,
      "candidate.magpsf": 1,
      "candidate.jd": 1
    }
  }
]`;

const FORBIDDEN_STAGES = ["$lookup", "$unionWith", "$out", "$merge"];

function validatePipeline(raw: string): { valid: boolean; error: string | null; pipeline: Record<string, unknown>[] | null } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { valid: false, error: "Invalid JSON. Please check your syntax.", pipeline: null };
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    return { valid: false, error: "Pipeline must be a non-empty JSON array.", pipeline: null };
  }

  const stages = parsed as Record<string, unknown>[];

  // Check for forbidden stages
  for (const stage of stages) {
    const keys = Object.keys(stage);
    for (const key of keys) {
      if (FORBIDDEN_STAGES.includes(key)) {
        return { valid: false, error: `Stage "${key}" is not allowed in filter pipelines.`, pipeline: null };
      }
    }
  }

  // Must contain at least one $match
  const hasMatch = stages.some((s) => "$match" in s);
  if (!hasMatch) {
    return { valid: false, error: "Pipeline must contain at least one $match stage.", pipeline: null };
  }

  // Must end with $project containing objectId: 1
  const lastStage = stages[stages.length - 1];
  if (!("$project" in lastStage)) {
    return { valid: false, error: "Pipeline must end with a $project stage.", pipeline: null };
  }
  const proj = lastStage["$project"] as Record<string, unknown> | undefined;
  if (!proj || proj["objectId"] !== 1) {
    return { valid: false, error: 'Final $project must include "objectId": 1.', pipeline: null };
  }

  return { valid: true, error: null, pipeline: stages };
}

// Adapt a raw pipeline result document into the shape AlertCutoutCard needs.
function toAlertCardData(row: Record<string, unknown>): AlertCardData {
  const candidate = (row["candidate"] && typeof row["candidate"] === "object")
    ? row["candidate"] as Record<string, unknown>
    : {};
  const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);
  const str = (v: unknown): string | undefined => (v !== undefined && v !== null ? String(v) : undefined);
  return {
    objectId: str(row["objectId"]),
    // In the alert collection the candid *is* the _id — and the API forbids projecting it
    // away, so it is always there. Without it the card falls back to the object-level
    // cutout lookup, which returns the object's brightest alert whatever its programid:
    // often a private one whose cutouts aren't stored, hence "No cutouts" on a public alert.
    candid: str(row["candid"] ?? candidate["candid"] ?? row["_id"]),
    jd: num(candidate["jd"] ?? row["jd"]),
    magpsf: num(candidate["magpsf"] ?? row["magpsf"]),
    fid: num(candidate["fid"] ?? row["fid"]),
    band: str(candidate["band"] ?? row["band"]),
    drb: num(candidate["drb"] ?? candidate["reliability"] ?? row["drb"]) ?? null,
  };
}

function friendlyError(err: unknown, fallback: string): string {
  if (err instanceof TypeError) {
    return "Backend unreachable.";
  }
  const raw = err instanceof Error ? err.message : "";
  const statusMatch = raw.match(/:\s*(\d{3})\s*(.*)$/);
  if (statusMatch) {
    const status = parseInt(statusMatch[1], 10);
    return `Error status code: ${status}`;
  }
  return raw || fallback;
}

export default function Filters() {
  const [activeTab, setActiveTab] = useState<"editor" | "results">("editor");
  const [survey, setSurvey] = useState<"ZTF" | "LSST">("ZTF");
  const [pipelineText, setPipelineText] = useState(DEFAULT_PIPELINE);
  // Only how the fixed window is displayed — the window itself never changes.
  const [timeFormat, setTimeFormat] = useState<TimeFormat>("jd");
  // Page size, also the API's `limit`. Paging is done with a $skip stage — see buildParams.
  const [pageSize, setPageSize] = useState("20");

  // Ref for FilterBuilder imperative handle
  const filterBuilderRef = useRef<FilterBuilderHandle>(null);
  // Scroll anchor so a new page starts at the top of the list, not wherever the last one ended.
  const resultsTopRef = useRef<HTMLDivElement>(null);

  // Any change to the query invalidates the known total and the page we are on:
  // offsets only mean something relative to the query that produced them.
  function resetPaging() {
    setCountResult(null);
    setTotalCount(null);
    setPage(0);
    setHasMore(false);
  }

  // Stable callback for FilterBuilder
  const handlePipelineTextChange = useCallback((text: string) => {
    setPipelineText(text);
    setCountResult(null);
    setTotalCount(null);
    setPage(0);
    setHasMore(false);
  }, []);

  // Schema state
  const [schema, setSchema] = useState<AvroSchema | null>(null);
  const [schemaLoading, setSchemaLoading] = useState(false);

  // Flatten schema for FilterFieldBrowser
  const fieldOptions = useMemo(() => {
    if (!schema) return [];
    return flattenAvroSchema(schema);
  }, [schema]);

  // Results state
  const [countResult, setCountResult] = useState<FilterTestCountResult | null>(null);
  const [totalCountLoading, setTotalCountLoading] = useState(false);
  const [totalCount, setTotalCount] = useState<number | null>(null);
  const [queryTimeMs, setQueryTimeMs] = useState<number | null>(null);
  const [results, setResults] = useState<Record<string, unknown>[]>([]);
  // 0-based index of the page currently displayed, and whether a next one may exist.
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [countLoading, setCountLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load schema on mount and survey change (falls back to hardcoded schema)
  useEffect(() => {
    let cancelled = false;
    setSchemaLoading(true);
    api.fetchBoomSchema(survey)
      .then((s) => { if (!cancelled) setSchema(s); })
      .catch(() => {
        if (!cancelled) {
          console.warn("Schema API unreachable, using fallback ZTF schema");
          if (survey === "ZTF") setSchema(ZTF_FALLBACK_SCHEMA as AvroSchema);
        }
      })
      .finally(() => { if (!cancelled) setSchemaLoading(false); });
    return () => { cancelled = true; };
  }, [survey]);

  // The time window is fixed to the ZTF Summer School range: it is the window the school's
  // data and example filter are built around. The inputs stay visible but read-only, and
  // the format picker still works — reading the window in UTC is useful, changing it isn't.
  const startJd = Number(FAST_FADING_JD_RANGE.start);
  const endJd = Number(FAST_FADING_JD_RANGE.end);
  const startTime = jdToFormatString(startJd, timeFormat);
  const endTime = jdToFormatString(endJd, timeFormat);

  // One-click preset: load the "fast fading transient" example filter. Its time window is
  // already the page's fixed one, so there is nothing to set here.
  function handleLoadExample() {
    setSurvey("ZTF");
    // The builder syncs the generated pipeline text back to us via onRawPipelineChange.
    filterBuilderRef.current?.loadFilterTree(FAST_FADING_FILTER);
    resetPaging();
    setError(null);
    setActiveTab("editor");
  }

  // No aux-collection condition here on purpose. Requiring public photometry via
  // `prv_candidates` makes the API inject a $lookup that costs ~20 ms per alert: measured
  // on one slice, 378 matches took 21 s to count and returned the very same 378 — the
  // condition removed nothing, because a public alert is itself part of its object's
  // public history. Cards that really have nothing to show are dropped client-side
  // instead, which keeps the count both true and fast.

  // `paged` adds the stages and sort that page through the matches. The API appends its
  // own $limit at the very end and requires the pipeline to still end on the $project, so
  // the extra stages go just before that last one. Count requests stay unpaged: a $skip
  // would make the total wrong, and sorting a count is pure cost.
  function buildParams(
    pipeline: Record<string, unknown>[],
    { skip = 0, paged = false }: { skip?: number; paged?: boolean } = {},
  ): FilterTestParams {
    const staged = [
      ...pipeline.slice(0, -1),
      ...(paged && skip > 0 ? [{ $skip: skip }] : []),
      pipeline[pipeline.length - 1],
    ];
    const params: FilterTestParams = {
      pipeline: staged,
      survey,
      permissions: { [survey]: [1] },
    };
    params.start_jd = startJd;
    params.end_jd = endJd;
    if (pageSize) params.limit = parseInt(pageSize, 10);
    if (paged) {
      // Paging by offset needs a defined order. This one is index-served; an in-pipeline
      // $sort measured 14 s per page against 0.4 s here. The catch is that it doesn't
      // break ties, and a whole exposure shares one jd — so alerts with the exact same jd
      // can in principle shuffle between two pages.
      params.sort_by = "candidate.jd";
      params.sort_order = "asc";
    }
    return params;
  }

  function fetchTotalForWindow(): Promise<void> {
    setTotalCountLoading(true);
    return api.fetchTotalAlertCount(survey, startJd, endJd, { [survey]: [1] })
      .then((c) => setTotalCount(c))
      .catch(() => setTotalCount(null))
      .finally(() => setTotalCountLoading(false));
  }

  async function handleCount() {
    const { valid, error: validationError, pipeline } = validatePipeline(pipelineText);
    if (!valid || !pipeline) {
      setError(validationError);
      return;
    }
    setError(null);
    setCountLoading(true);
    setTotalCount(null);
    try {
      const [result] = await Promise.all([
        api.fetchFilterTestCount(buildParams(pipeline)),
        fetchTotalForWindow(),
      ]);
      setCountResult(result);
    } catch (err) {
      setError(friendlyError(err, "Filter count failed"));
    } finally {
      setCountLoading(false);
    }
  }

  // Fetch one page of results. `nextPage` is 0-based.
  async function runFilter(nextPage: number) {
    const { valid, error: validationError, pipeline } = validatePipeline(pipelineText);
    if (!valid || !pipeline) {
      setError(validationError);
      return;
    }
    const size = parseInt(pageSize, 10) || 0;
    setError(null);
    setLoading(true);
    setResults([]);
    setQueryTimeMs(null);
    const t0 = performance.now();
    try {
      const params = buildParams(pipeline, { skip: nextPage * size, paged: true });
      const data = await api.fetchFilterTest(params);
      // The total-in-window is deliberately not fetched here: it re-runs an unindexed
      // COLLSCAN over the same jd window. A previous Count already got both numbers for
      // this query, and they are kept (resetPaging drops them when the query changes),
      // so running the filter after a Count keeps showing the real pass rate.
      setQueryTimeMs(Math.round(performance.now() - t0));
      setResults(data);
      setPage(nextPage);
      // A short page means the matches ran out, so there is nothing after this one.
      setHasMore(size > 0 && data.length === size);
      // A single short first page tells us the exact total without a Count query.
      if (!countResult && nextPage === 0 && (size === 0 || data.length < size)) {
        setCountResult({ count: data.length, pipeline });
      }
      setActiveTab("results");
      resultsTopRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (err) {
      setError(friendlyError(err, "Filter test failed"));
    } finally {
      setLoading(false);
    }
  }

  // Cutout cache keyed by candid, cleared whenever the result set changes.
  const cutoutCache = useRef<Map<string, Cutouts>>(new Map());
  useEffect(() => { cutoutCache.current.clear(); }, [results]);
  const getCutoutCache = useCallback((candid: string) => cutoutCache.current.get(candid), []);
  const setCutoutCache = useCallback((candid: string, data: Cutouts) => { cutoutCache.current.set(candid, data); }, []);

  // Pager labels. `offset` is 0 whenever the page size is unusable, in which case
  // runFilter never leaves page 0 either.
  const parsedPageSize = parseInt(pageSize, 10) || 0;
  const offset = parsedPageSize > 0 ? page * parsedPageSize : 0;
  const firstShown = offset + 1;
  const lastShown = offset + results.length;
  const countLabel = countResult === null ? null : countResult.count.toLocaleString();
  // Only known once a Count (or a short first page) gave us the total.
  const totalPages = countResult && parsedPageSize > 0
    ? Math.max(1, Math.ceil(countResult.count / parsedPageSize))
    : null;
  const canGoNext = hasMore && (totalPages === null || page + 1 < totalPages);

  return (
    <div className="px-4 lg:px-6 space-y-4">
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 max-w-7xl mx-auto">
        {/* Left column: Pipeline Editor + Results */}
        <div className="lg:col-span-2 space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Filter Tester</CardTitle>
              <CardDescription>Build and test MongoDB aggregation pipelines against live alert data.</CardDescription>
              <CardAction>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={handleLoadExample}
                  title={`Load a ready-made fast-fading transient filter (JD ${FAST_FADING_JD_RANGE.start} – ${FAST_FADING_JD_RANGE.end})`}
                >
                  <Sparkles className="h-3 w-3 mr-1" /> ZTF Summer School filter
                </Button>
              </CardAction>
            </CardHeader>
            <CardContent>
              <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as "editor" | "results")}>
                <TabsList className="grid w-full grid-cols-2 mb-4">
                  <TabsTrigger value="editor">Pipeline Editor</TabsTrigger>
                  <TabsTrigger value="results">
                    Results
                    {countResult && (
                      <span className="ml-2 text-xs bg-primary/10 text-primary px-1.5 py-0.5 rounded-full">
                        {countLabel}
                      </span>
                    )}
                  </TabsTrigger>
                </TabsList>

                <TabsContent value="editor" forceMount className={activeTab !== "editor" ? "hidden" : undefined}>
                  <div className="space-y-4">
                    <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
                      <div className="sm:col-span-4">
                        <Label className="text-xs font-medium mb-1 block text-muted-foreground">Survey</Label>
                        <Select value={survey} onValueChange={(v) => { setSurvey(v as "ZTF" | "LSST"); resetPaging(); }}>
                          <SelectTrigger className="w-full">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="ZTF">ZTF</SelectItem>
                            <SelectItem value="LSST">LSST</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                    </div>

                    {/* Visual Filter Builder (replaces raw textarea) */}
                    <FilterBuilder
                      ref={filterBuilderRef}
                      schema={schema}
                      rawPipelineText={pipelineText}
                      onRawPipelineChange={handlePipelineTextChange}
                    />

                    <Separator />

                    <div className="flex items-center justify-between gap-3 mb-2">
                      <div className="flex items-center gap-1.5">
                        <h3 className="font-semibold text-sm">Time Range</h3>
                        <Info className="h-3.5 w-3.5 text-muted-foreground" />
                      </div>
                      {/* Display only — switching to UTC/MJD re-renders the same fixed window. */}
                      <TimeFormatSelect value={timeFormat} onChange={setTimeFormat} />
                    </div>

                    <Tooltip>
                      <TooltipTrigger asChild>
                        <div className="grid grid-cols-1 sm:grid-cols-4 gap-3 cursor-help">
                          <div className="sm:col-span-2">
                            <Label htmlFor="startTime" className="text-xs font-medium mb-1 block text-muted-foreground">Start</Label>
                            <TimeInput
                              id="startTime"
                              value={startTime}
                              onChange={() => {}}
                              format={timeFormat}
                              disabled
                            />
                          </div>
                          <div className="sm:col-span-2">
                            <Label htmlFor="endTime" className="text-xs font-medium mb-1 block text-muted-foreground">End</Label>
                            <TimeInput
                              id="endTime"
                              value={endTime}
                              onChange={() => {}}
                              format={timeFormat}
                              disabled
                            />
                          </div>
                        </div>
                      </TooltipTrigger>
                      <TooltipContent className="max-w-xs">
                        ZTF Summer School default, the source to find is in this range.
                      </TooltipContent>
                    </Tooltip>

                    <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
                      <div className="sm:col-span-2">
                        <Label htmlFor="pageSize" className="text-xs font-medium mb-1 block text-muted-foreground">Results per page</Label>
                        <Input
                          id="pageSize"
                          type="number"
                          min={1}
                          value={pageSize}
                          // Offsets from the previous page size no longer line up.
                          onChange={(e) => { setPageSize(e.target.value); resetPaging(); }}
                          placeholder="20"
                        />
                      </div>
                    </div>

                    {error && (
                      <div className="text-red-500 text-sm">{error}</div>
                    )}

                    <div className="flex justify-end gap-2 mt-4">
                      <Button variant="outline" onClick={handleCount} disabled={countLoading}>
                        {countLoading ? "Counting..." : "Count"}
                      </Button>
                      <Button onClick={() => runFilter(0)} disabled={loading}>
                        {loading ? "Running..." : "Run Filter"}
                      </Button>
                    </div>

                    {countResult && !countLoading && (
                      <div className="text-sm text-muted-foreground mt-2">
                        Matched <span className="font-semibold text-foreground">{countLabel}</span> alerts.
                      </div>
                    )}
                  </div>
                </TabsContent>

                <TabsContent value="results" forceMount className={activeTab !== "results" ? "hidden" : undefined}>
                  <div ref={resultsTopRef} className="scroll-mt-4" />
                  {loading && (
                    <div className="space-y-2">
                      {[1, 2, 3, 4, 5].map((i) => (
                        <Skeleton key={i} className="h-8 w-full" />
                      ))}
                    </div>
                  )}

                  {!loading && error && (
                    <div className="flex items-start gap-2 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-400">
                      <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
                      <span>{error}</span>
                    </div>
                  )}

                  {/* Filter Health Panel — shown after results are available */}
                  {!loading && !error && (results.length > 0 || countResult) && (
                    <div className="mb-4">
                      <FilterHealthPanel
                        matchedCount={countResult?.count ?? lastShown}
                        totalCount={totalCount}
                        totalCountLoading={totalCountLoading}
                        results={results}
                        queryTimeMs={queryTimeMs}
                      />
                    </div>
                  )}

                  {!loading && !error && results.length > 0 && (
                    <div className="space-y-3">
                      {results.map((row, i) => (
                        <AlertCutoutCard
                          key={String(row["candid"] ?? row["_id"] ?? i)}
                          alert={toAlertCardData(row)}
                          survey={survey}
                          getCache={getCutoutCache}
                          setCache={setCutoutCache}
                          showLightcurve
                        />
                      ))}
                      <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
                        <div className="text-sm text-muted-foreground" title="Sorted by candidate.jd, then candid — a stable order is what makes paging exact">
                          Showing {firstShown}–{lastShown}
                          {countLabel ? ` of ${countLabel}` : ""}
                          {totalPages ? ` · page ${page + 1} of ${totalPages}` : ` · page ${page + 1}`}
                          {" · oldest first"}
                        </div>
                        <div className="flex items-center gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => runFilter(page - 1)}
                            disabled={loading || page === 0}
                          >
                            <ChevronLeft className="h-4 w-4 mr-1" /> Previous
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => runFilter(page + 1)}
                            disabled={loading || !canGoNext}
                          >
                            Next <ChevronRight className="h-4 w-4 ml-1" />
                          </Button>
                        </div>
                      </div>
                    </div>
                  )}

                  {!loading && !error && results.length === 0 && page > 0 && (
                    <div className="text-center text-muted-foreground py-8 space-y-3">
                      <div>No more results past page {page}.</div>
                      <Button variant="outline" size="sm" onClick={() => runFilter(page - 1)} disabled={loading}>
                        <ChevronLeft className="h-4 w-4 mr-1" /> Previous page
                      </Button>
                    </div>
                  )}

                  {!loading && !error && results.length === 0 && page === 0 && !countResult && (
                    <div className="text-center text-muted-foreground py-8">
                      No results yet. Write a pipeline and click "Run Filter" to see matching alerts.
                    </div>
                  )}
                </TabsContent>
              </Tabs>
            </CardContent>
          </Card>
        </div>

        {/* Right column: Field Browser */}
        <div className="space-y-4">
          {schemaLoading && (
            <Card>
              <CardHeader>
                <Skeleton className="h-5 w-24" />
                <Skeleton className="h-4 w-48 mt-1" />
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  {[1, 2, 3, 4, 5, 6, 7, 8].map((i) => (
                    <Skeleton key={i} className="h-4 w-full" />
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
          {!schemaLoading && fieldOptions.length > 0 && (
            <FilterFieldBrowser
              fieldOptions={fieldOptions}
              onFieldClick={(field) => filterBuilderRef.current?.addConditionWithField(field)}
            />
          )}
        </div>
      </div>
    </div>
  );
}
