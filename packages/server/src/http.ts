/* eslint-disable @typescript-eslint/no-explicit-any */
import type { EventEmitter } from 'events';
import type qs from 'qs';
import { DataTransformer } from './transformer';
import { assertNotBrowser } from './assertNotBrowser';
import { InputValidationError, RouteNotFoundError } from './errors';
import { Router } from './router';
import { Subscription, SubscriptionDestroyError } from './subscription';
assertNotBrowser();
export class HTTPError extends Error {
  public readonly statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
    Object.setPrototypeOf(this, HTTPError.prototype);
  }
}

export const httpError = {
  forbidden: (message?: string) => new HTTPError(403, message ?? 'Forbidden'),
  unauthorized: (message?: string) =>
    new HTTPError(401, message ?? 'Unauthorized'),
  badRequest: (message?: string) =>
    new HTTPError(400, message ?? 'Bad Request'),
  notFound: (message?: string) => new HTTPError(404, message ?? 'Not found'),
};
export type HTTPSuccessResponseEnvelope<TOutput> = {
  ok: true;
  statusCode: number;
  data: TOutput;
};

export type HTTPErrorResponseEnvelope = {
  ok: false;
  statusCode: number;
  error: {
    message: string;
    stack?: string | undefined;
  };
};

export type HTTPResponseEnvelope<TOutput> =
  | HTTPSuccessResponseEnvelope<TOutput>
  | HTTPErrorResponseEnvelope;

export function getErrorResponseEnvelope(
  _err?: Partial<HTTPError> | InputValidationError<Error>,
) {
  let err = _err;
  if (err instanceof InputValidationError) {
    err = httpError.badRequest(err.message);
  } else if (err instanceof RouteNotFoundError) {
    err = httpError.notFound(err.message);
  }
  const statusCode: number =
    typeof err?.statusCode === 'number' ? err.statusCode : 500;
  const message: string =
    typeof err?.message === 'string' ? err.message : 'Internal Server Error';

  const stack: string | undefined =
    process.env.NODE_ENV !== 'production' && typeof err?.stack === 'string'
      ? err.stack
      : undefined;

  const json: HTTPErrorResponseEnvelope = {
    ok: false,
    statusCode,
    error: {
      message,
      stack,
    },
  };

  return json;
}

export function getQueryInput<TRequest extends BaseRequest>(req: TRequest) {
  let input: unknown = undefined;

  const queryInput = req.query.input;
  if (!queryInput) {
    return input;
  }
  // console.log('query', queryInput);
  if (typeof queryInput !== 'string') {
    throw httpError.badRequest('Expected query.input to be a JSON string');
  }
  try {
    input = JSON.parse(queryInput);
  } catch (err) {
    throw httpError.badRequest('Expected query.input to be a JSON string');
  }

  return input;
}

export type CreateContextFnOptions<TRequest, TResponse> = {
  req: TRequest;
  res: TResponse;
};
export type CreateContextFn<TContext, TRequest, TResponse> = (
  opts: CreateContextFnOptions<TRequest, TResponse>,
) => TContext | Promise<TContext>;

interface BaseRequest {
  method?: string;
  query: qs.ParsedQs;
  body?: any;
}
interface BaseResponse extends EventEmitter {
  status: (code: number) => BaseResponse;
  json: (data: unknown) => any;
  statusCode?: number;
}

export interface BaseOptions {
  subscriptions?: {
    timeout?: number;
  };
  teardown?: () => Promise<void>;
  /**
   * Optional transformer too serialize/deserialize input args + data
   */
  transformer?: DataTransformer;
}

export async function requestHandler<
  TContext,
  TRouter extends Router<TContext, any, any, any>,
  TCreateContextFn extends CreateContextFn<TContext, TRequest, TResponse>,
  TRequest extends BaseRequest,
  TResponse extends BaseResponse
>({
  req,
  res,
  router,
  endpoint,
  subscriptions,
  createContext,
  teardown,
  transformer = {
    serialize: (data) => data,
    deserialize: (data) => data,
  },
}: {
  req: TRequest;
  res: TResponse;
  endpoint: string;
  router: TRouter;
  createContext: TCreateContextFn;
} & BaseOptions) {
  try {
    let output: unknown;
    const ctx = await createContext({ req, res });
    const method = req.method ?? 'GET';

    const deserializeInput = (input: unknown) =>
      input ? transformer.deserialize(input) : input;

    if (method === 'POST') {
      const input = deserializeInput(req.body.input);
      output = await router.invoke({
        target: 'mutations',
        input,
        ctx,
        path: endpoint,
      });
    } else if (method === 'GET') {
      const input = deserializeInput(getQueryInput(req));
      output = await router.invoke({
        target: 'queries',
        input,
        ctx,
        path: endpoint,
      });
    } else if (method === 'PATCH') {
      const input = deserializeInput(req.body.input);

      const sub = (await router.invoke({
        target: 'subscriptions',
        input,
        ctx,
        path: endpoint,
      })) as Subscription;
      const onClose = () => {
        sub.destroy('closed');
      };

      // FIXME - refactor
      //  this is a bit complex
      // needs to handle a few cases:
      // - ok subscription
      // - error subscription
      // - request got prematurely closed
      // - request timed out
      res.once('close', onClose);
      const timeout = subscriptions?.timeout ?? 9000; // 10s is vercel's api timeout
      const timer = setTimeout(() => {
        sub.destroy('timeout');
      }, timeout);
      try {
        output = await sub.onceOutputAndStop();

        res.off('close', onClose);
      } catch (err) {
        res.off('close', onClose);
        clearTimeout(timer);
        if (
          err instanceof SubscriptionDestroyError &&
          err.reason === 'timeout'
        ) {
          throw new HTTPError(
            408,
            `Subscription exceeded ${timeout}ms - please reconnect.`,
          );
        }
        throw err;
      }
    } else {
      throw httpError.badRequest(`Unexpected request method ${method}`);
    }

    const json: HTTPSuccessResponseEnvelope<unknown> = {
      ok: true,
      statusCode: res.statusCode ?? 200,
      data: transformer.serialize(output),
    };
    res.status(json.statusCode).json(json);
  } catch (err) {
    const json = getErrorResponseEnvelope(err);

    res.status(json.statusCode).json(json);
  }
  try {
    teardown && (await teardown());
  } catch (err) {
    console.error('Teardown failed', err);
  }
}