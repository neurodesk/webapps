import { logError } from './technicalLog';

export function asyncCallback<Args extends unknown[]>(
  context: string,
  callback: (...args: Args) => void | Promise<unknown>,
): (...args: Args) => void {
  return (...args) => {
    try {
      Promise.resolve(callback(...args)).catch(error => logError(context, error));
    } catch (error) {
      logError(context, error);
    }
  };
}
