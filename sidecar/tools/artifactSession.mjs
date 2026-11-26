export const artifactSpecs = [];
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod/v4";
import { fail, requestTool, send, text } from "../io.mjs";
import { PAID_TOOLS, SPRITECOOK_TOOLS, creditCheck } from "../spritecook.mjs";
import { current, turnGate } from "../turn.mjs";

export const makeArtifactServer = (s) =>
  createSdkMcpServer({
    name: "dreamer",
    version: "1.0.0",
    tools: artifactSpecs.map((spec) =>
      tool(spec.name, spec.description, spec.schema, async (args) => {
        {
          const lim = turnGate(s, "any");
          if (lim) return lim;
        }
        const call = (name, input, timeoutMs = 20000) => requestTool(`artifact_${name}`, { ...input, turn: s.turn?.id ?? null }, timeoutMs, s.turn);
        try {
          return await spec.run(args, call);
        } catch (e) {
          return fail(e);
        }
      }),
    ),
  });

/** Permission callback of an artifact session: SpriteCook calls only (paid ones count against the cap). */
export function artifactGate(s) {
  return async (toolName, input) => {
    const short = toolName.replace(/^mcp__spritecook__/, "");
    if (!toolName.startsWith("mcp__spritecook__") || !SPRITECOOK_TOOLS.includes(short)) {
      return { behavior: "deny", message: `${toolName} is not available in Dreamer.` };
    }
    if (PAID_TOOLS.has(short)) {
      const verdict = await creditCheck(s, short);
      if (!verdict.ok) return { behavior: "deny", message: verdict.message };
    }
    return { behavior: "allow", updatedInput: input };
  };
}

/** Registers an artifact tool; `run(args, call)` asks Rust through `call` (bound to the session's turn). */
const artifactTool = (name, description, schema, run) => {
  artifactSpecs.push({ name, description, schema, run });
};

artifactTool(
  "start_version",
  "Start the version this turn writes into. mode 'new' (default): a new version v<N+1> whose parent is the current one " +
    "(first generation, regenerate, any feedback/edit). mode 'add': add a part to the current version (an add-on such as " +
    "a turnaround, an expression, an animation, next to what is there). Call it once, before saving anything. brief: " +
    "what this version is; prompts: the exact prompts you send to SpriteCook (saved in brief.md).",
  {
    mode: z.enum(["new", "add"]).optional(),
    brief: z.string(),
    prompts: z.array(z.string()).optional(),
  },
  async (a, call) => {
    const r = await call("start_version", a);
    return text(`Writing into v${r.version} (${r.mode}).`);
  },
);

artifactTool(
  "save_image",
  "Download a SpriteCook result into the working version: url = the asset's sprite_url (or spritesheet_url for an " +
    "animation sheet) from the generate / check_job_status / get_asset_metadata result, asset_id = its SpriteCook asset " +
    "id (kept for later edits and references). name: a short file name such as hero.png, turnaround.png, " +
    "expression-angry.png, anim_idle.png, concept.png, key-art.png, or assets/<name>.png for mockup assets.",
  {
    url: z.string(),
    asset_id: z.string().optional(),
    name: z.string(),
    role: z.string().optional().describe("hero, turnaround, expression, pose, animation, concept, key-art, ui-kit, sprite"),
  },
  async (a, call) => {
    const r = await call("save_image", a, 150000);
    return text(`Saved ${r.file} in v${r.version}.`);
  },
);

artifactTool(
  "write_file",
  "Write a text file into the working version: notes.md (the design notes, always), index.html (a mockup or a theme's " +
    "style-guide page), or .css / .js / .svg / .json files it uses. Writing the same name again replaces it within the version.",
  {
    name: z.string(),
    content: z.string(),
    role: z.string().optional().describe("notes, html, style, script"),
  },
  async (a, call) => {
    const r = await call("write_file", a);
    return text(`Wrote ${r.file} in v${r.version}.`);
  },
);

artifactTool(
  "copy_asset",
  "Copy an image of another artifact in this project (a project sprite listed in the artifact block) into this " +
    "mockup's working version as assets/<name>, so the HTML can use it.",
  {
    from_artifact: z.string(),
    file: z.string(),
    name: z.string().optional().describe("new file name, default the same"),
  },
  async (a, call) => {
    const r = await call("copy_asset", a);
    return text(`Copied to ${r.file} in v${r.version}. Reference it as "${r.file}".`);
  },
);

artifactTool(
  "set_spritecook_project",
  "Record the SpriteCook project that mirrors this Dreamer project (after create_project, once per project).",
  { project_id: z.string() },
  async (a, call) => {
    await call("set_spritecook_project", a);
    return text("Recorded.");
  },
);

artifactTool(
  "set_theme",
  "Theme artifacts only: set the theme spec of the working version (only the keys you pass change). palette: named " +
    "swatches; fonts: heading and body, each one of Playfair Display, Nunito (bundled) or a web-safe family (Georgia, " +
    "Times New Roman, Palatino, Garamond, Arial, Helvetica, Verdana, Trebuchet MS, Tahoma, Courier New, Lucida Console, " +
    "Impact); mood words; dos / donts; art_mode (pixel with pixel_size, or hd); key_art = the saved key art file, with " +
    "its SpriteCook asset id; preset_id = the private preset saved from it.",
  {
    palette: z.array(z.object({ name: z.string(), hex: z.string() })).max(16).optional(),
    fonts: z.object({ heading: z.string().optional(), body: z.string().optional() }).optional(),
    mood: z.array(z.string()).max(12).optional(),
    dos: z.array(z.string()).max(12).optional(),
    donts: z.array(z.string()).max(12).optional(),
    art_mode: z.object({ mode: z.enum(["pixel", "hd"]), pixel_size: z.number().int().optional() }).optional(),
    key_art: z.string().optional(),
    key_art_asset_id: z.string().optional(),
    preset_id: z.string().optional(),
  },
  async (a, call) => {
    const r = await call("set_theme", a);
    return text(`Theme spec of v${r.version} saved.`);
  },
);

artifactTool(
  "suggest_next",
  "End every artifact turn with this: 2-5 contextual next steps shown as chips on the card (they replace the previous " +
    "ones). Each: a 1-3 word label, the exact instruction to run when clicked, and the estimated SpriteCook credits. " +
    "Character examples: Turnaround, Angry expression, Animate idle, Rival faction version. Concept examples: Storm " +
    "weather, Night, Abandoned, Other faction's district. Only steps that build on what exists; never repeat one just done.",
  {
    artifact_id: z.string().optional(),
    suggestions: z.array(z.object({ label: z.string().max(40), prompt: z.string(), estCredits: z.number().optional() })).min(2).max(5),
  },
  async (a, call) => {
    await call("suggest_next", { suggestions: a.suggestions });
    return text("Chips set. End the turn with one or two sentences on what you made.");
  },
);
