export class HttpError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export const notFound = (what: string) => new HttpError(404, "not_found", `${what} not found`);
export const badRequest = (message: string) => new HttpError(400, "bad_request", message);
export const conflict = (message: string) => new HttpError(409, "conflict", message);
export const unauthorized = () => new HttpError(401, "unauthorized", "Missing or invalid device token");
