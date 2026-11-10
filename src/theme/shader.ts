import { hexToRgb, type RGB } from "./color";
import type { ShaderParams } from "./types";

/** The approved D2 fragment shader, verbatim. */
export const FRAGMENT_SRC = `precision highp float;
uniform vec2 R; uniform float T, FALL;
uniform vec3 C0,C1,C2,C3,C4; uniform float IRI,FREQ,SH,MIST,SHP;
float h(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
float n(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);
  return mix(mix(h(i),h(i+vec2(1.,0.)),f.x),mix(h(i+vec2(0.,1.)),h(i+vec2(1.,1.)),f.x),f.y);}
float fbm(vec2 p){float v=0.,a=.5;for(int i=0;i<5;i++){v+=a*n(p);p=p*2.02+vec2(1.7,9.2);a*=FALL;}return v;}
vec2 UV(){return vec2(gl_FragCoord.x/R.x,1.-gl_FragCoord.y/R.y);}
void main(){
  vec2 uv=UV(); vec2 p=(uv-.5)*vec2(R.x/R.y,1.)*FREQ; float t=T*.07;
  p+=.16*vec2(sin(p.y*2.3+T*.32),cos(p.x*2.1+T*.28));
  vec2 q=vec2(fbm(p+t),fbm(p+vec2(5.2,1.3)-t));
  vec2 r=vec2(fbm(p+2.4*q+vec2(1.7,9.2)+t*1.3),fbm(p+2.4*q+vec2(8.3,2.8)-t));
  float f=fbm(p+2.4*r);
  vec3 col=mix(C0,C1,smoothstep(.15,.85,f));
  col=mix(col,C2,smoothstep(.35,.9,length(q))*.7);
  col=mix(col,C3,smoothstep(.45,.95,r.x)*.6);
  float sheen=pow(abs(sin(f*10.+r.y*6.+T*.22)),SHP);
  col+=C4*sheen*SH;
  col+=IRI*.05*vec3(sin(f*7.),sin(f*7.+2.1),sin(f*7.+4.2));
  col=mix(col,vec3(1.),.1*smoothstep(.3,1.1,length(uv-.5)));
  col=mix(col,vec3(1.),MIST);
  gl_FragColor=vec4(clamp(col,0.,1.),1.);
}`;

const VERTEX_SRC = `attribute vec2 a; void main(){gl_Position=vec4(a,0.,1.);}`;

/** Start offset so the animation begins at the approved look. */
const TIME_OFFSET = 33;
const FADE_MS = 600;

interface Resolved {
  palette: RGB[];
  freq: number;
  fall: number;
  sheen: number;
  sheenPower: number;
  mist: number;
  iridescence: number;
  speed: number;
  scale: number;
}

function resolve(p: ShaderParams): Resolved {
  return { ...p, palette: p.palette.map(hexToRgb).map((c) => c.map((v) => v / 255) as RGB) };
}

const lerp = (a: number, b: number, k: number) => a + (b - a) * k;

function mixResolved(a: Resolved, b: Resolved, k: number): Resolved {
  return {
    palette: a.palette.map((c, i) => c.map((v, j) => lerp(v, b.palette[i][j], k)) as RGB),
    freq: lerp(a.freq, b.freq, k),
    fall: lerp(a.fall, b.fall, k),
    sheen: lerp(a.sheen, b.sheen, k),
    sheenPower: lerp(a.sheenPower, b.sheenPower, k),
    mist: lerp(a.mist, b.mist, k),
    iridescence: lerp(a.iridescence, b.iridescence, k),
    speed: lerp(a.speed, b.speed, k),
    scale: b.scale,
  };
}

export class ShaderRenderer {
  private raf = 0;
  private time = TIME_OFFSET;
  private last = 0;
  private hidden = document.hidden;
  private reduced: boolean;
  private mq: MediaQueryList;
  private from: Resolved;
  private to: Resolved;
  private fadeStart = 0;
  private current: Resolved;
  private uniforms: Record<string, WebGLUniformLocation | null> = {};

