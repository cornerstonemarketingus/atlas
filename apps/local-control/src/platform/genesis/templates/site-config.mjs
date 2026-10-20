/**
 * The static-site template's configuration: turns a Genesis specification into
 * site.json. Pure (no file system), so the local Genesis pipeline and the
 * hosted website builder produce exactly the same site from the same spec.
 */

const ACCENTS = { blue: "#2563eb", green: "#15803d", red: "#b91c1c", orange: "#c2410c", purple: "#7c3aed", teal: "#0f766e", earthy: "#8a5a2b", warm: "#c2410c", dark: "#334155", black: "#1f2937" };

export function accentFor(spec) {
  const colour = spec.design?.colours?.find((name) => ACCENTS[name]);
  if (colour) return ACCENTS[colour];
  // The trade, not the whole prompt: every prompt starts with "Build …".
  const trade = spec.business?.phrase ?? "";
  if (/landscap|garden|lawn|tree|farm/iu.test(trade)) return "#15803d";
  if (/roof|construct|renovat|remodel|carpent|builder/iu.test(trade)) return "#b45309";
  if (/clean|plumb|pool|water/iu.test(trade)) return "#0e7490";
  if (/bak|cafe|restaurant|food/iu.test(trade)) return "#c2410c";
  return "#2563eb";
}

const TRADE_SERVICES = [
  [/roof/iu, [["Roof repairs", "Leaks, missing shingles and storm damage fixed fast."], ["Roof replacement", "Complete tear-off and new roof with a written warranty."], ["Inspections", "A clear report on your roof's condition, with photos."], ["Gutters", "Cleaning, repair and new gutter installation."]]],
  [/landscap|garden|lawn/iu, [["Lawn care", "Regular mowing, edging and feeding for a healthy lawn."], ["Garden design", "Planting plans that suit your space and your climate."], ["Hardscaping", "Patios, paths and retaining walls built to last."], ["Seasonal clean-ups", "Spring and autumn clean-ups, leaves and pruning."]]],
  [/construct|build|renovat|remodel/iu, [["New builds", "From plans to handover, managed by one team."], ["Renovations", "Kitchens, bathrooms and extensions done right."], ["Repairs", "Structural and general repairs, quoted up front."], ["Project management", "Schedules, permits and trades coordinated for you."]]],
  [/clean/iu, [["Regular cleaning", "Weekly or fortnightly cleans you can rely on."], ["Deep cleaning", "Top-to-bottom cleans for move-ins and special occasions."], ["Commercial cleaning", "Offices and shops cleaned outside your hours."], ["Windows", "Streak-free windows inside and out."]]],
  [/paint/iu, [["Interior painting", "Walls, ceilings and trim with a clean finish."], ["Exterior painting", "Weather-ready coatings that last."], ["Colour advice", "Help choosing colours that work together."], ["Repairs & prep", "Filling, sanding and priming done properly."]]],
];

function servicesFor(spec) {
  const trade = `${spec.business?.phrase ?? ""} ${spec.objective}`;
  const match = TRADE_SERVICES.find(([pattern]) => pattern.test(trade));
  const list = match ? match[1] : [["Consultations", "Talk through what you need and get honest advice."], ["Services", "Professional work delivered on time and on budget."], ["Support", "Friendly help before, during and after the job."], ["Quotes", "Clear, written quotes with no surprises."]];
  return list.map(([title, text]) => ({ title, text }));
}

/** Plain, factual one-liners for the services owners most often list. Anything else gets a neutral sentence, never a claim. */
const SERVICE_BLURBS = [
  [/fram/iu, "Wood framing for new-construction projects."],
  [/window/iu, "Window installation for new construction."],
  [/door/iu, "Exterior door installation for new construction."],
  [/housewrap|house wrap|weather barrier/iu, "Housewrap installed as part of the building envelope."],
];
const blurbFor = (service) => SERVICE_BLURBS.find(([pattern]) => pattern.test(service))?.[1] ?? `${service}.`;

const PLACEHOLDER = (what) => `[Add ${what} here before you publish.]`;

