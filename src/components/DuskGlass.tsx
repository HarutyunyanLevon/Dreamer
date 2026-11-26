import { useEffect, useRef, type ReactNode, type RefObject } from "react";

/**
 * "Dusk glass": the animated lavender -> peach starry sky behind every Claude suggestion (ghost
 * cards, edit-proposal strips, the proposal dialog head, the suggestions pill). One shared offscreen
 * WebGL context and one rAF loop for the whole app: each frame, every registered element that is on
 * screen gets the sky rendered at its on-screen pixel size and copied into its own 2D
 * <canvas class="dusk-glass">, which fills the element behind its content (CSS size 100%, so it
 * follows world zoom; backing size = on-screen px, DPR capped). Pauses when the window is hidden or
 * nothing is visible; reduced motion draws one still frame per element (again only on resize).
 * Without WebGL, <html> gets `.no-webgl-glass` and CSS paints a gradient with a few stars instead.
 */
export type DuskKind = "card" | "strip";

const MAX_DRAWN = 24;
const DPR_CAP = 1.5;

const VERT = `attribute vec2 a;void main(){gl_Position=vec4(a,0.,1.);}`;

const FRAG = `#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform vec2 u_res;     // element size, device px
uniform float u_t;
uniform float u_seed;
uniform float u_scale;  // device px per card px
uniform float u_sel;
uniform float u_hover;
uniform float u_kind;   // 0 card, 1 strip

float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
vec2 hash2(vec2 p){ return fract(sin(vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)))) * 43758.5453); }
float noise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3. - 2. * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p){
  float v = 0., a = .5;
  for (int i = 0; i < 4; i++) { v += a * noise(p); p = p * 2.03 + vec2(1.7, 9.2); a *= .5; }
  return v;
}

void main(){
  vec2 px = vec2(gl_FragCoord.x, u_res.y - gl_FragCoord.y);   // device px, y down
  vec2 cp = px / u_scale;                                     // card px
  vec2 uv = px / u_res;
  bool strip = u_kind > .5;
  // Card: lavender top -> violet-pink -> peach glow at the bottom. Strip: the same, left -> right.
  float y = strip ? uv.x : uv.y;
  vec3 base = mix(vec3(.60, .53, .85), vec3(.80, .60, .84), smoothstep(0., .65, y));
  base = mix(base, vec3(1., .80, .72), smoothstep(.55, 1., y) * .7);

  vec2 np = cp * .018 + u_seed * 37. + vec2(u_t * (strip ? .09 : .03), 0.);
  float n = fbm(np * 2. + fbm(np * 3.));
  vec3 sky = mix(base, base * vec3(.82, .78, 1.), n * .5);
  sky = mix(sky, vec3(1., .78, .9), smoothstep(.6, .85, n) * .35);

  // Stars: one jittered 4-point glint in about half the cells of a grid, drifting slowly right.
  float cell = strip ? 10. : 14.;
  float size = strip ? .75 : 1.;
  float dens = .5 * (1. + .25 * max(u_sel, u_hover));
  float tw = mix(1., 1.5, u_sel);
  vec2 sp = cp - vec2(u_t * 2., 0.);
  vec2 id0 = floor(sp / cell);
  vec3 glow = vec3(0.);
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 id = id0 + vec2(float(i), float(j));
      vec2 h = hash2(id + u_seed * 91.7);
      if (h.x > dens) continue;
      vec2 h2 = hash2(id * 1.37 + 4.1 + u_seed * 13.);
      vec2 c = (id + .2 + .6 * vec2(h.y, h2.x)) * cell;
      vec2 d = sp - c;
      float s = size * mix(.55, 1.35, h2.y);
      float r2 = dot(d, d);
      float core = exp(-r2 / (s * s * 1.1));
      float rays = exp(-abs(d.y) / (.32 * s)) * exp(-abs(d.x) / (3.6 * s))
                 + exp(-abs(d.x) / (.32 * s)) * exp(-abs(d.y) / (3.6 * s));
      float halo = exp(-r2 / (s * s * 8.));
      float ph = hash(id + 7.7) * 6.2832;
      float sp2 = mix(1., 3.5, hash(id + 3.3)) * tw;
      float twk = pow(.5 + .5 * sin(u_t * sp2 + ph), 5.);
      float b = mix(.3, 1., twk);
      vec3 tint = hash(id + 11.1) < .12 ? vec3(.98, .82, .5) : vec3(.48, .39, .79);
      glow += (vec3(1., .98, 1.) * core + mix(tint, vec3(1.), .35) * (rays * .55 + halo * .45)) * b;
    }
  }
  // Cards keep their stars in the upper sky, fading out into the peach glow.
  float fade = strip ? 1. : 1. - smoothstep(.55, .92, uv.y);
  vec3 col = sky + glow * fade;
  gl_FragColor = vec4(min(col, vec3(1.)), 1.);
}`;

