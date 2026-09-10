/**
 * Keeps <title> and key meta / Open Graph tags in sync with the current route.
 * Mount inside the router tree (e.g. RootWrapper).
 */

import { useEffect } from "react";
import { useLocation } from "react-router-dom";

import { trackGaPageView } from "@/lib/analytics";
import {
  DEFAULT_OG_IMAGE,
  getSiteUrl,
  resolvePageMeta,
  SITE_NAME,
} from "@/lib/seo";

function upsertMeta(
  attr: "name" | "property",
  key: string,
  content: string
) {
  let el = document.head.querySelector<HTMLMetaElement>(
    `meta[${attr}="${key}"]`
  );
  if (!el) {
    el = document.createElement("meta");
    el.setAttribute(attr, key);
    document.head.appendChild(el);
  }
  el.setAttribute("content", content);
}

function upsertLink(rel: string, href: string) {
  let el = document.head.querySelector<HTMLLinkElement>(`link[rel="${rel}"]`);
  if (!el) {
    el = document.createElement("link");
    el.setAttribute("rel", rel);
    document.head.appendChild(el);
  }
  el.setAttribute("href", href);
}

export default function DocumentMeta() {
  const location = useLocation();

  useEffect(() => {
    const meta = resolvePageMeta(location.pathname);
    const siteUrl = getSiteUrl();
    const canonical = `${siteUrl}${location.pathname || "/"}`;
    const ogImage = meta.ogImage
      ? meta.ogImage.startsWith("http")
        ? meta.ogImage
        : `${siteUrl}${meta.ogImage}`
      : `${siteUrl}${DEFAULT_OG_IMAGE}`;

    document.title = meta.title;

    upsertMeta("name", "description", meta.description);
    upsertMeta(
      "name",
      "robots",
      meta.noindex ? "noindex, nofollow" : "index, follow"
    );

    upsertMeta("property", "og:type", "website");
    upsertMeta("property", "og:site_name", SITE_NAME);
    upsertMeta("property", "og:url", canonical);
    upsertMeta("property", "og:title", meta.title);
    upsertMeta("property", "og:description", meta.description);
    upsertMeta("property", "og:image", ogImage);

    upsertMeta("name", "twitter:card", "summary_large_image");
    upsertMeta("name", "twitter:url", canonical);
    upsertMeta("name", "twitter:title", meta.title);
    upsertMeta("name", "twitter:description", meta.description);
    upsertMeta("name", "twitter:image", ogImage);

    upsertLink("canonical", canonical);

    trackGaPageView(
      `${location.pathname}${location.search}`,
      meta.title
    );
  }, [location.pathname, location.search]);

  return null;
}