export function siteConfig(spec) {
  const named = spec.services?.length > 0;
  const who = spec.business?.kind ? `${spec.business.kind[0].toUpperCase()}${spec.business.kind.slice(1)}` : spec.name;
  const services = named ? spec.services.map((title) => ({ title, text: blurbFor(title) })) : servicesFor(spec);
  const trade = spec.business?.phrase ?? "business";
  const place = spec.location ? [spec.location.city, spec.location.region].filter(Boolean).join(", ") : "";
  const related = (page) => {
    const words = page.id.split("-").filter((word) => !["and", "the"].includes(word));
    const matched = services.filter((service) => words.some((word) => service.title.toLowerCase().includes(word.replace(/s$/u, ""))));
    return matched.length ? matched : services;
  };
  const pages = spec.pages.map((page) => {
    const base = { id: page.id, title: page.title };
    if (page.id === "home") return { ...base, headline: named ? `${spec.name}${place ? ` in ${place}` : ""}` : `${who} you can count on`, intro: named ? `${services.map((service) => service.title.replace(/^./u, (c) => c.toLowerCase())).join(", ").replace(/^./u, (c) => c.toUpperCase())}${place ? ` for projects in ${place} and nearby` : ""}.` : `Dependable, professional ${spec.business?.kind ? `${spec.business.kind.toLowerCase()} ` : ""}work with clear quotes and friendly service.`, description: `${spec.name}${place ? `, ${place}` : ""}: ${named ? services.map((service) => service.title.toLowerCase()).join(", ") : `${trade} services`}.`.slice(0, 160), sections: [{ type: "cards", title: "What we do", items: services.slice(0, 4) }, { type: "steps", title: "How it works", items: [{ title: "Get in touch.", text: "Tell us about your project." }, { title: "Get an estimate.", text: "We review the details and respond with next steps." }, { title: "Plan the work.", text: "We confirm scope and schedule with you." }] }] };
    if (page.id === "services") return { ...base, headline: "Our services", intro: `Everything ${spec.name} can help you with.`, description: `Services offered by ${spec.name}${place ? ` in ${place}` : ""}.`.slice(0, 160), sections: [{ type: "cards", title: "Services", items: services }] };
    if (page.id === "about") return { ...base, headline: `About ${spec.name}`, intro: `${spec.name}${place ? ` is based in ${place}` : ""}.`, description: `About ${spec.name}${place ? `, ${place}` : ""}.`.slice(0, 160), sections: [{ type: "text", title: "Our company", paragraphs: [PLACEHOLDER("your company story, years in business and crew details"), PLACEHOLDER("licensing, insurance and credentials, only if they are real")] }] };
    if (page.id === "gallery") return { ...base, headline: "Our work", intro: "Project photos will appear here.", description: `Projects by ${spec.name}.`.slice(0, 160), sections: [{ type: "gallery", title: "Projects", items: services.map((service) => service.title), note: "Add your own project photos to replace these tiles." }] };
    if (page.id === "contact") return { ...base, headline: "Request an estimate", intro: "Tell us about your project and we will get back to you.", description: `Request an estimate from ${spec.name}${place ? ` in ${place}` : ""}.`.slice(0, 160), sections: [{ type: "contact", title: "Contact us", text: "Tell us a little about the project and the best way to reach you." }] };
    if (named && spec.services.length) {
      const items = related(page);
      return { ...base, headline: page.title, intro: `${page.title} from ${spec.name}${place ? ` in ${place}` : ""}.`, description: `${page.title}: ${items.map((item) => item.title.toLowerCase()).join(", ")} from ${spec.name}.`.slice(0, 160), sections: [{ type: "cards", title: page.title, items }, { type: "text", title: "Details", paragraphs: [PLACEHOLDER(`the materials, methods and project types you handle for ${page.title.toLowerCase()}`)] }] };
    }
    return { ...base, headline: page.title, intro: page.purpose, description: `${page.title} · ${spec.name}`.slice(0, 160), sections: [{ type: "text", title: page.title, paragraphs: [page.purpose] }] };
  });
  return { name: spec.name, tagline: named ? `${services.map((service) => service.title).slice(0, 3).join(", ")}${place ? ` in ${place}` : ""}` : `Trusted ${trade} services`, cta: "Request an estimate", url: "", location: spec.location ?? null, contact: { phone: "", email: "", area: place }, theme: { accent: accentFor(spec) }, pages };
}
