import type { MetadataRoute } from "next";

/** WorkWiki is an owner-only private workspace and must never be indexed. */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      disallow: "/",
    },
  };
}
