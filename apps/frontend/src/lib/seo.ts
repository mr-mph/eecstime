/**
 * Site-wide SEO defaults and per-route meta resolution.
 *
 * Static routes use ROUTE_META. Catalog URLs are derived from path params.
 * Private / auth surfaces get noindex.
 */

export const SITE_NAME = "EECStime";

export const DEFAULT_DESCRIPTION =
  "Berkeley's online course discovery platform. EECStime is a platform built, maintained, and run by students, just like you. We work hard to simplify and improve the course discovery experience.";

export const DEFAULT_OG_IMAGE = "/images/linkpreview.png";

export const SITE_URL = "https://eecstime.sethw.dev";

/** Absolute site origin for canonical / OG / sitemap URLs. */
export function getSiteUrl(): string {
  const fromEnv = import.meta.env.VITE_SITE_URL?.replace(/\/$/, "");
  if (fromEnv) return fromEnv;
  return SITE_URL;
}

export type PageMeta = {
  title: string;
  description: string;
  /** If true, emit robots noindex,nofollow */
  noindex?: boolean;
  ogImage?: string;
};

const ROUTE_META: Record<string, PageMeta> = {
  "/": {
    title: SITE_NAME,
    description: DEFAULT_DESCRIPTION,
  },
  "/catalog": {
    title: `Course Catalog | ${SITE_NAME}`,
    description:
      "Browse UC Berkeley courses by term — schedules, enrollment, grades, and ratings on EECStime.",
  },
  "/grades": {
    title: `Grade Distributions | ${SITE_NAME}`,
    description:
      "Explore historical grade distributions for UC Berkeley courses on EECStime.",
  },
  "/enrollment": {
    title: `Enrollment History | ${SITE_NAME}`,
    description:
      "Track UC Berkeley course enrollment trends and seat availability over time.",
  },
  "/schedules": {
    title: `Schedules | ${SITE_NAME}`,
    description:
      "Build and compare Berkeley class schedules with EECStime's schedule planner.",
    noindex: true,
  },
  "/gradtrak": {
    title: `GradTrak | ${SITE_NAME}`,
    description:
      "Plan your Berkeley graduation path and track degree requirements with GradTrak.",
  },
  "/gradtrak/onboarding": {
    title: `GradTrak Onboarding | ${SITE_NAME}`,
    description: "Set up GradTrak to track your UC Berkeley degree progress.",
    noindex: true,
  },
  "/gradtrak/dashboard": {
    title: `GradTrak Dashboard | ${SITE_NAME}`,
    description: "Your GradTrak degree progress dashboard.",
    noindex: true,
  },
  "/curated": {
    title: `Curated Classes | ${SITE_NAME}`,
    description: "Browse curated UC Berkeley class collections on EECStime.",
  },
  "/dorms": {
    title: `Dorms | ${SITE_NAME}`,
    description: "Explore Berkeley dorm rooms and layouts on EECStime.",
  },
  "/legal/privacy": {
    title: `Privacy Policy | ${SITE_NAME}`,
    description: "EECStime privacy policy.",
  },
  "/legal/terms": {
    title: `Terms of Service | ${SITE_NAME}`,
    description: "EECStime terms of service.",
  },
  "/profile": {
    title: `Profile | ${SITE_NAME}`,
    description: "Your EECStime account.",
    noindex: true,
  },
  "/profile/support": {
    title: `Support | ${SITE_NAME}`,
    description: "Get help with EECStime.",
    noindex: true,
  },
  "/profile/ratings": {
    title: `My Ratings | ${SITE_NAME}`,
    description: "Your course ratings on EECStime.",
    noindex: true,
  },
  "/profile/bookmarks": {
    title: `Bookmarks | ${SITE_NAME}`,
    description: "Your bookmarked classes on EECStime.",
    noindex: true,
  },
};

const capitalize = (s: string) =>
  s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : s;

/** Resolve title/description for the current pathname. */
export function resolvePageMeta(pathname: string): PageMeta {
  const path = pathname.replace(/\/$/, "") || "/";

  if (ROUTE_META[path]) return ROUTE_META[path];

  // /schedules/:id...
  if (path.startsWith("/schedules/")) {
    return {
      title: `Schedule | ${SITE_NAME}`,
      description: "Berkeley class schedule on EECStime.",
      noindex: true,
    };
  }

  // /collection/:id...
  if (path.startsWith("/collection/")) {
    return {
      title: `Collection | ${SITE_NAME}`,
      description: "A shared class collection on EECStime.",
      noindex: true,
    };
  }

  // /dorms/:roomId
  if (path.startsWith("/dorms/")) {
    return {
      title: `Dorm Room | ${SITE_NAME}`,
      description: "Berkeley dorm room layout on EECStime.",
    };
  }

  // /catalog/:year/:semester/:subject/:courseNumber/...
  if (path.startsWith("/catalog")) {
    const parts = path.split("/").filter(Boolean); // catalog, year, semester, subject, ...
    const [, year, semester, subject, courseNumber] = parts;
    if (subject && courseNumber) {
      const term =
        year && semester ? ` · ${capitalize(semester)} ${year}` : "";
      return {
        title: `${subject} ${courseNumber}${term} | ${SITE_NAME}`,
        description: `View ${subject} ${courseNumber}${term} — schedule, enrollment, grades, and ratings on EECStime.`,
      };
    }
    if (year && semester) {
      return {
        title: `${capitalize(semester)} ${year} Catalog | ${SITE_NAME}`,
        description: `Browse UC Berkeley courses for ${capitalize(semester)} ${year} on EECStime.`,
      };
    }
    return ROUTE_META["/catalog"];
  }

  if (path === "/grades-legacy" || path === "/enrollment-legacy") {
    return {
      title: path.includes("grades")
        ? `Grade Distributions (Legacy) | ${SITE_NAME}`
        : `Enrollment (Legacy) | ${SITE_NAME}`,
      description: DEFAULT_DESCRIPTION,
      noindex: true,
    };
  }

  return {
    title: SITE_NAME,
    description: DEFAULT_DESCRIPTION,
  };
}

/** Public paths included in sitemap.xml (no auth-only or dynamic IDs). */
export const SITEMAP_PATHS = [
  "/",
  "/catalog",
  "/grades",
  "/enrollment",
  "/gradtrak",
  "/curated",
  "/dorms",
  "/legal/privacy",
  "/legal/terms",
] as const;
