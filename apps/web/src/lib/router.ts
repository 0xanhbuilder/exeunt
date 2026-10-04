import { useEffect, useState } from "react";

export type Route = "overview" | "sell" | "buy" | "earn" | "frozen" | "developers";

const PATHS: Record<Route, string> = {
  overview: "/",
  sell: "/sell",
  buy: "/buy",
  earn: "/earn",
  frozen: "/frozen-collateral",
  developers: "/developers",
};

export function hrefFor(route: Route): string {
  return `#${PATHS[route]}`;
}

export function routeFromHash(hash: string): Route {
  const path = hash.replace(/^#/, "").split("?")[0] || "/";
  const found = (Object.keys(PATHS) as Route[]).find((r) => PATHS[r] === path);
  return found ?? "overview";
}

/** Hash routing: works on any static host without server rewrites. */
export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => routeFromHash(window.location.hash));
  useEffect(() => {
    const onChange = () => {
      setRoute(routeFromHash(window.location.hash));
      window.scrollTo(0, 0);
    };
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}
