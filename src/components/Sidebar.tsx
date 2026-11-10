import { useEffect, useRef, useState } from "react";
import type { ProjectSummary } from "../api";
import { useTheme } from "../theme/ThemeContext";
import { IconFolder, IconInbox, IconPlus } from "./Icons";

interface Props {
  projects: ProjectSummary[];
  active: string | null;
  onSelect: (slug: string) => void;
  onCreate: (name: string) => void;
}

export function Sidebar({ projects, active, onSelect, onCreate }: Props) {
  const { themes, theme, setThemeId } = useTheme();
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (naming) input.current?.focus();
  }, [naming]);

  const submit = () => {
    const n = name.trim();
    if (n) onCreate(n);
    setName("");
    setNaming(false);
  };

  return (
    <aside className="glass sidebar" aria-label="Projects">
      <div className="wordmark">Dreamer</div>

      <nav className="side-section">
        <div className="side-label">Projects</div>
        {projects.map((p) => (
          <button
            key={p.slug}
            className={"side-row" + (p.slug === active ? " active" : "")}
            type="button"
            aria-current={p.slug === active ? "true" : undefined}
            onClick={() => onSelect(p.slug)}
          >
            {p.is_inbox ? <IconInbox /> : <IconFolder />}
            <span>{p.name}</span>
            {p.is_inbox && p.card_count > 0 && (
              <span className="badge" aria-label={`${p.card_count} ideas`}>
                {p.card_count}
              </span>
            )}
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

      {naming ? (
        <input
          ref={input}
          className="name-input"
          aria-label="New project name"
          placeholder="Project name, then Enter"
          value={name}
          maxLength={120}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
            if (e.key === "Escape") {
              setName("");
              setNaming(false);
            }
          }}
          onBlur={submit}
        />
      ) : (
        <button className="new-project" type="button" onClick={() => setNaming(true)}>
          <IconPlus />
          New project
        </button>
      )}
    </aside>
  );
}
