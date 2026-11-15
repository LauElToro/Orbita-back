export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

export const notFound = (what: string) => new HttpError(404, `${what} no encontrado`);
export const conflict = (msg: string) => new HttpError(409, msg);
export const badRequest = (msg: string) => new HttpError(400, msg);
