import { FastifyError, FastifyRequest, FastifyReply } from 'fastify';

export function errorHandler(error: FastifyError, _request: FastifyRequest, reply: FastifyReply) {
  const statusCode = error.statusCode || 500;

  let safeMessage: string;

  switch (error.constructor.name) {
    case 'ZodError':
      safeMessage = 'Validation error';
      break;
    default:
      safeMessage = statusCode === 500 ? 'Internal Server Error' : (error.message || 'Error');
  }

  if (process.env.NODE_ENV === 'production' && statusCode === 500) {
    safeMessage = 'Internal Server Error';
    _request.log?.error({ err: error }, 'Unhandled error');
  } else {
    _request.log?.error({ err: error }, error.message || 'Error');
  }

  reply.status(statusCode).send({
    error: safeMessage,
    // Request ID ties a user-reported failure to the exact log line; Fastify
    // generates one per request (or honours an upstream x-request-id).
    request_id: _request.id,
    ...(statusCode === 400 && error.cause ? { details: (error.cause as { issues?: unknown }).issues || undefined } : {}),
    ...(process.env.NODE_ENV === 'development' && statusCode === 500 ? { stack: error.stack } : {}),
  });
}

/** FastifyError factory for 404s raised inside handlers. */
export function createNotFoundError(resource: string, id?: string): FastifyError {
  const err = new Error(`${resource}${id ? ` ${id}` : ''} not found`) as FastifyError;
  err.statusCode = 404;
  return err;
}