type Entry = {
  el: HTMLElement;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D | null;
  kind: DuskKind;
  seed: number;
  visible: boolean;
  hover: boolean;
  /** Reduced motion: size + state of the last still frame. */
  key: string;
};

function seedOf(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967296;
}

type GL = { gl: WebGLRenderingContext; loc: Record<string, WebGLUniformLocation | null> };

const entries = new Map<HTMLElement, Entry>();
let glState: GL | null | false = null;
let io: IntersectionObserver | null = null;
let raf = 0;
let start = 0;
let listening = false;
const reduce = typeof window !== "undefined" ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;

function failGL() {
  glState = false;
  document.documentElement.classList.add("no-webgl-glass");
  for (const e of entries.values()) e.canvas.remove();
}

function initGL(): GL | false {
  if (glState !== null) return glState;
  const canvas = document.createElement("canvas");
  const gl = canvas.getContext("webgl", { premultipliedAlpha: false, antialias: false, alpha: false, preserveDrawingBuffer: true });
  if (!gl) {
    failGL();
    return false;
  }
  const sh = (type: number, src: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    return gl.getShaderParameter(s, gl.COMPILE_STATUS) ? s : null;
  };
  const vs = sh(gl.VERTEX_SHADER, VERT);
  const fs = sh(gl.FRAGMENT_SHADER, FRAG);
  if (!vs || !fs) {
    failGL();
    return false;
  }
  const prog = gl.createProgram()!;
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    failGL();
    return false;
  }
  gl.useProgram(prog);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const aLoc = gl.getAttribLocation(prog, "a");
  gl.enableVertexAttribArray(aLoc);
  gl.vertexAttribPointer(aLoc, 2, gl.FLOAT, false, 0, 0);
  const loc: Record<string, WebGLUniformLocation | null> = {};
  for (const n of ["u_res", "u_t", "u_seed", "u_scale", "u_sel", "u_hover", "u_kind"]) loc[n] = gl.getUniformLocation(prog, n);
  canvas.addEventListener("webglcontextlost", (e) => {
    e.preventDefault();
    failGL();
  });
  glState = { gl, loc };
  start = performance.now();
  return glState;
}

