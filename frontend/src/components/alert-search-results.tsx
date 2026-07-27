import { useEffect, useCallback, useRef } from "react";
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, Cutouts } from "@/lib/api";
import { AlertCutoutCard, type AlertCardData } from "@/components/alert-cutout-card";

// ─── AlertSearchResults ───────────────────────────────────────────────────────

export function AlertSearchResults({ searchResultsRef, loading, error, alerts, survey, currentPage, pageSize, onPrev, onNext }: {
  searchResultsRef: React.RefObject<HTMLDivElement | null>;
  loading: boolean;
  error: string | null;
  alerts: Alert[];
  survey: 'ZTF' | 'LSST';
  currentPage: number;
  pageSize: number;
  onPrev: () => void;
  onNext: () => void;
}) {
  // Per-page cutout cache keyed by candid. Cleared whenever the result set changes
  // (new search or page navigation) so memory never accumulates across pages.
  const cutoutCache = useRef<Map<string, Cutouts>>(new Map());
  useEffect(() => { cutoutCache.current.clear(); }, [alerts]);

  const scrollContainerRef = useRef<HTMLDivElement>(null);

  const getCache = useCallback((candid: string) => cutoutCache.current.get(candid), []);
  const setCache = useCallback((candid: string, data: Cutouts) => { cutoutCache.current.set(candid, data); }, []);

  return (
    <Card ref={searchResultsRef} className="max-w-6xl mx-auto" style={{ height: '94vh' }}>
      <CardHeader>
        <CardTitle>Search Results</CardTitle>
        <CardDescription>
          {loading ? "Loading..." : alerts.length > 0 ? `Page ${currentPage} — ${alerts.length} alert${alerts.length !== 1 ? 's' : ''}` : error ? "Error" : "No results yet"}
        </CardDescription>
      </CardHeader>
      <CardContent ref={scrollContainerRef} className="overflow-y-auto" style={{ maxHeight: 'calc(100vh - 200px)' }}>
        {error && <div className="text-red-500 text-sm">{error}</div>}
        {loading && (
          <div className="space-y-4">
            {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((i) => (
              <div key={i} className="flex gap-4 p-4 border rounded-lg">
                <div className="flex gap-2 shrink-0">
                  <Skeleton className="h-24 w-24" />
                  <Skeleton className="h-24 w-24" />
                  <Skeleton className="h-24 w-24" />
                </div>
                <div className="flex-1 grid grid-cols-2 gap-x-4 gap-y-1">
                  <Skeleton className="h-4 w-3/4" />
                  <Skeleton className="h-4 w-1/2" />
                  <Skeleton className="h-4 w-2/3" />
                </div>
              </div>
            ))}
          </div>
        )}
        {!loading && !error && alerts.length > 0 && (
          <div className="space-y-3">
            {alerts.map((alert) => (
              <AlertCutoutCard
                key={alert.candid}
                alert={toCardData(alert)}
                survey={survey}
                scrollRoot={scrollContainerRef}
                getCache={getCache}
                setCache={setCache}
              />
            ))}
          </div>
        )}
        {!loading && !error && alerts.length === 0 && (
          <div className="text-center text-muted-foreground py-8">
            Enter search parameters and click "Search Alerts" to find alerts.
          </div>
        )}
      </CardContent>
      <CardFooter className="border-t px-6 py-4">
        <PaginationBar
          currentPage={currentPage}
          hasMore={alerts.length >= pageSize}
          onPrev={onPrev}
          onNext={onNext}
        />
      </CardFooter>
    </Card>
  );
}

// ─── Pagination ───────────────────────────────────────────────────────────────

function PaginationBar({ currentPage, hasMore, onPrev, onNext }: {
  currentPage: number; hasMore: boolean; onPrev: () => void; onNext: () => void;
}) {
  return (
    <div className="flex items-center justify-between text-sm gap-4 w-full">
      <div className="text-muted-foreground">Page {currentPage}</div>
      <div className="flex gap-2">
        <Button variant="outline" size="sm" onClick={onPrev} disabled={currentPage === 1}>Previous</Button>
        <Button variant="outline" size="sm" onClick={onNext} disabled={!hasMore}>Next</Button>
      </div>
    </div>
  );
}

// ─── Alert card ───────────────────────────────────────────────────────────────

function toCardData(alert: Alert): AlertCardData {
  return {
    objectId: alert.objectId,
    candid: alert.candid,
    jd: alert.candidate.jd,
    magpsf: alert.candidate.magpsf,
    fid: alert.candidate.fid,
    band: alert.candidate.band !== undefined ? String(alert.candidate.band) : undefined,
    drb: alert.candidate.drb ?? alert.candidate.reliability ?? null,
  };
}
