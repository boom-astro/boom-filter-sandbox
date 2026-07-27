// Easter egg: a confetti celebration when landing on one of these object pages.
// Object ids are matched case-insensitively, regardless of survey. Add an entry
// here to give an object its own celebration, with its own text.
export type Celebration = { title: string; subtitle?: string };

export const SPECIAL_OBJECTS = new Map<string, Celebration>([
  [
    "ZTF24aatezue", // <- swap for the object you want to celebrate
    { title: "You found it!"},
  ],
]);

/**
 * How long to let the page settle after its first paint before celebrating, so
 * the confetti lands on a drawn page rather than a half-built one.
 */
export const SETTLE_DELAY_MS = 400;

export function getCelebration(objectId: string | undefined): Celebration | undefined {
  if (!objectId) return undefined;
  const needle = objectId.toLowerCase();
  for (const [id, celebration] of SPECIAL_OBJECTS) {
    if (id.toLowerCase() === needle) return celebration;
  }
  return undefined;
}

const COLORS = [
  "#fbbf24", // amber
  "#fb7185", // rose
  "#60a5fa", // blue
  "#34d399", // emerald
  "#a78bfa", // violet
  "#f472b6", // pink
  "#22d3ee", // cyan
];
const GOLD = ["#fde68a", "#fbbf24", "#f59e0b"];

const GRAVITY = 0.26;
const DRAG = 0.994;
const LIFETIME_MS = 5200;
const FADE_START_MS = 4000;
const GLITTER_UNTIL_MS = 2600;
const MAX_PARTICLES = 900;

type Shape = "rect" | "circle" | "star" | "streamer";

type Particle = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  color: string;
  shape: Shape;
  angle: number;
  spin: number;
  // Ratio of height to width, animated to fake a 3D tumble.
  flip: number;
  flipSpeed: number;
  // Sideways drift, so pieces flutter instead of falling straight.
  wobble: number;
  wobbleSpeed: number;
  gravity: number;
  twinkle: number;
};

type Emitter = { at: number; spawn: (w: number, h: number) => Particle[] };

function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function makeParticle(
  x: number,
  y: number,
  angle: number,
  speed: number,
  shape: Shape,
  palette: readonly string[],
): Particle {
  const isStreamer = shape === "streamer";
  return {
    x,
    y,
    vx: Math.cos(angle) * speed,
    vy: Math.sin(angle) * speed,
    size: isStreamer ? 4 + Math.random() * 3 : 6 + Math.random() * 7,
    color: pick(palette),
    shape,
    angle: Math.random() * Math.PI * 2,
    spin: (Math.random() - 0.5) * 0.32,
    flip: 1,
    flipSpeed: 0.4 + Math.random() * 0.9,
    wobble: Math.random() * Math.PI * 2,
    wobbleSpeed: 0.02 + Math.random() * 0.04,
    gravity: GRAVITY * (isStreamer ? 0.55 : 1),
    twinkle: Math.random() * Math.PI * 2,
  };
}

/** A cone of particles fired from a point, `spread` radians wide around `aim`. */
function cannon(
  x: number,
  y: number,
  aim: number,
  count: number,
  spread: number,
  speed: [number, number],
  shapes: readonly Shape[],
  palette: readonly string[] = COLORS,
): Particle[] {
  const out: Particle[] = [];
  for (let i = 0; i < count; i++) {
    const angle = aim + (Math.random() - 0.5) * spread;
    const v = speed[0] + Math.random() * (speed[1] - speed[0]);
    out.push(makeParticle(x, y, angle, v, pick(shapes), palette));
  }
  return out;
}

// Waves, in the order they go off. Staggering them reads as a celebration
// rather than a single pop.
const EMITTERS: Emitter[] = [
  {
    at: 0,
    spawn: (w, h) => [
      ...cannon(0, h, -Math.PI / 3, 110, Math.PI * 0.3, [12, 25], ["rect", "streamer"]),
      ...cannon(w, h, (-Math.PI * 2) / 3, 110, Math.PI * 0.3, [12, 25], ["rect", "streamer"]),
    ],
  },
  {
    at: 260,
    spawn: (w, h) => cannon(w / 2, h + 10, -Math.PI / 2, 130, Math.PI * 0.42, [16, 27], ["rect", "circle", "star"]),
  },
  {
    at: 620,
    spawn: (w, h) => [
      ...cannon(w * 0.18, h * 0.62, -Math.PI / 2, 55, Math.PI * 1.1, [7, 15], ["star", "circle"], GOLD),
      ...cannon(w * 0.82, h * 0.62, -Math.PI / 2, 55, Math.PI * 1.1, [7, 15], ["star", "circle"], GOLD),
    ],
  },
  {
    at: 1000,
    spawn: (w, h) => [
      ...cannon(0, h * 0.85, -Math.PI / 4, 70, Math.PI * 0.26, [13, 23], ["rect", "streamer"]),
      ...cannon(w, h * 0.85, (-Math.PI * 3) / 4, 70, Math.PI * 0.26, [13, 23], ["rect", "streamer"]),
    ],
  },
  {
    at: 1500,
    spawn: (w, h) => cannon(w / 2, h * 0.35, 0, 80, Math.PI * 2, [4, 11], ["star", "circle", "rect"]),
  },
];

