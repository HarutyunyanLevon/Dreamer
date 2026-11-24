Dreamer: project versions. Be terse. Read src/api/types.ts, the src-tauri model + storage (folders.json, canvases, cards), useWorkspace.ts, Sidebar.tsx, the title pill, CanvasArea.tsx, the chat context builder + canvas tool handlers, and the handoff writer. Edit only what versions need. Add Rust tests for copy/lineage/migration. No summaries/screenshots.

Model
- A version is a top-level folder with kind:"version" in folders.json: {id, title ("v1"), kind:"version", parent:null, created, created_from?: <version id>}. The project root canvas holds only version folders. Ordinary folders (kind absent) may live inside a version. Organize still never touches folders.
- Cards get origin?: {card: <id>, version: <version folder id>} in frontmatter (set on copy, never changed after).
- project.json: last_version (id) = what opens by default.

Migration (once per project, on load, backup first to <project>/.backup-<date>/)
- If the root has no version folders:
  - If root has top-level folders already: show a one-time dialog "Treat these folders as versions?" listing them with checkboxes (prechecked when the title looks like v1/v2/Version 2/Alpha...). Checked ones become kind:"version"; everything else at root (cards, frames, unchecked folders) goes into a new "v1" (or the first checked version if that is clearer, say which).
  - Otherwise wrap all root content into a new version "v1" (positions kept).
- Handoff: rename design/v<N>/ to design/v1/r<N>/, rewrite design/index.json + manifests. Repo copies untouched.

New version
- Title-pill menu + version folder context menu: "New version from <vX>…". Dialog: name (default next vN), from (default open version). Copies in ONE storage transaction: the version's canvases, frames, nested folders, cards (new ULIDs, origin set), links remapped to the new ids, attachments (reference the same media files; make Trash/empty-trash refcount media so v2 deletes never break v1), tags, build info (build block + .built.md snapshots; see prompt 3 if it exists, else skip silently). Not copied: ghosts, drafts, proposals, chat threads, trash. Opens the new version. One undo step.

Navigation/UI
- Opening a project opens last_version. Title pill: "<Project> · v2 ▾" with: switch version, New version from…, Compare versions…, Rename version.
- Sidebar: project → versions (newest first, small "v" badge, item count) → folders. Root canvas (if ever shown, e.g. breadcrumb "Project") shows version nodes side by side.
- Card editor: a small "from v1" chip when origin exists; click = compare this card with its origin.

Compare view (modal, like the variants compare view; reuse util/diff.ts)
- Pick A and B (default: origin version vs open version). Match cards by lineage (B.origin == A.id, also follow chains). Lists: New in B, Changed (title/body/tags/stage/fields diff), Removed in B (A cards with no descendant in B), Unchanged (collapsed).
- Each changed/new/removed row: "Apply to <other version>": copies the change across (create with origin / patch fields / move to Trash), one undo step each, plus "Apply all shown". Clicking a row jumps to the card.

Claude scope
- Context header gets "Version: v2 (others: v1)". list_tree/list_cards/read_card/search default to the open version.
- Read tools accept optional version. Write tools accept optional version but Rust rejects writes to a non-open version unless the current user message contains that version's title (case-insensitive, word match); the error tells Claude to ask the user. Change-log entries for other-version writes show the version tag.
- Project memory stays shared across versions.

Handoff
- Export dialog scope defaults to the open version. Output: <project>/design/<version title>/r<N>/ (N per version). CHANGELOG: against previous revision of the same version; first revision of a new version compares against the last revision of created_from. manifest.json and the repo CLAUDE.md block name the version. Design view: version picker = project version, revision picker inside it.
