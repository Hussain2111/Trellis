import type postgres from 'postgres';
import { measure } from './server';

/**
 * Time the lazy postgres-js unsafe queries Drizzle executes. Start on consumption,
 * not construction; retain values()/raw() and the driver's rejection behavior.
 * Never inspect SQL, parameters, result rows, or error messages.
 */
export function instrumentSql<T extends postgres.Sql>(client: T): T {
  return new Proxy(client, {
    get(target, key, receiver) {
      if (key === 'begin' || key === 'savepoint') {
        const original = Reflect.get(target, key, receiver);
        if (typeof original !== 'function') return original;
        return (...args: unknown[]) =>
          Reflect.apply(
            original,
            target,
            args.map((arg) =>
              typeof arg === 'function'
                ? (transaction: postgres.Sql) => arg(instrumentSql(transaction))
                : arg,
            ),
          );
      }
      if (key !== 'unsafe') return Reflect.get(target, key, receiver);
      return (...args: Parameters<T['unsafe']>) => {
        const query = Reflect.apply(target.unsafe, target, args);
        let execution: Promise<unknown> | undefined;
        const run = () => (execution ??= measure('database', () => query));
        const wrapped = new Proxy(query, {
          get(original, property) {
            if (property === 'then' || property === 'catch' || property === 'finally') {
              return (...callbacks: unknown[]) => {
                const promise = run();
                return Reflect.apply(promise[property], promise, callbacks);
              };
            }
            const value = Reflect.get(original, property, original);
            if (typeof value !== 'function') return value;
            return (...parameters: unknown[]) => {
              const result = Reflect.apply(value, original, parameters);
              return result === original ? wrapped : result;
            };
          },
        });
        return wrapped;
      };
    },
  });
}