function drawStar(ctx: CanvasRenderingContext2D, r: number): void {
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const radius = i % 2 === 0 ? r : r * 0.45;
    const a = (i / 10) * Math.PI * 2 - Math.PI / 2;
    const px = Math.cos(a) * radius;
    const py = Math.sin(a) * radius;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.fill();
}

const BANNER_STYLE_ID = "boom-celebration-style";

function ensureBannerStyles(): void {
  if (document.getElementById(BANNER_STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = BANNER_STYLE_ID;
  style.textContent = `
@keyframes boom-banner-in {
  0%   { opacity: 0; transform: translateY(18px) scale(0.7); }
  55%  { opacity: 1; transform: translateY(0) scale(1.12); }
  70%  { transform: scale(0.97); }
  100% { opacity: 1; transform: scale(1); }
}
@keyframes boom-banner-out {
  from { opacity: 1; transform: scale(1); }
  to   { opacity: 0; transform: scale(1.15); }
}
@keyframes boom-shimmer {
  from { background-position: 0% 50%; }
  to   { background-position: 200% 50%; }
}
@keyframes boom-sub-in {
  from { opacity: 0; transform: translateY(10px); }
  to   { opacity: 1; transform: translateY(0); }
}
@keyframes boom-glow {
  0%, 100% { opacity: 0.55; transform: scale(1); }
  50%      { opacity: 0.9; transform: scale(1.08); }
}`;
  document.head.appendChild(style);
}

function showBanner(celebration: Celebration, reducedMotion: boolean): () => void {
  ensureBannerStyles();

  const wrap = document.createElement("div");
  wrap.style.cssText =
    "position:fixed;inset:0;display:flex;flex-direction:column;align-items:center;" +
    "justify-content:center;gap:0.6rem;pointer-events:none;z-index:10000;text-align:center;padding:1.5rem";

  const glow = document.createElement("div");
  glow.style.cssText =
    "position:absolute;width:min(46rem,90vw);height:min(46rem,90vw);border-radius:9999px;" +
    "background:radial-gradient(circle,rgba(251,191,36,0.28),rgba(251,191,36,0) 65%);" +
    (reducedMotion ? "" : "animation:boom-glow 2.4s ease-in-out infinite;");

  const title = document.createElement("div");
  title.textContent = celebration.title;
  title.style.cssText =
    "position:relative;font-size:clamp(2.2rem,7vw,4.5rem);font-weight:900;letter-spacing:-0.02em;" +
    "line-height:1.05;background:linear-gradient(90deg,#fbbf24,#f472b6,#60a5fa,#34d399,#fbbf24);" +
    "background-size:200% auto;-webkit-background-clip:text;background-clip:text;color:transparent;" +
    // Drop-shadow (not text-shadow) so the rim tracks the painted gradient glyphs;
    // the dark rim is what keeps it legible on a light background.
    "filter:drop-shadow(0 1px 1px rgba(15,23,42,0.55)) drop-shadow(0 4px 16px rgba(15,23,42,0.45));" +
    (reducedMotion
      ? "opacity:1;"
      : "animation:boom-banner-in 0.75s cubic-bezier(0.22,1.2,0.36,1) both,boom-shimmer 3s linear infinite;");

  wrap.appendChild(glow);
  wrap.appendChild(title);

  if (celebration.subtitle) {
    const sub = document.createElement("div");
    sub.textContent = celebration.subtitle;
    // A dark pill rather than bare text, so it survives a light theme too.
    sub.style.cssText =
      "position:relative;font-size:clamp(0.95rem,2vw,1.35rem);font-weight:600;color:#f8fafc;" +
      "padding:0.4rem 0.95rem;border-radius:9999px;background:rgba(15,23,42,0.78);" +
      "box-shadow:0 4px 18px rgba(15,23,42,0.35);" +
      (reducedMotion ? "" : "animation:boom-sub-in 0.6s ease-out 0.45s both;");
    wrap.appendChild(sub);
  }

  document.body.appendChild(wrap);

  const fadeAt = window.setTimeout(() => {
    wrap.style.transition = "opacity 0.7s ease";
    wrap.style.opacity = "0";
  }, LIFETIME_MS - 900);
  const removeAt = window.setTimeout(() => wrap.remove(), LIFETIME_MS);

  return () => {
    clearTimeout(fadeAt);
    clearTimeout(removeAt);
    wrap.remove();
  };
}

/**
 * Fires a multi-wave confetti celebration with a headline banner.
 *
 * Particles render into a throwaway fixed, pointer-events-none canvas that
 * removes itself once the show is over. Under `prefers-reduced-motion` the
 * particles are skipped and only the (static) banner is shown.
 */
export function fireConfetti(celebration: Celebration): () => void {
  if (typeof window === "undefined") return () => {};

  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const dismissBanner = showBanner(celebration, reducedMotion);
  if (reducedMotion) return dismissBanner;

  const canvas = document.createElement("canvas");
  canvas.style.cssText =
    "position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:9999";
  const ctx = canvas.getContext("2d");
  if (!ctx) return dismissBanner;

  const dpr = window.devicePixelRatio || 1;
  const resize = () => {
    canvas.width = window.innerWidth * dpr;
    canvas.height = window.innerHeight * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  resize();
  window.addEventListener("resize", resize);
  document.body.appendChild(canvas);

  const particles: Particle[] = [];
  const pending = [...EMITTERS];
  const start = performance.now();
  let last = start;
  let frame = 0;

  const cleanup = () => {
    cancelAnimationFrame(frame);
    window.removeEventListener("resize", resize);
    canvas.remove();
  };

  const tick = (now: number) => {
    const elapsed = now - start;
    if (elapsed > LIFETIME_MS) {
      cleanup();
      return;
    }

    const w = window.innerWidth;
    const h = window.innerHeight;
    // Normalise to 60fps so the physics don't depend on refresh rate.
    const dt = Math.min((now - last) / 16.67, 3);
    last = now;

    while (pending.length > 0 && pending[0].at <= elapsed) {
      const emitter = pending.shift()!;
      if (particles.length < MAX_PARTICLES) particles.push(...emitter.spawn(w, h));
    }

    // A steady drizzle of glitter from above, layered under the bursts.
    if (elapsed < GLITTER_UNTIL_MS && particles.length < MAX_PARTICLES) {
      for (let i = 0; i < 2; i++) {
        particles.push(
          makeParticle(Math.random() * w, -20, Math.PI / 2, 1 + Math.random() * 2, "circle", GOLD),
        );
      }
    }

    const alpha =
      elapsed < FADE_START_MS
        ? 1
        : Math.max(0, 1 - (elapsed - FADE_START_MS) / (LIFETIME_MS - FADE_START_MS));

    ctx.clearRect(0, 0, w, h);

    for (const p of particles) {
      p.vx *= DRAG;
      p.vy = p.vy * DRAG + p.gravity * dt;
      p.wobble += p.wobbleSpeed * dt;
      p.x += (p.vx + Math.cos(p.wobble) * 0.9) * dt;
      p.y += p.vy * dt;
      p.angle += p.spin * dt;
      p.twinkle += 0.18 * dt;
      p.flip = Math.cos((elapsed / 1000) * p.flipSpeed * Math.PI * 2);

      if (p.y - p.size > h || p.x < -60 || p.x > w + 60) continue;

      const twinkle = p.shape === "circle" || p.shape === "star" ? 0.7 + 0.3 * Math.sin(p.twinkle) : 1;
      ctx.globalAlpha = alpha * twinkle;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.angle);
      ctx.fillStyle = p.color;

      switch (p.shape) {
        case "circle":
          ctx.beginPath();
          ctx.arc(0, 0, p.size / 2.6, 0, Math.PI * 2);
          ctx.fill();
          break;
        case "star":
          drawStar(ctx, p.size * 0.85);
          break;
        case "streamer":
          ctx.fillRect(-p.size / 2, (-p.size * 3.4 * p.flip) / 2, p.size, p.size * 3.4 * p.flip);
          break;
        default:
          ctx.fillRect(-p.size / 2, (-p.size * p.flip) / 2, p.size, p.size * p.flip);
      }

      ctx.restore();
    }

    frame = requestAnimationFrame(tick);
  };

  frame = requestAnimationFrame(tick);

  return () => {
    cleanup();
    dismissBanner();
  };
}
