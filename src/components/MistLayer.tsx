import { useEffect, useRef, type RefObject } from "react";

/**
 * One shared WebGL overlay that draws the edge of every visible Mist, Reverie and Lucid card
 * (misty cloud -> watercolour bleed -> thin iridescent line; Dream stays CSS). It sits between
 * the dot grid and the world, covers the canvas area, and reads each Mist card's on-screen box
 * from the DOM every frame, so it follows the camera, drags and resizes exactly. Each card is a
 * rounded-rect SDF whose boundary is pushed out by animated fbm noise: puffy, scalloped, drifting.
 * Runs only while `active` (Mist cards on screen) and the window is visible; reduced motion draws
 * a still edge (redrawn only when cards move). Without WebGL the root gets `.no-webgl` and CSS
 * draws a plain soft border instead.
 */
const MAX_CARDS = 64;
const DPR_CAP = 1.5;

const STAGES = ["mist", "reverie", "lucid"] as const;
const FALLBACK: [number, number, number][] = [[0.79, 0.83, 0.96], [0.56, 0.66, 0.95], [0.94, 0.63, 0.75]];
const EDGE_SELECTOR = ".cards-layer > .card:is(.stage-mist, .stage-reverie, .stage-lucid):not(.ghost)";

const VERT = `attribute vec2 a;void main(){gl_Position=vec4(a,0.,1.);}`;

