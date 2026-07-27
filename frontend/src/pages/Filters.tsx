import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { Card, CardHeader, CardTitle, CardDescription, CardAction, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Select, SelectTrigger, SelectContent, SelectItem, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { AlertTriangle, ChevronLeft, ChevronRight, Sparkles } from "lucide-react";
import { FilterBuilder } from "@/components/filter/FilterBuilder";
import type { FilterBuilderHandle } from "@/components/filter/FilterBuilder";
import { FilterFieldBrowser } from "@/components/filter/FilterFieldBrowser";
import { FilterHealthPanel } from "@/components/filter/FilterHealthPanel";
import { TimeFormatSelect, TimeInput } from "@/components/alert-filter-form";
import { AlertCutoutCard, type AlertCardData } from "@/components/alert-cutout-card";
import { toJd, jdToFormatString, type TimeFormat } from "@/lib/time";
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
    candid: str(row["candid"] ?? candidate["candid"]),
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
  // Time range: `startTime`/`endTime` hold the value as typed, in `timeFormat`.
  // JD stays the wire format — see `startJd`/`endJd` below.
  const [timeFormat, setTimeFormat] = useState<TimeFormat>("jd");
  const [startTime, setStartTime] = useState("2461138.5");
  const [endTime, setEndTime] = useState("2461140.5");
  // Page size, also the API's `limit`. Paging is done with a $skip stage — see buildParams.
  const [pageSize, setPageSize] = useState("30");

  // Ref for FilterBuilder imperative handle
  const filterBuilderRef = useRef<FilterBuilderHandle>(null);
  // Scroll anchor so a new page starts at the top of the list, not wherever the last one ended.
  const resultsTopRef = useRef<HTMLDivElement>(null);

  // Any change to the query invalidates the known total and the page we are on:
  // offsets only mean something relative to the query that produced them.
  function resetPaging() {
    setCountResult(null);
    setPage(0);
    setHasMore(false);
  }

  // Stable callback for FilterBuilder
  const handlePipelineTextChange = useCallback((text: string) => {
    setPipelineText(text);
    setCountResult(null);
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

  // The API only ever speaks JD, whatever format is displayed.
  const startJd = toJd(startTime, timeFormat);
  const endJd = toJd(endTime, timeFormat);
  const rangeError =
    startTime && endTime && (startJd === undefined || endJd === undefined) ? "Invalid date." :
    startJd !== undefined && endJd !== undefined && endJd <= startJd ? "End must be after start." :
    null;

  function handleTimeChange(setter: (v: string) => void) {
    return (v: string) => { setter(v); resetPaging(); };
  }

  // Keep the instant the user picked when the display format changes.
  function handleTimeFormatChange(next: TimeFormat) {
    if (startJd !== undefined) setStartTime(jdToFormatString(startJd, next));
    if (endJd !== undefined) setEndTime(jdToFormatString(endJd, next));
    setTimeFormat(next);
  }

  // One-click preset: load the "fast fading transient" example filter and its time window.
  function handleLoadExample() {
    setSurvey("ZTF");
    // The builder syncs the generated pipeline text back to us via onRawPipelineChange.
    filterBuilderRef.current?.loadFilterTree(FAST_FADING_FILTER);
    setTimeFormat("jd");
    setStartTime(FAST_FADING_JD_RANGE.start);
    setEndTime(FAST_FADING_JD_RANGE.end);
    resetPaging();
    setError(null);
    setActiveTab("editor");
  }

  // `paged` adds the $sort/$skip stages that page through the matches. The API appends its
  // own $limit at the very end and requires the pipeline to still end on the $project, so
  // both go just before that last stage. Count requests stay unpaged: sorting them is pure
  // cost, and a $skip would make the total wrong.
  function buildParams(
    pipeline: Record<string, unknown>[],
    { skip = 0, paged = false }: { skip?: number; paged?: boolean } = {},
  ): FilterTestParams {
    // Paging needs a total order, otherwise the same offset can repeat or skip alerts from
    // one page to the next. candidate.jd alone isn't one — a whole exposure shares a single
    // jd — so _id (the candid, unique) breaks the ties.
    const staged = paged
      ? [
          ...pipeline.slice(0, -1),
          { $sort: { "candidate.jd": 1, _id: 1 } },
          ...(skip > 0 ? [{ $skip: skip }] : []),
          pipeline[pipeline.length - 1],
        ]
      : pipeline;
    const params: FilterTestParams = {
      pipeline: staged,
      survey,
      permissions: { [survey]: [1] },
    };
    if (startJd !== undefined) params.start_jd = startJd;
    if (endJd !== undefined) params.end_jd = endJd;
    if (pageSize) params.limit = parseInt(pageSize, 10);
    return params;
  }

  function fetchTotalForWindow(): Promise<void> {
    if (startJd === undefined || endJd === undefined) return Promise.resolve();
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
    setTotalCount(null);
    setQueryTimeMs(null);
    const t0 = performance.now();
    try {
      const params = buildParams(pipeline, { skip: nextPage * size, paged: true });
      const data = await api.fetchFilterTest(params);
      // Disabled for now: this doubles query cost by re-running an unindexed
      // COLLSCAN over the same jd window just to show total-in-window context.
      // await fetchTotalForWindow();
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
  // Only known once a Count (or a short first page) gave us the real total.
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
                  title="Load a ready-made fast-fading transient filter (JD 2460483 – 2460490)"
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
                        {countResult.count}
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
                      <h3 className="font-semibold text-sm">Time Range</h3>
                      <TimeFormatSelect value={timeFormat} onChange={handleTimeFormatChange} />
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
                      <div className="sm:col-span-2">
                        <Label htmlFor="startTime" className="text-xs font-medium mb-1 block text-muted-foreground">Start</Label>
                        <TimeInput
                          id="startTime"
                          value={startTime}
                          onChange={handleTimeChange(setStartTime)}
                          format={timeFormat}
                          className={rangeError ? "border-destructive focus-visible:ring-destructive" : undefined}
                        />
                      </div>
                      <div className="sm:col-span-2">
                        <Label htmlFor="endTime" className="text-xs font-medium mb-1 block text-muted-foreground">End</Label>
                        <TimeInput
                          id="endTime"
                          value={endTime}
                          onChange={handleTimeChange(setEndTime)}
                          format={timeFormat}
                          className={rangeError ? "border-destructive focus-visible:ring-destructive" : undefined}
                        />
                      </div>
                    </div>

                    {rangeError && <p className="text-xs text-destructive">{rangeError}</p>}

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
                          placeholder="30"
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
                        Matched <span className="font-semibold text-foreground">{countResult.count}</span> alerts.
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
                          {countResult ? ` of ${countResult.count}` : ""}
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
