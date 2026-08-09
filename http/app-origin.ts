export const APP_ORIGIN_HEADER = "x-investor-app-origin";

export function resolveAppOrigin(
  requestUrl: string,
  configuredBaseUrl?: string,
): string {
  const requestOrigin = new URL(requestUrl).origin;

  if (!configuredBaseUrl?.trim()) {
    return requestOrigin;
  }

  try {
    const configuredUrl = new URL(configuredBaseUrl);
    const hasOriginOnly =
      configuredUrl.pathname === "/" &&
      !configuredUrl.search &&
      !configuredUrl.hash &&
      !configuredUrl.username &&
      !configuredUrl.password;

    if (
      !hasOriginOnly ||
      (configuredUrl.protocol !== "https:" && configuredUrl.protocol !== "http:")
    ) {
      return requestOrigin;
    }

    return configuredUrl.origin;
  } catch {
    return requestOrigin;
  }
}

export function withAppOrigin(
  request: Request,
  configuredBaseUrl?: string,
): Request {
  const headers = new Headers(request.headers);
  headers.set(APP_ORIGIN_HEADER, resolveAppOrigin(request.url, configuredBaseUrl));

  return new Request(request, { headers });
}