const FRAG = `#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
#define N ${MAX_CARDS}
uniform vec2 u_res;
uniform float u_t;
uniform int u_n;
uniform vec4 u_rect[N];   // center.xy, half-size.xy (device px, y down)
uniform vec4 u_meta[N];   // radius, stage*2+selected (stage 0 mist, 1 reverie, 2 lucid), seed, scale
uniform vec3 u_tint[3];   // per-stage border colour

float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
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
float sdRound(vec2 p, vec2 b, float r){
  vec2 q = abs(p) - b + r;
  return length(max(q, 0.)) + min(max(q.x, q.y), 0.) - r;
}
// Shared Mist softness: alpha of a displaced SDF edge with a symmetric feather...
float softEdge(float dd, float feather){ return 1. - smoothstep(-feather, feather, dd); }
// ...and the rim fade toward the card interior so content stays clear.
float rimFade(float d, float depth){ return smoothstep(-depth, 0., d); }

void main(){
  vec2 p = vec2(gl_FragCoord.x, u_res.y - gl_FragCoord.y);
  float best = 1e9; int bi = -1;
  for (int i = 0; i < N; i++) {
    if (i >= u_n) break;
    vec4 r = u_rect[i];
    float d = sdRound(p - r.xy, r.zw, u_meta[i].x);
    if (d < best) { best = d; bi = i; }
  }
  if (bi < 0) discard;
  vec4 r; vec4 m;
  for (int i = 0; i < N; i++) { if (i == bi) { r = u_rect[i]; m = u_meta[i]; } }
  float s = m.w;
  float stage = floor(m.y * .5 + .01);
  float sel = m.y - stage * 2.;
  // Reverie keeps its interior (the wash is the card surface); others only draw a rim band.
  if (best > 46. * s || (stage != 1. && best < -28. * s)) discard;
  vec2 lp = (p - r.xy) / s;
  vec3 tint = stage < .5 ? u_tint[0] : stage < 1.5 ? u_tint[1] : u_tint[2];
  vec3 col; float a;

  if (stage < .5) {
    // Mist: puffy fbm cloud edge, calm drift; selected swirls faster, thicker, brighter.
    float t = u_t * mix(1., 2.2, sel);
    vec2 q = lp * .045 + m.z * 17.;
    vec2 w = vec2(fbm(q + vec2(t * .22, 0.)), fbm(q + vec2(5.2, -t * .19)));
    q += (w - .5) * mix(1., 1.8, sel);
    float n = fbm(q + vec2(t * .16, -t * .12));
    float puff = smoothstep(.25, .8, n);
    float dd = best - (3. + puff * mix(13., 19., sel)) * s;
    float shape = softEdge(dd, (4. + 3. * sel) * s);
    float inner = rimFade(best, mix(20., 26., sel) * s);
    a = shape * mix(.12, 1., inner) * mix(.62, .92, sel);
    float rim = smoothstep(-8. * s, 2. * s, dd) * shape;
    col = mix(vec3(1.), tint, rim * mix(.55, .9, sel));
    a = clamp(a + rim * mix(.08, .3, sel), 0., 1.);
  } else if (stage < 1.5) {
    // Reverie: watercolour bleed on Mist's soft alpha. Slow domain-warped marbling, wide feather,
    // colour seeps outward past the card and straddles the fill edge so no line shows.
    float t = u_t * mix(.6, 1.3, sel);
    vec2 q = lp * .02 + m.z * 13.;
    vec2 w1 = vec2(fbm(q + vec2(0., t * .07)), fbm(q + vec2(5.2, 1.3) - vec2(t * .06, 0.)));
    vec2 w2 = vec2(fbm(q + 3. * w1 + vec2(1.7, 9.2) + t * .04), fbm(q + 3. * w1 + vec2(8.3, 2.8) - t * .035));
    float n = fbm(q + 2.5 * w2);
    // One monotonic falloff: flat interior wash -> wide soft bleed outward, no rim or inner shape.
    float dd = best - n * mix(10., 16., sel) * s;
    float reach = mix(32., 42., sel) * s;
    float f = 1. - smoothstep(-16. * s, reach, dd);
    float marble = .5 + .5 * sin(n * 7. + w2.x * 4. + t * .25);
    // Uniform 0.9 surface inside the card, easing monotonically into a coloured bleed outside
    // (~0.5). No step, no rim.
    // Inside: exactly 0.9 everywhere. Outside: eases from 0.9 at the edge into the bleed.
    float deep = 1. - smoothstep(0., 10. * s, best);
    a = best <= 0. ? .9 : mix(f * mix(.48, .6, sel) * mix(.85, 1., marble), .9, deep);
    // Watercolour pigment: lilac <-> pink pooling in the warped marble, drifting all the time.
    vec3 lilac = vec3(.80, .70, .97), pink = vec3(.98, .73, .88);
    vec3 wash = mix(lilac, pink, smoothstep(.25, .75, w2.y));
    wash = mix(wash, mix(wash, tint, .3), sel);
    // Inside the card: plain uniform surface, no pigment. Pigment starts right at the edge and
    // lives in the bleed outside, so the colour change is soft but never enters the card.
    float pig = smoothstep(-3. * s, 8. * s, best) * (.55 + .45 * marble) * mix(1., 1.2, sel);
    col = mix(vec3(.995, .985, 1.), wash, clamp(pig, 0., 1.));
  } else {
    // Lucid: crisp ~1.2px pale pearl line plus 3-5 warm "sun bunny" glints on figure-8 paths.
    float t = u_t * mix(1., 1.9, sel);
    // Prismatic 2px edge (3px selected): spectral hue by perimeter angle + slow drift, pearl-light.
    float ang = atan(lp.y, lp.x);
    float hue = ang / 6.2832 + u_t * mix(.04, .1, sel) + m.z;
    vec3 spec = clamp(abs(fract(hue + vec3(0., 2. / 3., 1. / 3.)) * 6. - 3.) - 1., 0., 1.);
    col = mix(spec, vec3(1.), .28);
    float hw = mix(1., 1.5, sel) * s;
    float line = 1. - smoothstep(hw - .5, hw + .5, abs(best));
    a = line * mix(.92, 1., sel);
    // Thin chromatic outer glow (~6px), R/G/B offset outward like aberration; additive.
    float gw = mix(5., 7., sel) * s, o = max(best, 0.);
    vec3 ch = exp(-max(o - vec3(1.5, .5, -.5) * s, 0.) / gw) * step(0., best);
    vec3 glow = spec * ch * mix(.28, .45, sel);
    float fi = float(bi);
    float cnt = 3. + floor(fract(m.z * 7.31 + fi * .37) * 3.);
    for (int k = 0; k < 5; k++) {
      float fk = float(k);
      if (fk >= cnt) break;
      float h1 = fract(sin(fi * 12.9898 + fk * 78.233) * 43758.5453);
      float h2 = fract(sin(fi * 39.346 + fk * 11.135) * 24634.6345);
      float w = mix(.18, .34, h2) * mix(1., 1.8, sel);
      float ph = h1 * 6.2832 + t * w;
      float th = fk / cnt * 6.2832 + h2 * 1.5 + t * .02 + .4 * sin(ph);
      vec2 dir = vec2(cos(th), sin(th));
      float rr = min(r.z / max(abs(dir.x), 1e-3), r.w / max(abs(dir.y), 1e-3));
      vec2 gp = r.xy + dir * (rr + sin(2. * ph) * 5. * s);
      float rad = mix(6., 9., sel) * s;
      vec2 dv = p - gp;
      float g = exp(-dot(dv, dv) / (rad * rad));
      float flick = .78 + .22 * sin(u_t * (5. + 4. * h1) + fk * 2.1) * sin(u_t * (3.1 + 2. * h2));
      glow += vec3(1., .91, .72) * g * flick * mix(.55, .95, sel);
    }
    // Additive: glint rgb adds on top without raising alpha.
    if (a < .003 && dot(glow, glow) < 1e-5) discard;
    gl_FragColor = vec4(col * a + glow, a);
    return;
  }
  if (a < .003) discard;
  gl_FragColor = vec4(col * a, a);
}`;

function parseColor(v: string, fallback: [number, number, number]): [number, number, number] {
  const s = v.trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s);
  if (hex) {
    const h = hex[1].length === 3 ? hex[1].replace(/./g, "$&$&") : hex[1];
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255) as [number, number, number];
  }
  const rgb = /rgba?\(([^)]+)\)/.exec(s);
  if (rgb) return rgb[1].split(/[ ,/]+/).slice(0, 3).map((x) => Number(x) / 255) as [number, number, number];
  return fallback;
}

