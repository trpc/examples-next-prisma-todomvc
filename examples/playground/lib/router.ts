import { Prefixer, DropFirst } from './types';

export type ResolverFn<TContext, TData, TArgs extends any[]> = (
  ctx: TContext,
  ...args: TArgs
) => Promise<TData> | TData;

export class Router<
  TContext extends {},
  TEndpoints extends Record<string, ResolverFn<TContext, any, any>> = {}> {
  readonly _endpoints: TEndpoints;

  constructor(endpoints?: TEndpoints) {
    this._endpoints = endpoints ?? {} as TEndpoints;
  }

  public endpoint<TData, TArgs extends any[], TPath extends string>(
    path: TPath,
    resolver: ResolverFn<TContext, TData, TArgs>
  ) {
    const route = {
      [path]: resolver,
    } as Record<TPath, typeof resolver>;

    return new Router<TContext, TEndpoints & typeof route>({
      ...this._endpoints,
      ...route,
    });
  }

  public compose<
    TPath extends string,
    TChildRouter extends Router<TContext, any>
  >(
    path: TPath,
    router: TChildRouter
  ): Router<TContext, TEndpoints & Prefixer<TChildRouter['_endpoints'], `${TPath}/`>> {
    return Object.keys(router._endpoints).reduce((r, key) => {
      return r.endpoint(`${path}/${key}`, router._endpoints[key]);
    }, this as any as Router<TContext, any>);
  }

  public handler(ctx: TContext) {
    return async <
      TPath extends keyof TEndpoints,
      TArgs extends DropFirst<Parameters<TResolver>>,
      TResolver extends TEndpoints[TPath]
    >(path: TPath, ...args: TArgs): Promise<ReturnType<TResolver>> => {
      return this._endpoints[path](ctx, ...args);
    };
  }

  public has(path: string) {
    return !!this._endpoints[path]
  }
}