function frame() {
  raf = 0;
  const g = glState;
  if (!g || document.hidden) return;
  const visible = [...entries.values()].filter((e) => e.visible);
  if (!visible.length) return;
  raf = requestAnimationFrame(frame);
  const { gl, loc } = g;
  const still = !!reduce?.matches;
  const dpr = Math.min(window.devicePixelRatio || 1, DPR_CAP);
  const t = still ? 0 : (performance.now() - start) / 1000;
  const glc = gl.canvas as HTMLCanvasElement;
  let drawn = 0;
  for (const e of visible) {
    if (drawn >= MAX_DRAWN) break;
    const r = e.el.getBoundingClientRect();
    const w = Math.round(r.width * dpr);
    const h = Math.round(r.height * dpr);
    if (w < 1 || h < 1 || !e.ctx) continue;
    const sel = (e.el.closest(".card")?.classList.contains("selected") ?? false) ? 1 : 0;
    const key = `${w}x${h}:${sel}${e.hover ? 1 : 0}`;
    if (still && key === e.key) continue;
    e.key = key;
    drawn++;
    if (glc.width < w || glc.height < h) {
      glc.width = Math.max(glc.width, w);
      glc.height = Math.max(glc.height, h);
    }
    if (e.canvas.width !== w || e.canvas.height !== h) {
      e.canvas.width = w;
      e.canvas.height = h;
    }
    const zoom = e.el.offsetWidth ? r.width / e.el.offsetWidth : 1;
    gl.viewport(0, 0, w, h);
    gl.uniform2f(loc.u_res, w, h);
    gl.uniform1f(loc.u_t, t);
    gl.uniform1f(loc.u_seed, e.seed);
    gl.uniform1f(loc.u_scale, Math.max(zoom * dpr, 1e-3));
    gl.uniform1f(loc.u_sel, sel);
    gl.uniform1f(loc.u_hover, e.hover ? 1 : 0);
    gl.uniform1f(loc.u_kind, e.kind === "strip" ? 1 : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    // The viewport is the bottom-left corner of the GL canvas.
    e.ctx.drawImage(glc, 0, glc.height - h, w, h, 0, 0, w, h);
  }
}

function kick() {
  if (!raf && !document.hidden) raf = requestAnimationFrame(frame);
}

function onVisibility() {
  if (document.hidden) {
    cancelAnimationFrame(raf);
    raf = 0;
  } else kick();
}

function observer(): IntersectionObserver {
  if (!io) {
    io = new IntersectionObserver(
      (list) => {
        for (const it of list) {
          const e = entries.get(it.target as HTMLElement);
          if (e) e.visible = it.isIntersecting;
        }
        kick();
      },
      { rootMargin: "40px" },
    );
  }
  if (!listening) {
    listening = true;
    document.addEventListener("visibilitychange", onVisibility);
    reduce?.addEventListener("change", () => {
      for (const e of entries.values()) e.key = "";
      kick();
    });
  }
  return io;
}

/**
 * Makes `ref`'s element a dusk-glass surface (pass `kind: null` to turn it off). The element gets
 * the `dusk-host` class and a `<canvas class="dusk-glass" aria-hidden>` as its first child; give it
 * `position` and `isolation: isolate` (styles/ does for `.dusk-host`).
 */
export function useDuskGlass(ref: RefObject<HTMLElement | null>, kind: DuskKind | null, seed = "") {
  useEffect(() => {
    const el = ref.current;
    if (!el || !kind) return;
    el.classList.add("dusk-host");
    if (!initGL()) return () => el.classList.remove("dusk-host");
    const canvas = document.createElement("canvas");
    canvas.className = "dusk-glass";
    canvas.setAttribute("aria-hidden", "true");
    el.insertBefore(canvas, el.firstChild);
    const entry: Entry = { el, canvas, ctx: canvas.getContext("2d"), kind, seed: seedOf(seed), visible: false, hover: false, key: "" };
    const enter = () => {
      entry.hover = true;
      kick();
    };
    const leave = () => {
      entry.hover = false;
      kick();
    };
    el.addEventListener("pointerenter", enter);
    el.addEventListener("pointerleave", leave);
    entries.set(el, entry);
    observer().observe(el);
    return () => {
      io?.unobserve(el);
      entries.delete(el);
      el.removeEventListener("pointerenter", enter);
      el.removeEventListener("pointerleave", leave);
      canvas.remove();
      el.classList.remove("dusk-host");
    };
  }, [ref, kind, seed]);
}

/**
 * A full-width dusk strip (proposal header on a card, the proposal dialog head, the suggestions
 * pill). `onOpen` makes a click anywhere on it act (presses never start a card drag).
 */
export function DuskStrip({ seed, className, onOpen, children }: { seed: string; className?: string; onOpen?: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useDuskGlass(ref, "strip", seed);
  return (
    <div
      ref={ref}
      className={`dusk-strip${className ? ` ${className}` : ""}`}
      onPointerDown={onOpen ? (e) => e.stopPropagation() : undefined}
      onClick={
        onOpen
          ? (e) => {
              e.stopPropagation();
              onOpen();
            }
          : undefined
      }
    >
      {children}
    </div>
  );
}
