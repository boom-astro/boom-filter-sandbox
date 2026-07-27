import { useState, useEffect, useCallback, useRef, useMemo, memo } from "react";
import { ExternalLink } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import api, { ApiObject, Cutouts } from "@/lib/api";
import { bytes2image } from "@/lib/imageProcessing";
import Lightcurve from "@/components/Lightcurve";

// Minimal shape needed to render a cutout card. Sources (alert search, filter
// tester results, ...) adapt their own record shape into this.
export type AlertCardData = {
  objectId?: string;
  candid?: string;
  jd?: number;
  magpsf?: number;
  fid?: number;
  band?: string;
  drb?: number | null;
};

export const AlertCutoutCard = memo(function AlertCutoutCard({ alert, survey, scrollRoot, getCache, setCache, showLightcurve = false }: {
  alert: AlertCardData;
  survey: "ZTF" | "LSST";
  scrollRoot?: React.RefObject<HTMLDivElement | null>;
  getCache: (candid: string) => Cutouts | undefined;
  setCache: (candid: string, data: Cutouts) => void;
  // When true, the card always renders the object's photometry (lightcurve) below
  // the cutout row. Used on the Filters page, where scanning candidates means
  // judging the lightcurve at a glance. Clicking the card still opens the object page.
  showLightcurve?: boolean;
}) {
  const [cutouts, setCutouts] = useState<Cutouts | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);
  // Incremented on every exit or unmount to invalidate in-flight fetches.
  const fetchVersion = useRef(0);
  const candid = alert.candid;
  // Prefer the exact per-alert cutouts (by candid) when the pipeline projected one;
  // objectId is always present (the Filters page's own pipeline validation requires
  // it), so fall back to it — same "brightest alert" lookup the object page uses.
  const cacheKey = candid ?? alert.objectId;

  useEffect(() => {
    // Nothing to fetch without either identifier.
    if (!cacheKey) return;

    const el = cardRef.current;
    if (!el) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) {
          // Leaving the viewport: invalidate any in-flight fetch and drop rendered data.
          // The raw bytes remain in the shared cache for instant restore on re-entry.
          fetchVersion.current++;
          setIsLoading(false);
          setCutouts(null);
          return;
        }

        // Entering the viewport: restore from cache or fetch for the first time.
        const cached = getCache(cacheKey);
        if (cached !== undefined) {
          setCutouts(cached);
          return;
        }

        setIsLoading(true);
        const version = ++fetchVersion.current;

        const fetchPromise = candid
          ? api.fetchAlertCutouts(survey, candid)
          : api.fetchObjCutouts(survey, alert.objectId!);

        fetchPromise
          .then(data => {
            if (fetchVersion.current !== version) return;
            setCache(cacheKey, data);
            setCutouts(data);
          })
          .catch(() => {
            if (fetchVersion.current !== version) return;
            // Cache the empty result so we don't retry on every re-entry.
            const empty: Cutouts = {};
            setCache(cacheKey, empty);
            setCutouts(empty);
          })
          .finally(() => {
            if (fetchVersion.current === version) setIsLoading(false);
          });
      },
      { root: scrollRoot?.current ?? null, rootMargin: "150px 0px" },
    );

    observer.observe(el);
    return () => {
      fetchVersion.current++;
      observer.disconnect();
    };
  }, [cacheKey, candid, alert.objectId, survey, getCache, setCache, scrollRoot]);

  // Decode images only when cutouts change, not on every render.
  // cutouts === null means off-screen; {} means fetched but empty — both are handled.
  const images = useMemo(() => {
    if (cutouts === null) return null;
    return {
      science:    bytes2image(cutouts.cutoutScience,    survey, "science",    "bone"),
      template:   bytes2image(cutouts.cutoutTemplate,   survey, "template",   "bone"),
      difference: bytes2image(cutouts.cutoutDifference, survey, "difference", "bone"),
    };
  }, [cutouts, survey]);

  // Inline lightcurve panel (see `showLightcurve`). Fetched on mount for every card of
  // the page, not lazily on scroll: result pages are small (20 by default) and the
  // on-scroll variant proved unreliable, leaving cards stuck on their skeleton.
  const [objectDetail, setObjectDetail] = useState<ApiObject | null>(null);
  const [detailError, setDetailError] = useState(false);

  // The deps are the whole identity of the fetch, so this runs once per object —
  // no ref guard: one that outlives the effect makes StrictMode's remount skip the
  // fetch entirely (first pass claims the key, its cleanup cancels, second pass bails).
  useEffect(() => {
    if (!showLightcurve || !alert.objectId) return;
    let cancelled = false;
    setObjectDetail(null);
    setDetailError(false);
    api.fetchObject(survey, alert.objectId)
      .then((data) => { if (!cancelled) setObjectDetail(data); })
      .catch(() => { if (!cancelled) setDetailError(true); });
    return () => { cancelled = true; };
  }, [showLightcurve, survey, alert.objectId]);

  const handleRowClick = useCallback(() => {
    if (!alert.objectId) return;
    window.open(`/objects/${encodeURIComponent(survey)}/${encodeURIComponent(alert.objectId)}`, "_blank");
  }, [survey, alert.objectId]);

  // An object with no public datapoint at all gives an empty plot and usually no cutouts
  // either: nothing to judge, so it doesn't earn a row. This is done here rather than in
  // the filter pipeline because the equivalent condition there forces an aux $lookup
  // costing ~20 ms per alert — it made Count time out while removing nothing.
  const nothingToShow = useMemo(() => {
    if (detailError) return true;
    if (objectDetail === null) return false;
    const points = (source: unknown): number => {
      if (!source || typeof source !== "object") return 0;
      const doc = source as Record<string, unknown>;
      return (["prv_candidates", "fp_hists", "prv_nondetections"] as const)
        .reduce((n, key) => n + (Array.isArray(doc[key]) ? (doc[key] as unknown[]).length : 0), 0);
    };
    const matched = objectDetail["survey_matches"];
    const matchedPoints = matched && typeof matched === "object"
      ? Object.values(matched as Record<string, unknown>).reduce((n: number, m) => n + points(m), 0)
      : 0;
    return points(objectDetail) + matchedPoints === 0;
  }, [objectDetail, detailError]);

  if (showLightcurve && nothingToShow) return null;

  // Compact triplet for the collapsed row.
  const rowCutouts = (() => {
    if (!cacheKey) {
      return (
        <div className="h-24 w-78 bg-muted rounded flex items-center justify-center text-xs text-muted-foreground text-center px-2">
          No "candid" or "objectId" in projection
        </div>
      );
    }
    if (isLoading) {
      return (
        <>
          <Skeleton className="h-24 w-24" />
          <Skeleton className="h-24 w-24" />
          <Skeleton className="h-24 w-24" />
        </>
      );
    }
    if (images === null) {
      // Off-screen: invisible placeholders keep the row height stable.
      return (
        <>
          <div className="h-24 w-24" />
          <div className="h-24 w-24" />
          <div className="h-24 w-24" />
        </>
      );
    }
    if (!images.science && !images.template && !images.difference) {
      return (
        <>
          <div className="h-24 w-24 bg-muted rounded" />
          <div className="h-24 w-24 bg-muted rounded flex items-center justify-center text-xs text-muted-foreground">No cutouts</div>
          <div className="h-24 w-24 bg-muted rounded" />
        </>
      );
    }
    return (
      <>
        {images.science    && <img src={images.science}    alt="Science"    className="h-24 w-24 object-contain border rounded" title="Science"    style={{ imageRendering: "pixelated" }} />}
        {images.template   && <img src={images.template}   alt="Template"   className="h-24 w-24 object-contain border rounded" title="Template"   style={{ imageRendering: "pixelated" }} />}
        {images.difference && <img src={images.difference} alt="Difference" className="h-24 w-24 object-contain border rounded" title="Difference" style={{ imageRendering: "pixelated" }} />}
      </>
    );
  })();

  return (
    <div ref={cardRef} className="border rounded-lg overflow-hidden">
      <div
        className={`flex gap-4 p-4 transition-colors ${alert.objectId ? "hover:bg-accent/50 cursor-pointer" : ""}`}
        onClick={handleRowClick}
      >
        {/* Fixed-width image strip — always reserves the same space to prevent layout shifts. */}
        <div className="flex gap-2 shrink-0">
          {rowCutouts}
        </div>
        <div className="flex-1 grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
          {alert.objectId && <div><span className="text-muted-foreground">Object ID:</span> <span className="font-mono">{alert.objectId}</span></div>}
          {candid && <div><span className="text-muted-foreground">Candid:</span> <span className="font-mono">{candid}</span></div>}
          {alert.jd !== undefined && <div><span className="text-muted-foreground">JD:</span> <span className="font-mono">{alert.jd.toFixed(5)}</span></div>}
          {alert.drb !== undefined && alert.drb !== null && <div><span className="text-muted-foreground">DRB/Reliability:</span> <span className="font-mono">{alert.drb.toFixed(3)}</span></div>}
          {alert.magpsf !== undefined && <div><span className="text-muted-foreground">Magnitude:</span> <span className="font-mono">{alert.magpsf.toFixed(2)}</span></div>}
          {alert.band !== undefined && <div><span className="text-muted-foreground">Band:</span> <span className="font-mono">{alert.band}</span></div>}
          {alert.band === undefined && alert.fid !== undefined && <div><span className="text-muted-foreground">Band:</span> <span className="font-mono">{alert.fid}</span></div>}
        </div>
        {alert.objectId && (
          <div className="shrink-0 self-start" title="Open object page">
            <ExternalLink className="h-4 w-4 text-muted-foreground" />
          </div>
        )}
      </div>
      {showLightcurve && alert.objectId && (
        // Interactive plot (zoom, band toggles) — clicks here must not open the object page.
        <div className="border-t p-4" onClick={(e) => e.stopPropagation()}>
          {detailError ? (
            <div className="text-sm text-muted-foreground">Failed to load photometry for this object.</div>
          ) : objectDetail ? (
            // Kept mounted once loaded — unmounting off-screen would make the list jump while scrolling.
            <Lightcurve data={objectDetail} height="220px" />
          ) : (
            <Skeleton className="h-55 w-full" />
          )}
        </div>
      )}
    </div>
  );
});
