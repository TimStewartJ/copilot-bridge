import { API_BASE } from "../api";

export function getAppAbsoluteUrl(
  route: string,
  origin = window.location.origin,
  base = API_BASE,
): URL {
  const normalizedRoute = route.startsWith("/") ? route : `/${route}`;
  return new URL(`${base}${normalizedRoute}`, origin);
}
