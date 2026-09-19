export const CANDIDATES = [
  { name: "qwen2.5-coder:7b", parametersB: 7, minimumMemoryGiB: 6, tasks: ["coding", "planning", "summarization"] },
  { name: "qwen2.5-coder:14b", parametersB: 14, minimumMemoryGiB: 12, tasks: ["coding", "planning", "summarization"] },
  { name: "qwen2.5-coder:32b", parametersB: 32, minimumMemoryGiB: 20, tasks: ["coding", "planning", "summarization"] },
  { name: "llava:7b", parametersB: 7, minimumMemoryGiB: 8, tasks: ["vision"] },
  { name: "llava:13b", parametersB: 13, minimumMemoryGiB: 14, tasks: ["vision"] },
];

export function recommendModels({ hardware, installed = [] }) {
  const installedNames = new Set(installed.map((model) => model.name));
  const recommendations = {};
  for (const task of ["planning", "coding", "vision", "summarization"]) {
    const fitting = CANDIDATES.filter((candidate) => candidate.tasks.includes(task) && candidate.minimumMemoryGiB <= hardware.usableModelMemoryGiB);
    const recommended = fitting.reduce((best, value) => !best || value.parametersB > best.parametersB ? value : best, null);
    const selected = fitting.filter((candidate) => installedNames.has(candidate.name)).reduce((best, value) => !best || value.parametersB > best.parametersB ? value : best, null);
    let reason;
    if (selected && selected.name === recommended?.name) reason = `${selected.name} is both installed and the best fit for this machine.`;
    else if (selected && recommended) reason = `${selected.name} is installed; ${recommended.name} would fit this machine and do better.`;
    else if (!recommended) reason = `Available memory is below what any ${task} model in the catalog requires.`;
    else reason = `${recommended.name} would fit; pull it to enable ${task}.`;
    recommendations[task] = { selected: selected?.name ?? null, recommended: recommended?.name ?? null, reason };
  }
  return { recommendations };
}
