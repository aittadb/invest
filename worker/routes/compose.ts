import type { ApplicationRouteHandler } from "../contracts.ts";

export function composeRouteHandlers(
  handlers: readonly ApplicationRouteHandler[],
): ApplicationRouteHandler {
  return async (context) => {
    for (const handler of handlers) {
      const response = await handler(context);
      if (response) return response;
    }

    return null;
  };
}