function seedOf(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967296;
}

export function MistLayer({ rootRef, active }: { rootRef: RefObject<HTMLElement | null>; active: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const glRef = useRef<{ gl: WebGLRenderingContext; loc: Record<string, WebGLUniformLocation | null> } | null | false>(null);

  // Create the context once.
  useEffect(() => {
    const canvas = canvasRef.current;
    const root = rootRef.current;
    if (!canvas || !root) return;
    const gl = canvas.getContext("webgl", { premultipliedAlpha: true, antialias: false, alpha: true });
    const fail = () => {
      glRef.current = false;
      root.classList.add("no-webgl");
    };
    if (!gl) return fail();
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      return gl.getShaderParameter(s, gl.COMPILE_STATUS) ? s : null;
    };
    const vs = sh(gl.VERTEX_SHADER, VERT);
    const fs = sh(gl.FRAGMENT_SHADER, FRAG);
    const prog = gl.createProgram()!;
    if (!vs || !fs) return fail();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return fail();
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const aLoc = gl.getAttribLocation(prog, "a");
    gl.enableVertexAttribArray(aLoc);
    gl.vertexAttribPointer(aLoc, 2, gl.FLOAT, false, 0, 0);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    const loc: Record<string, WebGLUniformLocation | null> = {};
    for (const n of ["u_res", "u_t", "u_n", "u_rect", "u_meta", "u_tint"]) loc[n] = gl.getUniformLocation(prog, n);
    glRef.current = { gl, loc };
    const lose = (e: Event) => {
      e.preventDefault();
      fail();
    };
    canvas.addEventListener("webglcontextlost", lose);
    return () => canvas.removeEventListener("webglcontextlost", lose);
  }, [rootRef]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const root = rootRef.current;
    const ctx = glRef.current;
    if (!canvas || !root || !ctx) return;
    const { gl, loc } = ctx;
    const clear = () => {
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    };
    if (!active) {
      clear();
      return;
    }
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
    const rects = new Float32Array(MAX_CARDS * 4);
    const meta = new Float32Array(MAX_CARDS * 4);
    const tints = new Float32Array(9);
    let raf = 0;
    let frame = 0;
    let lastKey = "";
    const start = performance.now();

    const draw = () => {
      raf = requestAnimationFrame(draw);
      const box = root.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, DPR_CAP);
      const cw = Math.max(1, Math.round(box.width * dpr));
      const ch = Math.max(1, Math.round(box.height * dpr));
      if (canvas.width !== cw || canvas.height !== ch) {
        canvas.width = cw;
        canvas.height = ch;
        lastKey = "";
      }
      if (frame++ % 60 === 0) {
        const cs = getComputedStyle(root);
        STAGES.forEach((st, i) => tints.set(parseColor(cs.getPropertyValue(`--stage-${st}-border`), FALLBACK[i]), i * 3));
        gl.uniform3fv(loc.u_tint, tints);
      }
      let n = 0;
      let key = "";
      const margin = 60;
      for (const el of root.querySelectorAll<HTMLElement>(EDGE_SELECTOR)) {
        if (n >= MAX_CARDS) break;
        const r = el.getBoundingClientRect();
        const x = r.left - box.left, y = r.top - box.top;
        if (x + r.width < -margin || y + r.height < -margin || x > box.width + margin || y > box.height + margin) continue;
        const zoom = el.offsetWidth ? r.width / el.offsetWidth : 1;
        const sel = el.classList.contains("selected") ? 1 : 0;
        const stage = el.classList.contains("stage-mist") ? 0 : el.classList.contains("stage-reverie") ? 1 : 2;
        rects.set([(x + r.width / 2) * dpr, (y + r.height / 2) * dpr, (r.width / 2) * dpr, (r.height / 2) * dpr], n * 4);
        meta.set([Math.min(22 * zoom * dpr, (Math.min(r.width, r.height) / 2) * dpr), stage * 2 + sel, seedOf(el.dataset.id ?? ""), zoom * dpr], n * 4);
        key += `${x | 0},${y | 0},${r.width | 0},${r.height | 0},${stage * 2 + sel};`;
        n++;
      }
      // Reduced motion: one still frame, redrawn only when the cards move.
      if (reduce.matches && key === lastKey) return;
      lastKey = key;
      gl.viewport(0, 0, cw, ch);
      clear();
      if (!n) return;
      gl.uniform2f(loc.u_res, cw, ch);
      gl.uniform1f(loc.u_t, reduce.matches ? 0 : (performance.now() - start) / 1000);
      gl.uniform1i(loc.u_n, n);
      gl.uniform4fv(loc.u_rect, rects);
      gl.uniform4fv(loc.u_meta, meta);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };
    const run = () => {
      cancelAnimationFrame(raf);
      if (!document.hidden) raf = requestAnimationFrame(draw);
    };
    run();
    document.addEventListener("visibilitychange", run);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener("visibilitychange", run);
    };
  }, [active, rootRef]);

  return <canvas ref={canvasRef} className="mist-layer" aria-hidden="true" />;
}
