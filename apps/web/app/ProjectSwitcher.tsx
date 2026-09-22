"use client";
import { useEffect, useState } from "react";

export const PROJECT_STORAGE_KEY = "atlas-project";
export const PROJECT_CHANGE_EVENT = "atlas:project-change";

export function ProjectSwitcher() {
  const [projects, setProjects] = useState<string[]>([]);
  const [project, setProject] = useState("");

  useEffect(() => {
    let active = true;
    void fetch("/api/github/options")
      .then((response) => response.ok ? response.json() : null)
      .then((value: { repositories?: string[] } | null) => {
        if (!active || !value?.repositories?.length) return;
        const stored = window.localStorage.getItem(PROJECT_STORAGE_KEY);
        const selected = stored && value.repositories.includes(stored) ? stored : value.repositories[0];
        setProjects(value.repositories); setProject(selected);
        window.localStorage.setItem(PROJECT_STORAGE_KEY, selected);
      }).catch(() => undefined);
    return () => { active = false; };
  }, []);

  function choose(next: string) {
    setProject(next);
    window.localStorage.setItem(PROJECT_STORAGE_KEY, next);
    window.dispatchEvent(new CustomEvent(PROJECT_CHANGE_EVENT, { detail: next }));
  }

  if (!projects.length) return null;
  return <label className="project-switcher"><span>Project</span><select aria-label="Active project" value={project} onChange={(event) => choose(event.target.value)}>{projects.map((item) => <option key={item}>{item}</option>)}</select></label>;
}
