import { useTheme } from "../theme/ThemeContext";
import { IconFolder, IconInbox, IconPlus } from "./Icons";

// Placeholder data until the storage core lands in step 3.
const DEMO_PROJECTS = [{ id: "fish-punk", name: "Fish-punk fishing" }];

export function Sidebar() {
  const { themes, theme, setThemeId } = useTheme();
  return (
    <aside className="glass sidebar" aria-label="Projects">
      <div className="wordmark">Dreamer</div>

      <nav className="side-section">
        <div className="side-label">Projects</div>
        <button className="side-row" type="button">
          <IconInbox />
          <span>Inbox</span>
          <span className="badge" aria-label="3 ideas">3</span>
        </button>
        {DEMO_PROJECTS.map((p) => (
          <button key={p.id} className="side-row active" type="button" aria-current="true">
            <IconFolder />
            <span>{p.name}</span>
          </button>
        ))}
      </nav>

      <div className="side-spacer" />

      <div className="side-section">
        <div className="side-label">Theme</div>
        <div className="theme-row" role="radiogroup" aria-label="Theme">
          {themes.map((t) => (
            <button
              key={t.id}
              type="button"
              role="radio"
              aria-checked={t.id === theme.id}
              aria-label={t.name}
              title={t.name}
              className={"swatch" + (t.id === theme.id ? " on" : "")}
              onClick={() => setThemeId(t.id)}
              style={{
                background: `linear-gradient(135deg, ${t.shader.palette[0]}, ${t.shader.palette[1]} 45%, ${t.shader.palette[3]})`,
              }}
            />
          ))}
        </div>
        <div className="theme-name">{theme.name}</div>
      </div>

      <button className="new-project" type="button">
        <IconPlus />
        New project
      </button>
    </aside>
  );
}