  private constructor(
    private canvas: HTMLCanvasElement,
    private gl: WebGLRenderingContext,
    program: WebGLProgram,
    params: ShaderParams,
  ) {
    this.from = this.to = this.current = resolve(params);
    for (const name of ["R", "T", "FALL", "C0", "C1", "C2", "C3", "C4", "IRI", "FREQ", "SH", "MIST", "SHP"]) {
      this.uniforms[name] = gl.getUniformLocation(program, name);
    }
    this.mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    this.reduced = this.mq.matches;
    this.mq.addEventListener("change", this.onMotionChange);
    document.addEventListener("visibilitychange", this.onVisibility);
    window.addEventListener("resize", this.onResize);
    canvas.addEventListener("webglcontextlost", this.onContextLost);
  }

  /** Returns null when WebGL or the shader is unavailable (caller shows the flat fallback). */
  static create(canvas: HTMLCanvasElement, params: ShaderParams): ShaderRenderer | null {
    try {
      const gl = canvas.getContext("webgl", { antialias: false, alpha: false, powerPreference: "low-power" });
      if (!gl) return null;
      const compile = (type: number, src: string) => {
        const s = gl.createShader(type)!;
        gl.shaderSource(s, src);
        gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
          throw new Error(gl.getShaderInfoLog(s) ?? "shader compile failed");
        }
        return s;
      };
      const program = gl.createProgram()!;
      gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX_SRC));
      gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAGMENT_SRC));
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error("shader link failed");
      gl.useProgram(program);
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      const loc = gl.getAttribLocation(program, "a");
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      return new ShaderRenderer(canvas, gl, program, params);
    } catch (e) {
      console.warn("[dreamer] WebGL background unavailable, using flat color:", e);
      return null;
    }
  }

  start() {
    this.schedule();
  }

  /** Cross-fade to new shader params over ~600ms. */
  setShader(params: ShaderParams) {
    this.from = this.current;
    this.to = resolve(params);
    this.fadeStart = performance.now();
    this.schedule();
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.mq.removeEventListener("change", this.onMotionChange);
    document.removeEventListener("visibilitychange", this.onVisibility);
    window.removeEventListener("resize", this.onResize);
    this.canvas.removeEventListener("webglcontextlost", this.onContextLost);
  }

  private fading(now: number) {
    return this.fadeStart > 0 && now - this.fadeStart < FADE_MS;
  }

  private schedule() {
    if (this.raf || this.hidden) return;
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.tick);
  }

  private tick = (now: number) => {
    this.raf = 0;
    if (this.hidden) return;
    const dt = Math.min((now - this.last) / 1000, 0.1);
    this.last = now;
    const k = this.fadeStart > 0 ? Math.min(1, (now - this.fadeStart) / FADE_MS) : 1;
    const eased = k * k * (3 - 2 * k);
    this.current = k >= 1 ? this.to : mixResolved(this.from, this.to, eased);
    if (!this.reduced) this.time += dt * this.current.speed;
    this.draw();
    if (!this.reduced || this.fading(now)) this.raf = requestAnimationFrame(this.tick);
  };

  private draw() {
    const { gl, canvas, current: p, uniforms: u } = this;
    const w = Math.max(2, Math.round(window.innerWidth * p.scale));
    const h = Math.max(2, Math.round(window.innerHeight * p.scale));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      gl.viewport(0, 0, w, h);
    }
    gl.uniform2f(u.R, w, h);
    gl.uniform1f(u.T, this.time);
    gl.uniform1f(u.FALL, p.fall);
    gl.uniform1f(u.IRI, p.iridescence);
    gl.uniform1f(u.FREQ, p.freq);
    gl.uniform1f(u.SH, p.sheen);
    gl.uniform1f(u.MIST, p.mist);
    gl.uniform1f(u.SHP, p.sheenPower);
    (["C0", "C1", "C2", "C3", "C4"] as const).forEach((n, i) => gl.uniform3f(u[n], ...p.palette[i]));
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  private onVisibility = () => {
    this.hidden = document.hidden;
    if (!this.hidden) this.schedule();
  };
  private onMotionChange = () => {
    this.reduced = this.mq.matches;
    this.schedule();
  };
  private onResize = () => {
    if (this.reduced) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
      this.schedule();
    }
  };
  private onContextLost = (e: Event) => {
    e.preventDefault();
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.canvas.dispatchEvent(new CustomEvent("dreamer-shader-failed"));
  };
}
